// 公共 MCP 目录门禁：只做身份/设备范围、绑定、分页与元数据投影；方法清单和原生描述由各 provider 提供。
import { isDeepStrictEqual } from 'node:util'
import type { Store } from '../store.js'
import type { Principal } from '../router.js'
import { boundedJson, contractRef, hash, LIMITS, validateContractSource } from '../wire/index.js'
import type { JsonObject, ProviderBinding, V2Target } from '../wire/types.js'
import { FacadeServiceError } from './types.js'
import { terminalExecutionCatalog } from '../connector/terminal-execution.js'
import type { ProviderMetadata } from './types.js'

/**
 * provider 自己交付的目录事实。这里没有任何 provider 名称、方法分类或参数规则：
 * 方法清单、原生描述和元数据都由该 provider 的安装契约与在线能力解释。
 */
export type ProviderCatalogSource = Readonly<{
  target: V2Target
  local_provider: ProviderBinding
  contract_ref: string
  /** 可选的原生契约元数据，必须与 contract_ref 一致；缺失时不推断版本。 */
  contract?: { source: import('../wire/types.js').ContractSource; support_status: 'candidate' | 'validated' }
  capability_revision: string
  expires_at: number
  methods: readonly JsonObject[]
  /**
   * provider 自己对本次目录事实的摘要（如安装契约身份、在线能力内容）。
   * 公共门禁只用它判断"同一查询内来源是否变化"，不解释其内容。
   */
  digest?: string
  describe(method: string): JsonObject
}>

export interface ProviderCatalogProvider {
  kind: 'provider'
  // owner 从当前原生安装/能力提供目录；目录元数据不建立 Wire 执行许可。
  resolve(target: V2Target, principal: Principal): ProviderCatalogSource | undefined
}

export interface CompositeGatewayCatalogProvider {
  kind: 'mixed'
  // 只选择原目录端口，实际授权、期限与 schema 仍由原 authorizer 复验。
  select(target: V2Target): ProviderCatalogProvider | undefined
}

export type GatewayCatalog = ProviderCatalogProvider | CompositeGatewayCatalogProvider

/** 选中本次查询的 provider 目录端口；组合目录只做精确目标选择。 */
export function selectCatalogProvider(catalog: GatewayCatalog, target: V2Target): ProviderCatalogProvider | undefined {
  return catalog.kind === 'mixed' ? catalog.select(target) : catalog
}

export type AuthorizedCatalogOptions = Readonly<{
  store: Store
  principal: Principal
  /** 目录扫描及 describe 再次核对当前身份，不能保留已经撤销的设备范围。 */
  currentPrincipal(): Principal
  provider: ProviderCatalogProvider
  target: V2Target
  expected_binding_revision: number
  terminalExecutionState?(binding: ProviderBinding): boolean | undefined
}>

/**
 * 共用门禁：目标/read、当前主体、固定绑定、epoch、终端开关与期限逐次复核，
 * 再按授权后的集合分页。原生字段一律来自 provider 的 resolve 结果。
 */
