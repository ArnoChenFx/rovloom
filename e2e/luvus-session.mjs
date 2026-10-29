/** 经已部署 Gateway 的 MCP 对真实 Luvus 走一遍 discover → describe → call → get → result_read。
 * 用法：MCP_CONFIG=<quickstart.py 写出的 mcp.json> bun e2e/luvus-session.mjs
 * 默认只调只读方法（workspace.list / session.snapshot）；设置 LUVUS_WRITE=<workspace.new 的 params JSON> 时再创建一个 workspace 并读回计数。
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
const client = new Client({ name: 'luvus-chain', version: '1' })
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
async function invoke(contract_ref, native_request) {
  const submitted = await ok('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref,
    native_request,
    deadline: Date.now() + 30_000,
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
  const providers = await ok('providers_list', { machine_id: target.machine_id })
  assert.equal(providers.items[0].kind, 'luvus')
  // Luvus 刚被重建时 Connector 还在重连：目录读取在就绪前会失败，限时重试。
  let discovered
  for (let attempt = 0; ; attempt++) {
    const result = await tool('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
    if (!result.isError) {
      discovered = result.data
      break
    }
    assert(attempt < 120, `runtime_discover:${JSON.stringify(result.raw)}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const methods = discovered.items.map((item) => item.method).sort()
  assert(methods.includes('workspace.list'), `workspace.list missing in ${methods.join(',')}`)
  const entry = (method) => discovered.items.find((item) => item.method === method)
  const described = await ok('runtime_describe', { target, expected_binding_revision: 1, method: 'workspace.new' })
  assert.equal(described.method, 'workspace.new')
  if (process.env.SHOW_DESCRIBE) {
    console.log(JSON.stringify(described).slice(0, 3000))
  }
  const count = async () => {
    const view = await invoke(entry('workspace.list').contract_ref, { method: 'workspace.list', params: {} })
    assert.equal(view.state, 'responded', JSON.stringify(view))
    const reply = await readAll(view)
    return { reply, n: (reply.result?.workspaces ?? reply.result?.items ?? []).length }
  }
  const before = await count()
  const snapshot = await invoke(entry('session.snapshot').contract_ref, { method: 'session.snapshot', params: {} })
  assert.equal(snapshot.state, 'responded', JSON.stringify(snapshot))
  const evidence = { machines: machines.items.length, methods: methods.length, workspaces_before: before.n }
  // 两台机器部署时设备本机路径在 Gateway 侧不存在：已发布的 pin 必须引用 Gateway 自己的
  // 内容寻址副本，且该副本的摘要与在线契约摘要一致。
  const gatewayState = process.env.ROVLOOM_GATEWAY_STATE
  if (gatewayState) {
    const providers = JSON.parse(readFileSync(`${gatewayState}/managed/providers.json`, 'utf8'))
    const contract = providers.providers[0].value.contract
    if (process.env.ROVLOOM_EXPECT_LEGACY_SCHEMA === '1') {
      assert.equal(typeof contract.schema_bundle, 'string', 'legacy pin keeps the original inline schema')
      assert.equal(contract.schema_ref, undefined)
      assert.equal(createHash('sha256').update(contract.schema_bundle).digest('hex'), contract.schema_sha256)
      evidence.gateway_schema_ref = 'legacy-inline'
    } else {
      assert.equal(contract.schema_bundle, undefined, 'published pin must not inline the schema')
      assert.equal(
        contract.schema_ref,
        `${gatewayState}/managed/schema_${contract.schema_sha256}.json`,
        `published pin must reference the Gateway copy, got ${contract.schema_ref}`
      )
      const published = readFileSync(contract.schema_ref)
      assert.equal(createHash('sha256').update(published).digest('hex'), contract.schema_sha256)
      evidence.gateway_schema_ref = 'own-copy'
    }
  }
  if (process.env.LUVUS_WRITE) {
    const created = await invoke(entry('workspace.new').contract_ref, {
      method: 'workspace.new',
      params: JSON.parse(process.env.LUVUS_WRITE)
    })
    assert.equal(created.state, 'responded', JSON.stringify(created))
    evidence.workspaces_after = (await count()).n
    assert.equal(evidence.workspaces_after, before.n + 1)
  }
  console.log(JSON.stringify({ ok: true, ...evidence }))
} finally {
  await client.close()
}
