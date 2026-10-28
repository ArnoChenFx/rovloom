// 验证 Store 设备凭据接线：nativeSource 逐轴复验所属 socket，注册表原子封锁同设备全部 socket。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../../src/store.js'
import { ChannelRegistry, createDeviceLifecycle } from '../../src/transport/index.js'
import type { Connection, Session } from '../../src/transport/index.js'
import { OFFER } from '../../src/transport/common.js'
import { negotiate } from '../../src/wire/index.js'
import { fixture } from './helpers.js'
import type { TrustedNativeContext } from '../../src/connector/luvus/contract/index.js'
import { G, identity as nativeIdentity } from '../connector/luvus/contract/helpers.js'

/** 建立真实 Store 与生命周期接线；配对设备的凭据取自 Store 的一次性兑换结果。 */
function wiringFixture() {
  const f = fixture()
  const channels = new ChannelRegistry()
  const lifecycle = createDeviceLifecycle(f.store)
  return {
    f,
    lifecycle,
    channels,
    /** 复用 fixture 的注册与 provider 配置，但把凭据换成 Store 兑换得到的原始值。 */
    pair(name: string) {
      const original = f.store.redeem.bind(f.store)
      let real: { machine_id: string; credential: string } | undefined
      f.store.redeem = /** 捕获真实兑换结果，仅用于本测试认证。 */ (token) => {
        real = original(token)
        return real
      }
      let device: ReturnType<typeof f.pair>
      try {
        device = f.pair(name)
      } finally {
        f.store.redeem = original as Store['redeem']
      }
      device.credential = {
        machine_id: real!.machine_id,
        recovery_generation: f.store.generation(),
        credential: real!.credential
      }
      return device
    },
    close() {
      f.stop()
    }
  }
}

test(
  'nativeSource 解析前后复验所属 socket，拒绝跨机器、跨恢复代次和跨 epoch 的宿主来源',
  /** 解析函数提供完整 mock NativeBinding；接线不制造来源，也不接受其它连接的来源。 */
  () => {
    const f = wiringFixture()
    try {
      const a = f.pair('mock_native_scope')
      const epoch = f.lifecycle.authenticate(a.machine_id, a.credential.recovery_generation, a.credential.credential)
        .identity.connection_epoch
      const channel = f.channels.open(
        {},
        /** 本单元场景只关闭 mock socket，不执行主库管理动作。 */
        () => undefined
      )
      channel.bind({
        machine_id: a.machine_id,
        recovery_generation: a.credential.recovery_generation,
        connection_epoch: epoch,
        authenticated: true,
        active: true,
        negotiated: negotiate(OFFER, OFFER)
      })
      const source: TrustedNativeContext = {
        authenticated: true,
        source_verified: true,
        binding: {
          kind: 'luvus',
          provider_id: 'provider',
          binding_revision: 1,
          contract_source_ref: 'mock_contract',
          target: { machine_id: a.machine_id, profile: 'session', session: 'synthetic' },
          server_generation: G,
          connection_epoch: epoch,
          recovery_generation: a.credential.recovery_generation,
          capability_revision: 'caps1',
          classification_revision: 'review1',
          contract: nativeIdentity
        }
      }
      const variants = [
        {
          ...source,
          binding: { ...source.binding, target: { ...source.binding.target, machine_id: 'wrong_machine' } }
        },
        { ...source, binding: { ...source.binding, recovery_generation: 'wrong_generation' } },
        { ...source, binding: { ...source.binding, connection_epoch: 'wrong_epoch' } }
      ]
      for (const variant of variants) {
        const resolve = f.lifecycle.nativeSource(
          channel,
          /** 返回只改变一个身份轴的 mock 来源，验证接线逐轴核对。 */
          () => variant
        )
        assert.throws(
          /** 任何一个身份轴不符都必须在交给 adapter 之前拒绝。 */
          () => resolve('mock_call', 'mock_attempt'),
          /native_identity_mismatch/
        )
      }
      const resolve = f.lifecycle.nativeSource(
        channel,
        /** 模拟受信解析器中途同步关闭 socket，返回值不能绕过第二次门禁。 */
        () => {
          channel.close()
          return source
        }
      )
      assert.throws(
        /** 来源解析后的失效必须再次观察到，不能继续拿旧上下文工作。 */
        () => resolve('mock_call', 'mock_attempt'),
        /authentication_required/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '注册表先拒绝全部匹配 socket 再清资源，旧关闭事件不影响同设备新作用域',
  /** 检查 cleanup 回调重入时也无法使用另一个旧 socket，异常仍保证其它 socket 清理。 */
  () => {
    const registry = new ChannelRegistry()
    const connection: Connection = {
      machine_id: 'mock_machine',
      recovery_generation: 'mock_generation',
      connection_epoch: 'mock_epoch',
      authenticated: true,
      active: true,
      negotiated: negotiate(OFFER, OFFER)
    }
    let closed = 0
    /** 模拟底层 socket 的幂等关闭计数，不进行网络活动。 */
    const close = () => {
      closed++
    }
    const a = registry.open({}, close)
    const b = registry.open({}, close)
    a.bind(connection)
    b.bind(connection)
    a.attach({
      /** cleanup 在业务门禁失效之后才可调用，此时另一旧 socket 也已不可用。 */
      close() {
        assert.throws(
          /** 确认不是逐个清理导致其它旧 socket 暂时仍可工作。 */
          () => b.connection(),
          /authentication_required/
        )
        throw new Error('mock_cleanup_failure')
      }
    } as unknown as Session)
    assert.throws(
      /** 清理错误保留为失败，但不能停止其余 socket 的关闭。 */
      () => registry.blockAndClose(connection.machine_id),
      /synchronous_channel_block_required/
    )
    assert.equal(closed, 2)
    const fresh = registry.open({}, close)
    fresh.bind({ ...connection, connection_epoch: 'fresh_epoch' })
    a.close()
    assert.equal(fresh.connection().connection_epoch, 'fresh_epoch')
    const copy = fresh.connection()
    copy.connection_epoch = 'forged_epoch'
    assert.equal(fresh.connection().connection_epoch, 'fresh_epoch')
    fresh.close()
  }
)
