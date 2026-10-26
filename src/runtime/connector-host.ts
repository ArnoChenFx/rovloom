// 为各 provider 交付的已审 Wire 会话管理统一出站角色寿命，不解释原生协议或生成执行许可。
import { GatewayError } from '../contracts.js'
import { createConnector } from '../transport/index.js'
import type { Connection, ConnectorWireSession, WireConnectorOptions } from '../transport/index.js'
import { closeSession, OFFER } from '../transport/common.js'
import { probePlatform } from '../platform/device.js'

export type ConnectorHostOptions = Readonly<{
  transport: Omit<WireConnectorOptions, 'session'>
  // 只转发原provider真实、稳定的快照，不从readiness或配置重建。
  provider_snapshot?: true
  // 每个认证 epoch 的 provider 自行交付已审 adapter、执行、readiness 和关闭资源。
  session(connection: Connection): ConnectorWireSession
  // 全部 epoch 停止后释放角色拥有的长期资源，不清除调用墓碑或宣称原生工作回滚。
  release(): Promise<void>
  // 逻辑关闭默认最多等待 5000ms；只可用 1..5000 的正安全整数收紧，不改变原 release 的生命周期。
  release_timeout_ms?: number
}>

export type ConnectorReleaseStatus = Readonly<{
  state: 'not_started' | 'pending' | 'released' | 'failed'
  // 仅表示仍保留所交付 owner/release 回调引用；pending/failed 都不确认物理资源已经释放。
  owner_held: boolean
}>
export type ConnectorHostShutdown = Readonly<{
  closed: Promise<void>
  close(): Promise<void>
  // 只报告原 release 回调的最终结算，不推断进程退出、不启动第二次释放，也不改判 closed。
  releaseSettled: Promise<'released' | 'failed'>
  releaseStatus(): ConnectorReleaseStatus
}>

export class ConnectorHostStartupError extends GatewayError {
  /** 启动失败仍交付同一个关闭观察入口，长期 pending 或失败所有者不能随公开错误丢失。 */
  constructor(readonly shutdown: ConnectorHostShutdown) {
    super('connector_runtime_start_failed')
  }
}

const DEFAULT_RELEASE_TIMEOUT_MS = 5000

