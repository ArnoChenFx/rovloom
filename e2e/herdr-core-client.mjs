/**
 * herdr-core e2e 场景共用的 MCP 客户端：读取 quickstart 写出的 mcp.json，提交一次原生调用并等到终态。
 * 只做协议投影与轮询；每个场景自己断言业务结果。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

export async function connect() {
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
  /** 提交一次原生调用并等到终态；返回最后的调用视图。 */
  async function invoke(contract_ref, native_request, deadline = Date.now() + 30_000, wait_ms = 500) {
    const submitted = await ok('runtime_call', {
      target,
      expected_binding_revision: 1,
      contract_ref,
      native_request,
      deadline,
      wait_ms
    })
    let view = submitted
    const finished = new Set(['responded', 'not_dispatched', 'outcome_unknown'])
    for (let i = 0; i < 200 && !finished.has(view.state); i++) {
      view = await ok('runtime_call_get', { call_id: submitted.call_id, wait_ms: 100 })
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
  /** 一次成功读取：返回原生结果。 */
  async function call(contract_ref, method, params) {
    const view = await invoke(contract_ref, { method, params })
    assert.equal(view.state, 'responded', `${method}:${JSON.stringify(view)}`)
    return readAll(view)
  }
  return { client, target, tool, ok, invoke, readAll, call }
}