export function authorizedCatalog(options: AuthorizedCatalogOptions) {
  const { store, principal, target } = options
  const binding = store.provider(target.machine_id, target.provider_id)
  if (!binding) {
    throw new FacadeServiceError('not_found')
  }
  if (binding.binding_revision !== options.expected_binding_revision) {
    throw new FacadeServiceError('binding_revision_conflict')
  }
  if (!binding.enabled) {
    throw new FacadeServiceError('unavailable')
  }
  /** 只接受原连接的同步布尔观察；异步结果既不启用目录也不留下晚拒绝。 */
  function terminalState(): boolean | undefined {
    const value = options.terminalExecutionState?.(binding!)
    if (value !== undefined && typeof value !== 'boolean') {
      void Promise.resolve(value).catch(/** 消费违规异步来源的拒绝。 */ () => {})
      throw new FacadeServiceError('contract_unavailable')
    }
    return value
  }
  const terminal = terminalState()
  const generation = store.generation()
  const check = /* owner 回调前后重读同一现行主体/配置，不能沿用已改变的目录快照。 */ () => {
    if (terminalState() !== terminal) {
      throw new FacadeServiceError('contract_unavailable')
    }
    if (
      store.generation() !== generation ||
      !isDeepStrictEqual(options.currentPrincipal(), principal) ||
      !isDeepStrictEqual(store.provider(target.machine_id, target.provider_id), binding)
    ) {
      throw new FacadeServiceError('contract_unavailable')
    }
  }
  let stamp: string | undefined
  let expiresAt: number | undefined
  const current = /* callback 必须返回当前真实目录，缺失时不生成空成功目录。 */ () => {
    check()
    const resolved = options.provider.resolve(structuredClone(target), structuredClone(principal))
    check()
    if (!resolved) {
      throw new FacadeServiceError('backend_unavailable')
    }
    const describe = resolved.describe
    const source = JSON.parse(
      boundedJson(
        {
          target: resolved.target,
          local_provider: resolved.local_provider,
          contract_ref: resolved.contract_ref,
          ...(resolved.contract ? { contract: resolved.contract } : {}),
          capability_revision: resolved.capability_revision,
          expires_at: resolved.expires_at,
          methods: resolved.methods,
          ...(resolved.digest !== undefined ? { digest: resolved.digest } : {})
        },
        LIMITS.object_bytes
      )
    ) as ProviderCatalogSource
    check()
    if (
      typeof describe !== 'function' ||
      !isDeepStrictEqual(source.target, target) ||
      !isDeepStrictEqual(source.local_provider, binding) ||
      typeof source.contract_ref !== 'string' ||
      !/^[a-f0-9]{64}$/.test(source.contract_ref) ||
      typeof source.capability_revision !== 'string' ||
      !source.capability_revision.length ||
      !Number.isSafeInteger(source.expires_at) ||
      store.clock() >= Math.min(source.expires_at, expiresAt ?? source.expires_at) ||
      !Array.isArray(source.methods) ||
      source.methods.length > 256
    ) {
      throw new FacadeServiceError('contract_unavailable')
    }
    if (source.contract) {
      validateContractSource(source.contract.source)
      if (
        source.contract.source.provider_kind !== binding.kind ||
        !['candidate', 'validated'].includes(source.contract.support_status) ||
        contractRef(source.contract.source) !== source.contract_ref
      ) {
        throw new FacadeServiceError('contract_unavailable')
      }
    }
    // fresh 目录视图可以有不同观察期限，但同一次读取始终受最早取得的期限约束。
    expiresAt = Math.min(expiresAt ?? source.expires_at, source.expires_at)
    const methods = JSON.parse(boundedJson(source.methods, LIMITS.object_bytes)) as JsonObject[]
    const names = methods.map(/* 原生方法名逐项保留，拒绝重复/畸形目录。 */ (method) => method.method)
    if (
      new Set(names).size !== names.length ||
      names.some(
        /* 与现行 MCP method 字段采用同一有界文本形状。 */ (method) =>
          typeof method !== 'string' || method.length < 1 || method.length > 256 || !/\S/.test(method)
      )
    ) {
      throw new FacadeServiceError('contract_unavailable')
    }
    const next = hash(
      boundedJson(
        {
          target,
          binding,
          terminal_execution: terminal ?? null,
          contract_ref: source.contract_ref,
          contract: source.contract ?? null,
          revision: source.capability_revision,
          digest: source.digest ?? null,
          methods
        },
        LIMITS.object_bytes
      )
    )
    if (stamp !== undefined && stamp !== next) {
      throw new FacadeServiceError('contract_unavailable')
    }
    stamp = next
    return { source, methods, describe: describe.bind(resolved) }
  }
  const { source, methods } = current()
  const visible = methods.filter(
    /* 不把原生目录中的其它方法作为隐式授权。 */ (method) =>
      terminalExecutionCatalog(binding.kind, method.method as string, terminal).visible
  )
  current()
  return {
    metadata: metadataOf(source) as ProviderMetadata,
    methods: visible.map<JsonObject>(
      /* 契约引用取同一 owner 快照，不使用条目自报的另一引用。 */ (method) => {
        const entry = terminalExecutionCatalog(binding.kind, method.method as string, terminal)
        return {
          ...method,
          contract_ref: source.contract_ref,
          ...(entry.details ? { terminal_execution: entry.details } : {})
        }
      }
    ),
    scope: {
      generation,
      contract_ref: source.contract_ref,
      capability_revision: source.capability_revision,
      capability_digest: stamp!
    },
    expires_at: expiresAt!,
    describe: /* 原生描述返回前再复验当前目录、身份与原绑定。 */ (method: string): JsonObject => {
      if (!visible.some(/* 精确匹配已可见方法，不按前缀开放。 */ (entry) => entry.method === method)) {
        throw new FacadeServiceError('not_found')
      }
      const active = current()
      const description = JSON.parse(boundedJson(active.describe(method))) as JsonObject
      current()
      if (!description || typeof description !== 'object' || Array.isArray(description)) {
        throw new FacadeServiceError('contract_unavailable')
      }
      const entry = terminalExecutionCatalog(binding.kind, method, terminal)
      return {
        ...description,
        method,
        contract_ref: source.contract_ref,
        ...(entry.details ? { terminal_execution: entry.details } : {})
      }
    }
  }
}

/** 元数据只读已核验契约来源；未验证时保持 unavailable，不为未知版本填默认值。 */
function metadataOf(source: ProviderCatalogSource): ProviderMetadata {
  const validated = source.contract?.support_status === 'validated'
  return {
    schema_sha256: validated ? source.contract!.source.schema_sha256 : null,
    native_version:
      validated && source.contract!.source.binary_version !== 'unavailable'
        ? source.contract!.source.binary_version
        : null,
    schema_status: validated ? 'validated' : 'unavailable'
  }
}
