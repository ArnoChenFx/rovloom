// 从实际安装发现Luvus并初始化既有受保护root/持久账本；不启动Agent、调用模型或根据固定发行版猜pin。
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { discoverLuvusInstallation } from '../runtime/native-control.js'
import { initializeManagedLuvusRoot } from '../runtime/native-root.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../runtime/native-source.js'
import type { LuvusProductionOwnerConfig, LuvusProductionUserConfig } from '../runtime/production-luvus.js'
import type { LuvusProductionRemoteConfig } from '../runtime/remote-luvus.js'
import { localLimits, verifyInstallation } from '../connector/luvus/local.js'
import { effectiveBinDirectories } from '../connector/local/agent-path.js'
import { runFixedProcess } from '../connector/luvus/io.js'
import { LuvusDispatchClaims } from '../connector/luvus/claims.js'
import { boundedJson, fields, hash, id, object, validatePolicies } from '../wire/index.js'
import type { ProviderPolicies } from '../wire/types.js'
import {
  CliError,
  herdrMode,
  luvusMode,
  selectedNativeProviders,
  type ConnectorConfig,
  type NativeProviderKind
} from './config.js'
import { privateDirectory } from './first-config.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'
import { setupReference, setupSessionsFor, setupTarget } from './setup-policy.js'
import type { SetupConsole } from './setup-console.js'
import { cliMessages, formatMessage } from './messages.js'

export type PreparedSetupNative = Readonly<{
  schema_version: 1
  attempt_id: string
  machine_id: string
  phase: 'prepared'
  settings: NonNullable<ConnectorConfig['native']>
  reference: string
  local: LuvusProductionOwnerConfig | LuvusProductionUserConfig
  remote: LuvusProductionRemoteConfig
}>

// 首次兑换前即可核对Unix socket所需短路径，不先创建身份再要求用户迁移内部状态。
export function assertSetupNativePath(config: ConnectorConfig, console: SetupConsole): void {
  if (
    selectedNativeProviders(config).includes('luvus') &&
    luvusMode(config) === 'managed' &&
    Buffer.byteLength(join(config.state_dir, 'n')) > 52
  ) {
    console.show(cliMessages(console.io.language)['setup.native.statePathTooLongLuvus'])
    throw new CliError('configuration_required')
  }
  // 只有隔离实例把 socket 放在 Connector 数据目录里；附着模式的端点在用户自己的配置目录，Windows 是命名管道。
  if (
    selectedNativeProviders(config).includes('herdr') &&
    herdrMode(config) === 'managed' &&
    process.platform !== 'win32' &&
    Buffer.byteLength(join(config.state_dir, 'hr/c/herdr/herdr-client.sock')) > 107
  ) {
    console.show(cliMessages(console.io.language)['setup.native.statePathTooLongHerdr'])
    throw new CliError('configuration_required')
  }
}

// 搜索顺序：所有者显式列出的目录，其后是启动进程 PATH 中通过安全筛选的条目，最后是受控系统目录。
export function setupBinary(config: ConnectorConfig, kind: NativeProviderKind = 'luvus'): string {
  // Windows 没有固定的系统目录兜底（PATH 里的 System32 等已由 effectiveBinDirectories 筛选带入），可执行文件带 .exe。
  const fallback = process.platform === 'win32' ? [] : ['/usr/bin', '/bin']
  const name = process.platform === 'win32' ? kind + '.exe' : kind
  for (const directory of [...effectiveBinDirectories(config.native?.runtime_bin_dirs), ...fallback]) {
    const path = join(directory, name)
    if (existsSync(path)) {
      return path
    }
  }
  throw new CliError('configuration_required')
}

// 原生与 Agent 的 PATH 在安装时一次性固化：显式目录加筛选后的启动 PATH 条目；没有任何额外目录时保持固定系统 PATH。
export function setupAgentDirectories(config: ConnectorConfig): { agent_bin_dirs?: readonly string[] } {
  const directories = effectiveBinDirectories(config.native?.agent_bin_dirs)
  return directories.length > 0 ? { agent_bin_dirs: directories } : {}
}

