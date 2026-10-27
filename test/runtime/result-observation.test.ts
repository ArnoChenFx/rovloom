/** 真实通道完成后断连，结果读取不再解析原 Wire；身份与设备范围仍逐次生效。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { runtimeFixture } from './helpers.js'

test('已提交结果在断连后可打开并分页，token 撤销或设备范围收窄立即拒绝', { timeout: 30_000 }, async () => {
  const f = await runtimeFixture()
  try {
    await f.ready()
    const admitted = await f.gateway.runAuthenticated(f.caller, () =>
      f.gateway.admit({
        target: f.target,
        native_request: { method: 'task.add', params: { title: 'isolated_result_observation' } },
        options: { binding_revision: 1, contract_ref: f.reference, deadline: f.state.store.clock() + 25_000 }
      })
    )
    await f.responded(admitted.call.call_id)
    f.connector.transport.stop()
    const service = new RuntimeGatewayService(f.mcp)
    const context = { caller: f.caller, wait_signal: new AbortController().signal }
    try {
      const view = (await service.execute('runtime_call_get', { call_id: admitted.call.call_id }, context)).data
      assert.equal(view.content_delivery, 'result_handle')
      assert.equal(view.contract_ref, f.reference)
      const result = view.result as { result_id: string; sha256: string; expires_at: number }
      const page = (await service.execute('runtime_result_read', { result_id: result.result_id }, context)).data
      assert.equal(page.sha256, result.sha256)
      assert.equal(page.expires_at, result.expires_at)
      f.deviceScope([])
      await assert.rejects(service.execute('runtime_result_read', { result_id: result.result_id }, context), {
        code: 'forbidden'
      })
      f.deviceScope(undefined)
      f.authorize(false)
      await assert.rejects(service.execute('runtime_result_read', { result_id: result.result_id }, context), {
        code: 'unauthenticated'
      })
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.claims(), 1)
    } finally {
      service.close()
    }
  } finally {
    await f.close()
  }
})
