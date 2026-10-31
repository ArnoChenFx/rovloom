// 装配唯一账本、路由、认证设备通道及原请求结果门禁；不实现 HTTP/MCP 协议或管理写服务。
import { Router } from '../router.js'
import { GatewayError } from '../contracts.js'
import { createGateway } from '../transport/index.js'
import { createProviderResultAccess } from './results.js'
import { closeSession, providerHealth, ready, OFFER } from '../transport/common.js'
import type { Session, Readiness, Adapter } from '../transport/common.js'
import type { TrustedAttempt } from '../wire/backend.js'
import type { Call } from '../store.js'
import type { ProviderBinding, V2Target } from '../wire/types.js'
import { boundedJson, fail, validateProvider, validateTarget } from '../wire/index.js'
import { createTrustedRequestScope } from './request-scope.js'
import { composeGatewaySessions, type ProviderSessionGroup } from './provider-sessions.js'
import type {
  ProviderGatewayRuntimeOptions,
  RuntimeCallInput,
  GatewayProviderPort,
  GatewayHostedProviders,
  GatewayProviderServices
} from './types.js'
import type { Connection, SocketChannel } from '../transport/index.js'

/** 一组 provider 的会话只能有一个来源：原工厂或端口层。 */
function sessionFactory(
  group: ProviderGatewayRuntimeOptions | GatewayHostedProviders,
  connection: Connection,
  channel: SocketChannel,
  services: GatewayProviderServices
): Session {
  const fromPorts = group.ports !== undefined
  const fromFactory = typeof group.session === 'function'
  if (fromPorts === fromFactory) {
    // 两种来源都缺或同时出现时不能猜测；端口层登记后仍接受原工厂会让装配绕过已登记档位。
    fail('runtime_provider_session_source_invalid')
  }
  if (!fromPorts) {
    return group.session!(connection, channel, services)
  }
  const registry = group.ports!
  const kinds = [
    ...new Set(
      group.providers.map(
        /** 同组可能只有一种 kind；多 kind 需要分别组合，本层不猜组合顺序。 */ (entry) => entry.binding.kind
      )
    )
  ]
  if (kinds.length !== 1) {
    fail('runtime_provider_session_source_invalid')
  }
  // 未登记的 kind 由注册表明确拒绝，不返回空端口。
  return registry.ports(kinds[0]!).session.session(connection, channel, services)
}

