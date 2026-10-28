/** 真实升级前后复用同一 token/设备及已提交结果；仅操作 quickstart 的隔离 HOME。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

const phase = process.argv[2]
assert(['before', 'after'].includes(phase))
assert(process.env.MCP_CONFIG && process.env.UPGRADE_EVIDENCE)
const config = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const target = config.targets[0]
const client = new Client({ name: 'native-upgrade-proof', version: '1' })
async function tool(name, args) {
  const reply = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  assert(!reply.isError, JSON.stringify(reply.structuredContent))
  return reply.structuredContent.data
}
async function read(result) {
  const chunks = []
  let cursor
  for (;;) {
    const page = await tool('runtime_result_read', {
      result_id: result.result_id,
      max_bytes: 4096,
      ...(cursor ? { cursor } : {})
    })
    assert.equal(page.sha256, result.sha256)
    assert.equal(page.expires_at, result.expires_at)
    chunks.push(Buffer.from(page.chunk, 'base64'))
    if (page.eof) {
      const bytes = Buffer.concat(chunks)
      assert.equal(bytes.length, result.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256)
      assert(!JSON.parse(bytes.toString()).error)
      return
    }
    cursor = page.next_cursor
  }
}
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: { authorization: 'Bearer ' + config.token } }
    })
  )
  const device = await tool('machines_get', { machine_id: target.machine_id })
  assert.equal(device.machine_id, target.machine_id)
  if (phase === 'after') {
    const previous = JSON.parse(readFileSync(process.env.UPGRADE_EVIDENCE, 'utf8'))
    assert.deepEqual(previous.target, target)
    const stored = await tool('runtime_call_get', { call_id: previous.call_id })
    assert.equal(stored.state, 'responded')
    assert.deepEqual(stored.result, previous.result)
    await read(previous.result)
  }
  const route = { target, expected_binding_revision: 1 }
  const description = await tool('runtime_describe', { ...route, method: 'pane.list' })
  if (phase === 'after') {
    const previous = JSON.parse(readFileSync(process.env.UPGRADE_EVIDENCE, 'utf8'))
    assert.equal(description.contract_ref, previous.contract_ref, 'same installation contract_ref must survive upgrade')
  }
  let call = await tool('runtime_call', {
    ...route,
    contract_ref: description.contract_ref,
    native_request: { method: 'pane.list', params: {} },
    deadline: Date.now() + 20000,
    wait_ms: 500
  })
  while (['created', 'dispatching', 'connector_accepted'].includes(call.state)) {
    call = await tool('runtime_call_get', { call_id: call.call_id, wait_ms: 500 })
  }
  assert.equal(call.state, 'responded', JSON.stringify(call))
  await read(call.result)
  if (phase === 'before') {
    writeFileSync(
      process.env.UPGRADE_EVIDENCE,
      JSON.stringify({ target, contract_ref: description.contract_ref, call_id: call.call_id, result: call.result }),
      { mode: 0o600 }
    )
  }
  console.log(`UPGRADE_${phase.toUpperCase()}_OK provider=${target.provider_id} native=pane.list bytes_verified=true`)
} finally {
  await client.close()
}
