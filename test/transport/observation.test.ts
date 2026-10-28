// 用真实 loopback 与 Store 验证 transport 只读观测的来源、心跳时刻、epoch 隔离及 provider 失效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createGateway } from '../../src/transport/index.js'
import type { Adapter, GatewayTransportSnapshot, Readiness, TransportObserved } from '../../src/transport/index.js'
import { fixture, rawConnect, until } from './helpers.js'
import { observationTypes } from './observation-types.js'

void observationTypes

/** 仅解包已经核验的测试观测，拒绝用缺项或未知补造成功事实。 */
function verified<T>(observation: TransportObserved<T>): T {
  assert.equal(observation.verification, 'verified')
  assert(observation.verification === 'verified')
  assert.equal(observation.source, 'gateway_transport')
  return observation.value
}

/** 从本次有界快照查找对应真实连接，不按持久化 online 自行合成条目。 */
function device(snapshot: GatewayTransportSnapshot, machine: string) {
  const found = snapshot.devices.find(
    /** 只选择该稳定设备 ID 对应的观测，防止跨设备借用状态。 */
    (entry) => entry.machine_id === machine
  )
  assert(found)
  return found
}

test(
  '只有本 Gateway 的认证连接成为 verified，持久 online 和未认证帧均不构成观测',
  /** 第二个真实 listener 共享 Store 仍无该 socket，不能把持久状态当作本进程实时连接。 */
  async () => {
    const f = fixture()
    let other: ReturnType<typeof createGateway> | undefined
    const a = f.pair('mock_observed_a')
    const b = f.pair('mock_unverified_b')
    const raw = rawConnect(f.gateway.url, a.credential)
    try {
      const empty = f.gateway.observations.snapshot()
      assert.equal(verified(empty.transport), 'available')
      await until(
        /** 等待真实 welcome，而不是客户端自报的连接字段。 */
        () => !!raw.epoch
      )
      const current = f.gateway.observations.snapshot()
      assert.equal(current.observed_at, f.now)
      assert.equal(current.recovery_generation, f.store.generation())
      assert.equal(verified(device(current, a.machine_id).authentication).state, 'authenticated')
      assert.equal(verified(device(current, a.machine_id).connection).state, 'online')
      assert.equal(current.devices.length, 1)
      const text = JSON.stringify(current)
      assert.equal(text.includes(a.credential.credential), false)
      assert.equal(text.includes(raw.epoch), false)
      assert.equal(text.includes('native_adapter'), false)
      other = createGateway({
        hostname: '127.0.0.1',
        port: 0,
        developmentLoopback: true,
        identity: f.credentials,
        store: f.store,
        router: f.router,
        /** 只沿用测试宿主身份来源，不提供新的管理授权。 */
        principal: () => f.principal,
        session: f.session
      })
      assert.equal(f.store.machine(a.machine_id).status, 'online')
      assert.deepEqual(other.observations.snapshot().devices, [])
      const wrong = rawConnect(f.gateway.url, { ...a.credential, machine_id: b.machine_id })
      try {
        await until(
          /** 错设备凭据被认证宿主拒绝，不留下可冒充 B 的失败或成功记录。 */
          () => wrong.ws.readyState === WebSocket.CLOSED
        )
        assert.equal(f.gateway.observations.snapshot().devices.length, 1)
      } finally {
        wrong.ws.close()
      }
      assert.equal(f.executions, 0)
      assert.equal(Object.isFrozen(current), true)
      assert.equal(Object.isFrozen(current.devices), true)
      assert.equal(Object.isFrozen(device(current, a.machine_id).connection), true)
      assert.equal(Reflect.set(verified(device(current, a.machine_id).connection), 'state', 'offline'), false)
    } finally {
      raw.ws.close()
      other?.stop()
      f.stop()
    }
  }
)

