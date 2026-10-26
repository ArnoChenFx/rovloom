// 真实 Gateway/Connector、独立账本及本机 IPC；合成 native 延迟回包，不启动用户 Agent。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeFixture } from './helpers.js'
import { until } from '../transport/helpers.js'

test('Luvus RPC 超过三十秒仍返回原结果，同通道的短调用和心跳保持正常', { timeout: 60000 }, async () => {
  const f = await runtimeFixture()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await f.ready()
    f.native.respond((socket, raw) => {
      const request = JSON.parse(raw.trim())
      const finish = () => socket.end(JSON.stringify({ ...f.native.response, id: request.id }) + '\n')
      if (request.params.title === 'slow') {
        timer = setTimeout(finish, 31000)
      } else {
        finish()
      }
    })
    const epoch = f.connector.transport.status().connection_epoch
    const input = (title: string) => ({
      target: f.target,
      native_request: { method: 'task.add', params: { title } },
      options: { binding_revision: 1, contract_ref: f.reference, deadline: f.state.store.clock() + 55000 }
    })
    const slow = await f.gateway.runAuthenticated(f.caller, () => f.gateway.admit(input('slow')))
    await until(() => f.native.state.responses === 1)
    const quick = await f.gateway.runAuthenticated(f.caller, () => f.gateway.admit(input('quick')))
    await f.responded(quick.call.call_id)
    assert.equal(f.state.store.call('synthetic', slow.call.call_id).state, 'connector_accepted')
    await until(() => {
      const state = f.state.store.call('synthetic', slow.call.call_id).state
      assert.notEqual(state, 'outcome_unknown')
      return state === 'responded'
    }, 45000)
    assert.equal(f.connector.transport.status().connection_epoch, epoch)
    assert.equal(f.gateway.transport.status().connections, 1)
    assert.equal(f.claims(), 2)
    await f.gateway.runAuthenticated(f.caller, () => {
      const handle = f.gateway.results.open(slow.call.call_id)
      const page = f.gateway.results.read(handle.result_id, 0, 4096)
      assert.deepEqual(JSON.parse(Buffer.from(page.data, 'base64').toString()).error, f.native.response.error)
    })
  } finally {
    clearTimeout(timer)
    await f.close()
  }
})
