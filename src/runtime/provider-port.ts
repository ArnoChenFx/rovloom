/**
 * provider 中性端口：Descriptor / Catalog / ProviderSession / LocalIdentityVerifier / NativeOwner。
 * 新增 provider 只实现这五个端口，装配与调用面不再按 kind 分支；本模块不解释任何原生协议。
 */
import type { Principal } from '../router.js'
import type { Connection, Session, SocketChannel } from '../transport/index.js'
import type { GatewayProviderServices } from './types.js'
import type { ProviderBinding, V2Target } from '../wire/types.js'
import { id, text } from '../wire/index.js'

/** 已审核方法档位；档位决定调用面，不按 schema 枚举开放。 */
export const PROVIDER_METHOD_TIERS = Object.freeze(['observe', 'conditional', 'control', 'host'] as const)
export type ProviderMethodTier = (typeof PROVIDER_METHOD_TIERS)[number]

/** 逐项声明保证强度，缺失即不支持；provider 不能继承另一种 provider 的保证。 */
const GUARANTEE_STRENGTH = Object.freeze({
  event_recovery: ['unavailable', 'snapshot_rebuild'] as const,
  terminal_fence: ['unavailable', 'native'] as const,
  cancel: ['unavailable', 'native'] as const,
  prompt_completion: ['unavailable', 'turn_receipt'] as const
})

export type ProviderGuarantees = Readonly<{
  event_recovery: (typeof GUARANTEE_STRENGTH)['event_recovery'][number]
  terminal_fence: (typeof GUARANTEE_STRENGTH)['terminal_fence'][number]
  cancel: (typeof GUARANTEE_STRENGTH)['cancel'][number]
  prompt_completion: (typeof GUARANTEE_STRENGTH)['prompt_completion'][number]
}>

/** 一种 provider 的静态事实：协议族、已审核方法表与逐项保证，不含实例、凭据或授权。 */
export type ProviderDescriptor = Readonly<{
  kind: string
  protocol_family: string
  /** 方法名到档位的完整审核表；表外方法一律拒绝。 */
  methods: Readonly<Record<string, ProviderMethodTier>>
  /** 逐项保证；省略表示该 provider 不通过本端口声明任何一项，调用面按最弱处理。 */
  guarantees?: ProviderGuarantees
}>

/** provider 自己交付的目录事实；公共门禁仍复验绑定、epoch、期限与身份。 */
export type ProviderCatalogPort = Readonly<{
  resolve(target: V2Target, principal: Principal): unknown | undefined
}>

/** 原会话端口；连接、channel 与公共门禁由宿主交付，provider 不建立第二条设备通道。 */
export type ProviderSessionPort = Readonly<{
  session(connection: Connection, channel: SocketChannel, services: GatewayProviderServices): Session
}>

/** 原生实例身份的本地实证事实；只描述本次核对，不产生绑定、许可或授权。 */
export type LocalIdentityFacts = Readonly<{
  kind: string
  provider_id: string
  /** 原生实例稳定标识（安装身份、服务实例或会话根）；变化即按新实例处理。 */
  instance_id: string
  binary_version: string
  /** 已安装程序的内容摘要，用十六进制；不可用时为 null，不能以版本字符串代替。 */
  binary_sha256: string | null
  config_ref: string
}>

/** 本地身份核对器只复核调用方已登记的完整 binding，不能新建或提升绑定。 */
export type LocalIdentityVerifier = Readonly<{
  verify(binding: ProviderBinding): LocalIdentityFacts
}>

/** 原生资源所有权：释放幂等，实例被替换只通知宿主结束本周期，不复活许可。 */
export type NativeOwner = Readonly<{
  release(): Promise<void>
  session_replaced?(listener: () => void): () => void
}>

/** 一种 provider 交付的全部端口；五个端口必须同时存在，缺一项不能注册。 */
export type ProviderPorts = Readonly<{
  descriptor: ProviderDescriptor
  catalog: ProviderCatalogPort
  session: ProviderSessionPort
  identity: LocalIdentityVerifier
  owner: NativeOwner
}>

export type ProviderPortRegistry = Readonly<{
  kinds(): readonly string[]
  /** 未注册的 kind 明确拒绝，不返回空端口。 */
  ports(kind: string): ProviderPorts
  /** 档位来自已审核方法表；表外方法返回 undefined。 */
  tier(kind: string, method: string): ProviderMethodTier | undefined
}>

const TIERS = new Set<string>(PROVIDER_METHOD_TIERS)

