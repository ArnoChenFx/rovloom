// Herdr首次准备只使用实际binary/schema和既有编译、私有路径及账本工厂；不启动Agent或复制普通HOME认证。
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { compileHerdrSchemas } from '../connector/herdr/compiler-api.js'
import { herdrDeadline, isStoppedHerdrCommandCancellation, runHerdrCommand } from '../connector/herdr/io.js'
import { HerdrLocalError, measureHerdrInstallation, verifyHerdrInstallation } from '../connector/herdr/local.js'
import type { HerdrLocalConfig } from '../connector/herdr/local.js'
import { observedHerdrSource } from '../connector/herdr/review.js'
import { parseHerdrProviderRefConfig } from '../connector/herdr/provider.js'
import type { HerdrProviderRefConfig } from '../connector/herdr/provider.js'
import { LuvusDispatchClaims } from '../connector/luvus/claims.js'
import type { ProviderPolicies } from '../wire/types.js'
import { boundedJson, fields, hash, object } from '../wire/index.js'
import { CliCancelled, CliError, herdrMode, type ConnectorConfig } from './config.js'
import { privateDirectory } from './first-config.js'
import type { HerdrProductionOwnerConfig } from './production-herdr.js'
import { readSetupJson, writeSetupFile, writeSetupJson } from './setup-files.js'
import { assertSetupNativePath, setupAgentDirectories, setupBinary } from './setup-native.js'
import { setupReference, setupTarget } from './setup-policy.js'
import { runtimeReference } from './runtime-files.js'
import type { SetupConsole } from './setup-console.js'
import { cliMessages, formatMessage } from './messages.js'

export type HerdrSetupRemote = Readonly<{
  kind: 'herdr'
  config: Omit<HerdrProviderRefConfig, 'schema_path' | 'connector'>
  schema_bundle: string
}>
export type PreparedSetupHerdr = Readonly<{
  schema_version: 1
  attempt_id: string
  machine_id: string
  phase: 'prepared'
  settings: NonNullable<ConnectorConfig['native']>
  reference: string
  local: HerdrProductionOwnerConfig
  remote: HerdrSetupRemote
}>

