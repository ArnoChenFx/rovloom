/**
 * 多 provider 场景共用的 MCP 客户端：连一次 Gateway，按 provider_id 挑 target，
 * 提交原生调用并等到终态。只做协议投影，业务断言写在各自场景里。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

export async function connectMixed() {
  assert(process.env.MCP_CONFIG, 'MCP_CONFIG is required')
  const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
  const client = new Client({ name: 'mixed-chain', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { authorization: `Bearer ${mcp.token}` } }
    })
  )
  const byKind = new Map(mcp.targets.map((target) => [target.provider_id, target]))
  async function tool(name, args) {
    const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
    return { isError: result.isError === true, data: result.structuredContent?.data, raw: result.structuredContent }
  }
  async function ok(name, args) {
    const result = await tool(name, args)
    assert.equal(result.isError, false, `${name}:${JSON.stringify(result.raw)}`)
    return result.data
  }
  /** 该 provider 的目录条目（含 available 与 contract_ref）。 */
  async function discover(kind) {
    const target = byKind.get(kind)
    assert(target, `target ${kind} missing: ${JSON.stringify([...byKind.keys()])}`)
    const page = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
    const entry = (method) => page.items.find((item) => item.method === method)
    return { target, page, entry }
  }
  async function invoke(target, contract_ref, native_request, wait_ms = 500, deadline = Date.now() + 60_000) {
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
    for (let index = 0; index < 200 && !finished.has(view.state); index++) {
      view = await ok('runtime_call_get', { call_id: submitted.call_id, wait_ms: 100 })
    }
    return view
  }
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
  async function call(kind, method, params) {
    const { target, entry } = await discover(kind)
    const found = entry(method)
    assert(found, `${kind}/${method} missing: ${JSON.stringify((await discover(kind)).page.items.map((i) => i.method))}`)
    const view = await invoke(target, found.contract_ref, { method, params })
    assert.equal(view.state, 'responded', `${kind}/${method}:${JSON.stringify(view)}`)
    return readAll(view)
  }
  return { client, targets: byKind, tool, ok, discover, invoke, readAll, call }
}
