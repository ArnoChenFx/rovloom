// 已配对设备追加「配对时没有的 provider」：本机准备 → 用设备凭据向 Gateway 追加登记 → 写本机注册表。
// 不换配对码、不改设备身份；追加失败一律非致命，只打印固定码，继续用已配对来源启动。
import { setTimeout as delay } from 'node:timers/promises'
import { CliError, type ConnectorConfig, type NativeProviderKind } from './config.js'
import { parseJson } from '../json/bounds.js'
import { boundedJson, fields, object } from '../wire/index.js'
import type { SetupConsole } from './setup-console.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { providerSetupPath } from './provider-control.js'
import { prepareSetupHerdr } from './setup-herdr.js'
import { prepareSetupHerdrCore } from './setup-herdr-core.js'
import { prepareSetupNative } from './setup-native.js'
import { setupReference, SIMPLE_SETUP_ACTOR } from './setup-targets.js'
import { randomUUID } from 'node:crypto'

/** 追加登记的单次请求上限：不能让 Gateway 不可达拖住 Connector 启动。 */
export const APPEND_TIMEOUT_MS = 10_000
/**
 * 网络层失败（连接被拒、连接中断）最多重试几次、间隔多久。追加端点对同一 reference 幂等，重试是安全的；
 * 它覆盖 Gateway 刚好在重开 listener（别的设备配对或追加后的 reload）的窗口。超时不重试。
 */
export const APPEND_NETWORK_ATTEMPTS = 3
export const APPEND_RETRY_DELAY_MS = 1_500

export type AppendOutcome = Readonly<{
  appended: readonly NativeProviderKind[]
  /** 每个失败只带 kind 与固定原因码，不含路径、异常文本或凭据。 */
  failed: readonly Readonly<{ kind: NativeProviderKind; code: string }>[]
}>

type Credential = Readonly<{ machine_id: string; recovery_generation: string; credential: string }>
type Prepared = Readonly<{
  kind: NativeProviderKind
  attempt: string
  reference: string
  local: unknown
  remote: unknown
}>

/**
 * 本机准备：复用 join 用的三个准备函数。已有 prepared 记录且设置未变时直接复用（重试沿用它的 attempt，
 * 收敛到同一个 reference）；其余来源共用 `fresh` 这一个新 attempt，所以能放进同一个请求。
 * 半完成的 initializing 记录可能已经创建过账本或原生根，重来会碰撞——不替用户猜，固定码拒绝。
 */
async function prepare(
  config: ConnectorConfig,
  kind: NativeProviderKind,
  machine: string,
  fresh: string,
  console: SetupConsole
): Promise<Prepared> {
  const path = providerSetupPath(config.state_dir, kind)
  const existing = readSetupJson(path, 1_048_576)
  if (existing !== undefined) {
    let row: Record<string, unknown>
    try {
      row = object(existing)
    } catch {
      throw new CliError('configuration_required')
    }
    if (row.phase !== 'prepared') {
      throw new CliError('configuration_required')
    }
    // 设置变了就不复用旧准备记录：那是上一次（可能是别的 native 配置）留下的，不替用户改写。
    if (boundedJson(row.settings) !== boundedJson(config.native ?? {})) {
      throw new CliError('configuration_required')
    }
    const attempt = typeof row.attempt_id === 'string' ? row.attempt_id : ''
    if (row.reference !== setupReference(attempt, kind) || row.machine_id !== machine) {
      throw new CliError('configuration_required')
    }
    return Object.freeze({ kind, attempt, reference: row.reference as string, local: row.local, remote: row.remote })
  }
  const authorization = { principal_id: SIMPLE_SETUP_ACTOR }
  const prepared =
    kind === 'luvus'
      ? await prepareSetupNative(config, console, machine, fresh, authorization)
      : kind === 'herdr'
        ? await prepareSetupHerdr(config, console, machine, fresh, authorization)
        : await prepareSetupHerdrCore(config, console, machine, fresh, authorization)
  return Object.freeze({
    kind,
    attempt: fresh,
    reference: prepared.reference,
    local: prepared.local,
    remote: prepared.remote
  })
}

/** 有界读取响应体：只接受固定的小 JSON。 */
async function responseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > 65_536) {
      return undefined
    }
    const parsed = parseJson(bytes, { object_bytes: 65_536 })
    return parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 向 Gateway 发一次追加请求；返回 `appended` 或固定码。网络层失败按幂等重试。 */
