/** 真实 Luvus 的输出等待验收；由 quickstart --legacy-wait-output 在旧配置升级后调用。 */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

assert(process.env.MCP_CONFIG, 'MCP_CONFIG is required')
const config = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const target = config.targets[0]
const client = new Client({ name: 'legacy-wait-output', version: '1' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { authorization: 'Bearer ' + config.token } }
  })
)
const route = { target, expected_binding_revision: 1 }
async function tool(name, args) {
  const reply = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  assert(!reply.isError, JSON.stringify(reply.structuredContent))
  return reply.structuredContent.data
}
let methods
let createdWorkspace
async function native(method, params) {
  let call = await tool('runtime_call', {
    ...route,
    contract_ref: methods.get(method),
    native_request: { method, params },
    deadline: Date.now() + 30000,
    wait_ms: 500
  })
  while (['created', 'dispatching', 'connector_accepted'].includes(call.state)) {
    call = await tool('runtime_call_get', { call_id: call.call_id, wait_ms: 500 })
  }
  assert.equal(call.state, 'responded', JSON.stringify(call))
  const chunks = []
  let cursor
  for (;;) {
    const page = await tool('runtime_result_read', {
      result_id: call.result.result_id,
      max_bytes: 16384,
      ...(cursor ? { cursor } : {})
    })
    chunks.push(Buffer.from(page.chunk, 'base64'))
    if (page.eof) {
      const bytes = Buffer.concat(chunks)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), page.sha256)
      const reply = JSON.parse(bytes.toString())
      assert(!reply.error, JSON.stringify(reply.error))
      return reply.result
    }
    cursor = page.next_cursor
  }
}
try {
  const discovered = await tool('runtime_discover', { ...route, limit: 100 })
  methods = new Map(discovered.items.map((row) => [row.method, row.contract_ref]))
  assert(methods.has('wait.output'), 'legacy token cannot discover wait.output')
  const described = await tool('runtime_describe', { ...route, method: 'wait.output' })
  assert.equal(described.schema_status, 'generic_params_only')
  assert(described.parameter_help.rules.some((rule) => rule.includes('existing marker')))
  createdWorkspace = (await native('workspace.new', {})).workspace
  const panes = (await native('pane.list', {})).panes
  const pane = panes.find((row) => row.workspace === createdWorkspace)?.pane
  assert(pane, 'new workspace pane missing')
  let marker
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = (await native('pane.read', { pane, lines: 100 })).text
    marker = text
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.slice(0, 100)
    if (marker) {
      break
    }
    await pause(100)
  }
  assert(marker, 'shell produced no readable output')
  assert.equal((await native('wait.output', { pane, match: marker, timeout_s: 2 })).matched, true)
  assert.equal((await native('wait.output', { pane, match: randomUUID(), timeout_s: 0.2 })).matched, false)
  assert((await native('pane.list', {})).panes.some((row) => row.pane === pane))
  console.log(`WAIT_OUTPUT_NATIVE_OK visible_methods=${methods.size} matched=true timeout=false connection=alive`)
} finally {
  if (createdWorkspace !== undefined) {
    await native('workspace.close', { workspace: createdWorkspace })
  }
  await client.close()
}
