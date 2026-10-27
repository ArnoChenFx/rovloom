// 装配既有出站通道、Wire 和受限 Luvus RPC；每个认证 epoch 独立持有执行和关闭资源。
import { LuvusAdapterError, LuvusRpcAdapter } from '../connector/luvus/index.js'
import type { Socket } from 'node:net'
import type { NativeTransportEvidence } from '../connector/luvus/index.js'
import { createLuvusWireAdapter } from '../integration/luvus-wire.js'
import type { NativeWireBackend } from '../integration/luvus-wire.js'
import type { TrustedNativeContext } from '../native-contract/index.js'
import { createConnector } from '../transport/index.js'
import type { Adapter, Connection, ConnectorWireSession } from '../transport/index.js'
import { assertBinding, boundedJson, fail } from '../wire/index.js'
import type { AttemptBinding, V2Target } from '../wire/types.js'
import type { ProviderSessionGroup } from './provider-sessions.js'
import { composeConnectorSessions } from './provider-sessions.js'
import { connectorAdmissionAdapter } from './connector-attempts.js'
import { OFFER } from '../transport/common.js'
import { probePlatform } from '../platform/device.js'
import { probeHostProfile } from '../platform/host.js'
import { PRODUCT_VERSION } from '../mcp/version.js'
import type { ConnectorRuntimeOptions } from './types.js'

type Pending = {
  raw: string
  evidence?: string
  source?: string
  nativeEvidence?: NativeTransportEvidence
  socket?: Socket
}

