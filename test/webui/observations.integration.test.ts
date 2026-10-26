/** 用真实双SQLite、持久设备证明和loopback Connector验证投影；管理员/原生来源仍是隔离fixture。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DeviceSnapshot } from '../../src/mcp/management.js'
import {
  createManagementTransportProjection,
  sampleManagementTransport,
  type ManagementObservationFence
} from '../../src/mcp/transport-observations.js'
import { checkManagementReadReply } from '../../src/webui/validate.js'
import { realFixture } from '../transport/real-helpers.js'
import { until } from '../transport/helpers.js'

/** 只构造本测试拥有的Store元数据；设备读取与管理员授权仍由共享service负责。 */
function row(f: ReturnType<typeof realFixture>['f'], id: string): DeviceSnapshot {
  const machine = f.store.machine(id)
  const state = machine.status as DeviceSnapshot['persisted_state']
  return {
    machine_id: machine.machine_id,
    name: machine.name,
    labels: null,
    resource_revision: null,
    persisted_state: state,
    observed_at: f.store.clock(),
    connection: { verification: 'unverified', reason_code: 'backend_unavailable' },
    authentication:
      state === 'revoked' || state === 'pending'
        ? {
            verification: 'verified',
            observed_at: f.store.clock(),
            source: 'store',
            value: { state, last_failure: null }
          }
        : { verification: 'unverified', reason_code: 'backend_unavailable' },
    /** 平台只来自账本；测试行从不伪造它。 */
    platform: null
  }
}

/** 在真实观测取样后取得同一Store的fence；不把较晚观测时间夹回较早的now。 */
function project(f: ReturnType<typeof realFixture>['f']) {
  const snapshot = sampleManagementTransport(f.gateway.observations)
  const health = f.store.health()
  assert(health.mode === 'active' || health.mode === 'storage_degraded')
  const fence: ManagementObservationFence = {
    mode: health.mode,
    server_time: f.store.clock(),
    recovery_generation: health.generation,
    stale_after_ms: 15000
  }
  return createManagementTransportProjection(snapshot, fence)
}

/** 检查既有管理DTO边界接受真实transport字段，不改变该设备的身份或持久登记信息。 */
function device(f: ReturnType<typeof realFixture>['f'], id: string) {
  return checkManagementReadReply('devices_get', project(f).device(row(f, id)), { machine_id: id })
}

test(
  '真实双Connector的认证 心跳 安全epoch和断开重连分别进入对应管理DTO',
  { timeout: 20000 },
  /** 双端必须通过真实持久证明认证，读投影不会执行原生方法或复用别台设备的状态。 */ async () => {
    const r = realFixture()
    const { f } = r
    const a = r.pair('owned_observation_a')
    const b = r.pair('owned_observation_b')
    try {
      assert.equal(device(f, a.machine_id).connection.verification, 'unverified')
      const ca = r.connector(a)
      const cb = r.connector(b)
      await r.ready(ca, cb)
      const first = device(f, a.machine_id)
      const second = device(f, b.machine_id)
      assert.equal(first.connection.verification, 'verified')
      assert(first.connection.verification === 'verified')
      assert(second.connection.verification === 'verified')
      assert(first.authentication.verification === 'verified')
      assert.equal(first.authentication.value.state, 'authenticated')
      const firstRef = first.connection.value.connection_epoch_ref
      const secondRef = second.connection.value.connection_epoch_ref
      assert.notEqual(firstRef, secondRef)
      const output = JSON.stringify([first, second])
      for (const entry of [a, b]) {
        assert.equal(output.includes(entry.credential.credential), false)
      }
      for (const record of r.records) {
        assert.equal(output.includes(record.connection.connection_epoch), false)
      }
      f.now = 1500
      await until(
        /** 只有实际收到新心跳后才有该Store时刻。 */ () => {
          const value = device(f, a.machine_id).connection
          return value.verification === 'verified' && value.value.last_heartbeat_at === 1500
        }
      )
      assert.equal(f.executions, 0)
      f.gateway.disconnect(a.machine_id)
      assert.equal(device(f, a.machine_id).connection.verification, 'unverified')
      const unaffected = device(f, b.machine_id).connection
      assert(unaffected.verification === 'verified')
      assert.equal(unaffected.value.connection_epoch_ref, secondRef)
      await until(
        /** 断开保留设备授权，只有完成新认证才产生新的安全引用。 */ () => {
          const value = device(f, a.machine_id).connection
          return value.verification === 'verified' && value.value.connection_epoch_ref !== firstRef
        },
        8000
      )
      await r.ready(ca)
      assert.equal(device(f, a.machine_id).authentication.verification, 'verified')
      assert.equal(first.connection.value.connection_epoch_ref, firstRef)
      assert.equal(f.executions, 0)
    } finally {
      r.close()
    }
  }
)

test(
  '持久撤销不被旧transport样本恢复，真实dispatch_ready不变成native能力',
  { timeout: 15000 },
  /** 管理动作只作用于新建隔离fixture，产品投影没有写入口。 */ async () => {
    const r = realFixture()
    const { f } = r
    const a = r.pair('owned_observation_revoke')
    const b = r.pair('owned_observation_other')
    const ca = r.connector(a)
    const cb = r.connector(b)
    try {
      await r.ready(ca, cb)
      const captured = sampleManagementTransport(f.gateway.observations)!
      const ready = captured.devices.find(
        /** 仅核对该真实设备的传输派发门禁。 */ (item) => item.machine_id === a.machine_id
      )!.providers
      assert(
        ready.some(
          /** 派发门禁可能已核实，但它不是native运行观测。 */ (item) =>
            item.dispatch_ready.verification === 'verified' && item.dispatch_ready.value
        )
      )
      const projection = project(f)
      // MCP 视图复用同一投影的 link/providerReady，管理面只消费 device；公开接口不得扩散其它成员。
      assert.deepEqual(Object.keys(projection).sort(), ['device', 'link', 'providerReady', 'transport'])
      assert.equal(Object.hasOwn(device(f, a.machine_id), 'runtime'), false)
      f.store.setProviderEnabled(a.machine_id, 'provider', 1, false)
      assert.equal(device(f, a.machine_id).connection.verification, 'verified')
      assert.equal(device(f, b.machine_id).authentication.verification, 'verified')
      r.f.store.revoke(a.machine_id)
      r.f.gateway.disconnect(a.machine_id)
      const health = f.store.health()
      assert(health.mode === 'active' || health.mode === 'storage_degraded')
      const old = createManagementTransportProjection(captured, {
        mode: health.mode,
        server_time: f.store.clock(),
        recovery_generation: health.generation,
        stale_after_ms: 15000
      }).device(row(f, a.machine_id))
      assert.equal(old.connection.verification, 'unverified')
      assert(old.authentication.verification === 'verified')
      assert.equal(old.authentication.value.state, 'revoked')
      assert.equal(device(f, a.machine_id).connection.verification, 'unverified')
      assert.equal(device(f, b.machine_id).connection.verification, 'verified')
      assert.equal(f.executions, 0)
    } finally {
      r.close()
    }
  }
)
