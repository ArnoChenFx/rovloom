// 将真实Luvus目录接到当前Store绑定与双端read授权；目录描述不生成执行、Owner或原生身份许可。
import { createLuvusCatalog, LuvusAdapterError } from '../connector/luvus/index.js'
import type { NativeContractRecord } from '../integration/luvus-wire.js'
import type { TrustedNativeContext } from '../native-contract/index.js'
import type { Principal, LocalPolicies } from '../router.js'
import type { Store } from '../store.js'
import {
  boundedJson,
  contractRef,
  hash,
  LIMITS,
  providerScopeAllowed,
  validatePolicies,
  WireError
} from '../wire/index.js'
import type { AttemptBinding, JsonObject, ProviderBinding, ProviderPolicy, V2Target } from '../wire/types.js'
import { FacadeServiceError } from './types.js'
import { terminalExecutionCatalog } from '../connector/terminal-execution.js'
import { luvusParameterHelp } from '../runtime/luvus-parameter-help.js'

export type GatewayCatalogSource = Readonly<{
  record: NativeContractRecord
  source: TrustedNativeContext
  local_provider: ProviderBinding
  expires_at: number
}>
export interface GatewayCatalogProvider {
  kind?: 'luvus'
  // 从受保护registry返回独立认证的在线能力与安装契约，不从工具参数或session listing构造source。
  resolve(target: V2Target, principal: Principal): GatewayCatalogSource | undefined
}
export type ProviderCatalogSource = Readonly<{
  target: V2Target
  local_provider: ProviderBinding
  contract_ref: string
  capability_revision: string
  expires_at: number
  methods: readonly JsonObject[]
  describe(method: string): JsonObject
}>
export interface ProviderCatalogProvider {
  kind: 'provider'
  // owner从当前原生安装/能力提供目录；目录元数据不建立Wire执行许可。
  resolve(target: V2Target, principal: Principal): ProviderCatalogSource | undefined
}
export interface CompositeGatewayCatalogProvider {
  kind: 'mixed'
  // 只选择原目录端口，实际授权、期限与schema仍由原authorizer复验。
  select(target: V2Target): GatewayCatalogProvider | ProviderCatalogProvider | undefined
}
export type GatewayCatalog = GatewayCatalogProvider | ProviderCatalogProvider | CompositeGatewayCatalogProvider
type CatalogOptions = {
  store: Store
  principal: Principal
  // 目录扫描及describe再次核对当前身份，不能保留已经撤销的政策快照。
  currentPrincipal(): Principal
  localPolicies: LocalPolicies
  provider: GatewayCatalogProvider
  target: V2Target
  expected_binding_revision: number
  terminalExecutionState?(binding: ProviderBinding): boolean | undefined
}

