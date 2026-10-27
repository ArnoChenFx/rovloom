// 在一个认证 epoch 内按完整受保护路由委托原会话，不创建 Wire、许可、账本或第二条设备连接。
import type { Adapter, Connection, ConnectorWireSession, Session } from '../transport/index.js'
import type { Readiness } from '../transport/common.js'
import { closeSession, ReceiveWindow } from '../transport/common.js'
import {
  boundedJson,
  decodeWireFrame,
  encodeWireFrame,
  fail,
  hash,
  LIMITS,
  object,
  parseJson,
  validateProvider,
  validateTarget
} from '../wire/index.js'
import type { AttemptIdentity, Direction, ProviderBinding, V2Target } from '../wire/types.js'

export type ProviderSessionGroup<T extends Session = Session> = Readonly<{
  providers: readonly Readonly<{ binding: ProviderBinding; target: V2Target }>[]
  session: T
}>

/** 原 Gateway 会话保持各自来源与权限，组合层只选择同一个已认证连接中的原端口。 */
export function composeGatewaySessions(
  connection: Connection,
  groups: readonly ProviderSessionGroup[],
  now: () => number
) {
  return compose(connection, groups, now, false)
}

/** 原 Connector 执行和一次性 receipt 仍交给其原 owner，整个角色只使用一个 transport。 */
export function composeConnectorSessions(
  connection: Connection,
  groups: readonly ProviderSessionGroup<ConnectorWireSession>[],
  now: () => number,
  unavailable: ProviderSessionGroup['providers'] = []
): ConnectorWireSession {
  return compose(connection, groups, now, true, unavailable) as ConnectorWireSession
}

