// 定义双角色无密钥配置及严格只读加载边界；不解析凭据、不创建状态或连接。
import { posix, win32 } from 'node:path'
import { canonical } from '../contracts.js'
import { readPrivateBytes } from '../storage/files.js'
import { parseJson } from '../json/bounds.js'
import { binDirectories } from '../connector/local/agent-path.js'
import { pinTerminalExecution, resolveTerminalExecution } from '../connector/terminal-execution.js'

export type GatewayConfig = Readonly<{
  schema_version: 1
  role: 'gateway'
  state_dir: string
  mcp: 'http'
  mcp_hostname: '127.0.0.1' | '::1' | '0.0.0.0' | '::'
  mcp_port: number
  authentication_ref: string
  device_hostname: '127.0.0.1' | '::1' | '0.0.0.0' | '::'
  device_port: number
  management_enabled: boolean
  management_hostname: '127.0.0.1' | '0.0.0.0'
  management_port: number
}>
export type ConnectorConfig = Readonly<{
  schema_version: 1
  role: 'connector'
  state_dir: string
  gateway_url: string
  provider_config_refs: readonly string[]
  allow_terminal_execution?: boolean
  native?: Readonly<{
    // mixed 在 Linux 上表示全部三种（Luvus + Herdr TUI + herdr-core），其它平台仍是前两种；只要两种时用显式的组合值。
    provider?: NativeProviderSelection
    runtime_bin_dirs?: readonly string[]
    agent_bin_dirs?: readonly string[]
    // Herdr 专属：attach（默认）附着用户真实会话、不存在才自建；managed 在 Connector 私有目录里拉一个隔离实例。
    herdr?: Readonly<{ mode?: 'attach' | 'managed'; config_home?: string }>
    // Luvus 专属：attach（默认）附着用户真实的 default 会话（LUVUS_HOME，默认 ~/.luvus）、不存在才自建；
    // managed 在 Connector 私有目录里拉一个隔离实例（会话名 rovloom）。
    luvus?: Readonly<{ mode?: 'attach' | 'managed'; state_root?: string }>
    // herdr-core 专属：attach（默认）只附着已运行的 core；managed 由 Connector 在私有目录里拉起一个实例。
    // session 与 core 的套接字名一致，省略为 default；config_home 只给 managed 用（模板与 config.toml）。
    herdr_core?: Readonly<{ session?: string; mode?: 'attach' | 'managed'; config_home?: string }>
  }>
}>
export type RoleConfig = GatewayConfig | ConnectorConfig
export type NativeProviderKind = 'luvus' | 'herdr' | 'herdr-core'

/**
 * `native.provider` 的闭合取值。`mixed` 从 0.10 起在 Linux 上表示全部三种（其它平台仍是 Luvus + Herdr TUI）；
 * 原先的 Luvus + Herdr TUI 组合改用显式的 `luvus,herdr` 表达，已有配置逐字按原样解析
 * （已配对设备启动时 `native.provider` 只是对已配对来源的筛选，见 native-selection.ts）。
 */
export const NATIVE_PROVIDER_SELECTIONS = Object.freeze([
  'luvus',
  'herdr',
  'herdr-core',
  'mixed',
  'luvus,herdr',
  'luvus,herdr-core',
  'herdr,herdr-core'
] as const)
export type NativeProviderSelection = (typeof NATIVE_PROVIDER_SELECTIONS)[number]

/** 组合值到 kind 的固定映射；单值仍按原样返回，不按分隔符猜测。 */
const NATIVE_PROVIDER_COMBINATIONS: Readonly<Record<string, readonly NativeProviderKind[]>> = Object.freeze({
  mixed: Object.freeze(['luvus', 'herdr', 'herdr-core'] as const),
  'luvus,herdr': Object.freeze(['luvus', 'herdr'] as const),
  'luvus,herdr-core': Object.freeze(['luvus', 'herdr-core'] as const),
  'herdr,herdr-core': Object.freeze(['herdr', 'herdr-core'] as const)
})

// Herdr 的运行方式：默认附着用户已在运行的实例（不存在才自建），managed 为 Connector 私有的隔离实例。
export function herdrMode(config: ConnectorConfig): 'attach' | 'managed' {
  return config.native?.herdr?.mode ?? 'attach'
}

// Luvus 的运行方式：默认附着用户已在运行的 default 会话（不存在才自建），managed 为 Connector 私有的隔离实例。
export function luvusMode(config: ConnectorConfig): 'attach' | 'managed' {
  return config.native?.luvus?.mode ?? 'attach'
}

