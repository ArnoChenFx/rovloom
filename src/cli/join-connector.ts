import { migrateConnectorControls, providerSetupPath } from './provider-control.js'
// 单码直连配对的 Connector 侧：`rovloom connector --join ws://host:port#machine.attempt.secret`。
// 一条命令完成：写 Gateway 地址 → 本地推导固定授权 → 准备实测原生清单 → POST /pairing 换取设备凭据 → 落盘并直接进入运行。
// 非交互、无确认问答；已配对状态与码目标不一致时先重置本地配对状态（作为新设备重新配对）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseJson } from '../json/bounds.js'
import { createFileCredentialSink } from '../transport/credentials.js'
import type { DeviceCredential } from '../transport/identity.js'
import { boundedJson, fields, id, object } from '../wire/index.js'
import {
  CliError,
  configDocument,
  parseConfig,
  readConfig,
  selectedNativeProviders,
  type ConnectorConfig
} from './config.js'
import { privateDirectory } from './first-config.js'
import { cliMessages, formatMessage } from './messages.js'
import { readSetupJson, setupFileStamp, writeSetupFile, writeSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'
import { assertSetupNativePath, prepareSetupNative } from './setup-native.js'
import { prepareSetupHerdr } from './setup-herdr.js'
import { prepareSetupHerdrCore } from './setup-herdr-core.js'
import { SIMPLE_SETUP_ACTOR } from './setup-targets.js'
import { readRuntimeConfig } from './runtime-config.js'
import { silentConsole } from './setup-console.js'
import { hasPairingState, retirePairingState } from './unpair.js'
import type { CliIo } from './run.js'

export type JoinCode = Readonly<{
  url: string
  machine: string
  attempt: string
  secret: string
  value: string
}>

// 只接受 ws/wss origin 加 #machine.attempt.secret 片段；地址部分须能通过配置的严格 URL 校验。
export function parseJoinValue(value: string): JoinCode {
  const hash = value.indexOf('#')
  if (typeof value !== 'string' || hash <= 0 || hash === value.length - 1) {
    throw new CliError('invalid_arguments')
  }
  const url = value.slice(0, hash)
  const parts = value.slice(hash + 1).split('.')
  if (parts.length !== 3) {
    throw new CliError('invalid_arguments')
  }
  const [machine, attempt, secret] = parts
  id(machine)
  id(attempt)
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new CliError('invalid_arguments')
  }
  const parsed = new URL(url)
  if (
    !['ws:', 'wss:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !['/', ''].includes(parsed.pathname)
  ) {
    throw new CliError('invalid_arguments')
  }
  return { url: parsed.origin, machine, attempt, secret, value: machine + '.' + attempt + '.' + secret }
}

// 有界、严格地读取配对响应；非 200 先释放未锁定的响应体再拒绝。
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body || response.status !== 200) {
    await response.body?.cancel().catch(/* 只释放响应流，不输出远端文本。 */ () => {})
    throw new CliError('configuration_required')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const value = await reader.read()
      if (value.done) {
        break
      }
      bytes += value.value.length
      if (bytes > 262_144) {
        throw new CliError('configuration_required')
      }
      chunks.push(value.value)
    }
    const parsed = parseJson(Buffer.concat(chunks, bytes), { object_bytes: 262_144 })
    if (!parsed.ok) {
      throw new CliError('configuration_required')
    }
    return object(parsed.value)
  } finally {
    await reader.cancel().catch(/* 只释放响应流。 */ () => {})
    reader.releaseLock()
  }
}

// URL只由严格角色origin解析；系统TLS验证和fetch重定向拒绝保持开启。
async function post(config: ConnectorConfig, path: string, value: unknown, signal: AbortSignal, timeout = 300_000) {
  const origin = new URL(config.gateway_url)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  return await responseJson(
    await fetch(new URL(path, origin), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: boundedJson(value, 1_048_576),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    })
  )
}

