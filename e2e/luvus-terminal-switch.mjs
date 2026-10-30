/**
 * 终端执行开关的真实链路验收：Connector 配置显式 `allow_terminal_execution=false`（默认已是开启，
 * 须先在 connector.json 写入 false 并重启）时，
 * 目录必须隐藏直接输入终端的方法，精确 describe 必须拒绝，只读调用不受影响。
 * 用法：MCP_CONFIG=<quickstart.py 写出的 mcp.json> bun --no-env-file e2e/luvus-terminal-switch.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

assert(process.env.MCP_CONFIG, 'MCP_CONFIG is required')
const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const target = mcp.targets[0]
const client = new Client({ name: 'luvus-terminal-switch', version: '1' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: `Bearer ${mcp.token}` } }
  })
)

/** 统一投影；错误不抛出，由调用方断言。 */
async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  return { isError: result.isError === true, data: result.structuredContent?.data, raw: result.structuredContent }
}

// 完整分页读取目录，不能只看第一页就下结论。
const rows = []
let cursor
do {
  const page = await tool('runtime_discover', {
    target,
    expected_binding_revision: 1,
    limit: 100,
    ...(cursor ? { cursor } : {})
  })
  assert.notEqual(page.isError, true, JSON.stringify(page.raw))
  rows.push(...page.data.items)
  cursor = page.data.next_cursor
} while (cursor)
const methods = rows.map((row) => row.method)

// 开关关闭：直接输入终端的方法必须不出现在目录里。
for (const hidden of ['pane.run', 'agent.keys']) {
  assert(!methods.includes(hidden), `${hidden} must be hidden while terminal execution is off`)
}
// 精确 describe 同样按当前开关拒绝，而不是返回描述后再拒绝执行。
const denied = await tool('runtime_describe', { target, expected_binding_revision: 1, method: 'pane.run' })
assert.equal(denied.isError, true, JSON.stringify(denied.raw))
assert.equal(denied.raw.gateway_error.code, 'not_found')

// 只读调用不受开关影响：走完整 call → get 链路。
const reference = rows.find((row) => row.method === 'workspace.list')?.contract_ref
assert(reference, 'workspace.list must be discoverable')
const submitted = await tool('runtime_call', {
  target,
  expected_binding_revision: 1,
  contract_ref: reference,
  native_request: { method: 'workspace.list', params: {} },
  deadline: Date.now() + 30_000,
  wait_ms: 2000
})
assert.notEqual(submitted.isError, true, JSON.stringify(submitted.raw))
let view = submitted.data
for (let i = 0; i < 50 && !['responded', 'not_dispatched', 'outcome_unknown'].includes(view.state); i++) {
  await new Promise((resolve) => setTimeout(resolve, 200))
  view = (await tool('runtime_call_get', { call_id: view.call_id, wait_ms: 500 })).data
}
assert.equal(view.state, 'responded', JSON.stringify(view))

await client.close()
console.log(
  JSON.stringify({
    methods: methods.length,
    hidden: ['pane.run', 'agent.keys'],
    describe_denied: denied.raw.gateway_error.code,
    readonly_call: view.state
  })
)