test(
  '真实 heartbeat 接收才更新时间，业务帧、发送心跳、重复帧及取样均不伪造 last heartbeat',
  /** 手动控制合法帧和可信 Store 时钟，验证没有心跳时为 null，接收时刻不是客户端提供的时间。 */
  async () => {
    const f = fixture({ limits: { heartbeat_ms: 20, idle_ms: 10_000, handshake_ms: 1000 } })
    const a = f.pair('mock_heartbeat')
    const raw = rawConnect(f.gateway.url, a.credential)
    try {
      await until(
        /** 等待真实认证提交及欢迎返回。 */
        () => !!raw.epoch
      )
      const initial = f.gateway.observations.snapshot()
      assert.equal(verified(device(initial, a.machine_id).connection).last_heartbeat_at, null)
      f.now = 1200
      await until(
        /** 等待 Gateway 实际发出心跳，但本客户端尚未回心跳。 */
        () =>
          raw.frames.some(
            /** 只检查实际收到的顶层帧类型，不从载荷字段推断接收事件。 */
            (frame) => (frame as { type?: string }).type === 'heartbeat'
          )
      )
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).last_heartbeat_at, null)
      const call = f.call(a.target)
      const binding = f.gateway.dispatch(call.call_id)
      const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
      const base = { protocol_major: 2, protocol_minor: 0, machine_id, recovery_generation, connection_epoch }
      raw.ws.send(JSON.stringify({ ...base, type: 'accepted', message_id: randomUUID(), payload: { attempt } }))
      await until(
        /** accepted 证明业务接收已经完成，仍不能替代 heartbeat。 */
        () => f.store.call(f.principal.id, call.call_id).state === 'connector_accepted'
      )
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).last_heartbeat_at, null)
      f.now = 1400
      const heartbeat = JSON.stringify({
        ...base,
        type: 'heartbeat',
        message_id: randomUUID(),
        payload: { sequence: 0 }
      })
      raw.ws.send(heartbeat)
      await until(
        /** 只有通过序号检查的真实接收，才写入本机可信时刻。 */
        () => verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).last_heartbeat_at === 1400
      )
      const beforeDuplicate = f.gateway.observations.snapshot()
      f.now = 1500
      raw.ws.send(heartbeat)
      await new Promise(
        /** 仅让实际网络重复帧到达，不推进任何服务端时钟。 */
        (resolve) => setTimeout(resolve, 30)
      )
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).last_heartbeat_at, 1400)
      assert.equal(verified(device(beforeDuplicate, a.machine_id).connection).last_heartbeat_at, 1400)
      f.now = 1600
      raw.ws.send(JSON.stringify({ ...base, type: 'heartbeat', message_id: randomUUID(), payload: { sequence: 1 } }))
      await until(
        /** 下一条有序心跳推进接收时刻，未改变旧的冻结快照。 */
        () => verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).last_heartbeat_at === 1600
      )
      assert.equal(verified(device(initial, a.machine_id).connection).last_heartbeat_at, null)
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  'close、fresh epoch 和旧关闭回调正确隔离，stop 不留下 live 观测',
  /** 捕获实际 ChannelRegistry 的旧 socket 清理回调，确认迟到清理不删除新连接。 */
  async () => {
    const f = fixture()
    const closers: (() => void)[] = []
    const open = f.gateway.channels.open.bind(f.gateway.channels)
    f.gateway.channels.open =
      /** 只记录真实注册表调用，不向观测端口提供伪造连接。 */
      (socket, close) => {
        closers.push(close)
        return open(socket, close)
      }
    const a = f.pair('mock_epoch_reference')
    const raw = rawConnect(f.gateway.url, a.credential)
    let fresh: ReturnType<typeof rawConnect> | undefined
    try {
      await until(
        /** 等待原 socket 已被 Gateway 认证。 */
        () => !!raw.epoch
      )
      const old = verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).connection_epoch_ref
      raw.ws.close()
      await until(
        /** 关闭事件移除 live 状态，不把旧认证继续作为当前事实。 */
        () => f.gateway.observations.snapshot().devices.length === 0
      )
      fresh = rawConnect(f.gateway.url, a.credential)
      await until(
        /** 同一稳定设备只有新认证完成后才重新出现。 */
        () => !!fresh?.epoch
      )
      const current = verified(device(f.gateway.observations.snapshot(), a.machine_id).connection)
      assert.notEqual(current.connection_epoch_ref, old)
      assert.notEqual(current.connection_epoch_ref, fresh.epoch)
      assert.equal(current.last_heartbeat_at, null)
      closers[0]!()
      assert.deepEqual(verified(device(f.gateway.observations.snapshot(), a.machine_id).connection), current)
      f.gateway.stop()
      const stopped = f.gateway.observations.snapshot()
      assert.equal(verified(stopped.transport), 'unavailable')
      assert.deepEqual(stopped.devices, [])
    } finally {
      raw.ws.close()
      fresh?.ws.close()
      f.stop()
    }
  }
)

