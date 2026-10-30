/**
 * allow_terminal_execution=false 时的真实 core 场景：控制档在目录里不可见、describe 打不开、
 * runtime_call 在 Gateway 登记前就被拒绝，而 5 个读取照常可用。
 * 用法：MCP_CONFIG=<quickstart 写出的 mcp.json> bun e2e/herdr-core-control-off.mjs
 */
import assert from 'node:assert/strict'
import { connect } from './herdr-core-client.mjs'

const { client, target, tool, ok, call } = await connect()
try {
  const discovered = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  const methods = discovered.items.map((item) => item.method).sort()
  // 开关关闭时目录只剩 5 个读取：控制档不可见，连方法名都不出现。
  assert.deepEqual(methods, ['server.status', 'terminal.get', 'terminal.list', 'terminal.read', 'terminal.wait'])
  const described = await tool('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.send'
  })
  assert.equal(described.isError, true, JSON.stringify(described.raw))
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
      describe_denied: true,
      call_denied: denied.raw.gateway_error.code
    })
  )
} finally {
  await client.close()
}
