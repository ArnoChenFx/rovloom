// 已配对 Connector 启动时的来源筛选：配对记录决定「有哪些来源」，`native.provider` 只决定本次启动其中哪几个。
// 启动不再要求当前 native 配置与配对时逐字相同——配置文件本来就是给用户改的；这里只处理三件事：
// 1. 筛选：只启动「配对过且被选中」的来源；点名了却从未配对的来源要 join 才能加入，提示后跳过，不当作错误。
// 2. 配对时固化的字段（实例、二进制与目录）改了：沿用配对值并点名提示，不拒绝。
// 3. herdr-core managed 按 session / mode / config_home 推导套接字与目录，用改过的值会拉起另一个 core，
//    而配对钉住的是原来那个：这三项沿用配对时的值。
import { selectedNativeProviders, type ConnectorConfig, type NativeProviderKind } from './config.js'

export type NativeSelection = Readonly<{
  /** 配对过且被选中，本次启动。 */
  active: readonly NativeProviderKind[]
  /** 配对过但本次没被选中（用户用 native.provider 缩小了范围），不启动，不提示。 */
  idle: readonly NativeProviderKind[]
  /** 用户点名选了、但这台设备从未配对的来源：需要用新码 join 才能加入。`mixed` 是「本平台全部」，不算点名。 */
  unpaired: readonly NativeProviderKind[]
}>

/** `paired` 是配对记录里实际有的来源；省略 `native.provider` 就是全部已配对的来源。 */
export function selectNativeProviders(
  config: ConnectorConfig,
  paired: readonly NativeProviderKind[],
  platform: NodeJS.Platform = process.platform
): NativeSelection {
  const provider = config.native?.provider
  if (provider === undefined) {
    return Object.freeze({ active: paired, idle: [], unpaired: [] })
  }
  const selected = selectedNativeProviders(config, platform)
  return Object.freeze({
    active: paired.filter(/** 配对过且被选中。 */ (kind) => selected.includes(kind)),
    idle: paired.filter(/** 配对过但没被选中。 */ (kind) => !selected.includes(kind)),
    unpaired: provider === 'mixed' ? [] : selected.filter(/** 点名选了却没配对。 */ (kind) => !paired.includes(kind))
  })
}

type Settings = Readonly<Record<string, unknown>>

const record = (value: unknown): Settings | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : undefined

/** 取路径上的值，缺省用生效默认值：省略与显式写默认值相同。 */
function effective(settings: Settings | undefined, path: readonly string[], fallback: unknown): unknown {
  let value: unknown = settings
  for (const key of path) {
    value = record(value)?.[key]
  }
  return value ?? fallback
}

/** 配对时固化进该来源本地配置的 native 字段（路径与省略时的生效值）；改了要重新 join 才能生效。 */
const FIXED_AT_PAIRING: Readonly<Record<NativeProviderKind, readonly (readonly [readonly string[], unknown])[]>> = {
  luvus: [
    [['luvus', 'mode'], 'attach'],
    [['luvus', 'state_root'], undefined],
    [['runtime_bin_dirs'], undefined],
    [['agent_bin_dirs'], undefined]
  ],
  herdr: [
    [['herdr', 'mode'], 'attach'],
    [['herdr', 'config_home'], undefined],
    [['runtime_bin_dirs'], undefined],
    [['agent_bin_dirs'], undefined]
  ],
  'herdr-core': [
    [['herdr_core', 'session'], 'default'],
    [['herdr_core', 'mode'], 'attach'],
    [['herdr_core', 'config_home'], undefined]
  ]
}

/** 配对后又被改动、但仍沿用配对值的字段名（按生效值比较）。只输出字段名，不输出取值。 */
export function changedPairedSettings(
  kind: NativeProviderKind,
  pairedSettings: unknown,
  config: ConnectorConfig
): readonly string[] {
  const before = record(pairedSettings)
  const now = record(config.native)
  return FIXED_AT_PAIRING[kind]
    .filter(
      /** 生效值不同才算改动。 */ ([path, fallback]) =>
        JSON.stringify(effective(before, path, fallback)) !== JSON.stringify(effective(now, path, fallback))
    )
    .map(/** 与配置文件里的写法一致。 */ ([path]) => 'native.' + path.join('.'))
}

/** herdr-core 的 session / mode / config_home 沿用配对时的值；其它 native 设置保持当前配置（含它的 bin 目录）。 */
export function pinHerdrCoreInstance(config: ConnectorConfig, pairedSettings: unknown): ConnectorConfig {
  const before = record(record(pairedSettings)?.herdr_core)
  const text = (key: string): string | undefined =>
    typeof before?.[key] === 'string' ? (before[key] as string) : undefined
  const session = text('session')
  const mode = text('mode')
  const home = text('config_home')
  const pinned = {
    ...(session === undefined ? {} : { session }),
    ...(mode === 'attach' || mode === 'managed' ? { mode } : {}),
    ...(home === undefined ? {} : { config_home: home })
  }
  const { herdr_core: _live, ...rest } = config.native ?? {}
  return Object.freeze({
    ...config,
    native: Object.freeze({ ...rest, ...(Object.keys(pinned).length ? { herdr_core: Object.freeze(pinned) } : {}) })
  }) as ConnectorConfig
}