/** provider 交付原 Wire 会话；唯一常驻宿主只管理认证、调度和生命周期。 */
export async function createProviderGatewayRuntime(options: ProviderGatewayRuntimeOptions) {
  const hosted = [options, ...(options.hosted ?? [])]
  const configured = hosted.flatMap((group) => group.providers)
  const store = options.lifecycle.store
  const scope = createTrustedRequestScope(options.identities)
  const router = new Router(store)
  const providers = new Map<string, GatewayProviderPort>()
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
    for (const group of hosted) {
      const fromPorts = group.ports !== undefined
      const fromFactory = typeof group.session === 'function'
      // 会话来源必须二选一；端口层登记后仍接受原工厂会让装配绕过已登记档位。
      if (fromPorts === fromFactory) {
        fail('runtime_provider_session_source_invalid')
      }
      if (
        fromPorts &&
        new Set(group.providers.map(/** 多 kind 组需要分别组合，本层不猜顺序。 */ (entry) => entry.binding.kind))
          .size !== 1
      ) {
        fail('runtime_provider_session_source_invalid')
      }
    }
    for (const provider of configured) {
      const binding = structuredClone(provider.binding)
      validateProvider(binding)
      validateTarget(provider.target)
      if (
        provider.target.machine_id !== binding.machine_id ||
        provider.target.provider_id !== binding.provider_id ||
        boundedJson(store.provider(binding.machine_id, binding.provider_id)) !== boundedJson(binding)
      ) {
        fail('provider_binding_mismatch')
      }
      if (
        typeof provider.admit !== 'function' ||
        typeof provider.retainEvidence !== 'function' ||
        (provider.normalizeRequest !== undefined && typeof provider.normalizeRequest !== 'function')
      ) {
        fail('runtime_provider_invalid')
      }
      const name = key(binding)
      if (providers.has(name)) {
        fail('runtime_provider_conflict')
      }
      providers.set(name, {
        binding: Object.freeze(binding),
        target: Object.freeze(structuredClone(provider.target)),
        ready: provider.ready.bind(provider),
        admit: provider.admit.bind(provider),
        ...(provider.normalizeRequest ? { normalizeRequest: provider.normalizeRequest.bind(provider) } : {}),
        retainEvidence: provider.retainEvidence.bind(provider)
      })
    }
    const offer = structuredClone(options.listener.offer ?? OFFER)
    if (offer.capabilities.includes('rpc') && !offer.capabilities.includes('terminal_execution_state')) {
      offer.capabilities.push('terminal_execution_state')
    }
    if (options.provider_snapshot_machines?.length && !offer.capabilities.includes('provider_snapshot')) {
      offer.capabilities.push('provider_snapshot')
    }
    transport = createGateway({
      ...options.listener,
      offer,
      providerSnapshotMachines: [...(options.provider_snapshot_machines ?? [])],
      store,
      router,
      principal,
      identity: options.lifecycle.identityHost,
      channels: options.channels,
      /** 每个实际认证 socket 建立独立 backend/Wire；身份随该 socket fence 失效。 */
      session(connection, channel) {
        let retaining: string | undefined
        const isolated = connection.negotiated.capabilities.includes('provider_fence')
        function providerReady(provider: GatewayProviderPort): boolean {
          try {
            return provider.ready() === true
          } catch (error) {
            if (isolated) {
              return false
            }
            throw error
          }
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
        let owned: Session | undefined
        try {
          const parts: ProviderSessionGroup[] = []
          const selectedHosts = hosted.filter(
            /** 只为实际认证机器打开其已配置原会话。 */ (group) =>
              group.providers.some(
                /** 只检查本认证机器是否属于该原会话组。 */ (provider) =>
                  provider.binding.machine_id === connection.machine_id
              )
          )
          if (!selectedHosts.length && options.providers.length === 0) {
            selectedHosts.push(options)
          }
          let composed = false
          try {
            for (const group of selectedHosts) {
              const session = sessionFactory(group, connection, channel, {
                store,
                router,
                localProvider,
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
              return configured ? configured.retainEvidence(plan) : plan
            } finally {
              retaining = previous
            }
          }
          /** 所有 provider 都同时核对当前配置、政策和独立原生来源。 */
          function configuredReadiness(): Readiness {
            const entries = [...providers.values()].filter(
              /** 此 socket 只能观察和承载所属机器的实例。 */
              (provider) => provider.binding.machine_id === connection.machine_id
            )
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
              providers: entries.map(
                /** canonical、双端政策、来源和原生会话须同时保持就绪。 */
                (provider) => ({
                  expected:
                    store.provider(provider.binding.machine_id, provider.binding.provider_id) ?? provider.binding,
                  local: provider.binding,
                  native_ready:
                    providerReady(provider) &&
                    (isolated
                      ? sessionHealth!.get(provider.binding.provider_id) === true
                      : ready(native, connection, provider.binding.provider_id)) &&
                    !closing &&
                    !!localProvider(provider.target) &&
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
              }
            }
          }
        } catch (error) {
          closeSession(owned)
          throw error
        }
      }
    })
    const active = transport
    const results = createProviderResultAccess({ store, principal })
    return Object.freeze({
      store,
      router,
      transport: active,
      terminalExecutionState: active.terminalExecutionState.bind(active),
      refusalReason: active.refusalReason.bind(active),
      principal,
      targets: () => [...providers.values()].map((provider) => structuredClone(provider.target)),
      runAuthenticated: scope.runAuthenticated,
      results,
      catalog: undefined,
      closed,
      close,
      /** 原子准入仅 created=true 才派发；重复 key 不再次发送、不刷新任何期限。 */
      admit(input: RuntimeCallInput) {
        if (!localProvider(input.target)) {
          fail('provider_binding_mismatch')
        }
        const providerKey = key(input.target)
        const configured = providers.get(providerKey)!
        principal()
        // 等价规范化只由 provider 端口给出，中立宿主不猜任何 provider 的参数形状；
        // 规范化后的请求同时用于去重键、存档与 Wire 帧，省略与显式空对象因此是同一个请求。
        const request = configured.normalizeRequest?.(input.native_request) ?? input.native_request
        const admitted = configured.admit(
          request,
          input.options,
          /** 登记能力固定本次 caller/目标/请求，仍由 Router 在 Store 事务内分配真实原生 ID。 */
          (admission, check) => router.admit(principal(), input.target, request, admission, check)
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
