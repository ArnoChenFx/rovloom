// 通过真实 loopback/Wire 与合成资源验证 epoch 快照交付、去重、失效和同步契约；不启动原生或声明来源可信。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hash, boundedJson } from '../../src/wire/index.js'
import type { ProviderSnapshot } from '../../src/wire/index.js'
import { createGateway } from '../../src/transport/gateway.js'
import { source } from '../wire/helpers.js'
import { G } from '../connector/luvus/contract/helpers.js'
import { fixture, rawConnect, until } from './helpers.js'

const offer = { major: 2, minor: 0, capabilities: ['rpc', 'provider_snapshot'], required: ['rpc', 'provider_snapshot'] }
const optionalOffer = { ...offer, required: ['rpc'] }

/** 深冻结本测试自己建立的纯快照，不冻结或读取任何产品/native资源。 */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}

/** 每个实际认证连接都有独立合成 registry；接收端只测试通道边界，不能代替生产 pin/caps 验证。 */
function prepared(receiver = true) {
  const state: {
    live: boolean
    rows: readonly ProviderSnapshot[]
    getters: number
    deliveries: { epoch: string; snapshot: ProviderSnapshot }[]
    active: Map<string, ProviderSnapshot>
    beforeGet?: () => void
    beforeNativeInput?: () => void
    onAccept?: (snapshot: ProviderSnapshot) => void
  } = { live: true, rows: [], getters: 0, deliveries: [], active: new Map() }
  const f = fixture({
    offer,
    /** 原 Gateway session 的实际连接闭包限定接收范围，关闭仅清当前 epoch。 */
    session(connection, channel) {
      const base = f.session(connection, channel)
      const installed = new Map<string, ProviderSnapshot>()
      return {
        ...base,
        ...(receiver
          ? {
              /** 这里只收集真实 Wire 投递的测试元数据，生产必须另外完整验证 pin 与 capabilities。 */
              acceptProviderSnapshot(snapshot: ProviderSnapshot) {
                state.deliveries.push({ epoch: connection.connection_epoch, snapshot: structuredClone(snapshot) })
                installed.set(snapshot.binding.provider_id, snapshot)
                state.active.set(connection.connection_epoch, snapshot)
                return state.onAccept?.(snapshot)
              }
            }
          : {}),
        /** Gateway 的 native_ready 只有当前 epoch registry 收到快照后才有测试依据。 */
        readiness() {
          const readiness = base.readiness()
          return {
            ...readiness,
            providers: readiness.providers.map(
              /** 未接纳的 provider 不因为设备已认证就 ready。 */ (item) => ({
                ...item,
                native_ready: item.native_ready && installed.has(item.expected.provider_id)
              })
            )
          }
        },
        /** 断开后原 epoch 的 registry 即失效，不能供重连使用。 */
        close() {
          installed.clear()
          state.active.delete(connection.connection_epoch)
          base.close()
        }
      }
    }
  })
  const device = f.pair('mock_snapshot')
  const capabilities = { id: 'mock_caps', result: { session: 'synthetic', server_generation: G } }
  state.rows = freeze([
    {
      binding: f.store.provider(device.machine_id, device.target.provider_id)!,
      target: structuredClone(device.target),
      source: { ...source, runtime_generation: G, classification_revision: 'review1' },
      capabilities,
      capability_revision: hash(boundedJson(capabilities.result))
    }
  ])
  return {
    f,
    state,
    device,
    /** 由合成真实资源 getter 供给稳定深冻结数据；失效时抛错，不在同 epoch 换 generation。 */
    connect(getter = true) {
      return f.connector(/** 仅使用本测试独立配对得到的设备凭据。 */ () => device.credential, {
        offer,
        limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 150, reconnect_ms: 2000, reconnect_max_ms: 2000 },
        /** Connector 每 epoch 仍创建独立原 Wire，native readiness 来自原 fixture。 */
        session(connection) {
          return {
            ...f.session(connection),
            ...(getter
              ? {
                  /** tick 中只复核此轻量来源状态，已冻结 caps 不重新生成。 */
                  providerSnapshot() {
                    state.getters++
                    state.beforeGet?.()
                    if (!state.live) {
                      throw new Error('synthetic_source_closed')
                    }
                    return state.rows
                  }
                }
              : {})
          }
        },
        /** 保留原请求完整字段，只为模拟 native 注入无生产效力 auth。 */
        nativeInput(input) {
          state.beforeNativeInput?.()
          return { ...input, auth: { delegated_token: 'MOCK_ONLY' } }
        }
      })
    },
    /** 手工客户端用于发送重复/冲突元数据，不代表可信 native source。 */
    raw() {
      return rawConnect(f.gateway.url, device.credential, offer)
    }
  }
}

