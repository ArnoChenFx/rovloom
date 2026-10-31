/**
 * managed 模式的前置步骤：经 MCP 启动一个命名终端（survivor），供 Connector 重启后核对「终端还在」。
 * 用法：MCP_CONFIG=... bun e2e/herdr-core-managed-prepare.mjs
 */
import assert from 'node:assert/strict'
import { connect } from './herdr-core-client.mjs'

const { client, target, ok, invoke, readAll } = await connect()
try {
  const discovered = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  const run = discovered.items.find((item) => item.method === 'terminal.run')
  assert(run, 'terminal.run must be discoverable')
  const view = await invoke(run.contract_ref, {
    method: 'terminal.run',
    params: { name: 'survivor', line: 'printf "survivor\\n"; exec sleep 600' }
  })
  assert.equal(view.state, 'responded', JSON.stringify(view))
  const result = await readAll(view)
  console.log(JSON.stringify({ ok: true, address: result.address, created_ms: result.created_ms, name: 'survivor' }))
} finally {
  await client.close()
}
