// provider中性目录只投影宿主的原生方法描述；执行仍交同一runtime/Wire，不从目录建立许可。
import { isDeepStrictEqual } from 'node:util'
import type { Store } from '../store.js'
import type { LocalPolicies, Principal } from '../router.js'
import {
  boundedJson,
  contractRef,
  hash,
  LIMITS,
  providerScopeAllowed,
  validateContractSource,
  validatePolicies
} from '../wire/index.js'
import type { AttemptBinding, JsonObject, ProviderBinding, ProviderPolicy, V2Target } from '../wire/types.js'
import type { ProviderCatalogProvider, ProviderCatalogSource } from './native-catalog.js'
import { FacadeServiceError } from './types.js'
import { terminalExecutionCatalog } from '../connector/terminal-execution.js'

// 复用现行目录的目标/read、当前主体和固定绑定门禁，原生字段由各provider自己的安装/schema解释。
export function authorizedProviderCatalog(options: {
  store: Store
  principal: Principal
  currentPrincipal(): Principal
  localPolicies: LocalPolicies
  provider: ProviderCatalogProvider
  target: V2Target
  expected_binding_revision: number
  terminalExecutionState?(binding: ProviderBinding): boolean | undefined
}) {
  const { store, principal, target } = options
  const local = JSON.parse(boundedJson(options.localPolicies(target))) as ProviderPolicy
  validatePolicies({ caller: principal.policy, local })
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
  const check = /* owner回调前后重读同一现行主体/配置，不能沿用已改变的目录快照。 */ () => {
    if (terminalState() !== terminal) {
      throw new FacadeServiceError('contract_unavailable')
    }
    if (
      store.generation() !== generation ||
      !isDeepStrictEqual(options.currentPrincipal(), principal) ||
      !isDeepStrictEqual(options.localPolicies(target), local) ||
      !isDeepStrictEqual(store.provider(target.machine_id, target.provider_id), binding)
    ) {
      throw new FacadeServiceError('contract_unavailable')
    }
  }
  let stamp: string | undefined
  let expiresAt: number | undefined
  const current = /* callback必须返回当前真实目录，缺失时不生成空成功目录。 */ () => {
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
          methods: resolved.methods
        },
        LIMITS.object_bytes
      )
    ) as Omit<ProviderCatalogSource, 'describe'>
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
    // fresh目录视图可以有不同观察期限，但同一次读取始终受最早取得的期限约束。
    expiresAt = Math.min(expiresAt ?? source.expires_at, source.expires_at)
    const methods = JSON.parse(boundedJson(source.methods, LIMITS.object_bytes)) as JsonObject[]
    const names = methods.map(/* 原生方法名逐项保留，拒绝重复/畸形目录。 */ (method) => method.method)
    if (
      new Set(names).size !== names.length ||
      names.some(
        /* 与现行MCP method字段采用同一有界文本形状。 */ (method) =>
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
  const allowed = /* 同一完整Target和方法继续使用现有双端read交集。 */ (method: string) =>
    providerScopeAllowed({ target } as AttemptBinding, method, 'read', { caller: principal.policy, local })
  const visible = methods.filter(
    /* 不把原生目录中的其它方法作为隐式授权。 */ (method) =>
      allowed(method.method as string) &&
      terminalExecutionCatalog(binding.kind, method.method as string, terminal).visible
  )
  current()
  return {
    metadata: {
      schema_sha256: source.contract?.support_status === 'validated' ? source.contract.source.schema_sha256 : null,
      native_version:
        source.contract?.support_status === 'validated' && source.contract.source.binary_version !== 'unavailable'
          ? source.contract.source.binary_version
          : null,
      schema_status: source.contract?.support_status === 'validated' ? ('validated' as const) : ('unavailable' as const)
    },
    methods: visible.map<JsonObject>(
      /* 契约引用取同一owner快照，不使用条目自报的另一引用。 */ (method) => {
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
      capability_digest: stamp!,
      local
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
