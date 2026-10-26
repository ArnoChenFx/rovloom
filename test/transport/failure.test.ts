// 验证 Store 降级、派发锚点失败和来源不可信时的通道拒绝及无重放行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, until } from './helpers.js'

test(
  'dispatch 锚点提交失败和 storage_degraded 不返回 binding、不写出请求',
  /** 在派发锚点之后注入存储失败，断言没有 binding 或原生请求逃出持久化门禁。 */
  async () => {
    let fail = false
    const f = fixture(
      {},
      {
        /** 仅在指定提交点且故障开关打开时抛错，保持测试故障范围准确。 */
        fault(point) {
          if (point === 'after_anchor' && fail) {
            throw new Error('mock_commit_failure')
          }
        }
      }
    )
    try {
      const a = f.pair('mock')
      const client = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => client.status().phase === 'ready'
      )
      const call = f.call(a.target)
      fail = true
      assert.throws(
        /** 在 Store 降级时请求认证或派发，确认独立通道不绕过持久化门禁。 */
        () => f.gateway.dispatch(call.call_id),
        /storage_degraded/
      )
      assert.equal(f.store.health().mode, 'storage_degraded')
      assert.equal(
        f.encoded.some(
          /** 查找被记录的 request 帧，确认持久派发失败前未进入编码发送路径。 */
          (raw) => JSON.parse(raw).type === 'request'
        ),
        false
      )
      assert.equal(f.executions, 0)
      f.gateway.refresh()
      assert.equal(f.gateway.status().connections, 0)
      assert.throws(
        /** 在 Store 降级时请求认证或派发，确认独立通道不绕过持久化门禁。 */
        () => f.credentials.authenticate(a.machine_id, a.credential.recovery_generation, a.credential.credential),
        /storage_degraded/
      )
    } finally {
      f.stop()
    }
  }
)

test(
  '原生来源未核实时拒绝派发；Connector 重新启动保持相同设备 ID',
  /** 重启 Connector 并撤销 mock 原生来源，分别验证稳定设备 ID 和派发拒绝。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      const client = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => client.status().phase === 'ready'
      )
      const original = client.status().connection_epoch
      client.stop()
      await until(
        /** 等待 Gateway 移除当前连接并完成资源回收。 */
        () => f.gateway.status().connections === 0
      )
      const restarted = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => restarted.status().phase === 'ready'
      )
      assert.equal(restarted.status().machine_id, a.machine_id)
      assert.notEqual(restarted.status().connection_epoch, original)
      f.configs.get(a.machine_id)!.sourceVerified = false
      const call = f.call(a.target)
      // 原生来源门禁在编码时拒绝，尚未写 socket；账本确定拒绝并保留本次已认证连接。
      f.gateway.dispatch(call.call_id)
      assert.equal(f.store.call(f.principal.id, call.call_id).state, 'not_dispatched')
      assert.equal(f.gateway.status().connections, 1)
      assert.equal(f.executions, 0)
      f.configs.get(a.machine_id)!.sourceVerified = true
      const healthy = f.call(a.target)
      f.gateway.dispatch(healthy.call_id)
      await until(() => f.store.call(f.principal.id, healthy.call_id).state === 'responded')
      assert.equal(f.executions, 1)
    } finally {
      f.stop()
    }
  }
)
