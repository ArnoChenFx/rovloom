/**
 * 经已部署 Gateway 的 MCP 对真实 herdr-core 走一遍 machines → providers → discover → describe → 5 个读取，
 * 并验证控制档在 Gateway 就被拒绝。用法：MCP_CONFIG=<quickstart 写出的 mcp.json> bun e2e/herdr-core-session.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

assert(process.env.MCP_CONFIG, 'MCP_CONFIG is required')
const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const target = mcp.targets[0]
assert.equal(target.provider_id, 'herdr-core', JSON.stringify(target))
const client = new Client({ name: 'herdr-core-chain', version: '1' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: `Bearer ${mcp.token}` } }
  })
)

/** 返回统一投影；错误不抛出，由调用方断言。 */
async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  return { isError: result.isError === true, data: result.structuredContent?.data, raw: result.structuredContent }
}
async function ok(name, args) {
  const result = await tool(name, args)
  assert.equal(result.isError, false, `${name}:${JSON.stringify(result.raw)}`)
  return result.data
}

/** 提交一次原生调用并等到终态。 */
async function invoke(contract_ref, native_request, deadline = Date.now() + 30_000) {
  const submitted = await ok('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref,
    native_request,
    deadline,
    wait_ms: 500
  })
  let view = submitted
  const finished = new Set(['responded', 'not_dispatched', 'outcome_unknown'])
  for (let i = 0; i < 100 && !finished.has(view.state); i++) {
    view = await ok('runtime_call_get', { call_id: submitted.call_id, wait_ms: 200 })
  }
  return view
}

/** 读取全部结果页并校验摘要。 */
async function readAll(view) {
  assert(view.result?.result_id, `result_missing:${JSON.stringify(view)}`)
  const chunks = []
  let cursor
  for (;;) {
    const page = await ok('runtime_result_read', {
      result_id: view.result.result_id,
      max_bytes: 16_384,
      ...(cursor ? { cursor } : {})
    })
    chunks.push(Buffer.from(page.chunk, 'base64'))
    if (page.eof) {
      const bytes = Buffer.concat(chunks)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), page.sha256)
      return JSON.parse(bytes.toString('utf8'))
    }
    cursor = page.next_cursor
  }
}

try {
  const machines = await ok('machines_list', {})
  assert.equal(machines.items.length, 1)
  const providers = await ok('providers_list', { machine_id: target.machine_id })
  assert.equal(providers.items[0].kind, 'herdr-core')
  const discovered = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  const entry = (method) => discovered.items.find((item) => item.method === method)
  const methods = discovered.items.map((item) => item.method).sort()
  assert.deepEqual(methods, ['server.status', 'terminal.get', 'terminal.list', 'terminal.read', 'terminal.wait'])
  const described = await ok('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.read'
  })
  assert.equal(described.tier, 'conditional')
  const status = await invoke(entry('server.status').contract_ref, { method: 'server.status', params: {} })
  assert.equal(status.state, 'responded', JSON.stringify(status))
  const statusResult = (await readAll(status)).result
  assert.equal(statusResult.version, '0.1.14')
  assert.equal(typeof statusResult.pid, 'number')

  const listed = await invoke(entry('terminal.list').contract_ref, { method: 'terminal.list', params: {} })
  assert.equal(listed.state, 'responded', JSON.stringify(listed))
  const terminals = (await readAll(listed)).result.terminals
  assert(Array.isArray(terminals) && terminals.length >= 1, `terminal list: ${JSON.stringify(terminals)}`)
  const address = terminals[0].address

  const single = await invoke(entry('terminal.get').contract_ref, {
    method: 'terminal.get',
    params: { terminal: address }
  })
  assert.equal(single.state, 'responded', JSON.stringify(single))
  assert.equal((await readAll(single)).result.address, address)

  const read = await invoke(entry('terminal.read').contract_ref, {
    method: 'terminal.read',
    params: { terminal: address, lines: 0 }
  })
  assert.equal(read.state, 'responded', JSON.stringify(read))
  const text = (await readAll(read)).result.text
  assert.equal(typeof text, 'string')

  const waited = await invoke(entry('terminal.wait').contract_ref, {
    method: 'terminal.wait',
    params: { terminal: address, timeout: 0.2 }
  })
  assert.equal(waited.state, 'responded', JSON.stringify(waited))
  const waitResult = (await readAll(waited)).result
  assert.equal(waitResult.ended, false)

  // 控制档仍未开放：Gateway 在登记前拒绝，不会到达 core。
  const denied = await tool('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry('terminal.list').contract_ref,
    native_request: { method: 'terminal.send', params: { terminal: address, text: 'x' } },
    deadline: Date.now() + 30_000
  })
  assert.equal(denied.isError, true, JSON.stringify(denied.raw))
  const deniedCode = denied.raw?.gateway_error?.code
  assert.equal(deniedCode, 'herdr_core_method_unavailable', JSON.stringify(denied.raw))

  console.log(
    JSON.stringify({
      ok: true,
      kind: providers.items[0].kind,
      machines: machines.items.length,
      methods,
      described_tier: described.tier,
      version: statusResult.version,
      pid: statusResult.pid,
      terminal: address,
      read_bytes: text.length,
      wait_reason: waitResult.reason,
      denied: deniedCode
    })
  )
} finally {
  await client.close()
}
