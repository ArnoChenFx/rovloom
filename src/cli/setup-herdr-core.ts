import { migrateConnectorControls, providerControl, providerSetupPath } from './provider-control.js'
// herdr-core 首次准备只附着已运行实例：按内核 peer 与 /proc 事实核对身份，再把本次 rpc.discover 发布给两端。
// 不启动/停止 core、不创建 core 目录、不复制用户 HOME，也不接受设备选择的任意路径。
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DispatchClaims } from '../connector/claims.js'
import { openHerdrCoreClient } from '../connector/herdr-core/client.js'
import {
  herdrCorePeerFacts,
  herdrCorePinnedEndpoint,
  herdrCoreSessionLimit,
  inspectHerdrCoreSocket
} from '../connector/herdr-core/identity.js'
import { ensureHerdrCoreManaged, findHerdrCoreBinary, herdrCoreManagedDirs } from '../connector/herdr-core/managed.js'
import { HERDR_CORE_REVIEW } from '../connector/herdr-core/methods.js'
import { compileHerdrCoreContract } from '../connector/herdr-core/schema.js'
import { parseHerdrCoreProviderRefConfig } from '../connector/herdr-core/provider.js'
import type { HerdrCoreProviderRefConfig } from '../connector/herdr-core/provider.js'
import { publishSchema, schemaReference } from '../connector/schema-store.js'
import { boundedJson, fields, hash, object } from '../wire/index.js'
import { CliError, herdrCoreConfigHome, herdrCoreMode, herdrCoreSession, type ConnectorConfig } from './config.js'
import { privateDirectory } from './first-config.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'
import { setupReference, setupSessionsFor, setupTarget } from './setup-targets.js'
import type { SetupConsole } from './setup-console.js'

export type HerdrCoreSetupRemote = Readonly<{
  kind: 'herdr-core'
  config: Omit<HerdrCoreProviderRefConfig, 'schema_ref' | 'connector'>
  schema_bundle: string
}>
export type PreparedSetupHerdrCore = Readonly<{
  schema_version: 1
  attempt_id: string
  machine_id: string
  phase: 'prepared'
  settings: NonNullable<ConnectorConfig['native']>
  reference: string
  local: Readonly<{ kind: 'herdr-core'; config: HerdrCoreProviderRefConfig }>
  remote: HerdrCoreSetupRemote
}>

/** 端点位置在配对时固定：运行时不再读环境变量，也不从 cwd 推断。 */
function endpointPin(session: string): Readonly<{ runtime_dir?: string; state_home?: string }> {
  const runtime = process.env.XDG_RUNTIME_DIR
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state')
  const pin = runtime && isAbsolute(runtime) ? { runtime_dir: runtime } : { state_home: stateHome }
  if (!isAbsolute((pin.runtime_dir ?? pin.state_home)!)) {
    throw new CliError('configuration_required')
  }
  const bound = herdrCoreSessionLimit(process.env)
  // 只在 core 自己会用的两个位置之间选择，不额外探测 PATH 或任意目录。
  if ((bound.origin === 'runtime') !== 'runtime_dir' in pin) {
    throw new CliError('configuration_required')
  }
  if (session.length > bound.limit) {
    throw new CliError('configuration_required')
  }
  return Object.freeze(pin)
}

// 同一配对和设置才可继续已准备状态；半完成保留原记录，不重建丢失的账本或墓碑。
function prepared(value: unknown, config: ConnectorConfig, attempt: string, machine: string): PreparedSetupHerdrCore {
  const row = object(value)
  fields(row, ['schema_version', 'attempt_id', 'machine_id', 'phase', 'settings', 'reference', 'local', 'remote'])
  if (
    row.schema_version !== 1 ||
    row.attempt_id !== attempt ||
    row.machine_id !== machine ||
    row.phase !== 'prepared' ||
    row.reference !== setupReference(attempt, 'herdr-core') ||
    boundedJson(row.settings) !== boundedJson(config.native ?? {})
  ) {
    throw new CliError('configuration_required')
  }
  return row as PreparedSetupHerdrCore
}

/**
 * 连接一次真实 core，按内核 peer 取 pid，再核对 exe 摘要、argv、HC_SESSION 与套接字目录权限；
 * 契约只来自本次 rpc.discover。返回的 local/remote 都不含凭据或可变句柄。
 */