/** 只复用现有 Connector 通道；身份、原生来源及逐 provider 授权仍由已审会话负责。 */
export async function createProviderConnectorRuntime(options: ConnectorHostOptions) {
  let stopping = false
  let cleanupFailed = false
  let releaseTimeoutMs = DEFAULT_RELEASE_TIMEOUT_MS
  let retainedOwner: ConnectorHostOptions | undefined = options
  let releaseState: ConnectorReleaseStatus['state'] = 'not_started'
  let closeSettled = false
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let resolveRelease!: (state: 'released' | 'failed') => void
  const releaseSettled = new Promise<'released' | 'failed'>(
    /** 原所有者只结算一次；公开观察只返回安全状态，不传播底层异常。 */ (resolve) => {
      resolveRelease = resolve
    }
  )
  let transport: ReturnType<typeof createConnector> | undefined
  let resolveClosed!: () => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>(
    /** 并发关闭、回调重入和长期观察者共享同一个最终结果。 */ (resolve, reject) => {
      resolveClosed = resolve
      rejectClosed = reject
    }
  )
  void closed.catch(/** 内部观察失败，保留对外同一个拒绝结果而不产生无人消费的异常。 */ () => {})
  const sessions = new Set<ConnectorWireSession>()

  /** 逐项同步回收；非法异步关闭也标记失败并消费其晚到拒绝，错误原文不离开宿主。 */
  function cleanup(operations: readonly (() => unknown)[]): void {
    for (const operation of operations) {
      try {
        const returned = operation()
        if (returned !== undefined) {
          cleanupFailed = true
          void Promise.resolve(returned).catch(/** 消费违规异步清理的拒绝，不把它当作同步关闭完成。 */ () => {})
        }
      } catch {
        cleanupFailed = true
      }
    }
  }

  /** 只返回 owner 回调的观察状态；保留引用与内核中的资源状态是不同事实。 */
  function releaseStatus(): ConnectorReleaseStatus {
    return Object.freeze({ state: releaseState, owner_held: retainedOwner !== undefined })
  }

  /** 逻辑结果一旦超时或失败便不改判；晚到 release 只更新独立观察入口。 */
  function settleClose(timedOut = false): void {
    if (closeSettled) {
      return
    }
    closeSettled = true
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = undefined
    }
    if (timedOut) {
      rejectClosed(new GatewayError('connector_runtime_close_timeout'))
    } else if (cleanupFailed) {
      rejectClosed(new GatewayError('connector_runtime_close_failed'))
    } else {
      resolveClosed()
    }
  }

  /** 先同步停止传输及全部会话，再只调用一次长期释放；逻辑等待有界，未确认所有者仍被保留。 */
  function close(): Promise<void> {
    if (!stopping) {
      stopping = true
      cleanup([/** 原通道负责停 timer、socket 与重连，不另建协议或连接。 */ () => transport?.stop()])
      for (const active of sessions) {
        cleanup([/** 原 closeSession 顺序保证 adapter 与 provider 资源均被回收。 */ () => closeSession(active)])
      }
      releaseState = 'pending'
      releaseTimer = setTimeout(
        /** 到达逻辑预算仅拒绝关闭结果，不取消、重试或丢弃仍未结算的 release。 */ () => settleClose(true),
        releaseTimeoutMs
      )
      void Promise.resolve()
        .then(
          /** 延后调用使同步构建回滚先完成；保留同一个 owner，不能在超时后开启并行释放。 */ () =>
            retainedOwner!.release()
        )
        .then(
          /** 原回调晚成功只解除 owner 引用并通知独立观察者，原超时结果保持不变。 */ () => {
            releaseState = 'released'
            retainedOwner = undefined
            resolveRelease('released')
            settleClose()
          },
          /** 原回调晚拒绝也必须消费；失败保留所有者引用，不泄漏异常或自动重试。 */ () => {
            releaseState = 'failed'
            cleanupFailed = true
            resolveRelease('failed')
            settleClose()
          }
        )
    }
    return closed
  }

  /** 对实际认证 welcome 返回的会话加关闭 fence，provider 回调重入不能晚注册资源。 */
  function session(connection: Connection): ConnectorWireSession {
    if (stopping) {
      throw new GatewayError('runtime_closed')
    }
    let resource: ConnectorWireSession | undefined
    let owned: ConnectorWireSession | undefined
    let originalAdapter: ConnectorWireSession['adapter'] | undefined
    let ended = false
    let adapterClosed = false

    /** 已关闭的角色或 epoch 不再接受新的读取、执行或注册。 */
    function assertOpen(): void {
      if (stopping || ended) {
        throw new GatewayError('runtime_closed')
      }
    }

    try {
      resource = options.session(structuredClone(connection))
      const current = resource
      /** transport 也会主动关闭 adapter；本层统一计量失败并只调用原关闭一次。 */
      function closeAdapter(): void {
        if (!adapterClosed) {
          adapterClosed = true
          cleanup([
            /** 未注册回滚也只在清理时取得原 adapter，内部状态与订阅仍由 provider 自己释放。 */ () =>
              (originalAdapter ?? current.adapter).close()
          ])
        }
      }
      const adapter = new Proxy({} as ConnectorWireSession['adapter'], {
        /** 仅包装关闭；其余方法绑定回原对象，兼容 provider 私有字段与原始方法语义。 */
        get(_target, property) {
          if (property === 'close') {
            return closeAdapter
          }
          const source = originalAdapter ?? current.adapter
          const value: unknown = Reflect.get(source, property, source)
          return typeof value === 'function' ? value.bind(source) : value
        }
      })
      owned = {
        adapter,
        /** 原 readiness 回调可能同步关闭角色，返回值不能越过关闭 fence。 */
        readiness() {
          assertOpen()
          const readiness = current.readiness()
          assertOpen()
          return readiness
        },
        /** 原始 Wire 与观察信号原样交给 provider；关闭后不再交付晚到结果。 */
        async executeWire(raw, signal) {
          assertOpen()
          const result = await current.executeWire(raw, signal)
          assertOpen()
          return result
        },
        /** 先移除本 epoch，再清 adapter 和 provider；同步重入不会重复回收。 */
        close() {
          if (ended) {
            return
          }
          ended = true
          sessions.delete(owned!)
          closeAdapter()
          cleanup([/** 只回收当前 provider 交付的会话所有者，不猜测其原生停止语义。 */ () => current.close()])
        }
      }
      if (current.fenceProvider) {
        owned.fenceProvider = /** 只转发原组合会话的同步 provider 撤回，仍复核角色关闭 fence。 */ (binding) => {
          assertOpen()
          const result = current.fenceProvider!(binding)
          assertOpen()
          return result
        }
      }
      if (current.providerFences) {
        owned.providerFences = /** 永久失效配置来自原 owner，不从消息或状态字符串重建。 */ () => {
          assertOpen()
          const result = current.providerFences!()
          assertOpen()
          return result
        }
      }
      if (current.terminalExecutionState) {
        const terminalState = current.terminalExecutionState.bind(current)
        owned.terminalExecutionState = /** 保留原本机开关观察口；读取前后都复核所属 epoch 的关闭 fence。 */ () => {
          assertOpen()
          const result = terminalState()
          assertOpen()
          return result
        }
      }
      if (current.providerSnapshot) {
        const snapshot = current.providerSnapshot.bind(current)
        owned.providerSnapshot = /** 原getter每次重验来源和epoch，组合层不刷新快照。 */ () => {
          assertOpen()
          const result = snapshot()
          assertOpen()
          return result
        }
      }
      assertOpen()
      originalAdapter = current.adapter
      assertOpen()
      sessions.add(owned)
      return owned
    } catch {
      cleanup([
        /** 回调先关闭再返回的会话尚未注册，仍须立即 rollback 原 adapter 与 provider 资源。 */ () =>
          closeSession(owned ?? resource)
      ])
      throw new GatewayError(stopping ? 'runtime_closed' : 'connector_runtime_session_failed')
    }
  }

  const shutdown: ConnectorHostShutdown = Object.freeze({ closed, close, releaseSettled, releaseStatus })
  try {
    // 配置错误也已经归属同一个 owner；使用默认保守预算清理，不能因先抛校验异常跳过释放。
    const configured = options.release_timeout_ms
    if (configured !== undefined) {
      if (!Number.isSafeInteger(configured) || configured < 1 || configured > DEFAULT_RELEASE_TIMEOUT_MS) {
        throw new GatewayError('connector_runtime_release_timeout_invalid')
      }
      releaseTimeoutMs = configured
    }
    const offer = structuredClone(options.transport.offer ?? OFFER)
    if (options.provider_snapshot && !offer.capabilities.includes('provider_snapshot')) {
      offer.capabilities.push('provider_snapshot')
    }
    // 与单一 provider 组合器一致：采集不到平台时不广告该能力。
    const platform = options.transport.platform ?? (() => probePlatform())
    if (platform() !== undefined && !offer.capabilities.includes('device_platform')) {
      offer.capabilities.push('device_platform')
    }
    transport = createConnector({ ...options.transport, offer, platform, session })
  } catch {
    await close().catch(/** 启动失败只等待有界逻辑结果，未确认物理释放继续由 shutdown 暴露。 */ () => {})
    throw new ConnectorHostStartupError(shutdown)
  }
  return Object.freeze({ transport, ...shutdown })
}
