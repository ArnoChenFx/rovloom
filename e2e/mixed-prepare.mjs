/**
 * SIGKILL 之前的准备：在三来源上各提交一个调用，并让 core 的那个还在执行时被杀掉。
 * 把 core 在途调用的 call_id 写到 MIXED_INFLIGHT_FILE，重启后的 mixed-session.mjs 用它核对结局。
 * 用法：MCP_CONFIG=... MIXED_INFLIGHT_FILE=... bun e2e/mixed-prepare.mjs
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { connectMixed } from './mixed-client.mjs'

assert(process.env.MIXED_INFLIGHT_FILE, 'MIXED_INFLIGHT_FILE is required')
const { client, ok, discover, call } = await connectMixed()
try {
  // 三个来源先各做一次只读，确认重启前都是通的。
  const luvus = await call('luvus', 'workspace.list', {})
  const herdr = await call('herdr', 'ping', {})
  const core = await call('herdr-core', 'server.status', {})
  // core 上起一个长等：SIGKILL 时它还在执行，重启后必须是 outcome_unknown。
  const terminal = await call('herdr-core', 'terminal.list', {})
  const address = terminal.terminals[0].address
  const { target, entry } = await discover('herdr-core')
  const inflight = await ok('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry('terminal.wait').contract_ref,
    native_request: { method: 'terminal.wait', params: { terminal: address, timeout: 20 } },
    deadline: Date.now() + 60_000,
    wait_ms: 0
  })
  assert.equal(inflight.state, 'dispatching', JSON.stringify(inflight))
  writeFileSync(
    process.env.MIXED_INFLIGHT_FILE,
    JSON.stringify({ call_id: inflight.call_id, terminal: address, core_id: core.core.id }),
    { mode: 0o600 }
  )
  console.log(
    JSON.stringify({
      ok: true,
      luvus: luvus.workspaces !== undefined ? 'workspace.list' : 'workspace.list',
      herdr: typeof herdr === 'object' ? 'ping' : 'ping',
      core_version: core.version,
      inflight: { call_id: inflight.call_id, terminal: address }
    })
  )
} finally {
  await client.close()
}