/** 两种角色共用路由与同步关闭 fence；原 adapter 执行完整协议、来源、授权和结果校验。 */
function compose(
  connection: Connection,
  input: readonly ProviderSessionGroup[],
  now: () => number,
  connector: boolean,
  unavailableInput: ProviderSessionGroup['providers'] = []
) {
  let groups: ProviderSessionGroup[]
  try {
    groups = input.map(
      /** 固定原会话对象与独立路由快照，防止配置别名改变选择。 */ (group) => ({
        session: group.session,
        providers: Object.freeze(
          group.providers.map(
            /** 只复制纯配置，原adapter和opaque句柄保持原所有权。 */ (provider) =>
              Object.freeze({
                binding: Object.freeze(structuredClone(provider.binding)),
                target: Object.freeze(structuredClone(provider.target))
              })
          )
        )
      })
    )
  } catch (error) {
    // 调用方已交付全部会话；路由快照在校验前失败时，也不能遗留已经取得的adapter/owner。
    for (const group of [...input].reverse()) {
      try {
        closeSession(group.session)
      } catch {
        /* 继续回收其它原owner，原构建错误保持失败。 */
      }
    }
    throw error
  }
  const routes = new Map<string, { group?: ProviderSessionGroup; binding: ProviderBinding; target: V2Target }>()
  const unavailable: { binding: ProviderBinding; target: V2Target }[] = []
  const windows = new Map<Direction, ReceiveWindow>()
  let ended = false
  let cleanupFailed = false
  let adaptersClosed = false
  let operating = false
  let highWater = 0
  let snapshots: readonly import('../wire/types.js').ProviderSnapshot[] | undefined
  const snapshotSources = new Map<ProviderSessionGroup, readonly import('../wire/types.js').ProviderSnapshot[]>()
  const isolated = connection.negotiated.capabilities.includes('provider_fence')
  const fenced = new Set<ProviderSessionGroup>()
  const adapterReleased = new Set<ProviderSessionGroup>()
  const ownerReleased = new Set<ProviderSessionGroup>()
  const observed = new Map<ProviderSessionGroup, Readiness>()
  const wasReady = new Set<ProviderSessionGroup>()

  /** 每个原 adapter 只关闭一次，先登记关闭 fence 再调用可能重入的原端口。 */
  function releaseAdapter(group: ProviderSessionGroup): void {
    if (adapterReleased.has(group)) {
      return
    }
    adapterReleased.add(group)
    const value: unknown = group.session.adapter.close()
    if (value !== undefined) {
      void Promise.resolve(value).catch(/** 违规异步关闭的晚拒绝仍被消费。 */ () => {})
      fail('synchronous_channel_block_required')
    }
  }
  /** provider 原 owner 与 adapter 分别幂等释放，不把其它 provider 纳入其故障域。 */
  function releaseOwner(group: ProviderSessionGroup): void {
    if (ownerReleased.has(group)) {
      return
    }
    ownerReleased.add(group)
    const value: unknown = group.session.close()
    if (value !== undefined) {
      void Promise.resolve(value).catch(/** 消费清理晚拒绝，不冒充同步完成。 */ () => {})
      fail('synchronous_channel_block_required')
    }
  }
  /** 本 epoch 永久撤去一个原 owner 的全部来源；底层恢复不会重新调用其 getter 或恢复许可。 */
  function fenceGroup(group: ProviderSessionGroup): void {
    if (fenced.has(group)) {
      return
    }
    fenced.add(group)
    snapshotSources.delete(group)
    snapshots = undefined
    for (const release of [releaseAdapter, releaseOwner]) {
      try {
        release(group)
      } catch {
        cleanupFailed = true
      }
    }
  }

  /** 治理帧只复用既有 Wire header codec，不取得任一原生 validator、状态或 permit。 */
  function controlContext(direction: Direction) {
    return { phase: 'authenticated' as const, direction, connection }
  }
  /** 失效声明必须精确对应本 epoch 原受保护配置，不能借治理帧替换 revision。 */
  function protectedProvider(binding: ProviderBinding): ProviderSessionGroup | undefined {
    validateProvider(binding)
    const route = [...routes.values()].find(
      /** provider ID 在同机器内唯一，仍逐字段比较完整原 binding。 */ (entry) =>
        boundedJson(entry.binding) === boundedJson(binding)
    )
    if (!route) {
      fail('provider_binding_mismatch')
    }
    return route.group
  }
  /** 只让已协商的连接使用不依赖原生来源的有界治理消息。 */
  function control(frame: unknown): boolean {
    const value = object(frame)
    const terminalState =
      value.type === 'terminal_execution_state' &&
      connection.negotiated.capabilities.includes('terminal_execution_state')
    // 平台声明属于连接本身而不是某个 provider，没有可校验的 binding；只在协商到该能力时放行。
    const devicePlatform =
      value.type === 'device_platform' && connection.negotiated.capabilities.includes('device_platform')
    const hostProfile = value.type === 'host_profile' && connection.negotiated.capabilities.includes('host_profile')
    if (
      (!isolated && !terminalState && !devicePlatform && !hostProfile) ||
      ![
        'heartbeat',
        'error',
        'provider_fenced',
        'terminal_execution_state',
        'device_platform',
        'host_profile'
      ].includes(value.type as string)
    ) {
      return false
    }
    if (value.type === 'provider_fenced' || value.type === 'terminal_execution_state') {
      protectedProvider(object(value.payload).binding as ProviderBinding)
    }
    return true
  }

  /** 关闭所有原端口，即使某一项失败也不跳过其它 owner；重入和重复关闭不重复释放。 */
  function closeAdapters(): void {
    if (adaptersClosed) {
      if (cleanupFailed) {
        fail('runtime_session_close_failed')
      }
      return
    }
    adaptersClosed = true
    ended = true
    windows.clear()
    let failed = false
    for (const group of [...groups].reverse()) {
      try {
        releaseAdapter(group)
      } catch {
        failed = true
      }
    }
    if (failed || cleanupFailed) {
      cleanupFailed = true
      fail('runtime_session_close_failed')
    }
  }

  let ownersClosed = false
  /** adapter 与 owner 独立计量；transport 先关 adapter 后仍会尝试每一个原 owner。 */
  function close(): void {
    let failed = false
    try {
      closeAdapters()
    } catch {
      failed = true
    }
    if (!ownersClosed) {
      ownersClosed = true
      for (const group of [...groups].reverse()) {
        try {
          releaseOwner(group)
        } catch {
          failed = true
        }
      }
    }
    if (failed || cleanupFailed) {
      cleanupFailed = true
      fail('runtime_session_close_failed')
    }
  }

  /** 外部回调前后复核 epoch，组合上下文总量沿用原单会话的128上限。 */
  function assertOpen(): void {
    if (ended) {
      fail('adapter_closed')
    }
    let contexts = 0
    let bytes = 0
    for (const group of groups) {
      if (fenced.has(group)) {
        continue
      }
      let stats
      try {
        stats = group.session.adapter.stats()
      } catch (error) {
        if (!isolated) {
          throw error
        }
        fenceGroup(group)
        continue
      }
      if (ended || stats.closed) {
        if (isolated && !ended) {
          fenceGroup(group)
          continue
        }
        fail('adapter_closed')
      }
      contexts += stats.executions + stats.responses
      const measured = stats as typeof stats & { snapshot_bytes?: number; attempt_bytes?: number }
      bytes += (measured.snapshot_bytes ?? 0) + (measured.attempt_bytes ?? 0)
    }
    if (cleanupFailed) {
      fail('runtime_session_close_failed')
    }
    if (contexts > 128 || bytes > 16_777_216) {
      try {
        close()
      } finally {
        fail('attempt_capacity')
      }
    }
  }

  /** 同步关联不得被 provider 重入替换。 */
  function invoke<T>(action: () => T): T {
    if (operating) {
      try {
        close()
      } finally {
        fail('runtime_session_reentry')
      }
    }
    operating = true
    try {
      assertOpen()
      const value = action()
      assertOpen()
      return value
    } finally {
      operating = false
    }
  }

  /** target和kind都来自受保护注册组；帧中的提示只用于选原校验器，不能建立任何可信状态。 */
  function select(attempt: AttemptIdentity, cleanup = false): ProviderSessionGroup {
    const route = routes.get(boundedJson(attempt.target))
    if (!route || attempt.provider_kind !== route.binding.kind) {
      fail('provider_binding_mismatch')
    }
    if (!route.group) {
      fail('provider_not_ready')
    }
    if (!cleanup && fenced.has(route.group)) {
      fail('provider_not_ready')
    }
    return route.group
  }

  /** 快照按原binding选择codec；其它治理帧仍完整核验连接，对象只交唯一原Luvus组装器。 */
  function frameOwner(frame: unknown): ProviderSessionGroup {
    const value = object(frame)
    if (value.type === 'heartbeat' || value.type === 'error') {
      return groups[0]!
    }
    if (value.type === 'provider_snapshot') {
      const payload = object(value.payload)
      const binding = object(payload.binding)
      const route = routes.get(boundedJson(payload.target))
      if (!route?.group || binding.kind !== route.binding.kind || boundedJson(binding) !== boundedJson(route.binding)) {
        fail('provider_binding_mismatch')
      }
      // 这里只选择原端口；原codec继续核验快照、协商能力、header身份和实际epoch。
      return route.group
    }
    return select(object(object(value.payload).attempt) as AttemptIdentity)
  }

  try {
    if (!groups.length) {
      fail('runtime_session_unavailable')
    }
    for (const group of groups) {
      if (!group.providers.length || (isolated && group.providers.length !== 1)) {
        fail('provider_binding_mismatch')
      }
      for (const provider of group.providers) {
        const binding = structuredClone(provider.binding)
        const target = structuredClone(provider.target)
        validateProvider(binding)
        validateTarget(target)
        const key = boundedJson(target)
        if (
          binding.machine_id !== connection.machine_id ||
          target.machine_id !== connection.machine_id ||
          binding.provider_id !== target.provider_id ||
          routes.has(key) ||
          [...routes.values()].some(
            /** 同一机器的provider标识不得在多个会话组重复。 */ (route) =>
              route.binding.provider_id === binding.provider_id
          )
        ) {
          fail('provider_binding_mismatch')
        }
        routes.set(key, { group, binding, target })
      }
    }
    if (unavailableInput.length && !isolated) {
      fail('provider_fence_required')
    }
    if (unavailableInput.length + routes.size > 64) {
      fail('provider_limit')
    }
    for (const entry of unavailableInput) {
      const binding = Object.freeze(structuredClone(entry.binding))
      const target = Object.freeze(structuredClone(entry.target))
      validateProvider(binding)
      validateTarget(target)
      if (
        binding.machine_id !== connection.machine_id ||
        target.machine_id !== connection.machine_id ||
        binding.provider_id !== target.provider_id ||
        routes.has(boundedJson(target)) ||
        [...routes.values()].some(
          /** 不可用声明也不得覆盖任何原会话或同名 provider。 */ (route) =>
            route.binding.provider_id === binding.provider_id
        )
      ) {
        fail('provider_binding_mismatch')
      }
      unavailable.push(Object.freeze({ binding, target }))
      routes.set(boundedJson(target), { binding, target })
    }
    assertOpen()
  } catch (error) {
    try {
      close()
    } catch {
      /* 原构建错误保留；所有已交付资源均已尝试回收。 */
    }
    throw error
  }

  const adapter: Adapter = {
    decode: /** 提示解析有界，返回值始终取原adapter完整解码，不重包帧。 */ (raw, direction) =>
      invoke(
        /** 失效治理帧不读取已关闭原生端口；业务原字节仍只进入原decoder。 */ () =>
          control(parseJson(raw))
            ? decodeWireFrame(raw, controlContext(direction))
            : frameOwner(parseJson(raw)).session.adapter.decode(raw, direction)
      ),
    encode: /** 原对象原样交给对应原codec，保留完整请求和原生预算。 */ (frame, direction) =>
      invoke(
        /** 原帧交给原encoder，组合层不修改字段或权限。 */ () =>
          control(frame)
            ? encodeWireFrame(frame, controlContext(direction))
            : frameOwner(frame).session.adapter.encode(frame, direction)
      ),
    checkResult: /** 原始响应仍用本provider的原请求permit复验。 */ (binding, response) =>
      invoke(
        /** 原binding和响应交给对应原结果许可检查。 */ () =>
          select(binding).session.adapter.checkResult(binding, response)
      ),
    checkResultRetention: /** 可读与可保存继续由原adapter分别裁决。 */ (binding, response) =>
      invoke(
        /** 独立调用原保留门禁，不能以可读代替可保存。 */ () =>
          select(binding).session.adapter.checkResultRetention(binding, response)
      ),
    observeMessage: /** 原去重后再用共享有界窗口拒绝跨provider消息ID冲突，不复制完整对象缓冲。 */ (frame, direction) =>
      invoke(
        /** 原消息观察后执行共享有界去重。 */ () => {
          const group = control(frame) ? undefined : frameOwner(frame)
          const result = group ? group.session.adapter.observeMessage(frame, direction) : 'new'
          if (!group) {
            encodeWireFrame(frame, controlContext(direction))
          }
          const time = now()
          if (!Number.isSafeInteger(time) || time < highWater) {
            fail('clock_untrusted')
          }
          highWater = time
          let window = windows.get(direction)
          if (!window) {
            window = new ReceiveWindow()
            windows.set(direction, window)
          }
          const shared = window.observe(
            boundedJson({ message_id: frame.message_id, frame_sha256: hash(boundedJson(frame, LIMITS.object_bytes)) }),
            time
          )
          if (result === 'duplicate' || shared === 'duplicate') {
            return 'duplicate'
          }
          return 'new'
        }
      ),
    planEvidence: /** 证据只来自响应对应的原生会话和原Store锚点。 */ (frame) =>
      invoke(
        /** 证据规划只委托对应原请求上下文。 */ () => select(frame.payload.attempt).session.adapter.planEvidence(frame)
      ),
    release: /** 只释放完整目标所对应原adapter中的原attempt。 */ (binding) =>
      invoke(
        /** 已封锁 owner 已完成整体回收；重复清理不再调用关闭端口。 */ () => {
          const group = select(binding, true)
          if (!fenced.has(group)) {
            group.session.adapter.release(binding)
          }
        }
      ),
    close: closeAdapters,
    stats: /** 只合计计数；原始内容和原生句柄不离开各自owner。 */ () => ({
      closed: ended,
      executions: groups.reduce(
        /** 已关闭原 owner 不再提供活执行上下文。 */ (count, group) =>
          count + (fenced.has(group) ? 0 : group.session.adapter.stats().executions),
        0
      ),
      responses: groups.reduce(
        /** 失效来源不提供旧响应许可。 */ (count, group) =>
          count + (fenced.has(group) ? 0 : group.session.adapter.stats().responses),
        0
      )
    })
  }

  const result: Session & Partial<ConnectorWireSession> = {
    adapter,
    readiness: /** 每组只报告自己的canonical binding，政策修订必须属于同一全局配置。 */ () =>
      invoke(
        /** 逐组核对路由覆盖与全局政策修订后合并原健康观测。 */ () => {
          for (const group of groups) {
            if (fenced.has(group)) {
              continue
            }
            try {
              const state = group.session.readiness()
              if (state.providers.length !== group.providers.length) {
                fail('provider_binding_mismatch')
              }
              const seen = new Set<string>()
              for (const provider of state.providers) {
                if (seen.has(provider.local.provider_id)) {
                  fail('provider_binding_mismatch')
                }
                seen.add(provider.local.provider_id)
                if (
                  !group.providers.some(
                    /** 原 owner 只能报告原受保护配置，不能在同 epoch 换 binding。 */ (entry) =>
                      boundedJson(entry.binding) === boundedJson(provider.local)
                  )
                ) {
                  fail('provider_binding_mismatch')
                }
              }
              observed.set(group, structuredClone(state))
              const ready = state.providers.every(
                /** 双端原配置、策略和 native readiness 同时有效才记录首次就绪。 */ (provider) =>
                  provider.native_ready === true &&
                  provider.expected.enabled &&
                  boundedJson(provider.expected) === boundedJson(provider.local)
              )
              if (ready) {
                wasReady.add(group)
              }
              if (isolated && !ready && (connector || wasReady.has(group))) {
                fenceGroup(group)
                continue
              }
            } catch (error) {
              if (!isolated) {
                throw error
              }
              fenceGroup(group)
            }
          }
          return {
            providers: [
              ...groups.flatMap(
                /** 失效 provider 保留原配置与最后已验证状态，只收紧 readiness，不重新调用原 owner。 */ (group) => {
                  const state = observed.get(group)
                  if (!fenced.has(group)) {
                    return state!.providers
                  }
                  return group.providers.map(
                    /** 当前故障只影响此原 binding，恢复也不能复活本 epoch 的来源。 */ (entry) => ({
                      expected:
                        state?.providers.find(
                          /** 仅复用同一 provider 的最后 canonical 观测。 */ (provider) =>
                            provider.local.provider_id === entry.binding.provider_id
                        )?.expected ?? entry.binding,
                      local: entry.binding,
                      native_ready: false
                    })
                  )
                }
              ),
              ...unavailable.map(
                /** 受保护配置只声明不可用，不交付 adapter、native 来源或 permit。 */ (entry) => ({
                  expected: entry.binding,
                  local: entry.binding,
                  native_ready: false
                })
              )
            ]
          }
        }
      ),
    close
  }
  if (connector) {
    result.nativeVersions = () =>
      invoke(() =>
        groups.flatMap((group) => {
          if (fenced.has(group)) {
            return []
          }
          const values =
            group.session.nativeVersions?.() ??
            group.session.providerSnapshot?.().map((snapshot) => ({
              provider_id: snapshot.binding.provider_id,
              native_version: snapshot.source.binary_version === 'unavailable' ? null : snapshot.source.binary_version
            })) ??
            []
          if (
            !Array.isArray(values) ||
            values.length > group.providers.length ||
            values.some(
              (value) => !group.providers.some((provider) => provider.binding.provider_id === value.provider_id)
            )
          ) {
            void Promise.resolve(values).catch(() => {})
            fail('provider_binding_mismatch')
          }
          return values
        })
      )
    result.terminalExecutionState = /** 原owner只能报告自己原配置的本地开关，不使已失效组复活。 */ () =>
      invoke(
        /** 聚合原配置的同步观察值，不调用原生方法。 */ () =>
          groups.flatMap(
            /** 每个组保持独立的配置读取器和最终执行guard。 */ (group) => {
              if (fenced.has(group)) {
                return []
              }
              const values = group.session.terminalExecutionState?.() ?? []
              if (!Array.isArray(values) || values.length > group.providers.length) {
                void Promise.resolve(values).catch(/** 消费违规异步 getter 的拒绝。 */ () => {})
                fail('terminal_execution_state_invalid')
              }
              for (const value of values) {
                if (protectedProvider(value.binding) !== group || typeof value.enabled !== 'boolean') {
                  fail('provider_binding_mismatch')
                }
              }
              return values
            }
          )
      )
  }
  if (isolated) {
    result.fenceProvider = /** 只能永久撤回本 epoch 的原配置；不建立替换来源。 */ (binding) =>
      invoke(
        /** 不可用声明本就没有 owner；真实会话仍只关闭对应的原资源。 */ () => {
          const group = protectedProvider(binding)
          if (group) {
            fenceGroup(group)
          }
        }
      )
    result.providerFences = /** 仅交付有界原配置，失效记录不生成新许可。 */ () => {
      if (ended) {
        fail('adapter_closed')
      }
      return Object.freeze([
        ...unavailable.map(/** 始终撤回的配置不能在本 epoch 变为 ready。 */ (entry) => entry.binding),
        ...[...fenced].flatMap(
          /** 每个 owner 对应独立原 provider。 */ (group) =>
            group.providers.map(/** 配置已在组建立时固定并冻结。 */ (entry) => entry.binding)
        )
      ])
    }
  }
  if (groups.some(/** 只在原端口存在时暴露快照接纳能力。 */ (group) => group.session.acceptProviderSnapshot)) {
    result.acceptProviderSnapshot = /** 快照仍由目标原owner核验pin与实际epoch。 */ (snapshot) =>
      invoke(
        /** 按完整目标把原快照交给原pin和epoch核验端口。 */ () => {
          const group = routes.get(boundedJson(snapshot.target))?.group
          if (!group?.session.acceptProviderSnapshot) {
            fail('runtime_snapshot_session_unavailable')
          }
          group.session.acceptProviderSnapshot(snapshot)
        }
      )
  }
  if (groups.some(/** 只转发真实owner交付的稳定快照getter。 */ (group) => group.session.providerSnapshot)) {
    result.providerSnapshot = /** 每次复核原稳定getter，不刷新generation或给Herdr补造广告。 */ () =>
      invoke(
        /** 逐次复核原getter引用，聚合数组固定且不刷新来源期限。 */ () => {
          const all = []
          for (const group of groups) {
            if (!group.session.providerSnapshot) {
              continue
            }
            if (fenced.has(group)) {
              continue
            }
            try {
              const current = group.session.providerSnapshot()
              if (!Array.isArray(current)) {
                void Promise.resolve(current).catch(/** 消费违规异步来源的晚拒绝。 */ () => {})
                fail('synchronous_provider_snapshot_required')
              }
              const previous = snapshotSources.get(group)
              if (previous && previous !== current) {
                fail('provider_snapshot_changed')
              }
              for (const snapshot of current) {
                const route = routes.get(boundedJson(snapshot.target))
                if (route?.group !== group || boundedJson(route.binding) !== boundedJson(snapshot.binding)) {
                  fail('provider_binding_mismatch')
                }
              }
              snapshotSources.set(group, current)
              all.push(...current)
            } catch (error) {
              if (!isolated) {
                throw error
              }
              fenceGroup(group)
            }
          }
          snapshots ??= Object.freeze(all)
          return snapshots
        }
      )
  }
  if (connector) {
    const sessions = groups as unknown as readonly ProviderSessionGroup<ConnectorWireSession>[]
    if (
      sessions.some(
        /** 全部原Connector会话必须实际具备执行端口。 */ (group) => typeof group.session.executeWire !== 'function'
      )
    ) {
      closeSession(result)
      fail('connector_execution_required')
    }
    result.executeWire = /** 选中原会话后原始字节和signal保持不变；晚到结果仍受组合关闭fence约束。 */ async (
      raw,
      signal
    ) => {
      const group = invoke(
        /** 原始有界字节只用于选原会话，执行仍由其原端口完成。 */ () => frameOwner(parseJson(raw))
      ) as ProviderSessionGroup<ConnectorWireSession>
      const value = await group.session.executeWire(raw, signal)
      assertOpen()
      if (select(value.binding) !== group) {
        fail('provider_binding_mismatch')
      }
      return value
    }
  }
  return result
}
