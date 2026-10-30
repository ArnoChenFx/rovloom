/**
 * allow_terminal_execution=false 时的真实 core 场景：控制档与启动类仍然列出但标成
 * available:false（控制端要知道后端有哪些能力），runtime_call 在 Gateway 登记前被拒绝，
 * 读取照常可用。
 * 用法：MCP_CONFIG=<quickstart 写出的 mcp.json> bun e2e/herdr-core-control-off.mjs
 */
import assert from 'node:assert/strict'
import { connect } from './herdr-core-client.mjs'

const { client, target, tool, ok, call } = await connect()
try {
  const discovered = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  const methods = discovered.items.map((item) => item.method).sort()
  // 开关关闭时控制档与启动类仍然列出，但标成 available:false。
  assert.deepEqual(methods, [
    'server.status',
    'templates.list',
    'terminal.get',
    'terminal.interrupt',
    'terminal.keep',
    'terminal.keys',
    'terminal.kill',
    'terminal.label',
    'terminal.list',
    'terminal.put',
    'terminal.read',
    'terminal.rm',
    'terminal.run',
    'terminal.send',
    'terminal.wait'
  ])
  const available = Object.fromEntries(discovered.items.map((item) => [item.method, item.available]))
  for (const method of ['terminal.send', 'terminal.keys', 'terminal.run']) {
    assert.equal(available[method], false, `${method}:${JSON.stringify(available)}`)
  }
  // terminal.read 只有 lines>0 需要开关，所以它仍可用（限制写在参数说明里）。
  for (const method of ['server.status', 'templates.list', 'terminal.get', 'terminal.list', 'terminal.read']) {
    assert.equal(available[method], true, method)
  }
  const described = await tool('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.send'
  })
  // describe 仍可读（控制端要看得到 schema 与说明），但明确标成不可用。
  assert.equal(described.isError, false, JSON.stringify(described.raw))
  assert.equal(described.data.available, false)
  assert.equal(described.data.terminal_execution.local_state, 'disabled')
  // 读取不受开关影响。
  const status = await call(discovered.items[0].contract_ref, 'server.status', {})
  assert.equal(status.version, '0.1.14')
  // 控制档在 Gateway 登记前拒绝：本机策略不允许，公开码是 forbidden。
  const denied = await tool('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: discovered.items[0].contract_ref,
    native_request: {
      method: 'terminal.send',
      params: { terminal: 't1', core_id: status.core.id, created_ms: 0, text: 'x' }
    },
    deadline: Date.now() + 30_000
  })
  assert.equal(denied.isError, true, JSON.stringify(denied.raw))
  assert.equal(denied.raw?.gateway_error?.code, 'forbidden', JSON.stringify(denied.raw))
  console.log(
    JSON.stringify({
      ok: true,
      switch: 'off',
      methods,
      control_available: available['terminal.send'],
      describe_available: described.data.available,
      call_denied: denied.raw.gateway_error.code
    })
  )
} finally {
  await client.close()
}
