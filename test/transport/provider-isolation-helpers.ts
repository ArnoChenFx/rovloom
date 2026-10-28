// 双 provider 的来源/执行是明确合成 stub；原 Store、认证 loopback、Wire/native validator 和状态提交保持真实。
import { composeConnectorSessions, composeGatewaySessions } from '../../src/runtime/provider-sessions.js'
import type { ProviderSessionGroup } from '../../src/runtime/provider-sessions.js'
import { createConnector } from '../../src/transport/connector.js'
import type { ConnectorWireSession } from '../../src/transport/connector.js'
import type { Connection, Session, SocketChannel } from '../../src/transport/index.js'
import { boundedJson, hash } from '../../src/wire/index.js'
import type { AttemptBinding, ProviderBinding, ProviderSnapshot, V2Target } from '../../src/wire/types.js'
import { fixture } from './helpers.js'
import { source } from '../wire/helpers.js'
import { G } from '../native-contract/helpers.js'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import type { NativeContractRecord } from '../../src/wire/backend.js'

/** 只冻结合成纯数据，不冻结任何产品 owner、schema handle 或原生许可。 */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}

/** 同一合成设备的两个原 provider 有独立 Wire/owner，只共享生产 transport 的认证连接。 */
export function providerIsolationFixture(discovered?: NativeContractRecord, terminalState?: Map<string, boolean>) {
  const offer = {
    major: 2,
    minor: 0,
    capabilities: [
      'rpc',
      'provider_snapshot',
      'provider_fence',
      'dispatch_refusal',
      ...(terminalState ? ['terminal_execution_state'] : [])
    ],
    required: ['rpc', 'provider_snapshot', 'provider_fence', 'dispatch_refusal']
  }
  const state = {
    connector: new Map<string, boolean>(),
    gateway: new Map<string, boolean>(),
    changed: new Set<string>(),
    failOnSnapshot: new Set<string>(),
    sources: [] as {
      side: 'gateway' | 'connector'
      provider: string
      epoch: string
      gets: number
      closed: boolean
      closes: number
    }[],
    responses: [] as { side: 'gateway' | 'connector'; provider: string; call: string }[],
    executions: [] as AttemptBinding[],
    heartbeats: { gateway: 0, connector: 0 },
    received: [] as { side: 'gateway' | 'connector'; call: string; type: 'response' | 'dispatch_refused' }[],
    beforeRefusalSend: undefined as undefined | (() => void)
  }
  const work = new Map<string, { signal: AbortSignal; finish(): void; refuse(): void }>()
  const clients: ReturnType<typeof createConnector>[] = []
  const f = fixture(
    {
      offer,
      retainOriginalRead: true,
      limits: { heartbeat_ms: 30, idle_ms: 3000, handshake_ms: 500 },
      /** 只用原 fixture 的独立 backend 构造每实例真实 Wire，不从广告建立安装来源。 */
      session(connection, channel) {
        return observe(
          composeGatewaySessions(
            connection,
            groups(connection, 'gateway', channel),
            /** 与 Store 同一可信时间。 */ () => f.now
          ),
          'gateway'
        )
      }
    },
    {},
    discovered
      ? {
          contract: {
            source: discovered.wire.source,
            compiled: discovered.compiled,
            identity: discovered.compiled.identity,
            capabilities: discovered.capabilities,
            capability_revision: discovered.capability_revision
          }
        }
      : {}
  )
  const device = f.pair('synthetic_provider_isolation')
  const second = f.store.defineProvider({
    ...f.store.provider(device.machine_id, device.target.provider_id)!,
    provider_id: 'second'
  })
  f.localBindings.set(device.machine_id + '/second', second)
  const targets = [device.target, { ...device.target, provider_id: 'second' }] as V2Target[]
  for (const target of targets) {
    state.connector.set(target.provider_id, true)
    state.gateway.set(target.provider_id, true)
  }

  /** 只记录真实 transport 调用原 codec 的次数，不改帧、不造认证或 native 成功。 */
  function observe<T extends Session>(session: T, side: 'gateway' | 'connector'): T {
    const original = session.adapter
    session.adapter = {
      ...original,
      /** 发送计数必须在原 codec 完整通过后递增。 */ encode(frame, direction) {
        const raw = original.encode(frame, direction)
        if (frame.type === 'heartbeat') {
          state.heartbeats[side]++
        }
        if (frame.type === 'dispatch_refused') {
          state.beforeRefusalSend?.()
        }
        return raw
      },
      /** 记录实际收到的合成响应，再完整交原 decoder 决定接受或丢弃。 */ decode(raw, direction) {
        const hint = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString())
        if (hint.type === 'response' || hint.type === 'dispatch_refused') {
          state.received.push({ side, call: hint.payload.attempt.call_id, type: hint.type })
        }
        return original.decode(raw, direction)
      }
    }
    return session
  }

  /** 所有来源数值均为固定合成安装元数据；Wire 仍校验其真实字段、方向及连接绑定。 */
  function snapshot(binding: ProviderBinding, target: V2Target, generation = G): readonly ProviderSnapshot[] {
    const capabilities = discovered
      ? (structuredClone(discovered.capabilities) as { result: { server_generation: string } })
      : { id: 'synthetic_caps', result: { session: 'synthetic', server_generation: generation } }
    capabilities.result.server_generation = generation
    return freeze([
      {
        binding: structuredClone(binding),
        target: structuredClone(target),
        source: {
          ...(discovered?.wire.source ?? source),
          runtime_generation: generation,
          classification_revision: discovered?.wire.source.classification_revision ?? 'review1'
        },
        capabilities,
        capability_revision: hash(boundedJson(capabilities.result))
      }
    ])
  }

  /** 每个 epoch/provider 都建立原会话；关闭一个 owner 不改变另一原端口或底层测试健康开关。 */
  function groups(
    connection: Connection,
    side: 'gateway' | 'connector',
    channel?: SocketChannel
  ): ProviderSessionGroup<ConnectorWireSession>[] {
    return targets.map(
      /** 路由取受保护 fixture 配置，禁止从消息补造 provider。 */ (target) => {
        const binding = f.localBindings.get(target.machine_id + '/' + target.provider_id)!
        const base = f.session(connection, channel)
        const record = {
          side,
          provider: target.provider_id,
          epoch: connection.connection_epoch,
          gets: 0,
          closed: false,
          closes: 0
        }
        state.sources.push(record)
        let installed = side === 'connector'
        const initial = snapshot(binding, target)
        const replacement = snapshot(binding, target, 'f'.repeat(32))
        const session: ConnectorWireSession = {
          ...(side === 'connector' && terminalState
            ? {
                terminalExecutionState: /** 只报告受测原owner的合成本地配置，不生成许可。 */ () => [
                  { binding, enabled: terminalState.get(target.provider_id) === true }
                ]
              }
            : {}),
          adapter: {
            ...base.adapter,
            /** 仅记录已走原 encoder 的响应，不伪造发送或改变原帧。 */ encode(frame, direction) {
              const raw = base.adapter.encode(frame, direction)
              if (frame.type === 'response') {
                state.responses.push({ side, provider: target.provider_id, call: frame.payload.attempt.call_id })
              }
              return raw
            }
          },
          /** 来源 stub 只决定此实例健康；真实双端配置和政策仍由原 fixture 查询。 */ readiness() {
            const current = base.readiness()
            return {
              ...current,
              providers: current.providers
                .filter(
                  /** 原 session 只交付当前完整 provider 的观测。 */ (provider) =>
                    provider.local.provider_id === target.provider_id
                )
                .map(
                  /** 失效或尚未接纳快照时不得 ready。 */ (provider) => ({
                    ...provider,
                    native_ready:
                      provider.native_ready &&
                      state[side].get(target.provider_id) === true &&
                      !record.closed &&
                      installed
                  })
                )
            }
          },
          ...(side === 'gateway'
            ? {
                /** 合成 registry 不代表安装 pin 验收；只接受当前原配置和同 epoch 的合法来源元数据。 */ acceptProviderSnapshot(
                  value: ProviderSnapshot
                ) {
                  if (
                    boundedJson(value.binding) !== boundedJson(binding) ||
                    boundedJson(value.target) !== boundedJson(target) ||
                    record.closed
                  ) {
                    throw new Error('synthetic_snapshot_rejected')
                  }
                  installed = true
                }
              }
            : {
                /** 返回稳定原纯数据；测试替换来源时，新对象不得在同 epoch 被接纳。 */ providerSnapshot() {
                  record.gets++
                  if (state.failOnSnapshot.delete(target.provider_id)) {
                    state.connector.set(target.provider_id, false)
                  }
                  if (record.closed) {
                    throw new Error('synthetic_source_closed')
                  }
                  return state.changed.has(target.provider_id) ? replacement : initial
                }
              }),
          /** 执行是明确的合成服务 stub；原 transport 已用同一真实 Wire 验证请求和许可。 */ executeWire(raw, signal) {
            if (side !== 'connector' || record.closed) {
              return Promise.reject(new Error('synthetic_execution_unavailable'))
            }
            const request = JSON.parse(raw)
            const execution: AttemptBinding = {
              machine_id: request.machine_id,
              recovery_generation: request.recovery_generation,
              connection_epoch: request.connection_epoch,
              ...request.payload.attempt
            }
            state.executions.push(execution)
            return new Promise(
              /** 故意忽略 abort，模拟本地停止观察不能证明原生工作停止。 */ (resolve, reject) => {
                work.set(execution.call_id, {
                  signal,
                  /** 返回固定合成回包，仍须经过原响应校验和真实 Store 提交。 */ finish() {
                    resolve({
                      binding: execution,
                      native_response: { id: execution.native_request_id, result: { id: 'synthetic_task' } }
                    })
                  },
                  /** 仅模拟固定确定未写出异常，不声称实际原生终端门禁已经执行。 */ refuse() {
                    reject(new LuvusAdapterError('terminal_execution_disabled', 'not_dispatched'))
                  }
                })
              }
            )
          },
          /** 同步撤去此 epoch 的合成来源，真实 Wire 由组合层先关闭。 */ close() {
            if (record.closed) {
              return
            }
            record.closed = true
            record.closes++
            installed = false
            base.close()
          }
        }
        return { providers: [{ binding, target }], session }
      }
    )
  }

  return {
    f,
    device,
    targets,
    state,
    work,
    /** 每次显式新建客户端才产生新 epoch；provider 故障本身不得触发此重连。 */ connect() {
      const client = createConnector({
        url: f.gateway.url,
        developmentLoopback: true,
        offer,
        credential: /** 仅使用隔离 fixture 的无生产效力身份。 */ () => device.credential,
        now: /** 与真实 Store 一致的测试时钟。 */ () => f.now,
        limits: { heartbeat_ms: 30, idle_ms: 3000, handshake_ms: 500, reconnect_ms: 2000, reconnect_max_ms: 2000 },
        session: /** 实际 welcome 后建立每实例原 Wire 和合成执行端口。 */ (connection) =>
          observe(
            composeConnectorSessions(
              connection,
              groups(connection, 'connector'),
              /** 不续期原登记 deadline。 */ () => f.now
            ),
            'connector'
          )
      })
      clients.push(client)
      return client
    },
    /** 先释放全部合成等待，再停止本测试客户端、listener 和私有 Store。 */ stop() {
      for (const pending of work.values()) {
        pending.finish()
      }
      for (const client of clients) {
        client.stop()
      }
      f.stop()
    }
  }
}