test(
  '旧宿主 readiness 不复活新 revision，异常和回调内关闭不发布伪造状态',
  /** 对宿主回调的过期缓存、异常及同步关闭分别复验，不以旧 ready 填补未知。 */
  async () => {
    let mode: 'cached' | 'throw' | 'close' | 'reenter' = 'cached'
    let cached: Readiness | undefined
    const f: ReturnType<typeof fixture> = fixture({
      /** 每条连接仍创建真实 Wire，只控制宿主已有的只读 readiness 来源。 */
      session(connection, channel) {
        const base = f.session(connection, channel)
        return {
          ...base,
          /** 在真实宿主回调里注入过期、异常、重入或关闭，测试最终复验。 */
          readiness() {
            cached ??= structuredClone(base.readiness())
            if (mode === 'throw') {
              throw new Error('PRIVATE_READINESS_FAILURE_DO_NOT_EXPOSE')
            }
            if (mode === 'close') {
              f.gateway.disconnect(connection.machine_id)
            }
            if (mode === 'reenter') {
              assert.throws(
                /** 重入应固定拒绝，不递归调用更多宿主回调。 */
                () => f.gateway.observations.snapshot(),
                /transport_observation_unavailable/
              )
            }
            return cached
          }
        }
      }
    })
    const a = f.pair('mock_stale_readiness')
    const raw = rawConnect(f.gateway.url, a.credential)
    try {
      await until(
        /** 仅从真实 welcome 判断认证已完成。 */
        () => !!raw.epoch
      )
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).providers[0]!.dispatch_ready), true)
      f.store.setProviderEnabled(a.machine_id, 'provider', 1, false)
      const stale = device(f.gateway.observations.snapshot(), a.machine_id)
      assert.equal(stale.providers[0]!.binding_revision, 2)
      assert.deepEqual(stale.providers[0]!.dispatch_ready, { verification: 'unverified', reason_code: 'stale' })
      mode = 'throw'
      const failed = f.gateway.observations.snapshot()
      assert.equal(verified(device(failed, a.machine_id).authentication).state, 'authenticated')
      assert.deepEqual(device(failed, a.machine_id).providers, [])
      assert.equal(JSON.stringify(failed).includes('PRIVATE_READINESS_FAILURE'), false)
      mode = 'reenter'
      f.gateway.observations.snapshot()
      mode = 'close'
      const closed = f.gateway.observations.snapshot()
      assert.equal(device(closed, a.machine_id).connection.verification, 'unverified')
      assert.deepEqual(f.gateway.observations.snapshot().devices, [])
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  '身份租期或 Store fence 失效即撤回 verified，读取本身不调用断连管理',
  /** 在 timer 尚未运行的同步窗口查询失效状态，证明查询只读而非 status 的清理副作用。 */
  async () => {
    const f = fixture()
    const a = f.pair('mock_invalid_identity')
    const raw = rawConnect(f.gateway.url, a.credential)
    const originalAssert = f.credentials.assert.bind(f.credentials)
    const originalDisconnect = f.credentials.disconnect.bind(f.credentials)
    let deny = false
    let disconnects = 0
    f.credentials.assert =
      /** 独立身份宿主拒绝当前租期，异常原文不允许进入观测。 */
      (...args) => {
        if (deny) {
          throw new Error('PRIVATE_IDENTITY_FAILURE_DO_NOT_EXPOSE')
        }
        originalAssert(...args)
      }
    f.credentials.disconnect =
      /** 统计现有断连管理入口；只读快照不能主动调用它。 */
      (...args) => {
        disconnects++
        originalDisconnect(...args)
      }
    try {
      await until(
        /** 等待当前 socket 完成真实认证。 */
        () => !!raw.epoch
      )
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).state, 'online')
      deny = true
      const denied = f.gateway.observations.snapshot()
      assert.equal(device(denied, a.machine_id).authentication.verification, 'unverified')
      assert.equal(JSON.stringify(denied).includes('PRIVATE_IDENTITY_FAILURE'), false)
      assert.equal(disconnects, 0)
      assert.equal(raw.ws.readyState, WebSocket.OPEN)
      deny = false
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).state, 'online')
      f.credentials.assert =
        /** 身份来源只证明自身租期时，Gateway 仍须独立核对 Store fence。 */
        () => {}
      f.store.disconnect(a.machine_id, raw.epoch)
      const stale = device(f.gateway.observations.snapshot(), a.machine_id)
      assert.equal(stale.connection.verification, 'unverified')
      assert.equal(stale.authentication.verification, 'unverified')
      assert.deepEqual(stale.providers, [])
      assert.equal(disconnects, 0)
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  '较晚设备的宿主回调改变较早设备时，发布前整批撤回旧连接和 provider ready',
  /** A 已采样后由 B 的真实 readiness 回调改变 A，防止逐 peer 复验遗漏跨连接变化。 */
  async () => {
    let first = ''
    let mode: 'none' | 'provider' | 'close' | 'wire' = 'none'
    const adapters = new Map<string, Adapter>()
    const f: ReturnType<typeof fixture> = fixture({
      /** 复用真实 Wire 和宿主 readiness，仅在 B 的读取中触发已授权的测试生命周期动作。 */
      session(connection, channel) {
        const base = f.session(connection, channel)
        adapters.set(connection.machine_id, base.adapter)
        return {
          ...base,
          /** 只改变另一实际 peer，不给观测端口传入任何 asserted 状态。 */
          readiness() {
            if (connection.machine_id !== first) {
              if (mode === 'provider') {
                f.store.setProviderEnabled(first, 'provider', 1, false)
              }
              if (mode === 'close') {
                f.gateway.disconnect(first)
              }
              if (mode === 'wire') {
                adapters.get(first)!.close()
              }
              mode = 'none'
            }
            return base.readiness()
          }
        }
      }
    })
    const a = f.pair('mock_cross_observation_a')
    const b = f.pair('mock_cross_observation_b')
    first = a.machine_id
    const rawA = rawConnect(f.gateway.url, a.credential)
    let rawB: ReturnType<typeof rawConnect> | undefined
    try {
      await until(
        /** 明确让 A 先注册，保证触发此前遗漏的采样顺序。 */
        () => !!rawA.epoch
      )
      rawB = rawConnect(f.gateway.url, b.credential)
      await until(
        /** B 后注册，但在同一快照内仍能改变已经读过的 A。 */
        () => !!rawB?.epoch
      )
      assert.equal(verified(device(f.gateway.observations.snapshot(), first).providers[0]!.dispatch_ready), true)
      mode = 'wire'
      const wireClosed = device(f.gateway.observations.snapshot(), first)
      assert.equal(verified(wireClosed.connection).state, 'online')
      assert.equal(verified(wireClosed.authentication).state, 'authenticated')
      assert.equal(verified(wireClosed.providers[0]!.dispatch_ready), false)
      mode = 'provider'
      const changed = device(f.gateway.observations.snapshot(), first)
      assert.equal(changed.providers[0]!.binding_revision, 2)
      assert.deepEqual(changed.providers[0]!.dispatch_ready, { verification: 'unverified', reason_code: 'stale' })
      mode = 'close'
      const closed = f.gateway.observations.snapshot()
      assert.equal(device(closed, first).connection.verification, 'unverified')
      assert.deepEqual(device(closed, first).providers, [])
      assert.equal(verified(device(closed, b.machine_id).connection).state, 'online')
      assert.equal(f.executions, 0)
    } finally {
      rawA.ws.close()
      rawB?.ws.close()
      f.stop()
    }
  }
)