// herdr-core 默认只附着已运行实例；managed 由 Connector 自己拉起（见 connector/herdr-core/managed.ts）。
export function herdrCoreSession(config: ConnectorConfig): string {
  return config.native?.herdr_core?.session ?? 'default'
}

export function herdrCoreMode(config: ConnectorConfig): 'attach' | 'managed' {
  return config.native?.herdr_core?.mode ?? 'attach'
}

/** managed 的模板与 config.toml 目录；省略时用 Connector 私有的空目录（不碰真实 ~/.config）。 */
export function herdrCoreConfigHome(config: ConnectorConfig): string | undefined {
  return config.native?.herdr_core?.config_home
}

/** macOS/Windows 上 `mixed` 仍只表示 Luvus + Herdr TUI（herdr-core 只支持 Linux）。 */
const LEGACY_MIXED_PROVIDERS: readonly NativeProviderKind[] = Object.freeze(['luvus', 'herdr'] as const)

// 省略选择时保留已有Luvus首次路径；单值只选自己，mixed 选这个平台支持的全部来源，两种用显式组合值。
// herdr-core 只支持 Linux（靠内核 peer 凭据），所以 mixed 在 macOS/Windows 上仍是 Luvus + Herdr TUI，与 0.10 之前相同。
// 这里只决定「新配对准备哪些来源」；已配对设备启动时只把它当筛选（native-selection.ts），不再要求与配对时一致。
export function selectedNativeProviders(
  config: ConnectorConfig,
  platform: NodeJS.Platform = process.platform
): readonly NativeProviderKind[] {
  const value: NativeProviderSelection = config.native?.provider ?? 'luvus'
  if (value === 'mixed' && platform !== 'linux') {
    return LEGACY_MIXED_PROVIDERS
  }
  const combined = NATIVE_PROVIDER_COMBINATIONS[value]
  // 单值只能是 kind 本身（组合值都在表里），不按分隔符猜测。
  return combined ?? [value as NativeProviderKind]
}

export const CLI_ERROR_CODES = [
  'invalid_config',
  'invalid_config_path',
  'config_platform_unsupported',
  'config_not_protected',
  'config_unreadable',
  'config_changed',
  'config_exists',
  'config_not_found',
  'config_home_unavailable',
  'configuration_required',
  'invalid_arguments',
  'config_role_mismatch',
  'backend_unavailable'
] as const
export class CliError extends Error {
  // 仅保存稳定错误码和退出码，异常文本不携带配置或路径。
  constructor(
    readonly code: (typeof CLI_ERROR_CODES)[number],
    readonly exitCode = 2
  ) {
    super('Rovloom command failed')
    this.name = 'CliError'
  }
}

// 只标识本机终止信号取消的引导等待；资源清理异常仍由原关闭路径独立传播。
export class CliCancelled extends Error {}

// 统一拒绝非法配置，避免将输入值混入错误消息。
function fail(): never {
  throw new CliError('invalid_config')
}

// 只接纳规范绝对路径和有界文本；实际目录信任由宿主建立。
function fixedPath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  const paths = platform === 'win32' ? win32 : posix
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    !Array.from(value).some(
      /* 识别控制字符，防止路径携带不可见的日志或解析分隔符。 */ (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) &&
    paths.isAbsolute(value) &&
    paths.normalize(value) === value &&
    paths.parse(value).root !== value
  )
}

// 只接纳无凭据的 WS/WSS origin，端点路径仍由受信宿主固定。
function gatewayUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value.includes('\\') ||
    Array.from(value).some(
      /* 拒绝 URL 中的空白和控制字符，避免规范化掩盖原输入。 */ (char) =>
        char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127
    )
  ) {
    return false
  }
  try {
    const url = new URL(value)
    // 连接地址只能是无凭据 WS/WSS origin；endpoint 路径由受信 transport 宿主固定。
    return (
      ['ws:', 'wss:'].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      (value === url.origin || value === url.origin + '/')
    )
  } catch {
    return false
  }
}

