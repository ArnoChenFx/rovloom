// 装配唯一账本、路由、认证设备通道及原请求结果门禁；不实现 HTTP/MCP 协议或管理写服务。
import { Router } from '../router.js'
import { GatewayError } from '../contracts.js'
import { createGateway, createDeviceLifecycleAdapter } from '../transport/index.js'
import { createProviderResultAccess } from './results.js'
import { closeSession, providerHealth, ready, OFFER } from '../transport/common.js'
import type { Session, Readiness, Adapter } from '../transport/common.js'
import type { TrustedAttempt } from '../integration/luvus-wire.js'
import type { Call } from '../store.js'
import type { JsonObject, ProviderBinding, ProviderSnapshot, V2Target } from '../wire/types.js'
import { boundedJson, contractRef, fail, LIMITS, uint, validateProvider, validateTarget } from '../wire/index.js'
import { createTrustedRequestScope } from './request-scope.js'
import { createLuvusRequestPreflight, luvusValidation } from './request-preflight.js'
import { composeGatewaySessions, type ProviderSessionGroup } from './provider-sessions.js'
import type {
  GatewayRuntimeOptions,
  ProviderGatewayRuntimeOptions,
  RuntimeCallInput,
  RuntimeCatalogProvider,
  RemoteLuvusRuntimeProvider,
  RuntimeProvider,
  RuntimeProviderBinding
} from './types.js'

/** 在受信宿主显式交付已打开资源后启动常驻 listener；客户端寿命与角色寿命无关。 */
export async function createGatewayRuntime(options: GatewayRuntimeOptions) {
  return assembleGateway(options)
}

/** 由 provider 交付已审 Wire 会话，共用唯一身份、账本、路由和结果读取服务。 */
export async function createProviderGatewayRuntime(options: ProviderGatewayRuntimeOptions) {
  return assembleGateway(options)
}

