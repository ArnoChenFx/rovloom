// revision 漂移时准入层必须回确定性拒绝帧且保持连接：真实 loopback Gateway + Connector 全链路。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, until } from './helpers.js'

test(
  '策略 revision 漂移的派发帧回 dispatch_refused 且不杀连接',
  /** 复用真实 Store/Router/Wire codec 与传输层；仅原生执行为合成 stub。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('revision_drift_device')
      const client = f.connector(() => a.credential)
      await until(/** 等待真实握手与 readiness 核对完成。 */ () => client.status().phase === 'ready')
      // 网关实时注册表前进，connector 准入快照保持旧值：双侧 revision 漂移。
      f.local.revision = 'local2'
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待 connector 回确定性拒绝帧并内为未派发终态。 */ () =>
          f.router.get(f.principal, call.call_id).state === 'not_dispatched'
      )
      assert.equal(
        f.connectorSnapshot.revision,
        'local1',
        '前置：connector 快照保持旧 revision，与网关 local2 形成漂移'
      )
      // 连接必须存活：抖动循环正是本修复要消除的症状。
      await until(() => client.status().phase === 'ready')
      assert.equal(client.status().failure, undefined, '确定性拒绝不产生连接失败码')
      assert.equal(f.sessions.closed - 0 <= f.sessions.opened, true)
      // 同一连接上后续派发仍被拒绝为确定性 not_dispatched，而不是 outcome_unknown。
      const second = f.call(a.target)
      f.gateway.dispatch(second.call_id)
      await until(
        /** 第二次派发同样收敛为明确终态。 */ () => f.router.get(f.principal, second.call_id).state === 'not_dispatched'
      )
      assert.equal(client.status().phase, 'ready', '连续拒绝后连接仍保持 ready')
    } finally {
      f.stop()
    }
  }
)

test(
  'readiness 恢复一致后同一连接可继续完成真实派发',
  /** 验证拒绝路径不污染会话状态：漂移修复后调用正常 responded。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('revision_recover_device')
      const client = f.connector(() => a.credential)
      await until(() => client.status().phase === 'ready')
      // 网关侧 revision 前进制造漂移，触发一次确定性拒绝。
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