// 严格核对单份用户配置的功能分组；旧扁平字段、ref、TLS/CA路径及运行时来源均不作为用户输入。
export function parseConfig(value: unknown, platform: NodeJS.Platform = process.platform): RoleConfig {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(canonical(value)) as Record<string, unknown>
    const exact = /* 每层仅接纳明确的业务字段。 */ (
      raw: unknown,
      required: string[],
      optional: string[] = []
    ): Record<string, unknown> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return fail()
      }
      const row = raw as Record<string, unknown>
      if (
        required.some(/* 必需字段不得遗漏。 */ (key) => !Object.hasOwn(row, key)) ||
        Object.keys(row).some(/* 未知字段不能扩张能力。 */ (key) => ![...required, ...optional].includes(key))
      ) {
        return fail()
      }
      return row
    }
    const port = /* 监听端口必须是可用范围内的整数。 */ (raw: unknown): number => {
      if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > 65535) {
        return fail()
      }
      return raw as number
    }
    const listener = /* hostname 仅决定监听网卡；HTTP 代理域名无需额外配置。 */ (raw: unknown) => {
      const row = exact(raw, ['hostname', 'port'])
      const hosts = ['127.0.0.1', '::1', '0.0.0.0', '::']
      if (!hosts.includes(row.hostname as string)) {
        return fail()
      }
      return {
        hostname: row.hostname as GatewayConfig['device_hostname'],
        port: port(row.port)
      }
    }
    if (input.schema_version !== 1 || !['gateway', 'connector'].includes(input.role as string)) {
      return fail()
    }
    const data = exact(input.data, ['directory'])
    if (!fixedPath(data.directory, platform)) {
      return fail()
    }
    if (input.role === 'gateway') {
      exact(input, ['schema_version', 'role', 'data', 'mcp', 'devices', 'management'])
      const mcp = listener(input.mcp)
      const devices = listener(input.devices)
      const management = exact(input.management, ['enabled', 'port'], ['hostname'])
      if (typeof management.enabled !== 'boolean') {
        return fail()
      }
      if (management.hostname !== undefined && !['127.0.0.1', '0.0.0.0'].includes(management.hostname as string)) {
        return fail()
      }
      const managementHostname = (management.hostname ?? '127.0.0.1') as GatewayConfig['management_hostname']
      const managementPort = port(management.port)
      if (
        new Set([mcp.port, devices.port, ...(management.enabled ? [managementPort] : [])]).size !==
        (management.enabled ? 3 : 2)
      ) {
        return fail()
      }
      return Object.freeze({
        schema_version: 1,
        role: 'gateway',
        state_dir: data.directory,
        mcp: 'http',
        mcp_hostname: mcp.hostname as GatewayConfig['mcp_hostname'],
        mcp_port: mcp.port,
        device_hostname: devices.hostname,
        device_port: devices.port,
        management_enabled: management.enabled,
        management_hostname: managementHostname,
        management_port: managementPort,
        authentication_ref: 'mcp-callers'
      })
    }
    exact(input, ['schema_version', 'role', 'data', 'gateway'], ['native', 'allow_terminal_execution'])
    if (input.allow_terminal_execution !== undefined && typeof input.allow_terminal_execution !== 'boolean') {
      return fail()
    }
    const gateway = exact(input.gateway, ['url'])
    if (gateway.url !== '' && !gatewayUrl(gateway.url)) {
      return fail()
    }
    const native =
      input.native === undefined
        ? undefined
        : exact(input.native, [], ['provider', 'runtime_bin_dirs', 'agent_bin_dirs', 'herdr', 'luvus', 'herdr_core'])
    if (native) {
      if (native.herdr !== undefined) {
        const herdr = exact(native.herdr, [], ['mode', 'config_home'])
        if (
          (herdr.mode !== undefined && !['attach', 'managed'].includes(herdr.mode as string)) ||
          (herdr.config_home !== undefined && !fixedPath(herdr.config_home, platform))
        ) {
          return fail()
        }
        Object.freeze(herdr)
      }
      if (native.herdr_core !== undefined) {
        const core = exact(native.herdr_core, [], ['session', 'mode', 'config_home'])
        if (
          (core.session !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(core.session as string)) ||
          (core.mode !== undefined && !['attach', 'managed'].includes(core.mode as string)) ||
          (core.config_home !== undefined && !fixedPath(core.config_home, platform)) ||
          // 只附着时没有可用的 config_home：拒绝而不是静默忽略。
          (core.config_home !== undefined && core.mode !== 'managed')
        ) {
          return fail()
        }
        Object.freeze(core)
      }
      if (native.luvus !== undefined) {
        const luvus = exact(native.luvus, [], ['mode', 'state_root'])
        if (
          (luvus.mode !== undefined && !['attach', 'managed'].includes(luvus.mode as string)) ||
          (luvus.state_root !== undefined && !fixedPath(luvus.state_root, platform))
        ) {
          return fail()
        }
        Object.freeze(luvus)
      }
      if (
        native.provider !== undefined &&
        !NATIVE_PROVIDER_SELECTIONS.includes(native.provider as NativeProviderSelection)
      ) {
        return fail()
      }
      for (const key of ['runtime_bin_dirs', 'agent_bin_dirs']) {
        const directories = native[key]
        if (directories === undefined) {
          continue
        }
        // 数组本身及每项都按目标平台的规范绝对路径校验；非法形态一律 invalid_config。
        if (!Array.isArray(directories) || !directories.every((entry) => fixedPath(entry, platform))) {
          return fail()
        }
        try {
          binDirectories(directories, platform)
        } catch {
          return fail()
        }
        Object.freeze(directories)
      }
      Object.freeze(native)
    }
    return Object.freeze({
      schema_version: 1,
      role: 'connector',
      state_dir: data.directory,
      gateway_url: gateway.url as string,
      provider_config_refs: Object.freeze([]),
      allow_terminal_execution: pinTerminalExecution(input.allow_terminal_execution),
      ...(native ? { native } : {})
    })
  } catch {
    return fail()
  }
}