/** join 主流程：返回更新后的配置；失败保持固定错误码，不回显码原文。 */
export async function joinConnector(
  config: ConnectorConfig,
  path: string,
  io: CliIo,
  value: string
): Promise<ConnectorConfig> {
  const code = parseJoinValue(value)
  const console = silentConsole(io)
  migrateConnectorControls(config.state_dir)
  const providers = readRuntimeConfig(config).providers
  const hasCredential = existsSync(runtimeReference(config.state_dir, 'device'))
  if (hasPairingState(config.state_dir)) {
    const paired = readSetupJson(runtimeReference(config.state_dir, 'pairing'))
    const current = paired === undefined ? undefined : object(paired)
    const machine = current && 'machine_id' in current ? String(current.machine_id) : undefined
    if (
      hasCredential &&
      existsSync(runtimeReference(config.state_dir, 'providers')) &&
      machine === code.machine &&
      config.gateway_url === code.url
    ) {
      // 同一设备对同一 Gateway 的重复 join：状态已完整，直接按已配对启动。
      return config
    }
    // 换码即换设备身份（吊销恢复），换地址即换 Gateway：码本身就是意图证明，旧状态整体退役后重新配对。
    // managed 模式的原生根必须回到空白才能重新初始化，因此退役目录而不是只删文件。
    const prepared = ['luvus', 'herdr', 'herdr-core'] as const
    const records = prepared
      .map((kind) => readSetupJson(providerSetupPath(config.state_dir, kind), 1_048_576))
      .filter((entry) => entry !== undefined)
    const resume =
      !hasCredential &&
      providers.length === 0 &&
      config.gateway_url === code.url &&
      records.length > 0 &&
      records.every((entry) => {
        const row = object(entry)
        return row.phase === 'prepared' && row.machine_id === code.machine && row.attempt_id === code.attempt
      })
    if (!resume) {
      const retired = retirePairingState(config, console)
      if (retired !== undefined) {
        console.show(
          formatMessage(
            cliMessages(io.language)[
              config.gateway_url === code.url ? 'setup.join.resettingState' : 'setup.join.switchingGateway'
            ],
            { retired }
          )
        )
      }
    }
  }
  if (config.gateway_url !== code.url) {
    // 写入（或换写）Gateway 地址前核对磁盘文件仍与内存配置一致，防止覆盖并发编辑。
    if (boundedJson(configDocument(readConfig(path))) !== boundedJson(configDocument(config))) {
      throw new CliError('config_changed')
    }
    config = parseConfig({ ...configDocument(config), gateway: { url: code.url } }) as ConnectorConfig
    writeSetupFile(path, JSON.stringify(configDocument(config), null, 2) + '\n', true, setupFileStamp(path))
  }
  privateDirectory(config.state_dir)
  privateDirectory(join(config.state_dir, 'managed'))
  assertSetupNativePath(config, console)
  const authorization = { principal_id: SIMPLE_SETUP_ACTOR }
  const prepared = []
  for (const kind of selectedNativeProviders(config)) {
    try {
      prepared.push(
        await (kind === 'luvus' ? prepareSetupNative : kind === 'herdr' ? prepareSetupHerdr : prepareSetupHerdrCore)(
          config,
          console,
          code.machine,
          code.attempt,
          authorization
        )
      )
    } catch (error) {
      // 固定错误码不带来源信息；多 provider（含 mixed）时用户必须知道是哪一个没准备好，才能装好它或改选 provider。
      // 只输出 provider 名，不输出异常内容、路径或任何配置。
      console.show(formatMessage(cliMessages(io.language)['setup.join.providerFailed'], { kind }))
      throw error
    }
  }
  const installations = prepared.map(
    /* 每份清单只包含原生来源和公开schema，不包含Connector的本地路径或凭据。 */ (native) => ({
      reference: native.reference,
      value: native.remote
    })
  )
  const installation =
    installations.length === 1 && selectedNativeProviders(config)[0] === 'luvus' ? installations[0]! : { installations }
  const applied = await post(config, '/pairing', { code: code.value, installation }, io.signal)
  fields(applied, ['state', 'machine_id', 'recovery_generation', 'credential'], ['mcp', 'replayed'])
  id(applied.machine_id)
  id(applied.recovery_generation)
  if (
    applied.state !== 'paired' ||
    applied.machine_id !== code.machine ||
    typeof applied.credential !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(applied.credential)
  ) {
    throw new CliError('configuration_required')
  }
  const credential: DeviceCredential = {
    machine_id: code.machine,
    recovery_generation: applied.recovery_generation,
    credential: applied.credential
  }
  const credentialPath = runtimeReference(config.state_dir, 'device')
  const sink = createFileCredentialSink(credentialPath, credential, existsSync(credentialPath))
  try {
    await sink.deliver(credential, io.signal, { delivery_id: 'join_' + code.attempt, revision: 0 })
  } finally {
    sink.close()
  }
  writeSetupJson(
    runtimeReference(config.state_dir, 'providers'),
    {
      schema_version: 1,
      role: 'connector',
      providers: prepared.map(
        /* 程序自己的私有本地配置沿用既有生产工厂。 */ (native) => ({
          reference: native.reference,
          value: native.local
        })
      )
    },
    false,
    1_048_576
  )
  writeSetupJson(
    runtimeReference(config.state_dir, 'pairing'),
    {
      schema_version: 1,
      attempt_id: code.attempt,
      machine_id: code.machine,
      gateway_url: config.gateway_url,
      phase: 'configured'
    },
    false
  )
  console.show(
    formatMessage(cliMessages(io.language)['setup.join.completed'], {
      machine: code.machine,
      url: config.gateway_url
    }) +
      formatMessage(cliMessages(io.language)['setup.join.providers'], {
        entries: prepared.map((native) => (native as { reference: string }).reference).join(', ')
      })
  )
  if (applied.mcp !== undefined) {
    const mcp = object(applied.mcp)
    fields(mcp, ['url', 'token'])
    if (typeof mcp.url !== 'string' || typeof mcp.token !== 'string') {
      throw new CliError('configuration_required')
    }
    console.show(formatMessage(cliMessages(io.language)['setup.join.mcpBlock'], { url: mcp.url, token: mcp.token }))
  }
  return config
}