export async function prepareSetupHerdrCore(
  config: ConnectorConfig,
  console: SetupConsole,
  machine: string,
  attempt: string,
  authorization: Readonly<{ principal_id: string }>
): Promise<PreparedSetupHerdrCore> {
  console.assertOwner()
  migrateConnectorControls(config.state_dir)
  const path = providerSetupPath(config.state_dir, 'herdr-core')
  const existing = readSetupJson(path, 1_048_576)
  if (existing !== undefined) {
    return prepared(existing, config, attempt, machine)
  }
  const session = herdrCoreSession(config)
  // managed：先由 Connector 自己拉起私有实例，再走完全相同的身份核对与契约发布。
  const configHome = herdrCoreConfigHome(config)
  const managed =
    herdrCoreMode(config) === 'managed'
      ? herdrCoreManagedDirs({
          state_dir: config.state_dir,
          session,
          ...(configHome === undefined ? {} : { config_home: configHome })
        })
      : undefined
  if (managed) {
    await ensureHerdrCoreManaged({
      dirs: managed,
      binary: findHerdrCoreBinary(
        config.native?.runtime_bin_dirs ? { runtime_bin_dirs: [...config.native.runtime_bin_dirs] } : {}
      )
    })
  }
  const pin = managed ? { runtime_dir: managed.run } : endpointPin(session)
  const endpoint = herdrCorePinnedEndpoint(pin, session)
  inspectHerdrCoreSocket(endpoint.socket)
  const target = setupTarget(machine, 'herdr-core', setupSessionsFor(config))
  const reference = setupReference(attempt, 'herdr-core')
  const client = await openHerdrCoreClient(endpoint.socket)
  let discovered: string
  let binaryVersion: string
  let binarySha256: string
  let serverVersion: string | null
  try {
    discovered = boundedJson(await client.request('rpc.discover', {}, 10_000), 1024 * 1024)
    const contract = compileHerdrCoreContract(discovered)
    const status = contract.validateResult('server.status', await client.request('server.status', {}, 10_000))
    // pid 来自这条连接的内核 peer；自报 pid 只用于与内核值互相印证。
    const facts = herdrCorePeerFacts(client.peer(), status.pid, session)
    binaryVersion = client.hello.version
    binarySha256 = facts.binary_sha256
    serverVersion = typeof status.version === 'string' ? status.version : null
  } finally {
    client.close()
  }
  const source = {
    provider_kind: 'herdr-core' as const,
    protocol_family: 'herdr-core-jsonrpc' as const,
    // 版本来自本次握手与 server.status；二进制摘要来自正在运行的映像。
    binary_version: binaryVersion,
    binary_sha256: binarySha256,
    schema_sha256: hash(discovered),
    schema_origin: 'live_instance' as const,
    schema_command: 'rpc.discover' as const,
    server_version: serverVersion,
    native_protocol_version: String(HERDR_CORE_REVIEW.protocol_generation),
    runtime_generation: null,
    adapter_revision: 'adapter-herdr-core-1',
    classification_revision: `${HERDR_CORE_REVIEW.version}@${HERDR_CORE_REVIEW.commit}`,
    support_basis: 'schema_and_version' as const
  }
  const shared: HerdrCoreSetupRemote['config'] = {
    version: 1,
    target,
    binding_revision: 1,
    config_ref: reference,
    expected_source: source
  }
  privateDirectory(join(config.state_dir, 'control'))
  const control = providerControl(config.state_dir, 'herdr-core')
  privateDirectory(control)
  const schemaPath = schemaReference(config.state_dir, source.schema_sha256)
  const claimsRef = {
    path: join(control, 'claims.db'),
    mode: 'open' as const,
    ledger_id: hash(boundedJson([reference, target, source, 'claims'])),
    limits: { entries: 1024, bytes: 4_194_304 }
  }
  const provider = parseHerdrCoreProviderRefConfig({
    ...shared,
    schema_ref: schemaPath,
    connector: {
      session,
      endpoint: pin,
      principal_id: authorization.principal_id,
      claims: claimsRef
    }
  })
  writeSetupJson(path, {
    schema_version: 1,
    attempt_id: attempt,
    machine_id: machine,
    phase: 'initializing'
  })
  publishSchema(schemaPath, Buffer.from(discovered, 'utf8'))
  const claims = new DispatchClaims({ ...claimsRef, mode: 'create', now: Date.now })
  try {
  } finally {
    claims.close()
  }
  const result: PreparedSetupHerdrCore = {
    schema_version: 1,
    attempt_id: attempt,
    machine_id: machine,
    phase: 'prepared',
    settings: config.native ?? {},
    reference,
    local: { kind: 'herdr-core', config: provider },
    remote: { kind: 'herdr-core', config: shared, schema_bundle: discovered }
  }
  writeSetupJson(path, result, true, 1_048_576)
  return result
}