// 附着模式使用用户自己的 LUVUS_HOME（显式配置，或 Connector 环境里的 LUVUS_HOME，否则 ~/.luvus）；不存在则以 0700 创建，与 Luvus 自建一致。
function userLuvusHome(config: ConnectorConfig): string {
  const configured = config.native?.luvus?.state_root
  const environment = process.env.LUVUS_HOME
  const path = configured ?? (environment && isAbsolute(environment) ? environment : join(homedir(), '.luvus'))
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

// 恢复只能使用同一配对的完整已准备记录；未完成创建不猜测缺失账本可重建。
function prepared(value: unknown, attempt: string, machine: string, config: ConnectorConfig): PreparedSetupNative {
  const row = object(value)
  fields(row, ['schema_version', 'attempt_id', 'machine_id', 'phase', 'settings', 'reference', 'local', 'remote'])
  if (
    row.schema_version !== 1 ||
    row.attempt_id !== attempt ||
    row.machine_id !== machine ||
    row.phase !== 'prepared' ||
    row.reference !== setupReference(attempt) ||
    boundedJson(row.settings) !== boundedJson(config.native ?? {})
  ) {
    throw new CliError('configuration_required')
  }
  // 这些数据不会反序列化为可信句柄；正式生产工厂仍重开root并实测native和原始schema。
  return row as PreparedSetupNative
}

// 发现本地安装并初始化受保护root/持久账本；单码直连配对自动批准，不再逐次人工确认。
export async function prepareSetupNative(
  config: ConnectorConfig,
  console: SetupConsole,
  machine: string,
  attempt: string,
  authorization: Readonly<{ principal_id: string; policies: ProviderPolicies }>
): Promise<PreparedSetupNative> {
  console.assertOwner()
  id(attempt)
  id(machine)
  id(authorization.principal_id)
  validatePolicies(authorization.policies)
  const path = runtimeReference(config.state_dir, 'native-setup')
  const existing = readSetupJson(path, 1_048_576)
  if (existing !== undefined) {
    return prepared(existing, attempt, machine, config)
  }
  const binary = setupBinary(config)
  const attach = luvusMode(config) === 'attach'
  if (!attach && process.platform === 'win32') {
    // 隔离实例依赖 POSIX 权限与 pidfd 进程模型；Windows 上目前只支持附着用户自己的会话。
    console.show(
      formatMessage(cliMessages(console.io.language)['setup.native.managedUnsupportedWindows'], {
        provider: 'luvus',
        configKey: 'luvus'
      })
    )
    throw new CliError('configuration_required')
  }
  if (!attach && process.platform === 'darwin') {
    // 隔离实例依赖 Linux 的 pidfd 进程模型；macOS 上目前只支持附着用户自己的会话。
    console.show(
      formatMessage(cliMessages(console.io.language)['setup.native.managedUnsupportedMacos'], {
        provider: 'luvus',
        configKey: 'luvus'
      })
    )
    throw new CliError('configuration_required')
  }
  const control = join(config.state_dir, 'control')
  // 附着：状态根是用户自己的 LUVUS_HOME；managed：Connector 私有的隔离目录。
  const stateRoot = attach ? userLuvusHome(config) : join(config.state_dir, 'n')
  const home = join(config.state_dir, 'h')
  const work = join(config.state_dir, 'w')
  // 官方socket超过Unix地址长度后会退到root外；在创建root/账本前明确拒绝，不能绕过原endpoint门禁。
  assertSetupNativePath(config, console)
  for (const directory of [
    control,
    ...(attach ? [] : [stateRoot]),
    home,
    work,
    ...['config', 'data', 'cache', 'runtime'].map(/* HOME下固定的独立XDG目录。 */ (name) => join(home, name))
  ]) {
    privateDirectory(directory)
  }
  const reference = setupReference(attempt)
  const target = setupTarget(machine, 'luvus', setupSessionsFor(config))
  const discovered = await discoverLuvusInstallation(
    {
      target,
      config_ref: reference,
      binding_revision: 1,
      binary,
      state_root: stateRoot,
      home,
      cwd: work,
      transport: 'ipc',
      allow_terminal_execution: config.allow_terminal_execution === true,
      ...(attach ? { attach: true as const, user_home: homedir() } : {}),
      ...setupAgentDirectories(config)
    },
    { revision: MANAGED_LUVUS_REVISION, signal: console.io.signal }
  )
  // 正式发现返回opaque compiled而不返回原字节；只用现有固定schema命令读取并与该实际编译身份交叉核对。
  const schema = await runFixedProcess(
    discovered.config,
    localLimits(discovered.config.limits),
    'schema',
    console.io.signal
  )
  if (schema.exit_code !== 0 || hash(schema.stdout) !== discovered.compiled.identity.schema_sha256) {
    throw new CliError('configuration_required')
  }
  await verifyInstallation(discovered.config)
  const remote: LuvusProductionRemoteConfig = {
    kind: 'luvus',
    authentication: 'remote_connector',
    binding: {
      machine_id: target.machine_id,
      provider_id: target.provider_id,
      kind: 'luvus',
      config_ref: reference,
      binding_revision: 1,
      enabled: true
    },
    target,
    contract: {
      binary_version: discovered.binaryVersion,
      binary_sha256: discovered.config.binary_sha256,
      schema_sha256: discovered.compiled.identity.schema_sha256,
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      schema_bundle: schema.stdout.toString('utf8')
    },
    peer_policy_revision: authorization.policies.local.revision
  }
  boundedJson(remote, 1_048_576)
  console.assertOwner()
  // journal先持久发布；此后任何失败保留证据，不能通过重跑create清除原native或账本历史。
  writeSetupJson(path, {
    schema_version: 1,
    attempt_id: attempt,
    machine_id: machine,
    phase: 'initializing'
  })
  if (attach) {
    // 附着用户自己的 Luvus：没有 Connector 拥有的 root，只建 claim 账本；实例配置直接记入受保护的已准备记录。
    const ledgerId = hash(boundedJson([reference, 'user', target]))
    new LuvusDispatchClaims({
      path: join(control, 'luvus-claims.db'),
      mode: 'create',
      ledger_id: ledgerId,
      limits: { entries: 1024, bytes: 4_194_304 },
      now: Date.now
    }).close()
    const result: PreparedSetupNative = {
      schema_version: 1,
      attempt_id: attempt,
      machine_id: machine,
      phase: 'prepared',
      settings: config.native ?? {},
      reference,
      local: {
        kind: 'luvus',
        authentication: 'local_owner',
        native: { mode: 'user', config: discovered.config },
        peer_policy_revision: remote.peer_policy_revision,
        principal_id: authorization.principal_id,
        policies: authorization.policies,
        storage_mode: 'open'
      },
      remote
    }
    writeSetupJson(path, result, true, 1_048_576)
    return result
  }
  const rootRecord = join(control, 'luvus-root.json')
  const root = await initializeManagedLuvusRoot({
    record_path: rootRecord,
    config: discovered.config
  })
  try {
    const ledgerId = hash(boundedJson([reference, root.root_id, root.root_revision, root.config.target]))
    const claims = new LuvusDispatchClaims({
      path: join(control, 'luvus-claims.db'),
      mode: 'create',
      ledger_id: ledgerId,
      limits: { entries: 1024, bytes: 4_194_304 },
      now: Date.now
    })
    claims.close()
    const result: PreparedSetupNative = {
      schema_version: 1,
      attempt_id: attempt,
      machine_id: machine,
      phase: 'prepared',
      settings: config.native ?? {},
      reference,
      local: {
        kind: 'luvus',
        authentication: 'local_owner',
        native: {
          mode: 'managed',
          root_record: rootRecord,
          expected_root_id: root.root_id,
          expected_root_revision: root.root_revision
        },
        peer_policy_revision: remote.peer_policy_revision,
        principal_id: authorization.principal_id,
        policies: authorization.policies,
        storage_mode: 'open'
      },
      remote
    }
    writeSetupJson(path, result, true, 1_048_576)
    return result
  } finally {
    root.close()
  }
}