// 内部宿主视图只用于现有工厂装配；序列化时只能输出此用户分组文档，不能把内部字段写回配置。
export function configDocument(config: RoleConfig): Record<string, unknown> {
  const common = { schema_version: 1, role: config.role, data: { directory: config.state_dir } }
  return config.role === 'gateway'
    ? {
        ...common,
        mcp: {
          hostname: config.mcp_hostname,
          port: config.mcp_port
        },
        devices: { hostname: config.device_hostname, port: config.device_port },
        management: {
          enabled: config.management_enabled,
          hostname: config.management_hostname,
          port: config.management_port
        }
      }
    : {
        ...common,
        gateway: { url: config.gateway_url },
        allow_terminal_execution: resolveTerminalExecution(config.allow_terminal_execution),
        ...(config.native ? { native: config.native } : {})
      }
}

// 模板使用实际分组解析器；没有用户可配置的ref、证书路径、schema hash或运行时身份字段。
export function configTemplate(role: 'gateway', platform?: NodeJS.Platform): GatewayConfig
// Connector模板保留待输入的地址，不假定远端Gateway存在。
export function configTemplate(role: 'connector', platform?: NodeJS.Platform): ConnectorConfig
// 动态角色使用同一模板入口。
export function configTemplate(role: 'gateway' | 'connector', platform?: NodeJS.Platform): RoleConfig
// 实际模板统一经过严格解析器。
export function configTemplate(
  role: 'gateway' | 'connector',
  platform: NodeJS.Platform = process.platform
): RoleConfig {
  const base = platform === 'win32' ? 'C:\\absolute\\protected\\rovloom' : '/absolute/protected/rovloom'
  const paths = platform === 'win32' ? win32 : posix
  return parseConfig(
    role === 'gateway'
      ? {
          schema_version: 1,
          role,
          data: { directory: paths.join(base, role) },
          mcp: { hostname: '0.0.0.0', port: 9444 },
          devices: { hostname: '0.0.0.0', port: 9443 },
          management: { enabled: true, hostname: '127.0.0.1', port: 9445 }
        }
      : {
          schema_version: 1,
          role,
          data: { directory: paths.join(base, role) },
          gateway: { url: '' },
          allow_terminal_execution: true
        },
    platform
  )
}

// 普通跨平台有界JSON读取；保留重复键、编码、文件类型和精确字段校验。
export function readProtectedJson(path: string): unknown {
  if (!fixedPath(path)) {
    throw new CliError('invalid_config_path')
  }
  let bytes: Buffer | undefined
  try {
    bytes = readPrivateBytes(path, 16_384)
    const parsed = parseJson(bytes, {
      object_bytes: 16_384,
      object_depth: 16,
      object_nodes: 4096
    })
    if (!parsed.ok) {
      throw new CliError('invalid_config')
    }
    return parsed.value
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('config_not_found')
    }
    throw new CliError('config_unreadable')
  } finally {
    bytes?.fill(0)
  }
}

// 读取角色配置后继续执行精确字段校验，不从文件扩张宿主能力。
export function readConfig(path: string): RoleConfig {
  return parseConfig(readProtectedJson(path))
}