/** 复用同一个原Luvus会话构建器，不启动transport；供唯一出站宿主组合已审provider。 */
export function createLuvusConnectorSessions(options: Pick<ConnectorRuntimeOptions, 'session'>) {
  let stopping = false
  const sessions = new Set<ConnectorWireSession>()
  let cleanupFailed = false
  const backends = new WeakSet<object>()
  const targets = new WeakMap<ConnectorWireSession, () => V2Target>()

  /** 逐项执行同步清理；其中一项失败不阻止其它会话资源关闭。 */
  function cleanup(operations: readonly (() => void)[]): void {
    for (const operation of operations) {
      try {
        if (operation() !== undefined) {
          fail('synchronous_channel_block_required')
        }
      } catch {
        cleanupFailed = true
      }
    }
  }

  /** 只由现有 transport 在成功 welcome 认证后调用，后端不能跨 epoch 复用。 */
  function session(connection: Connection): ConnectorWireSession {
    if (stopping) {
      fail('runtime_closed')
    }
    const resource = options.session(structuredClone(connection))
    let wire: Adapter | undefined
    let rpc: LuvusRpcAdapter | undefined
    let ended = false
    const pending = new Map<string, Pending>()
    /** 每个外部构建回调返回后都复核角色状态，关闭中的资源只能进入清理分支。 */
    function assertSessionOpen(): void {
      if (stopping || ended) {
        fail('runtime_closed')
      }
    }

    try {
      const authentication = resource.authentication
      assertSessionOpen()
      if (authentication !== 'local_owner' || typeof resource.nativeAuth !== 'function') {
        fail('native_host_binding_required')
      }
      const configuredTransport = resource.config.transport
      assertSessionOpen()
      if (configuredTransport !== 'ipc') {
        fail('connector_runtime_transport_unsupported')
      }
      if (backends.has(resource.backend)) {
        fail('connector_backend_reused')
      }
      backends.add(resource.backend)
      if (boundedJson(resource.backend.connection()) !== boundedJson(connection)) {
        fail('connection_binding_mismatch')
      }
      assertSessionOpen()
      /** 原 adapter 每次 beforeWrite 解码都经此来源端口复核同一实测 socket 与来源。 */
      function boundSource(call: string, attemptId: string): TrustedNativeContext | undefined {
        const source = resource.backend.nativeSource(call, attemptId)
        const tracked = pending.get(call + ':' + attemptId)
        if (tracked?.nativeEvidence) {
          const attempt = resource.backend.attempt(call, attemptId)
          if (!attempt || !source || stopping || ended) {
            fail('native_source_untrusted')
          }
          if (!tracked.socket) {
            fail('native_socket_unavailable')
          }
          // EOF 后原 IO 已销毁 socket；结果校验仍核对实例与来源，不能要求结束的 fd 继续可读。
          if (
            !tracked.socket.destroyed &&
            resource.assertEvidence(attempt.binding, tracked.nativeEvidence) !== undefined
          ) {
            fail('synchronous_native_evidence_required')
          }
          if (boundedJson(source) !== tracked.source || boundedJson(tracked.nativeEvidence) !== tracked.evidence) {
            fail('native_evidence_changed')
          }
        }
        return source
      }
      const guardedBackend: NativeWireBackend = {
        ...resource.backend,
        nativeSource: boundSource,
        /** 受保护 authority 回调结束后再复核来源，防止回调中的同步撤销漏过最终写入门禁。 */
        authority(attempt, binding) {
          const result = resource.backend.authority(attempt, binding)
          boundSource(attempt.binding.call_id, attempt.binding.attempt_id)
          return result
        }
      }
      assertSessionOpen()
      wire = connectorAdmissionAdapter(resource.backend, createLuvusWireAdapter(guardedBackend))
      assertSessionOpen()
      const adapter = wire

      /** 在每次 secret/claim 边界重跑原 Wire，全量复验当前策略、来源、epoch 和不可延长的 deadline。 */
      function current(binding: AttemptBinding) {
        if (stopping || ended) {
          fail('runtime_closed')
        }
        const active = resource.backend.connection()
        if (active.authenticated !== true || active.active !== true) {
          fail('authentication_required')
        }
        assertBinding(binding, { ...binding, ...connection })
        assertBinding(binding, { ...binding, ...active })
        const tracked = pending.get(binding.call_id + ':' + binding.attempt_id)
        if (!tracked) {
          fail('attempt_anchor_unavailable')
        }
        adapter.decode(tracked.raw, 'gateway_to_connector')
        const attempt = resource.backend.attempt(binding.call_id, binding.attempt_id)
        if (!attempt) {
          fail('attempt_anchor_unavailable')
        }
        assertBinding(binding, attempt.binding)
        if (resource.backend.now() >= binding.registration.deadline) {
          fail('deadline_exceeded')
        }
        const source = resource.backend.nativeSource(binding.call_id, binding.attempt_id)
        if (!source || source.authenticated !== true || source.source_verified !== true) {
          fail('native_source_untrusted')
        }
        return { tracked, attempt, source }
      }

      rpc = new LuvusRpcAdapter(resource.config, {
        backend: guardedBackend,
        terminalExecution: resource.terminalExecution,
        /** 保存实际同一 socket；宿主异步核验前后都不能把证据移交给其它 attempt 或已关闭连接。 */
        async verifyPeer(socket, endpoint, binding) {
          const name = binding.call_id + ':' + binding.attempt_id
          const tracked = pending.get(name)
          if (
            !tracked ||
            stopping ||
            ended ||
            socket.destroyed ||
            socket.connecting ||
            (tracked.socket !== undefined && tracked.socket !== socket)
          ) {
            fail('native_socket_unavailable')
          }
          tracked.socket = socket
          const peer = await resource.verifyPeer(socket, endpoint, binding)
          if (
            stopping ||
            ended ||
            pending.get(name) !== tracked ||
            tracked.socket !== socket ||
            socket.destroyed ||
            socket.connecting
          ) {
            fail('native_socket_unavailable')
          }
          return peer
        },
        /** 先核对实际同一传输证据，再向宿主取得本机 Owner 认证。 */
        async nativeAuth(binding, evidence) {
          if (resource.assertEvidence(binding, evidence) !== undefined) {
            fail('synchronous_native_evidence_required')
          }
          const state = current(binding)
          const token = await resource.nativeAuth(binding, evidence)
          if (typeof token !== 'object' || token?.kind !== 'local_owner') {
            fail('native_auth_required')
          }
          current(binding)
          state.tracked.evidence = boundedJson(evidence)
          state.tracked.source = boundedJson(state.source)
          state.tracked.nativeEvidence = evidence
          return token
        },
        /** 在完整最终帧预算之后重新验权与同源证据，固定截止只从受保护端口取得。 */
        async claimDispatch(binding, evidence: NativeTransportEvidence) {
          if (resource.assertEvidence(binding, evidence) !== undefined) {
            fail('synchronous_native_evidence_required')
          }
          const state = current(binding)
          if (state.tracked.evidence !== boundedJson(evidence) || state.tracked.source !== boundedJson(state.source)) {
            throw new LuvusAdapterError('native_evidence_changed')
          }
          const expires = resource.dedupExpires(binding)
          assertSessionOpen()
          resource.claims.claim(binding, expires)
        }
      })
      assertSessionOpen()
      const execution = rpc
      const result: ConnectorWireSession = {
        adapter,
        ...(resource.providerSnapshot
          ? {
              providerSnapshot: /** 原工厂检查实际实例，回调返回后仍复核该 epoch 的关闭 fence。 */ () => {
                assertSessionOpen()
                const snapshot = resource.providerSnapshot!()
                assertSessionOpen()
                return snapshot
              }
            }
          : {}),
        ...(resource.terminalExecutionState
          ? { terminalExecutionState: resource.terminalExecutionState.bind(resource) }
          : {}),
        /** 宿主 readiness 也可能同步关闭角色，返回值不能越过关闭 fence。 */
        readiness() {
          assertSessionOpen()
          const readiness = resource.readiness()
          assertSessionOpen()
          return readiness
        },
        /** 原始帧直接进入原 LuvusRpcAdapter.dispatch；不复制协议、注入第二份 auth 或重新排队。 */
        async executeWire(raw, signal) {
          if (stopping || ended) {
            fail('runtime_closed')
          }
          const frame = adapter.decode(raw, 'gateway_to_connector')
          if (frame.type !== 'request' || !('connection_epoch' in frame)) {
            fail('ordinary_rpc_required')
          }
          const name = frame.payload.attempt.call_id + ':' + frame.payload.attempt.attempt_id
          if (pending.has(name)) {
            fail('attempt_replay_rejected')
          }
          pending.set(name, { raw })
          try {
            return await execution.dispatch(raw, signal)
          } finally {
            pending.delete(name)
          }
        },
        /** transport 关闭只中止本 epoch 观察并释放所属资源，长期 claims 的墓碑不在此清除。 */
        close() {
          if (ended) {
            return
          }
          ended = true
          sessions.delete(result)
          cleanup([
            /** 先中止原生等待并停其私有 Wire，再停 transport Wire。 */ () => execution.close(),
            /** 停止外层 Wire 并释放 admission 正文。 */ () => adapter.close(),
            /** 释放该 epoch 所有者交付的额外来源和 backend 资源。 */ () => resource.close()
          ])
          pending.clear()
        }
      }
      // 最终注册必须在最后一个外部构建回调之后；已开始 close 的 epoch 不能在遍历结束后补入集合。
      assertSessionOpen()
      sessions.add(result)
      targets.set(
        result,
        /** 只有组合调用方显式取组时才读取原受保护配置。 */ () => structuredClone(resource.config.target)
      )
      return result
    } catch (error) {
      cleanup([
        /** 创建中途失败也要停止已创建的 RPC。 */ () => rpc?.close(),
        /** 清理半建 Wire 的维护和订阅。 */ () => wire?.close(),
        /** 始终通知本 epoch 所有者回收额外资源。 */ () => resource.close()
      ])
      throw error
    }
  }

  return Object.freeze({
    session,
    failed: /** 原构建回调晚于同步close才完成回滚时，仍向角色终态交付真实清理失败。 */ () => cleanupFailed,
    /** 路由只来自原config和同一原会话的readiness，不读取请求或广告建立目标。 */
    group(connection: Connection): ProviderSessionGroup<ConnectorWireSession> {
      const current = session(connection)
      try {
        const target = targets.get(current)!()
        const state = current.readiness()
        const provider = state.providers.find(
          /** 同一配置精确选择原canonical provider，不按名称或最近实例猜测。 */ (entry) =>
            entry.local.machine_id === target.machine_id &&
            entry.local.provider_id === target.provider_id &&
            entry.local.kind === 'luvus'
        )
        if (stopping || !provider || state.providers.length !== 1) {
          fail('provider_binding_mismatch')
        }
        return { providers: [{ target, binding: provider.local }], session: current }
      } catch (error) {
        current.close()
        throw error
      }
    },
    /** 先同步封锁所有新epoch，再尝试原会话清理；失败保留为真实逻辑关闭失败。 */
    close(): void {
      if (!stopping) {
        stopping = true
        for (const active of sessions) {
          active.close()
        }
      }
      if (cleanupFailed) {
        throw new LuvusAdapterError('connector_runtime_session_close_failed')
      }
    }
  })
}