async function post(
  config: ConnectorConfig,
  group: readonly Prepared[],
  credential: Credential,
  signal: AbortSignal
): Promise<'appended' | Readonly<{ code: string }>> {
  const origin = new URL(config.gateway_url)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  const installations = group.map(
    /** 只带引用与可公开的清单。 */ (entry) => ({
      reference: entry.reference,
      value: entry.remote
    })
  )
  const body = boundedJson(
    {
      machine_id: credential.machine_id,
      recovery_generation: credential.recovery_generation,
      credential: credential.credential,
      installation: installations.length === 1 ? installations[0] : { installations }
    },
    1_048_576
  )
  let response: Response | undefined
  for (let attempt = 1; response === undefined; attempt++) {
    try {
      response = await fetch(new URL('/pairing/providers', origin), {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(APPEND_TIMEOUT_MS)])
      })
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError') {
        return Object.freeze({ code: 'append_timeout' })
      }
      if (signal.aborted || attempt >= APPEND_NETWORK_ATTEMPTS) {
        return Object.freeze({ code: 'append_network' })
      }
      await delay(APPEND_RETRY_DELAY_MS)
    }
  }
  const parsed = await responseJson(response)
  if (response.status !== 200 || parsed?.state !== 'appended') {
    const code =
      typeof parsed?.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(parsed.error)
        ? parsed.error
        : 'append_http_' + response.status
    return Object.freeze({ code })
  }
  return 'appended'
}

/** Gateway 确认之后才写本机注册表：保留已有条目，追加同一个 {reference, local}；已有同引用必须逐字相同。 */
function recordLocally(config: ConnectorConfig, group: readonly Prepared[]): string | undefined {
  const path = runtimeReference(config.state_dir, 'providers')
  let current: Record<string, unknown>
  try {
    current = object(readRuntimeJson(path, 1_048_576))
    fields(current, ['schema_version', 'role', 'providers'])
  } catch {
    return 'append_registry_invalid'
  }
  if (current.schema_version !== 1 || current.role !== 'connector' || !Array.isArray(current.providers)) {
    return 'append_registry_invalid'
  }
  // readRuntimeJson 的结果是只读的：在副本上追加，绝不原地改冻结数组。
  const entries = [...(current.providers as { reference: string; value: unknown }[])]
  for (const prepared of group) {
    const found = entries.find(/** 同一 reference。 */ (entry) => entry.reference === prepared.reference)
    if (found) {
      if (boundedJson(found.value, 1_048_576) !== boundedJson(prepared.local, 1_048_576)) {
        return 'append_registry_conflict'
      }
    } else {
      entries.push({ reference: prepared.reference, value: prepared.local })
    }
  }
  try {
    writeSetupJson(path, { schema_version: 1, role: 'connector', providers: entries }, true, 1_048_576)
  } catch {
    return 'append_registry_unwritable'
  }
  return undefined
}

/**
 * 追加 `kinds`（按调用方给的固定顺序）。先逐个准备本机，再按 attempt 分组：同一次启动里新追加的来源
 * 共用一个 attempt，所以只发一个请求、Gateway 只 reload 一次；只有此前准备过但没登记成功的来源带着
 * 自己的旧 attempt，才会多一组。每组独立成败；调用方在失败后继续用已配对来源启动，运行中不重试
 * （下次启动再试）。
 */
export async function appendNativeProviders(input: {
  config: ConnectorConfig
  kinds: readonly NativeProviderKind[]
  credential: Credential
  console: SetupConsole
  signal: AbortSignal
}): Promise<AppendOutcome> {
  const appended: NativeProviderKind[] = []
  const failed: { kind: NativeProviderKind; code: string }[] = []
  const fixedCode = (error: unknown, fallback: string): string =>
    error instanceof CliError && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code) ? error.code : fallback
  const fresh = randomUUID()
  const prepared: Prepared[] = []
  for (const kind of input.kinds) {
    if (input.signal.aborted) {
      failed.push({ kind, code: 'append_cancelled' })
      continue
    }
    try {
      prepared.push(await prepare(input.config, kind, input.credential.machine_id, fresh, input.console))
    } catch (error) {
      // 任何未预期异常都只投影成固定码，不带路径或异常文本。
      failed.push({ kind, code: fixedCode(error, 'append_prepare_failed') })
    }
  }
  const groups = new Map<string, Prepared[]>()
  for (const entry of prepared) {
    groups.set(entry.attempt, [...(groups.get(entry.attempt) ?? []), entry])
  }
  for (const group of groups.values()) {
    let code: string | undefined
    try {
      const outcome = await post(input.config, group, input.credential, input.signal)
      code = outcome === 'appended' ? recordLocally(input.config, group) : outcome.code
    } catch {
      code = 'append_internal'
    }
    for (const entry of group) {
      if (code === undefined) {
        appended.push(entry.kind)
      } else {
        failed.push({ kind: entry.kind, code })
      }
    }
  }
  return Object.freeze({ appended: Object.freeze(appended), failed: Object.freeze(failed) })
}
