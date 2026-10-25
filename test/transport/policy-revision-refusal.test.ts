// revision 漂移时准入层必须回确定性拒绝帧且保持连接：真实 loopback Gateway + Connector 全链路。
// 本文件同时覆盖生产准入后端（本机 attempt 锚点）与共享 Store 后端两种装配。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, until } from './helpers.js'
import { Store } from '../../src/store.js'
import { connected, management, options } from '../storage/helpers.js'

test(
  '生产准入后端：漂移的派发帧回 dispatch_refused 且不杀连接',
  /** Connector 侧 attempt 锚点在本机准入后端（生产同构），不在 Gateway Store。 */
  async () => {
    const f = fixture({}, {}, { connectorAdmission: true })
    try {
      const a = f.pair('admission_drift_device')
      const client = f.connector(() => a.credential)
      await until(/** 等待真实握手与 readiness 核对完成。 */ () => client.status().phase === 'ready')
      // 网关实时注册表前进，connector 准入快照保持旧值：双侧 revision 漂移。
      f.local.revision = 'local2'
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待 connector 回确定性拒绝帧并落为未派发终态。 */ () =>
          f.router.get(f.principal, call.call_id).state === 'not_dispatched'
      )
      assert.equal(f.connectorSnapshot.revision, 'local1', '前置：connector 快照保持旧 revision')
      // 连接必须存活：抖动循环正是本修复要消除的症状。
      await until(() => client.status().phase === 'ready')
      assert.equal(client.status().failure, undefined, '确定性拒绝不产生连接失败码')
      // 同一连接上后续派发仍被拒绝为确定性 not_dispatched，而不是 outcome_unknown。
      const second = f.call(a.target)
      f.gateway.dispatch(second.call_id)
      await until(
        /** 第二次派发同样收敛为明确终态。 */ () => f.router.get(f.principal, second.call_id).state === 'not_dispatched'
      )
      assert.equal(client.status().phase === 'ready', true, '连续拒绝后连接仍保持 ready')
    } finally {
      f.stop()
    }
  }
)

test(
  '生产准入后端：readiness 恢复一致后同一连接可继续完成真实派发',
  /** 验证拒绝路径不污染准入表：漂移修复后调用正常 accepted → responded。 */
  async () => {
    const f = fixture({}, {}, { connectorAdmission: true })
    try {
      const a = f.pair('admission_recover_device')
      const client = f.connector(() => a.credential)
      await until(() => client.status().phase === 'ready')
      f.local.revision = 'local2'
      const drifted = f.call(a.target)
      f.gateway.dispatch(drifted.call_id)
      await until(() => f.router.get(f.principal, drifted.call_id).state === 'not_dispatched')
      assert.equal(client.status().phase, 'ready')
      // revision 恢复一致后新调用走完整 accepted → response 路径。
      f.local.revision = 'local1'
      const recovered = f.call(a.target)
      f.gateway.dispatch(recovered.call_id)
      await until(() => f.router.get(f.principal, recovered.call_id).state === 'responded')
      assert.equal(f.executions >= 1, true, '恢复后原生执行真实发生')
    } finally {
      f.stop()
    }
  }
)

test(
  '已接受的 attempt 不能被 policy_revision_stale 拒绝证明倒退为未派发',
  /** Store 纵深：准入拒绝只存在于首帧被接受前；执行器自身的未写出证明不受影响。 */
  () => {
    const store = new Store(':memory:', () => 1000, { management })
    try {
      const device = connected(store)
      const created = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
      const binding = store.dispatch('alice', created.call_id, device.epoch)
      // dispatching 状态：准入拒绝（首帧尚未被接受）允许提交。
      assert.equal(store.commitDispatchRefusal(binding, 'policy_revision_stale'), true)
      // 重新构造一个走到 connector_accepted 的 attempt。
      const second = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
      const acceptedBinding = store.dispatch('alice', second.call_id, device.epoch)
      store.accepted(acceptedBinding)
      // 已接受状态：policy_revision_stale 不能倒退；terminal_execution_disabled（执行器自身未写出证明）仍可提交。
      assert.equal(store.commitDispatchRefusal(acceptedBinding, 'policy_revision_stale'), false)
      assert.equal(store.commitDispatchRefusal(acceptedBinding, 'terminal_execution_disabled'), true)
    } finally {
      store.close()
    }
  }
)
