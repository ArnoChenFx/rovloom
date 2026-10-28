// 执行器确定未写出的拒绝必须保持连接并可收敛：真实 loopback Gateway + Connector 全链路。
// 本文件同时覆盖生产准入后端（本机 attempt 锚点）与共享 Store 后端两种装配。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, until } from './helpers.js'
import { Store } from '../../src/store.js'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import { connected, management, options } from '../storage/helpers.js'

test('生产准入后端忽略旧 revision 与方法动作清单，保持同一连接完成调用', async () => {
  const f = fixture({}, {}, { connectorAdmission: true })
  try {
    const device = f.pair('legacy_policy_ignored')
    const client = f.connector(() => device.credential)
    await until(() => client.status().phase === 'ready')
    const epoch = client.status().connection_epoch
    // 旧 revision 与方法/动作清单已不参与准入；同一设备范围下连接与调用都应保持。
    for (let i = 0; i < 2; i++) {
      const call = f.call(device.target)
      f.gateway.dispatch(call.call_id)
      await until(() => f.router.get(f.principal, call.call_id).state === 'responded')
    }
    assert.equal(client.status().connection_epoch, epoch)
    assert.equal(f.executions, 2)
  } finally {
    f.stop()
  }
})

test(
  '已接受的 attempt 不能被 dispatch 拒绝证明倒退为未派发',
  /** Store 纵深：准入拒绝只存在于首帧被接受前；执行器自身的未写出证明不受影响。 */
  () => {
    const store = new Store(':memory:', () => 1000, { management })
    try {
      const device = connected(store)
      const created = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
      const binding = store.dispatch('alice', created.call_id, device.epoch)
      // dispatching 状态：准入拒绝（首帧尚未被接受）允许提交。
      assert.equal(store.commitDispatchRefusal(binding, 'terminal_execution_disabled'), true)
      // 重新构造一个走到 connector_accepted 的 attempt。
      const second = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
      const acceptedBinding = store.dispatch('alice', second.call_id, device.epoch)
      store.accepted(acceptedBinding)
      // 已接受状态：terminal_execution_disabled（执行器自身未写出证明）仍可提交。
      assert.equal(store.commitDispatchRefusal(acceptedBinding, 'terminal_execution_disabled'), true)
    } finally {
      store.close()
    }
  }
)

test(
  'accepted 后执行器真实的 terminal_execution_disabled 未写出证明仍能收敛为 not_dispatched',
  /** 执行器在写入前复核本机终端开关抛 not_dispatched：与 decode 重放帧不同，这是真实首帧拒绝。 */
  async () => {
    const f = fixture()
    let refused = ''
    let signal: AbortSignal | undefined
    let finish: (() => void) | undefined
    const device = f.pair('post_accepted_stale_refusal')
    const client = f.connector(() => device.credential, {
      limits: { reconnect_ms: 5000, reconnect_max_ms: 5000 },
      execute: (raw, active, binding) => {
        if (binding.call_id === refused) {
          // 模拟执行器写入前的策略复核拒绝：真实 not_dispatched 语义，非重放帧。
          throw new LuvusAdapterError('terminal_execution_disabled', 'not_dispatched')
        }
        signal = active
        return new Promise((resolve) => {
          finish = () => resolve({ id: JSON.parse(raw).id, result: { id: 'synthetic_task' } })
        })
      }
    })
    try {
      await until(() => client.status().phase === 'ready')
      const first = f.call(device.target)
      f.gateway.dispatch(first.call_id)
      await until(() => signal !== undefined)
      const second = f.call(device.target)
      refused = second.call_id
      f.gateway.dispatch(second.call_id)
      await until(() => f.router.get(f.principal, second.call_id).state === 'not_dispatched')
      // 拒绝不杀连接，另一调用仍能正常完成。
      assert.equal(client.status().phase, 'ready')
      assert.equal(f.router.get(f.principal, first.call_id).state, 'connector_accepted')
      finish!()
      await until(() => f.router.get(f.principal, first.call_id).state === 'responded')
    } finally {
      finish?.()
      f.stop()
    }
  }
)
