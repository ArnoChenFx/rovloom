// 在隔离安装、真实 loopback/Store/Wire 与实际 LuvusRpcAdapter 之间组合原始帧接缝，生产身份均用 fixture。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StoreOptions } from '../../src/store.js'
import { LuvusRpcAdapter } from '../../src/connector/luvus/index.js'
import type { LuvusLocalLimits } from '../../src/connector/luvus/index.js'
import { createLuvusWireAdapter } from '../../src/connector/luvus/wire.js'
import { persistentBackend } from '../../src/connector/luvus/persistence.js'
import { createConnector } from '../../src/transport/index.js'
import type { Connection, WireConnectorOptions, ConnectorWireSession } from '../../src/transport/index.js'
import { assertBinding, boundedJson, fail } from '../../src/wire/index.js'
import type { AttemptBinding } from '../../src/wire/types.js'
import { fixture as nativeFixture } from '../connector/luvus/helpers.js'
import { fixture, until } from './helpers.js'

/** 用自建 Unix listener 和真实已合入 adapter 验证 transport 接缝，不启动用户的原生实例或读取凭据。 */
export async function wireFixture(
  options: {
    nativeLimits?: Partial<LuvusLocalLimits>
    store?: Partial<StoreOptions>
    dispatchRefusal?: boolean
    frameBytes?: number
    readContexts?: number
  } = {}
) {
  const native = await nativeFixture()
  const path = join(native.root, 'claims.sqlite')
  writeFileSync(path, '', { mode: 0o600, flag: 'wx' })
  const claims = new DatabaseSync(path)
  claims.exec('CREATE TABLE claims(call_id TEXT,attempt_id TEXT,binding TEXT,PRIMARY KEY(call_id,attempt_id))')
  const gateways: ReturnType<typeof createLuvusWireAdapter>[] = []
  const failures: { stage: string; code: string }[] = []
  /** 仅记录 fixture 中已脱敏的 Wire 错误码，保留失败层次而不输出载荷、凭据或异常原文。 */
  function trace<T>(stage: string, operation: () => T): T {
    try {
      return operation()
    } catch (error) {
      failures.push({ stage, code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown' })
      throw error
    }
  }
  const offer = {
    major: 2,
    minor: 0,
    capabilities: ['rpc', ...(options.dispatchRefusal ? ['dispatch_refusal'] : [])],
    required: ['rpc']
  }
  const f = fixture(
    {
      offer,
      retainOriginalRead: true,
      limits: {
        heartbeat_ms: 100,
        idle_ms: 10_000,
        handshake_ms: 1000,
        frame_bytes: options.frameBytes ?? 1_048_576,
        read_contexts: options.readContexts ?? 128
      }
    },
    options.store,
    {
      contract: { source: native.origin, compiled: native.compiled, identity: native.native.contract },
      /** Gateway 保留自己的真实 Wire 请求状态，刻意保留额外空白以检测原帧是否被重编码。 */
      adapter(connection, _channel, services) {
        const adapter = createLuvusWireAdapter(persistentBackend(f.store, services))
        gateways.push(adapter)
        return {
          ...adapter,
          /** 只对 request 加合法外层空白，不能改变 payload 或登记身份。 */
          encode(frame, direction) {
            const raw = adapter.encode(frame, direction)
            return frame.type === 'request' ? ' \n' + raw + '\t ' : raw
          },
          /** 沿用真实 Gateway Wire 解码，失败只记录安全错误码供组合断言。 */
          decode(input, direction) {
            try {
              if (JSON.parse(typeof input === 'string' ? input : Buffer.from(input).toString()).type === 'response') {
                state.receivedResponses++
              }
            } catch {
              /* 非 JSON 仍交原 decoder 拒绝，不改变真实校验错误。 */
            }
            const frame = trace(
              'decode',
              /** 用原 adapter 和实际方向校验收到的帧。 */
              () => adapter.decode(input, direction)
            )
            return frame
          },
          /** 观察原帧与原去重窗，不通过新 adapter 绕过已登记消息。 */
          observeMessage(frame, direction) {
            return trace(
              'observe',
              /** 保留原 adapter 的消息身份、当前许可和去重行为。 */
              () => adapter.observeMessage(frame, direction)
            )
          }
        }
      }
    }
  )
  const devices = new Map<string, ReturnType<typeof f.pair>>()
  const clients: ReturnType<typeof createConnector>[] = []
  const sessions: { connection: Connection; wire: ConnectorWireSession; rpc: LuvusRpcAdapter }[] = []
  const state: {
    auth: number
    claim: number
    hook: number
    closed: number
    subscriptions: number
    badBinding: boolean
    failClaim: boolean
    requests: string[]
    nativeCompleted: number
    receivedResponses: number
    rpcErrors: { code: string; outcome?: string }[]
    /** 在 auth 返回前制造有界等待或撤权，所有改变仅作用于本测试资源。 */
    beforeAuth?: (binding: AttemptBinding) => Promise<void>
    /** 在实际原生响应验证后阻塞 hook 返回，用于旧 epoch 迟到响应的隔离回归。 */
    afterDispatch?: (binding: AttemptBinding) => Promise<void>
  } = {
    auth: 0,
    claim: 0,
    hook: 0,
    closed: 0,
    subscriptions: 0,
    badBinding: false,
    failClaim: false,
    requests: [],
    nativeCompleted: 0,
    receivedResponses: 0,
    rpcErrors: []
  }
  native.respond(
    /** 按每个实际原生请求的登记 id 返回深层 error.data，不由 transport 重新分配 id。 */
    (socket, input) => {
      const request = JSON.parse(input.trim().split('\n').at(-1)!)
      socket.end(JSON.stringify({ ...native.response, id: request.id }) + '\n')
    }
  )
  return {
    f,
    native,
    state,
    sessions,
    gateways,
    failures,
    /** 创建已有 Store 注册/配对流程的纯 mock 设备，不提供生产管理接口。 */
    pair(name: string) {
      const device = f.pair(name)
      devices.set(device.machine_id, device)
      return device
    },
    /** 每个 welcome 新建 Wire 与 Luvus adapter，关闭时销毁该 epoch 的全部私有状态。 */
    connect(device: ReturnType<typeof f.pair>, override: Partial<WireConnectorOptions> = {}) {
      const client = createConnector({
        url: f.gateway.url,
        developmentLoopback: true,
        offer,
        /** 仅向本次 loopback Gateway 提供 fixture 中已兑换的凭据。 */
        credential: () => device.credential,
        /** 提供与真实持久 backend 相同的受控时钟。 */
        now: () => f.now,
        limits: {
          heartbeat_ms: 100,
          idle_ms: 10_000,
          handshake_ms: 1000,
          reconnect_ms: 20,
          reconnect_max_ms: 200,
          frame_bytes: options.frameBytes ?? 1_048_576
        },
        /** 固定退避采样，防止测试在关闭后无界尝试。 */
        random: () => 1,
        /** 从实际认证连接构造独立后端，不借用最近上线设备的状态。 */
        session(connection) {
          const device = devices.get(connection.machine_id)!
          const base = f.session(connection)
          const backend = persistentBackend(f.store, f.backendServices(connection))
          const subscribe = backend.subscribeInvalidation!
          backend.subscribeInvalidation =
            /** 统计本机 RPC 私有 Wire 的订阅，不替代真实 Store 的提交后失效通知。 */
            (listener) => {
              state.subscriptions++
              const unsubscribe = subscribe(listener)
              return (
                /** 本机 adapter 关闭时释放自己的原始订阅，不能关闭其它设备资源。 */
                () => {
                  state.subscriptions--
                  unsubscribe()
                }
              )
            }
          const rpc = new LuvusRpcAdapter(
            {
              ...native.config,
              target: device.target as typeof native.config.target,
              config_ref: 'mock_config',
              ...(options.nativeLimits ? { limits: options.nativeLimits } : {})
            },
            {
              backend,
              verifyPeer: native.host.verifyPeer,
              /** 仅返回本 fixture 的无生产效力 token，并允许测试阻塞 auth 以检查取消收敛。 */
              async nativeAuth(binding) {
                state.auth++
                await state.beforeAuth?.(binding)
                return native.state.auth
              },
              /** 独立临时 SQLite 原子登记唯一 attempt；不再次调用 Store.dispatch 冒充发送 claim。 */
              async claimDispatch(binding) {
                state.claim++
                if (state.failClaim) {
                  fail('mock_claim_denied')
                }
                f.store.assertConnection(binding)
                assertBinding(f.store.attempt(binding.call_id, binding.attempt_id)!.binding, binding)
                if (f.now >= binding.registration.deadline) {
                  fail('deadline_exceeded')
                }
                claims
                  .prepare('INSERT INTO claims VALUES(?,?,?)')
                  .run(binding.call_id, binding.attempt_id, boundedJson(binding))
              }
            }
          )
          const wire: ConnectorWireSession = {
            ...base,
            /** 不解析或重包装 raw；实际 Luvus adapter 自己核验原请求、唯一 claim 并仅注入一次 auth。 */
            async executeWire(raw, signal) {
              state.hook++
              state.requests.push(raw)
              let result
              try {
                result = await rpc.dispatch(raw, signal)
              } catch (error) {
                state.rpcErrors.push({
                  code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown',
                  ...(error instanceof Error && 'outcome' in error ? { outcome: String(error.outcome) } : {})
                })
                throw error
              }
              state.nativeCompleted++
              await state.afterDispatch?.(result.binding)
              return state.badBinding
                ? { ...result, binding: { ...result.binding, attempt_id: 'wrong_attempt' } }
                : result
            },
            /** transport 已先关闭本会话 Wire，再关闭原生 adapter 及其活动 IO 与私有 Wire。 */
            close() {
              state.closed++
              rpc.close()
              base.close()
            }
          }
          sessions.push({ connection, wire, rpc })
          return wire
        },
        ...override
      })
      clients.push(client)
      return client
    },
    /** 等待指定客户端收到真实 welcome 并按本机配置进入 ready。 */
    async ready(...clients: ReturnType<typeof createConnector>[]) {
      await until(
        /** 每个指定设备都必须独立 ready，不能只观察 Gateway 上的 TCP 连接数。 */
        () =>
          clients.every(
            /** 单设备必须在新 epoch 的原生 readiness 门禁通过后报告 ready。 */
            (client) => client.status().phase === 'ready'
          ),
        8000
      )
    },
    /** 返回真实临时唯一发送登记的行数，不把收到 accepted 当作成功 claim。 */
    claimCount() {
      return Number(claims.prepare('SELECT COUNT(*) n FROM claims').get()!.n)
    },
    /** 停止所有会话和自建 listener，最后删除仅属于本 fixture 的私有安装与 claim 库。 */
    async close() {
      for (const client of clients) {
        client.stop()
      }
      f.stop()
      claims.close()
      await native.close()
    }
  }
}