/** 档位必须是已定义枚举值；字符串真值不能冒充已审核档位。 */
function methodTier(value: unknown, method: string): ProviderMethodTier {
  if (typeof value !== 'string' || !TIERS.has(value)) {
    throw new TypeError(`provider_method_tier_invalid:${method}`)
  }
  return value as ProviderMethodTier
}

/** 保证强度限定在闭合集合内，避免自由文本承诺原生不具备的能力。 */
function guarantees(input: unknown): ProviderGuarantees {
  const value = input as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('provider_guarantees_invalid')
  }
  const keys = Object.keys(GUARANTEE_STRENGTH) as (keyof ProviderGuarantees)[]
  if (Object.keys(value).length !== keys.length || keys.some(/** 四项必须逐项声明。 */ (key) => !(key in value))) {
    throw new TypeError('provider_guarantees_invalid')
  }
  const result = {} as Record<keyof ProviderGuarantees, string>
  for (const key of keys) {
    const allowed: readonly string[] = GUARANTEE_STRENGTH[key]
    const level = value[key]
    if (typeof level !== 'string' || !allowed.includes(level)) {
      throw new TypeError(`provider_guarantee_invalid:${key}`)
    }
    result[key] = level
  }
  return Object.freeze(result) as ProviderGuarantees
}

/** 方法表逐项复制并冻结；注册后修改调用方对象不影响已注册档位。 */
function methods(input: unknown): Readonly<Record<string, ProviderMethodTier>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('provider_methods_invalid')
  }
  const entries = Object.entries(input as Record<string, unknown>)
  if (!entries.length) {
    throw new TypeError('provider_methods_empty')
  }
  const table: Record<string, ProviderMethodTier> = {}
  for (const [method, value] of entries) {
    text(method, 256)
    table[method] = methodTier(value, method)
  }
  return Object.freeze(table)
}

/** 一种 provider 的端口只登记一次；重复 kind 直接拒绝，后写不能覆盖先登记事实。 */
function port(kind: string, input: ProviderPorts): ProviderPorts {
  const descriptor = input.descriptor
  text(descriptor.protocol_family, 128)
  if (
    !input.catalog ||
    typeof input.catalog.resolve !== 'function' ||
    !input.session ||
    typeof input.session.session !== 'function' ||
    !input.identity ||
    typeof input.identity.verify !== 'function' ||
    !input.owner ||
    typeof input.owner.release !== 'function'
  ) {
    throw new TypeError('provider_port_incomplete')
  }
  return Object.freeze({
    descriptor: Object.freeze({
      kind,
      protocol_family: descriptor.protocol_family,
      methods: methods(descriptor.methods),
      ...(descriptor.guarantees ? { guarantees: guarantees(descriptor.guarantees) } : {})
    }),
    catalog: Object.freeze({ resolve: input.catalog.resolve }),
    session: Object.freeze({ session: input.session.session }),
    identity: Object.freeze({ verify: input.identity.verify }),
    owner: Object.freeze({
      release: input.owner.release,
      ...(input.owner.session_replaced ? { session_replaced: input.owner.session_replaced } : {})
    })
  })
}

/**
 * 注册固定已实现端口。装配只按 kind 取端口，因此新增 provider 不改调用面；
 * 本层不做发现、动态加载或授权，也不持有实例资源。
 */
export function createProviderPortRegistry(input: readonly ProviderPorts[]): ProviderPortRegistry {
  if (!Array.isArray(input) || !input.length) {
    throw new TypeError('provider_port_registry_empty')
  }
  const registered = new Map<string, ProviderPorts>()
  for (const entry of input) {
    const kind = entry?.descriptor?.kind
    if (typeof kind !== 'string' || !kind) {
      throw new TypeError('provider_descriptor_kind_invalid')
    }
    id(kind)
    if (registered.has(kind)) {
      throw new TypeError(`provider_kind_duplicate:${kind}`)
    }
    registered.set(kind, port(kind, entry))
  }
  const kinds = Object.freeze([...registered.keys()])
  /** 未注册 kind 不返回空端口，避免调用面把缺失当作可执行。 */
  function ports(kind: string): ProviderPorts {
    const value = registered.get(kind)
    if (!value) {
      throw new TypeError(`provider_kind_unregistered:${typeof kind === 'string' ? kind : typeof kind}`)
    }
    return value
  }
  return Object.freeze({
    kinds: /** 固定注册顺序，不随查询变化。 */ () => kinds,
    ports,
    tier: /** 档位只读自已审核表，表外方法不在本层解释。 */ (kind: string, method: string) => {
      const table = ports(kind).descriptor.methods
      return Object.hasOwn(table, method) ? table[method] : undefined
    }
  })
}