/** 两种装配入口共用同一常驻生命周期；通用入口不解释 provider 原生协议。 */
async function assembleGateway(options: GatewayRuntimeOptions | ProviderGatewayRuntimeOptions) {
  const hostOptions = 'session' in options ? options : undefined
  const nativeOptions = 'session' in options ? undefined : options
  const hosted = hostOptions ? [hostOptions] : (nativeOptions!.hosted ?? [])
  const hostedNames = new Set<string>()
  const configured = [
    ...(nativeOptions?.providers ?? []).map(
      /** 原Luvus条目标记为原生注册表来源。 */ (provider) => ({ provider, hosted: false })
    ),
    ...hosted.flatMap(
      /** 展开中性会话组，保留每个原provider条目。 */ (group) =>
        group.providers.map(/** 只标记宿主归属，不重建条目的来源或预检。 */ (provider) => ({ provider, hosted: true }))
    )
  ]
  const store = options.lifecycle.store
  const scope = createTrustedRequestScope(options.identities)
  const router = new Router(store, localPolicies)
  const providers = new Map<string, RuntimeProviderBinding>()
  const nativeProviders = new Map<string, RuntimeProvider>()
  const remoteProviders = new Map<string, RemoteLuvusRuntimeProvider>()
  const machineModes = new Map<string, 'local' | 'remote'>()
  const contracts = new Map<string, RuntimeProvider['contract']>()
  let sessionCleanupFailed = false
  let closing: Promise<void> | undefined
  let transport: ReturnType<typeof createGateway> | undefined
  let finish!: () => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>(
    /** 只有显式角色关闭完成才终止常驻生命周期。 */
    (resolve, reject) => {
      finish = resolve
      rejectClosed = reject
    }
  )
  void closed.catch(/** 关闭失败始终被观察，调用者仍从同一 Promise 取得失败结果。 */ () => {})
  /** 在外部政策回调前后都核对关闭 fence，并复制其返回值，不能放行回调中的同步关闭。 */
  function localPolicies(target: V2Target) {
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    const policy = JSON.parse(boundedJson(options.localPolicies(structuredClone(target)))) as ReturnType<
      typeof options.localPolicies
    >
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    return policy
  }
  /** 使用完整机器/provider 键，不按名称或最近上线实例选目标。 */
  function key(target: Pick<V2Target, 'machine_id' | 'provider_id'>): string {
    return target.machine_id + '/' + target.provider_id
  }
  /** 复核当前 canonical binding，不把启动配置变成隐式注册、重绑或授权。 */
  function localProvider(target: V2Target): ProviderBinding | undefined {
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    const entry = providers.get(key(target))
    if (!entry || boundedJson(target) !== boundedJson(entry.target)) {
      return undefined
    }
    const configured = entry.binding
    const current = store.provider(target.machine_id, target.provider_id)
    return configured && current && boundedJson(configured) === boundedJson(current)
      ? structuredClone(configured)
      : undefined
  }
  /** 所有公开操作均从当前请求取身份，关闭开始即拒绝新操作。 */
  function principal() {
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    const current = scope.principal()
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    return current
  }
  /** 按持久原请求选择独立 native 来源，不能从响应或 caller JSON 建立来源。 */
  function source(callId: string, attemptId: string, fenced: ReadonlySet<string>) {
    const attempt = store.attempt(callId, attemptId)
    const current =
      attempt && !fenced.has(key(attempt.binding.target))
        ? nativeProviders.get(key(attempt.binding.target))?.source(attempt.binding)
        : undefined
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    return current
  }
  /** 分层只返回元数据；正文只能通过 results 及原 Wire 读取门禁。 */
  function metadata(call: Call): Call {
    return { ...call, response: null }
  }
  /** 共享关闭 Promise，失败也清理所有资源，不将关闭解释为原生撤销。 */
  function close(): Promise<void> {
    if (closing) {
      return closed
    }
    closing = closed
    void Promise.resolve().then(
      /** 先停止设备 listener 与 socket，再撤销请求作用域并释放宿主账本。 */
      async () => {
        let failed = false
        try {
          transport?.stop()
        } catch {
          failed = true
        } finally {
          scope.close()
          try {
            await options.release()
          } catch {
            failed = true
          }
        }
        if (failed || sessionCleanupFailed) {
          rejectClosed(new GatewayError('gateway_runtime_close_failed'))
        } else {
          finish()
        }
      }
    )
    return closed
  }
  try {
    for (const { provider, hosted: isHosted } of configured) {
      const binding = structuredClone(provider.binding)
      validateProvider(binding)
      validateTarget(provider.target)
      if (provider.target.machine_id !== binding.machine_id || provider.target.provider_id !== binding.provider_id) {
        fail('provider_binding_mismatch')
      }
      const responseBudget = isHosted ? provider.max_response_bytes : LIMITS.frame_bytes
      uint(responseBudget)
      if (!responseBudget || responseBudget > LIMITS.frame_bytes) {
        fail('transport_limit')
      }
      const name = key(binding)
      const remote =
        !isHosted && 'remote_luvus' in provider && provider.remote_luvus === true
          ? (provider as RemoteLuvusRuntimeProvider)
          : undefined
      const native = isHosted || remote ? undefined : (provider as RuntimeProvider)
      if (!isHosted) {
        const mode = remote ? 'remote' : 'local'
        const previousMode = machineModes.get(binding.machine_id)
        if (previousMode && previousMode !== mode) {
          fail('runtime_provider_machine_mode_conflict')
        }
        machineModes.set(binding.machine_id, mode)
      }
      const ref = native ? contractRef(native.contract.wire.source) : undefined
      const previous = ref ? contracts.get(ref) : undefined
      // 同一引用不证明 live capability 相同；冲突必须拒绝，不能让另一实例的后写覆盖当前来源。
      if (
        providers.has(name) ||
        (previous &&
          boundedJson({
            wire: previous.wire,
            identity: previous.compiled.identity,
            capabilities: previous.capabilities,
            revision: previous.capability_revision
          }) !==
            boundedJson({
              wire: native!.contract.wire,
              identity: native!.contract.compiled.identity,
              capabilities: native!.contract.capabilities,
              revision: native!.contract.capability_revision
            }))
      ) {
        fail('runtime_provider_conflict')
      }
      if (
        (!isHosted && binding.kind !== 'luvus') ||
        boundedJson(store.provider(binding.machine_id, binding.provider_id)) !== boundedJson(binding)
      ) {
        fail('provider_binding_mismatch')
      }
      if (isHosted) {
        hostedNames.add(name)
      }
      const requestShape = native ? createLuvusRequestPreflight(native.contract.compiled) : undefined
      providers.set(name, {
        ...provider,
        ...(requestShape
          ? {
              /** 先检查既有原生请求结构，再保留原 provider 的额外同步预检；都不签发执行许可。 */
              preflightRequest(request: JsonObject) {
                requestShape(request)
                return provider.preflightRequest?.(request)
              }
            }
          : {}),
        max_response_bytes: responseBudget,
        binding: Object.freeze(binding),
        target: Object.freeze(structuredClone(provider.target))
      })
      if (native && ref) {
        nativeProviders.set(name, native)
        if (!previous) {
          contracts.set(ref, native.contract)
        }
      } else if (remote) {
        remoteProviders.set(name, remote)
      }
    }
    const offer = structuredClone(options.listener.offer ?? OFFER)
    if (offer.capabilities.includes('rpc') && !offer.capabilities.includes('terminal_execution_state')) {
      offer.capabilities.push('terminal_execution_state')
    }
    if (remoteProviders.size && !offer.capabilities.includes('provider_snapshot')) {
      offer.capabilities.push('provider_snapshot')
    }
    transport = createGateway({
      ...options.listener,
      offer,
      providerSnapshotMachines: [
        ...new Set(
          [...remoteProviders.values()].map(
            /** 仅明确配置远端来源的机器协商快照，本机 attach 会话保持自己的独立测量路径。 */
            (provider) => provider.binding.machine_id
          )
        )
      ],
      store,
      router,
      principal,
      identity: options.lifecycle.identityHost,
      channels: options.channels,
      retainOriginalRead: true,
      /** 每个实际认证 socket 建立独立 backend/Wire；身份随该 socket fence 失效。 */
      session(connection, channel) {
        let retaining: string | undefined
        const remoteEpochs = new Map<
          string,
          {
            epoch: ReturnType<RemoteLuvusRuntimeProvider['open']>
            live?: RuntimeProvider
          }
        >()
        const isolated = connection.negotiated.capabilities.includes('provider_fence')
        const fencedNative = new Set<string>()
        /** 同一来源只关闭自己的 epoch；其它 provider 的目录与契约仍由其原 owner 持有。 */
        function fenceNativeProvider(binding: ProviderBinding): void {
          const name = key(binding)
          const configured = providers.get(name)
          if (!configured || boundedJson(configured.binding) !== boundedJson(binding)) {
            fail('provider_binding_mismatch')
          }
          if (fencedNative.has(name)) {
            return
          }
          fencedNative.add(name)
          const state = remoteEpochs.get(name)
          if (!state) {
            return
          }
          try {
            state.epoch.close()
          } finally {
            remoteEpochs.delete(name)
            if (state.live && nativeProviders.get(name) === state.live) {
              nativeProviders.delete(name)
              const ref = contractRef(state.live.contract.wire.source)
              if (
                ![...nativeProviders.values()].some(
                  /** 相同契约仍被其它活来源使用时保留其原引用。 */ (provider) =>
                    contractRef(provider.contract.wire.source) === ref
                )
              ) {
                contracts.delete(ref)
              }
            }
          }
        }
        /** 全角色关闭仍逐项回收全部原 epoch，即使一项失败也不跳过其它 owner。 */
        function closeRemoteEpochs(): void {
          let failed = false
          for (const name of remoteEpochs.keys()) {
            try {
              fenceNativeProvider(providers.get(name)!.binding)
            } catch {
              failed = true
              sessionCleanupFailed = true
            }
          }
          if (failed) {
            fail('runtime_session_close_failed')
          }
        }
        /** 已失效来源永不复查为 ready；独立来源 getter 的失败只收紧对应 provider。 */
        function providerReady(provider: RuntimeProviderBinding): boolean {
          if (fencedNative.has(key(provider.binding))) {
            return false
          }
          try {
            return provider.ready() === true
          } catch (error) {
            if (isolated) {
              return false
            }
            throw error
          }
        }
        /** 每个来源操作都回到当前 SocketChannel 与唯一 Store，不信任帧中的 authenticated 标志。 */
        function assertRemoteCurrent(provider: RemoteLuvusRuntimeProvider): void {
          if (
            closing ||
            boundedJson(channel.connection()) !== boundedJson(connection) ||
            !localProvider(provider.target)
          ) {
            fail('remote_luvus_epoch_unavailable')
          }
          store.assertConnection(connection)
          if (
            closing ||
            boundedJson(channel.connection()) !== boundedJson(connection) ||
            !localProvider(provider.target)
          ) {
            fail('remote_luvus_epoch_unavailable')
          }
        }
        /** 只接纳本 socket 所属机器的固定 pin；schema/opaque 由 Gateway 本地工厂创建，消息不能注册 provider。 */
        function acceptProviderSnapshot(snapshot: ProviderSnapshot): void {
          const name = key(snapshot.target)
          const configured = providers.get(name)
          if (
            fencedNative.has(name) ||
            !configured ||
            snapshot.target.machine_id !== connection.machine_id ||
            boundedJson(configured.binding) !== boundedJson(snapshot.binding) ||
            boundedJson(configured.target) !== boundedJson(snapshot.target) ||
            !localProvider(snapshot.target)
          ) {
            fail('provider_binding_mismatch')
          }
          const remote = remoteEpochs.get(name)
          if (!remote) {
            fail('remote_luvus_binding_mismatch')
          }
          const live = remote.epoch.accept(snapshot)
          const ref = contractRef(live.contract.wire.source)
          const previous = contracts.get(ref)
          if (
            previous &&
            boundedJson({
              wire: previous.wire,
              identity: previous.compiled.identity,
              capabilities: previous.capabilities,
              revision: previous.capability_revision
            }) !==
              boundedJson({
                wire: live.contract.wire,
                identity: live.contract.compiled.identity,
                capabilities: live.contract.capabilities,
                revision: live.contract.capability_revision
              })
          ) {
            fail('runtime_provider_conflict')
          }
          assertRemoteCurrent(remoteProviders.get(name)!)
          contracts.set(ref, live.contract)
          nativeProviders.set(name, live)
          remote.live = live
        }
        /** 保留证据只使用本同步栈内的原 caller；其余调用重新取得当前 HTTP 主体。 */
        function currentPrincipal() {
          if (retaining) {
            return retaining
          }
          try {
            return principal().id
          } catch {
            return undefined
          }
        }
        const services: Omit<Parameters<typeof createDeviceLifecycleAdapter>[2], 'connection'> = {
          localProvider,
          /** 仅查受保护契约注册表中的固定来源。 */
          contract: (ref) => contracts.get(ref),
          nativeSource: /** 只从原账本取 attempt，再排除本 epoch 已永久失效的来源。 */ (call, attempt) =>
            source(call, attempt, fencedNative),
          /** caller 及本机策略始终重新取当前来源；未认证的持久引用不能继续授权。 */
          policies(principalId) {
            const caller = options.identities.principal({ principal_id: principalId })
            if (!caller || caller.id !== principalId) {
              fail('unauthenticated')
            }
            const policies = [...providers.values()]
              .filter(
                /** 只组合此机器受保护配置中的目标，不从 caller grant 补造实例。 */
                (provider) => provider.binding.machine_id === connection.machine_id
              )
              .map(
                /** 对每个固定目标重新读取当前本机策略。 */
                (provider) => ({ policy: localPolicies(provider.target), target: provider.target })
              )
            const revision = policies[0]?.policy.revision
            if (
              !revision ||
              policies.some(/** 一个连接上的政策必须属于同一全局修订。 */ ({ policy }) => policy.revision !== revision)
            ) {
              fail('policy_revision_conflict')
            }
            return {
              caller: caller.policy,
              local: {
                revision,
                grants: policies.flatMap(
                  /** 每次查询只为该精确 tuple 提供权限，禁止其它查询里的多余 grant 覆盖当前撤权。 */ ({
                    policy,
                    target
                  }) =>
                    policy.grants.filter(
                      /** 保留当前被查询目标的完整 tuple。 */ (grant) =>
                        boundedJson(grant.target) === boundedJson(target)
                    )
                )
              }
            }
          },
          /** 分类权限从固定 provider 的独立宿主读取，普通请求不能提升 Owner/custody。 */
          authority(attempt, binding) {
            const provider = nativeProviders.get(key(attempt.binding.target))
            if (!provider) {
              fail('provider_binding_unavailable')
            }
            const authority = provider.authority(attempt, binding)
            if (closing) {
              throw new GatewayError('runtime_closed')
            }
            return authority
          },
          currentPrincipal
        }
        let owned: Session | undefined
        try {
          for (const [name, provider] of remoteProviders) {
            if (provider.binding.machine_id === connection.machine_id) {
              const epoch = provider.open(
                connection,
                /** 真实通道、canonical binding 与当前 epoch 逐次复验。 */ () => assertRemoteCurrent(provider)
              )
              remoteEpochs.set(name, { epoch })
            }
          }
          const parts: ProviderSessionGroup[] = []
          const selectedHosts = hosted.filter(
            /** 只为实际认证机器打开其已配置原会话。 */ (group) =>
              group.providers.some(
                /** 只检查本认证机器是否属于该原会话组。 */ (provider) =>
                  provider.binding.machine_id === connection.machine_id
              )
          )
          let composed = false
          try {
            const nativeEntries = [...providers.values()].filter(
              /** 原生与远端Luvus保持同一个原注册表和原adapter。 */ (provider) =>
                provider.binding.machine_id === connection.machine_id && !hostedNames.has(key(provider.binding))
            )
            if (nativeOptions && (nativeEntries.length || !selectedHosts.length)) {
              const scopes =
                isolated && nativeEntries.length
                  ? nativeEntries.map(
                      /** 每个原 provider 独立持有同一真实后端的 Wire 状态。 */ (provider) => [provider]
                    )
                  : [nativeEntries]
              for (const entries of scopes) {
                parts.push({
                  providers: entries,
                  session: {
                    ...createDeviceLifecycleAdapter(nativeOptions.lifecycle, channel, services),
                    /** 仅投影此原实例的健康，不改变其 canonical binding 或权限。 */ readiness() {
                      const state = nativeReadiness(entries)
                      return {
                        ...state,
                        providers: state.providers.filter(
                          /** 独立 adapter 只报告其原实例。 */ (provider) =>
                            entries.some(
                              /** 按同机器唯一 provider ID 匹配，不拼接 tuple。 */ (entry) =>
                                entry.binding.provider_id === provider.local.provider_id
                            )
                        )
                      }
                    },
                    /** 仍由原远端 pin/epoch 接纳实际快照。 */ acceptProviderSnapshot(snapshot) {
                      if (
                        !entries.some(
                          /** 不允许跨原实例导入来源。 */ (entry) =>
                            entry.binding.provider_id === snapshot.binding.provider_id
                        )
                      ) {
                        fail('provider_binding_mismatch')
                      }
                      acceptProviderSnapshot(snapshot)
                    },
                    /** 只撤去此原实例来源；原 Wire 的许可由 transport 关闭。 */ close() {
                      if (isolated) {
                        for (const entry of entries) {
                          fenceNativeProvider(entry.binding)
                        }
                      }
                    }
                  }
                })
              }
            }
            for (const group of selectedHosts) {
              const session = group.session(connection, channel, {
                store,
                router,
                localProvider,
                localPolicies,
                policies: services.policies,
                currentPrincipal
              })
              parts.push({
                providers: group.providers.filter(
                  /** 原会话仅覆盖当前机器的精确provider集合。 */ (provider) =>
                    provider.binding.machine_id === connection.machine_id
                ),
                session
              })
              if (closing) {
                throw new GatewayError('runtime_closed')
              }
            }
            if (!parts.length) {
              fail('runtime_session_unavailable')
            }
            if (parts.length === 1 && (!isolated || !parts[0]!.providers.length)) {
              owned = parts[0]!.session
            } else {
              composed = true
              owned = composeGatewaySessions(
                connection,
                parts,
                /** 使用唯一Store的可信单调时间，不引入独立业务时钟。 */ () => store.clock()
              )
            }
          } catch (error) {
            for (const part of composed ? [] : parts.reverse()) {
              try {
                closeSession(part.session)
              } catch {
                /* 每个已交付owner都必须尝试关闭。 */
              }
            }
            throw error
          }
          if (closing) {
            throw new GatewayError('runtime_closed')
          }
          const native: Session = owned
          const originalWire = native.adapter
          const releaseSession = native.close
          if (closing) {
            throw new GatewayError('runtime_closed')
          }
          const adapter = new Proxy({} as Adapter, {
            /** 保持 provider 方法的真实 this；仅在原证据保留栈中交付原 caller。 */
            get(_target, property) {
              if (property === 'close') {
                return closeAdapter
              }
              if (property === 'planEvidence') {
                return planEvidence
              }
              const value = Reflect.get(originalWire, property, originalWire)
              return typeof value === 'function' ? value.bind(originalWire) : value
            }
          })
          /** 原adapter关闭失败必须进入角色最终结果，仍由原transport尝试其它资源。 */
          function closeAdapter(): void {
            try {
              const value: unknown = originalWire.close()
              if (value !== undefined) {
                void Promise.resolve(value).catch(/** 消费违规异步关闭，不把它当作物理释放完成。 */ () => {})
                fail('synchronous_channel_block_required')
              }
            } catch (error) {
              sessionCleanupFailed = true
              throw error
            }
          }
          /** 原文保留以原持久 caller 的当前权限独立评估，不借用最近 HTTP 身份。 */
          function planEvidence(frame: Parameters<typeof originalWire.planEvidence>[0]) {
            const attempt = store.attempt(frame.payload.attempt.call_id, frame.payload.attempt.attempt_id)
            const previous = retaining
            retaining = attempt?.principal_id
            try {
              const plan = originalWire.planEvidence(frame)
              const configured = attempt ? providers.get(key(attempt.binding.target)) : undefined
              const maxBytes = configured?.max_response_bytes ?? LIMITS.frame_bytes
              if (plan.evidence.response_bytes > maxBytes) {
                // 只收窄原 Wire 的保留意图：仍提交真实摘要，超 provider 预算不保存原文。
                return {
                  ...plan,
                  content: {
                    status: plan.content.status,
                    expires_at: plan.content.expires_at,
                    delivery: 'metadata_only' as const
                  }
                }
              }
              return plan
            } finally {
              retaining = previous
            }
          }
          /** Luvus原组只报告自己的来源，不递归读取组合会话或借用Herdr就绪。 */
          function nativeReadiness(entries: readonly RuntimeProviderBinding[]): Readiness {
            const revision = entries[0] ? localPolicies(entries[0].target).revision : ''
            const peer = entries[0]?.peer_policy_revision ?? ''
            return {
              policy_revision: revision,
              peer_policy_revision: peer,
              providers: entries.map(
                /** 原Luvus就绪逐项核对canonical配置和当前政策。 */ (provider) => ({
                  expected:
                    store.provider(provider.binding.machine_id, provider.binding.provider_id) ?? provider.binding,
                  local: provider.binding,
                  native_ready:
                    providerReady(provider) &&
                    !closing &&
                    !!localProvider(provider.target) &&
                    localPolicies(provider.target).revision === revision &&
                    provider.peer_policy_revision === peer &&
                    !closing
                })
              )
            }
          }
          /** 所有 provider 都同时核对当前配置、政策和独立原生来源。 */
          function configuredReadiness(): Readiness {
            const entries = [...providers.values()].filter(
              /** 此 socket 只能观察和承载所属机器的实例。 */
              (provider) => provider.binding.machine_id === connection.machine_id
            )
            const local = entries[0]
            const policyRevision = local ? localPolicies(local.target).revision : ''
            const peerRevision = local?.peer_policy_revision ?? ''
            const sessionHealth = isolated
              ? new Map(
                  providerHealth(connection, native.readiness()).map(
                    /** 每轮只观察组合原来源一次，避免为每个 provider 重读全部实例。 */ (provider) => [
                      provider.provider_id,
                      provider.ready
                    ]
                  )
                )
              : undefined
            return {
              policy_revision: policyRevision,
              peer_policy_revision: peerRevision,
              providers: entries.map(
                /** canonical、双端政策、来源和原生会话须同时保持就绪。 */
                (provider) => ({
                  expected:
                    store.provider(provider.binding.machine_id, provider.binding.provider_id) ?? provider.binding,
                  local: provider.binding,
                  native_ready:
                    providerReady(provider) &&
                    ((!isolated && !selectedHosts.length) ||
                      (isolated
                        ? sessionHealth!.get(provider.binding.provider_id) === true
                        : ready(native, connection, provider.binding.provider_id))) &&
                    !closing &&
                    !!localProvider(provider.target) &&
                    localPolicies(provider.target).revision === policyRevision &&
                    provider.peer_policy_revision === peerRevision &&
                    !closing
                })
              )
            }
          }
          return {
            adapter,
            readiness: configuredReadiness,
            ...(native.fenceProvider
              ? {
                  /** 原组合先关闭该 provider 的许可，再永久移除其本 epoch 来源。 */ fenceProvider(
                    binding: ProviderBinding
                  ) {
                    native.fenceProvider!(binding)
                    if (!hostedNames.has(key(binding))) {
                      fenceNativeProvider(binding)
                    }
                  },
                  providerFences: native.providerFences?.bind(native)
                }
              : {}),
            ...(native.acceptProviderSnapshot
              ? { acceptProviderSnapshot: native.acceptProviderSnapshot.bind(native) }
              : {}),
            /** 仅释放当前 epoch 的 provider 会话，不推断原生动作已停止。 */
            close() {
              try {
                if (releaseSession.call(native) !== undefined) {
                  fail('synchronous_channel_block_required')
                }
              } catch (error) {
                sessionCleanupFailed = true
                throw error
              } finally {
                closeRemoteEpochs()
              }
            }
          }
        } catch (error) {
          try {
            closeSession(owned)
          } finally {
            closeRemoteEpochs()
          }
          throw error
        }
      }
    })
    const active = transport
    const results = createProviderResultAccess({
      store,
      localPolicies,
      principal,
      /** 本结果层在策略回调前后分别执行带正文的原 Wire 门禁；解析只取当前 peer/ACL/期限核对后的引用。 */
      resolveOriginalRead: (callId) => active.resolveOriginalRead(callId, false),
      /** 每次读取重新核对当前受保护配置；所有 provider 共用 Store 的内容和 handle 总预算。 */
      provider(target) {
        const configured = providers.get(key(target))
        const binding = localProvider(target)
        return configured && binding
          ? {
              binding,
              max_response_bytes: configured.max_response_bytes ?? LIMITS.frame_bytes
            }
          : undefined
      }
    })
    const catalog: RuntimeCatalogProvider = Object.freeze({
      /** 目录复用唯一 Store 与当前实际认证 epoch；Owner 无 token 到期，实例/连接寿命逐次复核。 */
      resolve(target, requesting) {
        const provider = nativeProviders.get(key(target))
        const binding = localProvider(target)
        const connection = active.currentConnection(target.machine_id)
        if (!provider?.catalogSource || !binding?.enabled || !connection) {
          return undefined
        }
        if (boundedJson(principal()) !== boundedJson(requesting)) {
          fail('principal_changed')
        }
        const local = localPolicies(target)
        const native = provider.catalogSource(connection, {
          caller_policy_revision: requesting.policy.revision,
          local_policy_revision: local.revision
        })
        store.assertConnection(connection)
        if (
          boundedJson(principal()) !== boundedJson(requesting) ||
          boundedJson(localPolicies(target)) !== boundedJson(local) ||
          boundedJson(active.currentConnection(target.machine_id) ?? null) !== boundedJson(connection) ||
          boundedJson(localProvider(target) ?? null) !== boundedJson(binding) ||
          closing
        ) {
          fail('runtime_catalog_unavailable')
        }
        return Object.freeze({
          record: provider.contract,
          source: native,
          local_provider: binding,
          // 该字段满足既有目录有限整数格式；它不建立委托寿命，真实 Owner/epoch 失效即拒绝。
          expires_at: Number.MAX_SAFE_INTEGER,
          ...(provider.catalog_methods ? { supported_methods: provider.catalog_methods } : {})
        })
      }
    })
    return Object.freeze({
      store,
      router,
      transport: active,
      terminalExecutionState: active.terminalExecutionState.bind(active),
      principal,
      runAuthenticated: scope.runAuthenticated,
      results,
      catalog,
      closed,
      close,
      /** 原子准入仅 created=true 才派发；重复 key 不再次发送、不刷新任何期限。 */
      admit(input: RuntimeCallInput) {
        if (!localProvider(input.target)) {
          fail('provider_binding_mismatch')
        }
        const providerKey = key(input.target)
        const configured = providers.get(providerKey)!
        const requestedContract = input.options.contract_ref
        const admitted = router.admit(
          principal(),
          input.target,
          input.native_request,
          luvusValidation(configured.binding.kind, input.native_request, input.options),
          /** 首次登记在授权事务内比对当前批准契约；旧 key 仍返回原意图，不受新契约影响。 */
          (request) => {
            const native = nativeProviders.get(providerKey)
            const expected = configured.contract_ref ?? (native ? contractRef(native.contract.wire.source) : undefined)
            if (
              (expected !== undefined && requestedContract !== expected) ||
              (remoteProviders.has(providerKey) && !native)
            ) {
              fail('contract_unavailable')
            }
            return configured.preflightRequest?.(request)
          }
        )
        if (admitted.created) {
          try {
            active.dispatch(admitted.call.call_id)
          } catch {
            // 登记已经提交；派发失败只保留账本实际状态，不重试，也不丢失可对账的调用引用。
          }
        }
        // 即使派发失败或命中旧 key，仍重新核对当前身份和读取权限，禁止用登记快照泄露旧 ID。
        return { created: admitted.created, call: metadata(router.get(principal(), admitted.call.call_id)) }
      },
      /** 即使已回应也只返回当前授权元数据，正文交付由 results 统一完成。 */
      get(callId: string) {
        return metadata(router.get(principal(), callId))
      },
      /** 取消仅显式命令触发；HTTP 断开与前端等待结束不会进入此端口。 */
      cancel(callId: string) {
        return metadata(active.cancel(callId))
      },
      /** 原请求索引只对当前所属 caller 开放，不恢复失效 permit 或跨 epoch 请求。 */
      originalAttempt(callId: string, attemptId: string): TrustedAttempt | undefined {
        const current = router.get(principal(), callId)
        return current.attempt_id === attemptId ? store.attempt(callId, attemptId) : undefined
      }
    })
  } catch (error) {
    await close()
    throw error
  }
}
