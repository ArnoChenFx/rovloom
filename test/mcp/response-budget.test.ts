// 真实 SDK transport 的最终信封预算；自建 Server 故意绕过工具结果预算，不代表原生执行。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { FacadeHttpTransport } from '../../src/mcp/http-transport.js'
import { MAX_MCP_BYTES } from '../../src/mcp/schema.js'
import { rpcResponse } from './http-fixture.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const catalog = (description: string) => ({
  tools: [{ name: 'budget_probe', description, inputSchema: { type: 'object' as const } }]
})

for (const enableJsonResponse of [false, true]) {
  test(`超限响应只拒绝当前请求，边界、并发、ID 复用和会话保持正常（JSON=${enableJsonResponse}）`, async () => {
    const transport = new FacadeHttpTransport({
      sessionIdGenerator: () => 'response-budget',
      keepAliveMs: 0,
      enableJsonResponse
    })
    const server = new Server({ name: 'response-budget', version: '1' }, { capabilities: { tools: {} } })
    const entered = gate()
    const release = gate()
    let response = catalog('small')
    let heldSignal: AbortSignal | undefined
    let closed = 0
    const diagnostics: string[] = []
    server.onclose = () => {
      closed++
    }
    server.onerror = (error) => {
      diagnostics.push(error.message)
    }
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      if (request.params?.cursor === 'hold') {
        heldSignal = extra.signal
        entered.resolve()
        await release.promise
        return catalog('held')
      }
      return response
    })
    await server.connect(transport)
    const sdk = transport as unknown as { _requestToStreamMapping: Map<string | number, string> }
    const send = async (message: JSONRPCMessage) => {
      const reservation = transport.reserve(message)
      assert.notEqual(reservation, false)
      return transport.handleReservedRequest(
        new Request('http://127.0.0.1:1/mcp', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-session-id': 'response-budget',
            'mcp-protocol-version': '2025-11-25'
          }
        }),
        { parsedBody: message },
        reservation || undefined
      )
    }
    let held: Promise<Response> | undefined
    try {
      await rpcResponse(
        await send({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'response-budget', version: '1' }
          }
        })
      )
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      held = send({ jsonrpc: '2.0', id: 'held', method: 'tools/list', params: { cursor: 'hold' } })
      await entered.promise
      for (const id of [0, '']) {
        const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, result: catalog('') }))
        for (const bytes of [MAX_MCP_BYTES, MAX_MCP_BYTES + 1]) {
          response = catalog('x'.repeat(bytes - overhead))
          const reply = await rpcResponse(await send({ jsonrpc: '2.0', id, method: 'tools/list' }))
          assert('id' in reply)
          assert.equal(reply.id, id)
          if (bytes > MAX_MCP_BYTES) {
            assert('error' in reply)
            assert.deepEqual(reply.error, {
              code: -32603,
              message: 'Internal error',
              data: { reason: 'response_too_large', limit_bytes: 65536 }
            })
          } else {
            assert('result' in reply)
            assert.equal(Buffer.byteLength(JSON.stringify(reply)), MAX_MCP_BYTES)
          }
          assert.equal(closed, 0)
          assert.equal(heldSignal?.aborted, false)
          assert.equal(sdk._requestToStreamMapping.size, 1)
        }
      }
      // 无请求关联的超限发送必须明确拒绝，不能吞掉发送失败或结束会话。
      await assert.rejects(
        transport.send({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { text: 'x'.repeat(MAX_MCP_BYTES) }
        }),
        { message: 'response_too_large' }
      )
      assert.equal(closed, 0)
      assert.equal(heldSignal?.aborted, false)
      release.resolve()
      const other = await rpcResponse(await held)
      assert('result' in other)
      assert.deepEqual(other.result, catalog('held'))
      assert.equal(sdk._requestToStreamMapping.size, 0)
      response = catalog('after')
      const after = await rpcResponse(await send({ jsonrpc: '2.0', id: 0, method: 'tools/list' }))
      assert('result' in after)
      assert.deepEqual(after.result, catalog('after'))
      assert.equal(sdk._requestToStreamMapping.size, 0)
      assert.deepEqual(diagnostics, Array(3).fill('response_too_large'))
    } finally {
      release.resolve()
      if (held) {
        await held
          .then(async (reply) => {
            if (!reply.bodyUsed) {
              await reply.text()
            }
          })
          .catch(() => {})
      }
      await server.close()
    }
  })
}
