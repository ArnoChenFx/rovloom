/** 验证可信transport到管理读模型的纯投影，不实现身份、授权查询或真实管理写入。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GatewayTransportSnapshot } from '../../src/transport/observation.js'
import {
  createManagementTransportProjection,
  sampleManagementTransport,
  type ManagementObservationFence
} from '../../src/mcp/transport-observations.js'
import { fixtureDevice, fixtureReply, fixtureTime } from './fixtures.js'

/** 构造与现有共享status同源的时间与恢复fence，仅用于隔离投影测试。 */
function fence(): ManagementObservationFence {
  return fixtureReply('status', {})
}

/** 仅此文件的合成transport数据；生产必须注入实际Gateway.observations。 */
function sample(): GatewayTransportSnapshot {
  return {
    observed_at: fixtureTime,
    recovery_generation: 'fixture-recovery',
    transport: { verification: 'verified', observed_at: fixtureTime, source: 'gateway_transport', value: 'available' },
    devices: [
      {
        machine_id: 'fixture-a',
        connection: {
          verification: 'verified',
          observed_at: fixtureTime,
          source: 'gateway_transport',
          value: { state: 'online', connection_epoch_ref: 'opaque-observed-ref', last_heartbeat_at: fixtureTime - 4000 }
        },
        authentication: {
          verification: 'verified',
          observed_at: fixtureTime,
          source: 'gateway_transport',
          value: { state: 'authenticated', last_failure: null }
        },
        providers: [
          {
            provider_id: 'fixture-luvus',
            binding_revision: 2,
            dispatch_ready: {
              verification: 'verified',
              observed_at: fixtureTime,
              source: 'gateway_transport',
              value: true
            }
          }
        ]
      }
    ]
  }
}

test(
  '投影仅复制匹配设备的连接认证和可信接收时刻，不暴露provider或原始epoch',
  /** gateway派发就绪与native能力没有转换入口。 */ () => {
    const raw = sample()
    Object.assign(raw.devices[0]!.connection, { credential: 'SYNTHETIC_SECRET', connection_epoch: 'RAW_EPOCH_SECRET' })
    const projection = createManagementTransportProjection(raw, fence())
    assert.equal(projection.transport, 'available')
    const original = fixtureDevice('fixture-a')
    const output = projection.device(original)
    assert.equal(output.connection.verification, 'verified')
    assert(output.connection.verification === 'verified')
    assert.equal(output.connection.value.connection_epoch_ref, 'opaque-observed-ref')
    assert.equal(output.connection.value.last_heartbeat_at, fixtureTime - 4000)
    assert.equal(output.authentication.verification, 'verified')
    assert.equal(JSON.stringify(output).includes('SECRET'), false)
    assert.equal(JSON.stringify(output).includes('dispatch_ready'), false)
    assert.equal(Object.hasOwn(projection, 'provider'), false)
    assert.equal(Object.hasOwn(projection, 'native'), false)
    assert.equal(original.connection.verification, 'verified')
    assert.notEqual(output.labels, original.labels)
    assert.equal(projection.device(fixtureDevice('not-in-this-gateway')).connection.verification, 'unverified')
  }
)

test(
  '缺项 过期 未来时刻 恢复代次不符和非active均不被解释成offline或authenticated',
  /** 所有失效都保留未知，而不是从持久online补实时值。 */ () => {
    const cases: (GatewayTransportSnapshot | null)[] = [
      null,
      { ...sample(), devices: [] },
      { ...sample(), observed_at: fixtureTime - 15000 },
      { ...sample(), observed_at: fixtureTime + 1 },
      { ...sample(), recovery_generation: 'different-generation' },
      { ...sample(), transport: { verification: 'unverified', reason_code: 'stale' } }
    ]
    for (const snapshot of cases) {
      const output = createManagementTransportProjection(snapshot, fence()).device(fixtureDevice('fixture-a'))
      assert.equal(output.persisted_state, 'online')
      assert.equal(output.connection.verification, 'unverified')
      assert.equal(output.authentication.verification, 'unverified')
      assert.equal(JSON.stringify(output.connection).includes('offline'), false)
    }
    for (const mode of ['storage_degraded'] as const) {
      const projection = createManagementTransportProjection(sample(), { ...fence(), mode })
      assert.notEqual(projection.transport, 'available')
      assert.equal(projection.device(fixtureDevice('fixture-a')).connection.verification, 'unverified')
    }
  }
)