/** 返回可长期运行的角色句柄；显式关闭先停止重连及所有 epoch，再释放长期 custody/claims 所有者。 */
export async function createConnectorRuntime(options: ConnectorRuntimeOptions) {
  let stopping = false
  let finished = false
  let resolveClosed!: () => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>(
    /** 保存单一完成入口，使并发 close 返回同一个关闭结果。 */ (resolve, reject) => {
      resolveClosed = resolve
      rejectClosed = reject
    }
  )
  // closed 可被长期观察；调用者仍从 close/closed 收到同一错误，不产生无人消费的异步拒绝。
  void closed.catch(/** 标记拒绝已被内部观察，不改写对外 closed 的失败结果。 */ () => {})
  const owner = createLuvusConnectorSessions(options)
  let cleanupFailed = false
  /** 逐项执行同步清理；其中一项失败不阻止其它会话资源关闭。 */
  function cleanup(operations: readonly (() => void)[]): void {
    for (const operation of operations) {
      try {
        if (operation() !== undefined) {
          fail('synchronous_channel_block_required')
        }
      } catch {
        cleanupFailed = true
      }
    }
  }

  /** 单 provider 也使用同一原 owner 组合，隔离后仍可处理当前连接的治理帧。 */
  const session = (connection: Connection): ConnectorWireSession =>
    connection.negotiated.capabilities.includes('provider_fence')
      ? composeConnectorSessions(connection, [owner.group(connection)], Date.now)
      : owner.session(connection)

  let transport: ReturnType<typeof createConnector>
  try {
    const offer = structuredClone(options.transport.offer ?? OFFER)
    if (options.provider_snapshot && !offer.capabilities.includes('provider_snapshot')) {
      offer.capabilities.push('provider_snapshot')
    }
    // 平台采集只读固定系统文件；采集不到时不广告该能力，老 Gateway 的握手因此完全不变。
    const platform = options.transport.platform ?? (() => probePlatform())
    if (platform() !== undefined && !offer.capabilities.includes('device_platform')) {
      offer.capabilities.push('device_platform')
    }
    const hostProfile = options.transport.hostProfile ?? (() => probeHostProfile(PRODUCT_VERSION))
    if (!offer.capabilities.includes('host_profile')) {
      offer.capabilities.push('host_profile')
    }
    transport = createConnector({ ...options.transport, offer, platform, hostProfile, session })
  } catch {
    stopping = true
    cleanup([/** 原构建器停止全部已交付epoch。 */ () => owner.close()])
    try {
      await options.release()
    } catch {
      // 启动与释放错误统一收敛，不能把配置、路径或凭据放进异常。
    }
    throw new LuvusAdapterError('connector_runtime_start_failed')
  }
  return Object.freeze({
    transport,
    closed,
    /** 并发与失败路径都只停止和 release 一次；结果经 closed 统一交付。 */
    close(): Promise<void> {
      if (!stopping) {
        stopping = true
        cleanup([/** 先停原 transport 的 timer/socket/reconnect，再释放长期凭据资源。 */ () => transport.stop()])
        cleanup([/** 同一个原构建器释放全部epoch，不重复实现关闭。 */ () => owner.close()])
        void Promise.resolve().then(
          /** 所有 epoch 都已同步阻止派发，最后关闭长期 custody/claims 所有者。 */ async () => {
            try {
              await options.release()
            } catch {
              cleanupFailed = true
            }
            if (!finished) {
              finished = true
              if (cleanupFailed || owner.failed()) {
                rejectClosed(new LuvusAdapterError('connector_runtime_close_failed'))
              } else {
                resolveClosed()
              }
            }
          }
        )
      }
      return closed
    }
  })
}
