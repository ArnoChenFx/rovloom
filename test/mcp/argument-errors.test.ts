// 经真实 HTTP/SDK 与 Store/Router 验证错误面和幂等；投影 fixture 不派发原生请求。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { canonical } from '../../src/contracts.js'
import { MAX_MCP_BYTES } from '../../src/mcp/schema.js'
import { rawHttp } from './http-fixture.js'
import { projectionFixture } from './runtime-service-fixture.js'

test('MCP deadline 错误可编程区分，首次登记精确接受十分钟上界且拒绝时不占 key', async () => {
  const f = projectionFixture({ pending: true })
  const http = rawHttp(f.service, { authentication: { authenticate: () => f.context.caller } })
  try {
    await http.initialize()
    const now = f.store.clock()
    const args = { ...f.args, client_request_key: 'deadline_boundary' }
    for (const [offset, code] of [
      [600_001, 'invalid_deadline'],
      [0, 'deadline_exceeded'],
      [-5000, 'deadline_exceeded']
    ] as const) {
      const reply = await http.request(String(offset), 'tools/call', {
        name: 'runtime_call',
        arguments: { ...args, deadline: now + offset }
      })
      assert.equal(reply.error, undefined)
      const result = reply.result as { isError: boolean; structuredContent: unknown }
      assert.equal(result.isError, true)
      assert.deepEqual(result.structuredContent, { gateway_error: { code } })
      assert.equal(f.registered.length, 0)
    }
    const accepted = await http.request('upper_bound', 'tools/call', {
      name: 'runtime_call',
      arguments: { ...args, deadline: now + 600_000 }
    })
    assert.equal(accepted.error, undefined)
    const result = accepted.result as { isError?: boolean; structuredContent: { data: { call_id: string } } }
    assert(!result.isError)
    assert.equal(f.store.call('alice', result.structuredContent.data.call_id).deadline, now + 600_000)
    assert.equal(f.registered.length, 1)
  } finally {
    await http.close()
    f.close()
  }
})

test('MCP 幂等重试复用绝对 deadline，过期后仍查原调用，改 deadline 冲突而 wait_ms 可变', async () => {
  const f = projectionFixture({ pending: true })
  const http = rawHttp(f.service, { authentication: { authenticate: () => f.context.caller } })
  try {
    await http.initialize()
    const args = { ...f.args, client_request_key: 'fixed_deadline' }
    const invoke = (id: string, arguments_: Record<string, unknown>) =>
      http.request(id, 'tools/call', { name: 'runtime_call', arguments: arguments_ })
    const first = await invoke('first', args)
    const original = (first.result as { structuredContent: { data: { call_id: string } } }).structuredContent.data
    for (const change of [{ deadline: args.deadline + 1 }, { native_request: { method: 'pane.list' } }]) {
      const conflict = await invoke('changed', { ...args, ...change })
      assert.deepEqual((conflict.result as { structuredContent: unknown }).structuredContent, {
        gateway_error: { code: 'conflict' }
      })
    }
    f.advance(20_001)
    const retry = await invoke('expired_duplicate', { ...args, wait_ms: 1 })
    assert.equal(retry.error, undefined)
    const result = retry.result as {
      isError?: boolean
      structuredContent: { data: { call_id: string } }
    }
    assert(!result.isError)
    assert.equal(result.structuredContent.data.call_id, original.call_id)
    assert.equal(f.store.call('alice', original.call_id).deadline, args.deadline)
    assert.deepEqual(f.registered, [original.call_id, original.call_id])
  } finally {
    await http.close()
    f.close()
  }
})

test('MCP 完整参数按 UTF-8 JSON 字节限额，超限 -32602 保留固定 data 而不反射参数', async () => {
  const f = projectionFixture()
  const http = rawHttp(f.service, { authentication: { authenticate: () => f.context.caller } })
  const expected = {
    reason: 'arguments_too_large',
    limit_bytes: 65_536,
    hint: 'reduce tool arguments; split into smaller calls only when supported by the native method'
  }
  try {
    await http.initialize()
    const base = { ...f.args, native_request: { method: 'pane.run', params: { pane: '1', command: '' } } }
    const overhead = Buffer.byteLength(canonical(base))
    for (const character of ['x', '界', '\n']) {
      const width = Buffer.byteLength(JSON.stringify(character)) - 2
      for (const size of [MAX_MCP_BYTES - 1, MAX_MCP_BYTES, MAX_MCP_BYTES + 1]) {
        const available = size - overhead
        const args = {
          ...base,
          native_request: {
            ...base.native_request,
            params: {
              pane: '1',
              command: character.repeat(Math.floor(available / width)) + 'x'.repeat(available % width)
            }
          }
        }
        assert.equal(Buffer.byteLength(canonical(args)), size)
        const previous = f.calls.length
        const reply = await http.request('budget', 'tools/call', { name: 'runtime_call', arguments: args })
        if (size > MAX_MCP_BYTES) {
          assert.deepEqual(reply.error, { code: -32602, message: 'Invalid params', data: expected })
          assert.equal(f.calls.length, previous)
        } else {
          assert.equal(reply.error, undefined)
          assert.equal(f.calls.length, previous + 1)
        }
      }
    }
    const malformed = await http.request('shape', 'tools/call', {
      name: 'runtime_call',
      arguments: { ...base, private_field: 'SYNTHETIC_SECRET_DO_NOT_PRINT' }
    })
    assert.deepEqual(malformed.error, { code: -32602, message: 'Invalid params' })
    assert(!JSON.stringify(http.wire).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
    // 官方客户端也必须保留 error.data，不能只在原始 JSON-RPC 探针里可见。
    await http.client.connect(http.transport, { timeout: 5000 })
    const previous = f.calls.length
    await assert.rejects(
      http.client.callTool(
        {
          name: 'runtime_call',
          arguments: { ...base, native_request: { method: 'pane.run', params: { command: 'x'.repeat(MAX_MCP_BYTES) } } }
        },
        undefined,
        { timeout: 5000 }
      ),
      (error: unknown) => {
        assert(error instanceof McpError)
        assert.equal(error.code, -32602)
        assert.deepEqual(error.data, expected)
        return true
      }
    )
    assert.equal(f.calls.length, previous)
  } finally {
    await http.close()
    f.close()
  }
})