// 只在当前精确binding和可信来源有效时创建目录，沿用原生validator并按授权后的集合分页。
export function authorizedLuvusCatalog(options: CatalogOptions) {
  const { store, target, principal } = options
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
  if (binding.kind !== 'luvus' || target.profile !== 'session') {
    throw new FacadeServiceError('unsupported')
  }
  /** 同步读取本 epoch 的本地开关；未知和违规异步值不能作为启用证明。 */
  function terminalState(): boolean | undefined {
    const value = options.terminalExecutionState?.(binding!)
    if (value !== undefined && typeof value !== 'boolean') {
      void Promise.resolve(value).catch(/** 异步来源不满足同步契约，拒绝仍须被观察。 */ () => {})
      throw new FacadeServiceError('contract_unavailable')
    }
    return value
  }
  const terminal = terminalState()
  let stamp: string | undefined
  // 每次fresh检查重新读取受信来源与Store fence，不借用最近连接或其它provider的能力。
  const current = /* 缺能力来源保持拒绝；消息里的authenticated/source_verified不能进入此接口。 */ () => {
    if (terminalState() !== terminal) {
      throw new FacadeServiceError('contract_unavailable')
    }
    const provider = store.provider(target.machine_id, target.provider_id)
    if (
      !provider ||
      boundedJson(options.currentPrincipal()) !== boundedJson(principal) ||
      boundedJson(options.localPolicies(target)) !== boundedJson(local) ||
      boundedJson(provider) !== boundedJson(binding)
    ) {
      throw new FacadeServiceError('contract_unavailable')
    }
    const resolved = options.provider.resolve(target, principal)
    if (!resolved) {
      throw new FacadeServiceError('backend_unavailable')
    }
    const source = resolved.source
    const native = source.binding
    const origin = resolved.record.wire.source
    const ref = contractRef(origin)
    const currentStamp = hash(
      boundedJson(
        {
          ref,
          terminal_execution: terminal ?? null,
          capabilities: resolved.record.capabilities,
          capability_revision: resolved.record.capability_revision,
          compiled: resolved.record.compiled.identity,
          expires_at: resolved.expires_at
        },
        LIMITS.object_bytes
      )
    )
    if (stamp !== undefined && stamp !== currentStamp) {
      throw new FacadeServiceError('contract_unavailable')
    }
    stamp = currentStamp
    const nativeTarget = { ...native.target, provider_id: native.provider_id }
    if (
      source.authenticated !== true ||
      source.source_verified !== true ||
      native.kind !== 'luvus' ||
      boundedJson(nativeTarget) !== boundedJson(target) ||
      native.binding_revision !== binding.binding_revision ||
      native.contract_source_ref !== ref ||
      origin.provider_kind !== 'luvus' ||
      resolved.record.compiled.identity.binary_sha256 !== origin.binary_sha256 ||
      resolved.record.compiled.identity.schema_sha256 !== origin.schema_sha256 ||
      boundedJson(resolved.local_provider) !== boundedJson(binding) ||
      native.caller_policy_revision !== principal.policy.revision ||
      native.local_policy_revision !== local.revision ||
      native.capability_revision !== resolved.record.capability_revision ||
      native.classification_revision !== resolved.record.wire.source.classification_revision ||
      native.server_generation !== resolved.record.wire.source.runtime_generation ||
      native.recovery_generation !== store.generation()
    ) {
      throw new FacadeServiceError('contract_unavailable')
    }
    store.assertConnection({
      machine_id: target.machine_id,
      recovery_generation: native.recovery_generation,
      connection_epoch: native.connection_epoch
    })
    // 来源回调可触发同步撤权或时钟推进；返回前重新核对，不能只检查回调之前的快照。
    if (terminalState() !== terminal) {
      throw new FacadeServiceError('contract_unavailable')
    }
    const currentPrincipal = options.currentPrincipal()
    const currentLocal = options.localPolicies(target)
    const currentProvider = store.provider(target.machine_id, target.provider_id)
    const now = store.clock()
    if (
      boundedJson(currentPrincipal) !== boundedJson(principal) ||
      boundedJson(currentLocal) !== boundedJson(local) ||
      boundedJson(currentProvider) !== boundedJson(binding) ||
      !Number.isSafeInteger(resolved.expires_at) ||
      now >= resolved.expires_at
    ) {
      throw new FacadeServiceError('contract_unavailable')
    }
    return resolved
  }
  try {
    const resolved = current()
    const ref = contractRef(resolved.record.wire.source)
    const catalog = createLuvusCatalog(resolved.record.compiled, resolved.record.capabilities, resolved.source, {
      now: /* 使用实际Store的单调门禁，不让目录查询续期原能力。 */ () => store.clock(),
      current: /* 原生catalog对每次list/describe重验完整来源绑定。 */ () => current().source,
      expires_at: resolved.expires_at
    })
    const methods: JsonObject[] = []
    let scanned = 0
    let cursor: string | undefined
    do {
      const page = catalog.list({ limit: 100, ...(cursor ? { cursor } : {}) })
      scanned += page.methods.length
      if (scanned > 256) {
        throw new FacadeServiceError('busy')
      }
      for (const method of page.methods) {
        const entry = terminalExecutionCatalog('luvus', method.method, terminal)
        if (
          entry.visible &&
          providerScopeAllowed({ target } as AttemptBinding, method.method, 'read', { caller: principal.policy, local })
        ) {
          methods.push(
            JSON.parse(
              boundedJson({
                ...method,
                contract_ref: ref,
                ...(entry.details ? { terminal_execution: entry.details } : {})
              })
            ) as JsonObject
          )
        }
      }
      cursor = page.next_cursor ?? undefined
    } while (cursor)
    return {
      methods,
      scope: {
        contract_ref: ref,
        source: resolved.source.binding,
        capability_revision: resolved.record.capability_revision,
        expires_at: resolved.expires_at,
        capability_digest: stamp!,
        local
      },
      describe: /* 精确方法必须位于当前授权集合；原生read标签不自动授予任何方法。 */ (method: string): JsonObject => {
        if (
          !methods.some(/* 只接受同一授权目录中的精确方法名，不做前缀或模糊授权。 */ (row) => row.method === method)
        ) {
          throw new FacadeServiceError('not_found')
        }
        try {
          const entry = terminalExecutionCatalog('luvus', method, terminal)
          const parameterHelp = luvusParameterHelp(method)
          return JSON.parse(
            boundedJson({
              ...catalog.describe(method),
              contract_ref: ref,
              ...(parameterHelp ? { parameter_help: parameterHelp } : {}),
              ...(entry.details ? { terminal_execution: entry.details } : {})
            })
          ) as JsonObject
        } catch (error) {
          if (error instanceof LuvusAdapterError || error instanceof WireError) {
            throw new FacadeServiceError('contract_unavailable')
          }
          throw error
        }
      }
    }
  } catch (error) {
    if (error instanceof LuvusAdapterError || error instanceof WireError) {
      throw new FacadeServiceError('contract_unavailable')
    }
    throw error
  }
}