test(
  'welcome 后同 epoch 只交付一次快照，心跳不会重新发送，断连销毁 registry',
  /** 单帧直接走原 adapter.encode；已认证但没接纳快照时不能报告 Gateway ready。 */ async () => {
    const p = prepared()
    try {
      const client = p.connect()
      await until(
        /** 等 Gateway 接纳和 Connector 原 native readiness 都完成。 */ () =>
          client.status().phase === 'ready' && p.f.gateway.status().devices[0]?.ready === true
      )
      const epoch = client.status().connection_epoch
      await until(
        /** 观察至少两次原心跳，不靠固定睡眠判断是否重发。 */ () =>
          p.f.encoded.filter(
            /** 只统计真实编码的 Connector/Gateway heartbeat。 */ (raw) => JSON.parse(raw).type === 'heartbeat'
          ).length >= 4
      )
      assert.equal(p.state.deliveries.length, 1)
      assert.equal(p.state.deliveries[0]!.epoch, epoch)
      assert.equal(p.state.active.size, 1)
      assert(p.state.getters > 1)
      assert.equal(
        p.f.encoded.filter(/** 原 socket 只编码一次来源快照。 */ (raw) => JSON.parse(raw).type === 'provider_snapshot')
          .length,
        1
      )
      client.stop()
      await until(/** 等当前实际通道关闭，而不是仅观察本地close请求。 */ () => p.f.gateway.status().connections === 0)
      assert.equal(p.state.active.size, 0)
      assert.equal(p.f.executions, 0)
    } finally {
      p.f.stop()
    }
  }
)

test(
  '相同消息及新ID同内容快照幂等，改变 generation 关闭 epoch且不第二次投递',
  /** ReceiveWindow、原 MessageWindow 和 provider fingerprint 都在实际接收路径执行。 */ async () => {
    const p = prepared()
    const raw = p.raw()
    try {
      await until(/** 手工消息必须使用此真实 welcome 的 epoch。 */ () => !!raw.epoch)
      const frame = {
        protocol_major: 2,
        protocol_minor: 0,
        type: 'provider_snapshot',
        message_id: randomUUID(),
        machine_id: p.device.machine_id,
        recovery_generation: p.device.credential.recovery_generation,
        connection_epoch: raw.epoch,
        payload: p.state.rows[0]
      }
      raw.ws.send(JSON.stringify(frame))
      await until(/** 首条真实投递完成后才发送重复。 */ () => p.state.deliveries.length === 1)
      raw.ws.send(JSON.stringify(frame))
      raw.ws.send(JSON.stringify({ ...frame, message_id: randomUUID() }))
      raw.ws.send(
        JSON.stringify({
          ...frame,
          message_id: randomUUID(),
          payload: {
            ...p.state.rows[0]!,
            source: { ...p.state.rows[0]!.source, runtime_generation: 'changed_generation' }
          }
        })
      )
      await until(/** 冲突只关闭原 epoch，不替换已接纳的实例来源。 */ () => raw.ws.readyState === WebSocket.CLOSED)
      assert.equal(p.state.deliveries.length, 1)
      assert.equal(p.state.active.size, 0)
      assert.equal(p.f.executions, 0)
    } finally {
      raw.ws.close()
      p.f.stop()
    }
  }
)