test(
  '连接认证各自保留时间与未知，旧子观测不被新全局取样续期',
  /** 一层verified不授予另一层证明，未来心跳不能被夹到当前时间。 */ () => {
    const raw = structuredClone(sample())
    const device = raw.devices[0]!
    Object.assign(device.authentication, { verification: 'unverified', reason_code: 'not_recorded' })
    const first = createManagementTransportProjection(raw, fence()).device(fixtureDevice('fixture-a'))
    assert.equal(first.connection.verification, 'verified')
    assert.equal(first.authentication.verification, 'unverified')
    const stale = structuredClone(sample())
    Object.assign(stale.devices[0]!.connection, { observed_at: fixtureTime - 15000 })
    assert.equal(
      createManagementTransportProjection(stale, fence()).device(fixtureDevice('fixture-a')).connection.verification,
      'unverified'
    )
    const future = structuredClone(sample())
    if (future.devices[0]!.connection.verification === 'verified') {
      Object.assign(future.devices[0]!.connection.value, { last_heartbeat_at: fixtureTime + 1 })
    }
    assert.equal(
      createManagementTransportProjection(future, fence()).device(fixtureDevice('fixture-a')).connection.verification,
      'unverified'
    )
  }
)

test(
  'pending/revoked只保留已有Store证明，旧transport认证不能恢复授权',
  /** 不从登记状态另造认证，也不把旧来源当新连接。 */ () => {
    for (const state of ['pending', 'revoked'] as const) {
      const device = fixtureDevice('fixture-a')
      device.persisted_state = state
      device.authentication = {
        verification: 'verified',
        observed_at: fixtureTime,
        source: 'store',
        value: { state, last_failure: null }
      }
      const result = createManagementTransportProjection(sample(), fence()).device(device)
      assert.equal(result.connection.verification, 'unverified')
      assert.equal(result.authentication.verification, 'verified')
      assert(result.authentication.verification === 'verified')
      assert.equal(result.authentication.value.state, state)
      device.authentication = { verification: 'unverified', reason_code: 'not_recorded' }
      assert.equal(
        createManagementTransportProjection(sample(), fence()).device(device).authentication.verification,
        'unverified'
      )
    }
  }
)

test(
  '来源异常和重复设备固定失败关闭，不回显底层错误或靠last-wins选状态',
  /** 真实宿主每次显式取样，异常内容不进入管理响应。 */ () => {
    assert.equal(sampleManagementTransport(undefined), null)
    assert.equal(
      sampleManagementTransport({
        snapshot: /** 模拟固定的宿主失败。 */ () => {
          throw new Error('PRIVATE_SECRET')
        }
      }),
      null
    )
    const duplicate = sample()
    const invalid = { ...duplicate, devices: [...duplicate.devices, ...duplicate.devices] }
    const projection = createManagementTransportProjection(invalid, fence())
    assert.equal(projection.transport, 'unverified')
    assert.equal(projection.device(fixtureDevice('fixture-a')).connection.verification, 'unverified')
  }
)

test(
  '平台是设备属性：不经 Observed 投影、不随时效失效，非法形状退化为 null',
  /** 平台像 labels 一样随设备返回，不因连接/认证过期而消失或被标成历史。 */ () => {
    const withPlatform = fixtureDevice('fixture-a')
    assert.deepEqual(withPlatform.platform, {
      os: 'linux',
      arch: 'x64',
      distribution: { id: 'ubuntu', version_id: '24.04' }
    })
    // 传输取样缺失（fence 不匹配）时，平台仍原样交付：它不是时效观测。
    const stale = createManagementTransportProjection(sample(), {
      ...fence(),
      server_time: fixtureTime + 60_000
    }).device(withPlatform)
    assert.deepEqual(stale.platform, withPlatform.platform)
    // 从未上报就是 null，不会被包装成 unverified 占位。
    assert.equal(
      createManagementTransportProjection(sample(), fence()).device(fixtureDevice('fixture-b')).platform,
      null
    )
    // 非法形状（这里是非 Linux 携带发行版）按 null 处理，不把坏数据带进管理面。
    const invalid = fixtureDevice('fixture-a')
    invalid.platform = { os: 'darwin', arch: 'arm64', distribution: { id: 'ubuntu', version_id: null } }
    assert.equal(createManagementTransportProjection(sample(), fence()).device(invalid).platform, null)
    // Linux 无发行版（os-release 读不到）是合法形状，必须原样保留。
    const linuxNoDistro = fixtureDevice('fixture-a')
    linuxNoDistro.platform = { os: 'linux', arch: 'arm64', distribution: null }
    assert.deepEqual(createManagementTransportProjection(sample(), fence()).device(linuxNoDistro).platform, {
      os: 'linux',
      arch: 'arm64',
      distribution: null
    })
  }
)