// 附着模式使用用户真实的 HOME 与 XDG 目录（Connector 自己的环境，或用户显式配置的 config_home）；缺失的 XDG 目录以 0700 创建。
function attachedDirectories(
  config: ConnectorConfig
): Pick<HerdrLocalConfig, 'home' | 'config_home' | 'state_home' | 'cache_home' | 'cwd'> {
  const home = homedir()
  if (process.platform === 'win32') {
    // Windows：Herdr 的配置与日志在 %APPDATA%\herdr，本地数据在 %LOCALAPPDATA%；沿用用户真实目录。
    const roaming = config.native?.herdr?.config_home ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    for (const path of [roaming, local]) {
      mkdirSync(path, { recursive: true })
    }
    return { home, config_home: roaming, state_home: local, cache_home: local, cwd: home }
  }
  const xdg = (variable: string, fallback: string): string => {
    const value = process.env[variable]
    return value && isAbsolute(value) ? value : join(home, fallback)
  }
  const directories = {
    home,
    config_home: config.native?.herdr?.config_home ?? xdg('XDG_CONFIG_HOME', '.config'),
    state_home: xdg('XDG_STATE_HOME', '.local/state'),
    cache_home: xdg('XDG_CACHE_HOME', '.cache'),
    cwd: home
  }
  for (const path of [directories.config_home, directories.state_home, directories.cache_home]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  return directories
}

// 版本只作诊断；只降低原固定版本命令不支持/独立超时，安装、取消或IO错误保持失败。
async function version(config: HerdrLocalConfig, signal: AbortSignal): Promise<string> {
  const scope = herdrDeadline(signal, 1000)
  try {
    const raw = await runHerdrCommand(config, 'version', scope.signal)
    const label = raw
      .toString('utf8')
      .trim()
      .replace(/^herdr\s+/i, '')
    return label.length > 0 &&
      label.length <= 128 &&
      [...label].every(
        /* 诊断标签不能向本机终端注入控制字符。 */ (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      )
      ? label
      : 'unavailable'
  } catch (error) {
    if (
      error instanceof HerdrLocalError &&
      (error.code === 'herdr_cli_exit' || (error.code === 'herdr_timeout' && !signal.aborted))
    ) {
      return 'unavailable'
    }
    throw error
  } finally {
    scope.close()
  }
}

// 同一配对和设置才可继续已准备状态；初始化半完成保留原journal，不重建丢失的账本或墓碑。
function prepared(value: unknown, config: ConnectorConfig, attempt: string, machine: string): PreparedSetupHerdr {
  const row = object(value)
  fields(row, ['schema_version', 'attempt_id', 'machine_id', 'phase', 'settings', 'reference', 'local', 'remote'])
  if (
    row.schema_version !== 1 ||
    row.attempt_id !== attempt ||
    row.machine_id !== machine ||
    row.phase !== 'prepared' ||
    row.reference !== setupReference(attempt, 'herdr') ||
    boundedJson(row.settings) !== boundedJson(config.native ?? {})
  ) {
    throw new CliError('configuration_required')
  }
  return row as PreparedSetupHerdr
}

// 发现本地 Herdr 安装并创建隔离状态；单码直连配对自动批准，实际server/peer来源由原生产工厂在正式启动时建立。
export async function prepareSetupHerdr(
  config: ConnectorConfig,
  console: SetupConsole,
  machine: string,
  attempt: string,
  authorization: Readonly<{ principal_id: string; policies: ProviderPolicies }>
): Promise<PreparedSetupHerdr> {
  console.assertOwner()
  const path = runtimeReference(config.state_dir, 'herdr-setup')
  const existing = readSetupJson(path, 1_048_576)
  if (existing !== undefined) {
    return prepared(existing, config, attempt, machine)
  }
  const binary = setupBinary(config, 'herdr')
  const attach = herdrMode(config) === 'attach'
  if (!attach && process.platform === 'win32') {
    // 隔离实例依赖 POSIX 权限与进程模型；Windows 上目前只支持附着用户自己的会话。
    console.show(
      formatMessage(cliMessages(console.io.language)['setup.native.managedUnsupportedWindows'], {
        provider: 'herdr',
        configKey: 'herdr'
      })
    )
    throw new CliError('configuration_required')
  }
  if (!attach && process.platform === 'darwin') {
    // 隔离实例依赖 Linux 的 pidfd 进程模型；macOS 上目前只支持附着用户自己的会话。
    console.show(
      formatMessage(cliMessages(console.io.language)['setup.native.managedUnsupportedMacos'], {
        provider: 'herdr',
        configKey: 'herdr'
      })
    )
    throw new CliError('configuration_required')
  }
  assertSetupNativePath(config, console)
  const root = join(config.state_dir, 'hr')
  privateDirectory(root)
  for (const name of ['h', 'c', 's', 'k', 't', 'w', 'control']) {
    privateDirectory(join(root, name))
  }
  const target = setupTarget(machine, 'herdr')
  const reference = setupReference(attempt, 'herdr')
  const local: HerdrLocalConfig = {
    target,
    binding_revision: 1,
    config_ref: reference,
    binary,
    ...(attach
      ? attachedDirectories(config)
      : {
          home: join(root, 'h'),
          config_home: join(root, 'c'),
          state_home: join(root, 's'),
          cache_home: join(root, 'k'),
          cwd: join(root, 'w')
        }),
    temporary_home: join(root, 't'),
    allow_terminal_execution: false,
    ...(attach ? { attach: true as const } : {}),
    ...setupAgentDirectories(config)
  }
  const measured = measureHerdrInstallation(local)
  const scope = herdrDeadline(console.io.signal, 10_000)
  let raw: Buffer
  let source: HerdrProviderRefConfig['expected_source']
  try {
    const label = await version(local, scope.signal)
    raw = await runHerdrCommand(local, 'schema', scope.signal)
    const compiled = await compileHerdrSchemas(raw, scope.signal)
    if (verifyHerdrInstallation(local, measured.sha256) !== measured.stamp || compiled.schema_sha256 !== hash(raw)) {
      throw new CliError('configuration_required')
    }
    source = observedHerdrSource(label, measured.sha256, compiled.schema_sha256, compiled.protocol)
  } catch (error) {
    if (console.io.signal.aborted && isStoppedHerdrCommandCancellation(error)) {
      throw new CliCancelled()
    }
    throw error
  } finally {
    scope.close()
  }
  const shared: HerdrSetupRemote['config'] = {
    version: 1,
    target,
    binding_revision: 1,
    config_ref: reference,
    expected_source: source,
    peer_policy_revision: authorization.policies.local.revision
  }
  const control = join(root, 'control')
  const schemaPath = join(control, 'schema.json')
  const limits = { entries: 1024, bytes: 4_194_304 }
  const claimsRef = {
    path: join(control, 'claims.db'),
    mode: 'open' as const,
    ledger_id: hash(boundedJson([reference, target, source, 'claims'])),
    limits
  }
  const provider = parseHerdrProviderRefConfig({
    ...shared,
    schema_path: schemaPath,
    connector: {
      local,
      principal_id: authorization.principal_id,
      claims: claimsRef
    }
  })
  console.assertOwner()
  writeSetupJson(path, {
    schema_version: 1,
    attempt_id: attempt,
    machine_id: machine,
    phase: 'initializing'
  })
  writeSetupFile(schemaPath, raw)
  const claims = new LuvusDispatchClaims({ ...claimsRef, mode: 'create', now: Date.now })
  try {
  } finally {
    claims.close()
  }
  const result: PreparedSetupHerdr = {
    schema_version: 1,
    attempt_id: attempt,
    machine_id: machine,
    phase: 'prepared',
    settings: config.native ?? {},
    reference,
    local: {
      kind: 'herdr',
      config: provider as HerdrProductionOwnerConfig['config'],
      native: { mode: attach ? 'attach' : 'managed' },
      policies: authorization.policies
    },
    remote: { kind: 'herdr', config: shared, schema_bundle: raw.toString('utf8') }
  }
  writeSetupJson(path, result, true, 1_048_576)
  return result
}