for (const kind of ['missing_getter', 'not_frozen', 'too_large', 'duplicate_provider', 'changed', 'closed'] as const) {
  test(
    `协商后的来源 ${kind} 关闭 WSS，不重发快照或执行原生`,
    /** 缺资源、可变对象、预算错误及来源变化都不能留在同epoch继续服务。 */ async () => {
      const p = prepared()
      try {
        if (kind === 'not_frozen') {
          p.state.rows = structuredClone(p.state.rows)
        } else if (kind === 'too_large') {
          p.state.rows = freeze([{ ...p.state.rows[0]!, capabilities: { data: 'x'.repeat(1_048_576) } }])
        } else if (kind === 'duplicate_provider') {
          p.state.rows = freeze([p.state.rows[0]!, p.state.rows[0]!])
        }
        const client = p.connect(kind !== 'missing_getter')
        if (kind === 'changed' || kind === 'closed') {
          await until(/** 先确立唯一原快照，随后检查同epoch失效。 */ () => p.state.deliveries.length === 1)
          if (kind === 'changed') {
            p.state.rows = freeze([
              { ...p.state.rows[0]!, source: { ...p.state.rows[0]!.source, runtime_generation: 'new_generation' } }
            ])
          } else {
            p.state.live = false
          }
        }
        await until(/** 等实际关闭进入有界退避，不允许原epoch刷新或重复投递。 */ () => client.status().reconnects > 0)
        await until(
          /** 客户端发起关闭后仍须等Gateway消费实际socket关闭事件。 */ () => p.f.gateway.status().connections === 0
        )
        assert.equal(p.f.gateway.status().connections, 0)
        assert.equal(p.state.deliveries.length, kind === 'changed' || kind === 'closed' ? 1 : 0)
        assert.equal(p.state.active.size, 0)
        assert.equal(p.f.executions, 0)
      } finally {
        p.f.stop()
      }
    }
  )
}

test(
  '缺同步Gateway接收端口时拒绝协商会话，违规异步端口晚拒绝被消费',
  /** 源能力不能静默降级，异步实现不能冒充 registry 已完成接纳。 */ async () => {
    const missing = prepared(false)
    const raw = missing.raw()
    try {
      await until(/** 缺端口在welcome前就关闭。 */ () => raw.ws.readyState === WebSocket.CLOSED)
      assert.equal(raw.epoch, '')
    } finally {
      raw.ws.close()
      missing.f.stop()
    }
    const p = prepared()
    let unhandled = 0
    const rejected = /** 仅统计本回归晚到拒绝，不输出错误内容。 */ () => {
      unhandled++
    }
    process.on('unhandledRejection', rejected)
    try {
      p.state.onAccept = /** 故意违反同步端口约定，不能视作接纳已完成。 */ () =>
        Promise.reject(new Error('synthetic_async_receiver'))
      const client = p.connect()
      await until(/** 等违规端口导致实际连接被关闭。 */ () => client.status().reconnects > 0)
      assert.equal(p.state.active.size, 0)
      assert.equal(unhandled, 0)
      assert.equal(p.f.executions, 0)
    } finally {
      process.off('unhandledRejection', rejected)
      p.f.stop()
    }
  }
)

test(
  '请求完整帧准备期间来源失效时，在真实执行前关闭且旧调用保持unknown',
  /** 实际派发已提交后仍复核 snapshot getter，accepted不能变成执行许可。 */ async () => {
    const p = prepared()
    try {
      const client = p.connect()
      await until(
        /** 必须先有当前epoch的实际快照和ready。 */ () =>
          client.status().phase === 'ready' && p.state.deliveries.length === 1
      )
      p.state.beforeNativeInput = /** 模拟准备帧的宿主回调同步使来源失效。 */ () => {
        p.state.live = false
      }
      const call = p.f.call(p.device.target)
      p.f.gateway.dispatch(call.call_id)
      await until(
        /** 等原通道关闭后的真实账本保守状态。 */ () =>
          p.f.store.call(p.f.principal.id, call.call_id).state === 'outcome_unknown'
      )
      assert.equal(p.f.executions, 0)
      assert.equal(p.state.deliveries.length, 1)
      assert.equal(p.state.active.size, 0)
    } finally {
      p.f.stop()
    }
  }
)

test(
  '接收端同步关闭Gateway后不返回ready，原session资源仍完整清理',
  /** 新快照回调也受同一关闭fence，不能在callback后复活连接。 */ async () => {
    const p = prepared()
    try {
      p.state.onAccept = /** 在真实接收hook内模拟角色关闭。 */ () => p.f.gateway.stop()
      const client = p.connect()
      await until(/** 等Connector确认socket关闭。 */ () => client.status().reconnects > 0)
      assert.equal(p.f.gateway.status().stopped, true)
      assert.equal(p.f.gateway.status().connections, 0)
      assert.equal(p.state.active.size, 0)
      assert.equal(p.f.executions, 0)
    } finally {
      p.f.stop()
    }
  }
)