test(
  '宿主异常的取码 getter 或类型转换不能泄漏原文或破坏后续取样',
  /** 不信任异常对象的附带行为；异常分类失败也只能给出固定未知原因。 */
  async () => {
    const f = fixture()
    const a = f.pair('mock_hostile_observation_error')
    const raw = rawConnect(f.gateway.url, a.credential)
    const originalAssert = f.credentials.assert.bind(f.credentials)
    try {
      await until(
        /** 先建立真实认证 peer，再使身份来源不可用。 */
        () => !!raw.epoch
      )
      const getterError = Object.defineProperty({}, 'code', {
        /** 模拟宿主异常的嵌套 getter，原文不能穿透快照端口。 */
        get() {
          throw new Error('PRIVATE_NESTED_IDENTITY_FAILURE')
        }
      })
      const conversionError = {
        code: {
          /** 类型不符的 code 不应被 String 隐式执行。 */
          toString() {
            throw new Error('PRIVATE_COERCION_FAILURE')
          }
        }
      }
      for (const error of [getterError, conversionError]) {
        f.credentials.assert =
          /** 只注入异常对象，不创建成功身份或操纵设备状态。 */
          () => {
            throw error
          }
        const snapshot = f.gateway.observations.snapshot()
        assert.deepEqual(device(snapshot, a.machine_id).connection, {
          verification: 'unverified',
          reason_code: 'stale'
        })
        assert.equal(JSON.stringify(snapshot).includes('PRIVATE_'), false)
      }
      f.credentials.assert = originalAssert
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).connection).state, 'online')
    } finally {
      f.credentials.assert = originalAssert
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  '宿主回调期间 Store 降级使整次快照固定不可用',
  /** 最终复验健康，不能发布回调之前的 available 和 recovery generation。 */
  async () => {
    let degrade = false
    const f: ReturnType<typeof fixture> = fixture({
      /** 保留真实 session，仅使用 fixture 时钟触发真实 Store 降级。 */
      session(connection, channel) {
        const base = f.session(connection, channel)
        return {
          ...base,
          /** 模拟读取期间存储来源失效，不修改系统时间。 */
          readiness() {
            if (degrade) {
              f.now = 999
              f.store.clock()
            }
            return base.readiness()
          }
        }
      }
    })
    const a = f.pair('mock_mid_snapshot_degraded')
    const raw = rawConnect(f.gateway.url, a.credential)
    try {
      await until(
        /** 先获得有效 Store fence，再在只读取样中触发降级。 */
        () => !!raw.epoch
      )
      assert.equal(verified(f.gateway.observations.snapshot().transport), 'available')
      degrade = true
      assert.throws(
        /** 顶层不提供旧成功兜底，也不返回原始存储错误。 */
        () => f.gateway.observations.snapshot(),
        /transport_observation_unavailable/
      )
      assert.equal(f.store.health().mode, 'storage_degraded')
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  '观测时钟或存储不可信时固定拒绝，不回显异常或延用旧 verified',
  /** public clock 故障与真实时钟回拨都必须失效，恢复时不因失败取样留下重入锁。 */
  async () => {
    const f = fixture()
    const clock = f.store.clock.bind(f.store)
    try {
      f.gateway.observations.snapshot()
      f.store.clock =
        /** 只在本测试注入时钟读取异常，不触碰真实系统时钟或安全设置。 */
        () => {
          throw new Error('PRIVATE_CLOCK_FAILURE_DO_NOT_EXPOSE')
        }
      assert.throws(
        /** 原始异常只变成固定不可用码，不能成为 UI 诊断原文。 */
        () => f.gateway.observations.snapshot(),
        /transport_observation_unavailable/
      )
      f.store.clock = clock
      assert.equal(verified(f.gateway.observations.snapshot().transport), 'available')
      f.now = 999
      assert.throws(
        /** 真实 Store 识别回拨并进入降级，不能再次提供 verified。 */
        () => f.gateway.observations.snapshot(),
        /transport_observation_unavailable/
      )
      f.now = 2000
      assert.equal(f.store.health().mode, 'storage_degraded')
      assert.throws(
        /** 时间恢复但存储仍处于降级，不能自动恢复观测权威。 */
        () => f.gateway.observations.snapshot(),
        /transport_observation_unavailable/
      )
    } finally {
      f.store.clock = clock
      f.stop()
    }
  }
)

test(
  '客户端不能自报 heartbeat 时间或 verified，非法帧只使所属连接失效',
  /** 额外客户端时间字段不属于 Wire heartbeat，拒绝后不会留下伪造心跳时刻。 */
  async () => {
    const f = fixture()
    const a = f.pair('mock_forged_heartbeat')
    const raw = rawConnect(f.gateway.url, a.credential)
    try {
      await until(
        /** 等待当前 socket 完成真实认证。 */
        () => !!raw.epoch
      )
      raw.ws.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'heartbeat',
          message_id: randomUUID(),
          machine_id: a.machine_id,
          recovery_generation: a.credential.recovery_generation,
          connection_epoch: raw.epoch,
          payload: { sequence: 0, observed_at: 9_999_999, verification: 'verified' }
        })
      )
      await until(
        /** 现行 Wire 字段检查拒绝自报观测，不修改任何管理或原生事实。 */
        () => raw.ws.readyState === WebSocket.CLOSED
      )
      assert.deepEqual(f.gateway.observations.snapshot().devices, [])
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  'provider 健康、策略、binding revision 和禁用即时重新核对，另一设备不受影响',
  /** 只报告当前派发门禁，不增加不存在的 runtime、契约摘要或原生支持传输。 */
  async () => {
    const f = fixture()
    const a = f.pair('mock_provider_a')
    const b = f.pair('mock_provider_b')
    const ca = f.connector(
      /** 只使用 A 的无生产效力测试凭据。 */
      () => a.credential
    )
    const cb = f.connector(
      /** 只使用 B 的无生产效力测试凭据。 */
      () => b.credential
    )
    try {
      await until(
        /** 双 Connector 均真实完成认证及 readiness 核对。 */
        () => ca.status().phase === 'ready' && cb.status().phase === 'ready'
      )
      const initial = f.gateway.observations.snapshot()
      assert.equal(verified(device(initial, a.machine_id).providers[0]!.dispatch_ready), true)
      f.configs.get(a.machine_id)!.native = false
      let snapshot = f.gateway.observations.snapshot()
      assert.equal(verified(device(snapshot, a.machine_id).providers[0]!.dispatch_ready), false)
      assert.equal(verified(device(snapshot, b.machine_id).providers[0]!.dispatch_ready), true)
      f.configs.get(a.machine_id)!.native = true
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).providers[0]!.dispatch_ready), true)
      const disabled = f.store.setProviderEnabled(a.machine_id, 'provider', 1, false)
      snapshot = f.gateway.observations.snapshot()
      assert.equal(device(snapshot, a.machine_id).providers[0]!.binding_revision, disabled.binding_revision)
      assert.equal(verified(device(snapshot, a.machine_id).providers[0]!.dispatch_ready), false)
      assert.equal(verified(device(snapshot, b.machine_id).providers[0]!.dispatch_ready), true)
      f.localBindings.set(a.machine_id + '/provider', disabled)
      const enabled = f.store.setProviderEnabled(a.machine_id, 'provider', disabled.binding_revision, true)
      assert.equal(
        verified(device(f.gateway.observations.snapshot(), a.machine_id).providers[0]!.dispatch_ready),
        false
      )
      f.localBindings.set(a.machine_id + '/provider', enabled)
      assert.equal(verified(device(f.gateway.observations.snapshot(), a.machine_id).providers[0]!.dispatch_ready), true)
      assert.equal(device(initial, a.machine_id).providers[0]!.binding_revision, 1)
      assert.equal(Object.hasOwn(device(snapshot, a.machine_id).providers[0]!, 'runtime'), false)
      assert.equal(f.executions, 0)
    } finally {
      f.stop()
    }
  }
)