test(
  '同一全局广告按静态机器名单强制远端快照，本机无快照端口仍完成rpc认证',
  /** 使用两台真实配对的合成机器证明能力不跨机器泄漏，远端缺能力不能降级。 */ async () => {
    const f = fixture()
    const remote = f.pair('mock_remote')
    const local = f.pair('mock_local')
    f.gateway.stop()
    const machines = [remote.machine_id]
    let deliveries = 0
    const rows = freeze([
      {
        binding: f.store.provider(remote.machine_id, remote.target.provider_id)!,
        target: structuredClone(remote.target),
        source: { ...source, runtime_generation: G, classification_revision: 'review1' },
        capabilities: { result: { session: 'synthetic', server_generation: G } },
        capability_revision: 'a'.repeat(64)
      }
    ])
    const gateway = createGateway({
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      identity: f.credentials,
      store: f.store,
      router: f.router,
      /** caller仍来自受保护测试宿主，不从连接帧取得。 */
      principal: () => f.principal,
      offer: optionalOffer,
      providerSnapshotMachines: machines,
      limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 150 },
      /** 仅远端提供接收端；本机保持原session且没有快照receiver。 */
      session(connection, channel) {
        const base = f.session(connection, channel)
        return connection.machine_id === remote.machine_id
          ? {
              ...base,
              /** 仅计数当前认证远端快照，本测试不代替runtime来源核验。 */
              acceptProviderSnapshot() {
                deliveries++
              }
            }
          : base
      }
    })
    // 调用方修改原数组不能改写已经交付的受信静态名单。
    machines.splice(0, 1, local.machine_id)
    const missing = rawConnect(gateway.url, remote.credential)
    try {
      await until(
        /** 远端只广告rpc时在welcome前拒绝，不能把required快照降级。 */ () => missing.ws.readyState === WebSocket.CLOSED
      )
      assert.equal(missing.epoch, '')
      assert.equal(f.sessions.opened, 0)
      const remoteClient = f.connector(/** 远端仍使用它独立配对的凭据。 */ () => remote.credential, {
        url: gateway.url,
        offer: optionalOffer,
        /** 远端来源只交付固定深冻结快照，不为本机添加getter。 */
        session(connection) {
          return {
            ...f.session(connection),
            /** 每次只复核同一个合成来源对象，不能更换generation。 */
            providerSnapshot: () => rows
          }
        }
      })
      const localClient = f.connector(/** 本机凭据不能取得远端的协商能力。 */ () => local.credential, {
        url: gateway.url,
        offer: optionalOffer
      })
      await until(
        /** 两个实际socket同时ready；本机既没有getter也没有receiver。 */ () =>
          remoteClient.status().phase === 'ready' && localClient.status().phase === 'ready' && deliveries === 1
      )
      assert.deepEqual(gateway.currentConnection(remote.machine_id)?.negotiated.capabilities, [
        'provider_snapshot',
        'rpc'
      ])
      assert.deepEqual(gateway.currentConnection(local.machine_id)?.negotiated.capabilities, ['rpc'])
      assert.equal(f.executions, 0)
    } finally {
      missing.ws.close()
      gateway.stop()
      f.stop()
    }
  }
)

test(
  '全局必需快照与机器排除冲突时拒绝握手，名单配置在listener启动前有界校验',
  /** 空名单不剥除全局required；坏名单或未广告能力均不能创建可用通道。 */ async () => {
    const f = fixture()
    const device = f.pair('mock_excluded')
    f.gateway.stop()
    const base = {
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      identity: f.credentials,
      store: f.store,
      router: f.router,
      /** 配置校验也不引入新的caller来源。 */
      principal: () => f.principal,
      session: f.session,
      offer
    }
    try {
      for (const machines of [
        [device.machine_id, device.machine_id],
        ['bad id'],
        Array.from({ length: 65 }, /** 超过静态名单上限。 */ (_, i) => 'machine_' + i)
      ]) {
        assert.throws(
          /** 无效静态名单不启动listener或建立epoch。 */ () =>
            createGateway({ ...base, providerSnapshotMachines: machines })
        )
      }
      assert.throws(
        /** 名单内强制能力必须已经由受信全局offer广告。 */ () =>
          createGateway({
            ...base,
            offer: { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] },
            providerSnapshotMachines: [device.machine_id]
          }),
        /required_capability_unsupported/
      )
      const gateway = createGateway({ ...base, providerSnapshotMachines: [] })
      const raw = rawConnect(gateway.url, device.credential, offer)
      try {
        await until(
          /** 即使对端支持快照，排除与全局required冲突仍拒绝。 */ () => raw.ws.readyState === WebSocket.CLOSED
        )
        assert.equal(raw.epoch, '')
        assert.equal(f.sessions.opened, 0)
      } finally {
        raw.ws.close()
        gateway.stop()
      }
    } finally {
      f.stop()
    }
  }
)
