// 用真实SDK异步派发窗口复现重复ID/取消竞争，断言实际SDK关联被清理，不用成功stub替代协议。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ErrorCode, ListToolsRequestSchema, McpError, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { rpcResponse } from './http-fixture.js'
import { createMcpFacade } from '../../src/mcp/facade.js'
import { FacadeHttpTransport } from '../../src/mcp/http-transport.js'
import { FacadeServiceError, type ServiceContext } from '../../src/mcp/types.js'

// 暂停SDK真实的异步priming阶段，显式控制取消和后续请求进入的次序。
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(
    /* 保存测试私有握手，不参与产品授权。 */ (done) => {
      resolve = done
    }
  )
  return { promise, resolve }
}

test(
  'SDK派发前重复/取消和旧POST收尾不误删复用ID，关闭清空SDK自身请求流映射',
  /* 保持默认5秒预算，重现真实异步窗口而不放宽超时。 */ async () => {
    const contexts: ServiceContext[] = []
    const serviceGate = gate()
    const serviceReady = gate()
    const transport = new FacadeHttpTransport({
      sessionIdGenerator: /* 固定值仅用于本隔离SDK实例。 */ () => 'test-session',
      keepAliveMs: 0
    })

    const sdk = transport as unknown as {
      _requestToStreamMapping: Map<string | number, string>
      // 测试只控制真实SDK已有的await点，仍调用原handleRequest及协议回调。
      writePrimingEvent(...args: unknown[]): Promise<void>
    }
    const server = createMcpFacade({
      service: {
        execute: /* 仅记录当前请求等待；故意阻塞以检测错误取消和重复执行。 */ async (_name, _args, context) => {
          contexts.push(context)
          serviceReady.resolve()
          await serviceGate.promise
          throw new FacadeServiceError('unavailable')
        }
      },
      context: {
        resolve: /* 合成上下文只在本SDK实例内有效。 */ (signal) => ({
          caller: { principal_id: 'isolated' },
          wait_signal: signal
        })
      }
    })
    await server.connect(transport)
    const send = /* 同一HTTP请求持有自己实际预留的token，SDK仍处理parsedBody。 */ (message: JSONRPCMessage) => {
      const reservation = transport.reserve(message)
      assert.notEqual(reservation, false)
      return {
        reservation: reservation || undefined,
        response: transport.handleReservedRequest(
          new Request('http://127.0.0.1:1/mcp', {
            method: 'POST',
            headers: {
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
              'mcp-session-id': 'test-session',
              'mcp-protocol-version': '2025-11-25'
            }
          }),
          { parsedBody: message },
          reservation || undefined
        )
      }
    }
    const originalPriming = sdk.writePrimingEvent
    let phase = gate()
    let entered = gate()
    try {
      const init = send({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'race', version: '1' } }
      })
      await (await init.response).text()
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' }).response
      sdk.writePrimingEvent = /* 暂停在SDK已建立原始stream映射、尚未派发业务的真实窗口。 */ async () => {
        entered.resolve()
        await phase.promise
      }
      const first = send({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'machines_list' } })
      await entered.promise
      assert.equal(sdk._requestToStreamMapping.size, 1)
      assert.equal(transport.reserve({ jsonrpc: '2.0', id: 0, method: 'ping' }), false)
      transport.releaseUndelivered(undefined)
      assert.equal(transport.reserve({ jsonrpc: '2.0', id: 0, method: 'ping' }), false)
      transport.cancelReservation(first.reservation!)
      assert.equal(transport.reserve({ jsonrpc: '2.0', id: 0, method: 'ping' }), false)
      phase.resolve()
      assert.equal(await (await first.response).text(), '')
      assert.equal(contexts.length, 0)
      assert.equal(sdk._requestToStreamMapping.size, 0)

      sdk.writePrimingEvent = originalPriming
      const second = send({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'machines_list' } })
      await serviceReady.promise
      transport.releaseUndelivered(first.reservation)
      transport.cancelReservation(first.reservation!)
      assert.equal(contexts[0]!.wait_signal.aborted, false)
      transport.cancelReservation(second.reservation!)
      await new Promise(
        /* 官方SDK通知处理异步派发，等其取消回调后检查真实signal。 */ (resolve) => setImmediate(resolve)
      )
      assert.equal(contexts[0]!.wait_signal.aborted, true)
      assert.equal(await (await second.response).text(), '')
      assert.equal(sdk._requestToStreamMapping.size, 0)

      phase = gate()
      entered = gate()
      sdk.writePrimingEvent = /* 再次暂停，覆盖transport.close发生在预派发窗口。 */ async () => {
        entered.resolve()
        await phase.promise
      }
      const last = send({ jsonrpc: '2.0', id: 8, method: 'ping' })
      await entered.promise
      await transport.close()
      assert.equal(sdk._requestToStreamMapping.size, 0)
      phase.resolve()
      assert.equal(await (await last.response).text(), '')
      assert.equal(sdk._requestToStreamMapping.size, 0)
    } finally {
      phase.resolve()
      serviceGate.resolve()
      sdk.writePrimingEvent = originalPriming
      await server.close()
    }
  }
)

test(
  '初始化回调await期间关闭先阻止SDK登记新流，恢复回调也不遗留请求映射',
  /* 检查早于priming的官方初始化await边界。 */ async () => {
    const entered = gate()
    const release = gate()
    const transport = new FacadeHttpTransport({
      sessionIdGenerator: /* 固定值只在此SDK实例有效。 */ () => 'initializing',
      onsessioninitialized: /* 把真实初始化回调停在可控窗口，不绕过SDK初始化实现。 */ async () => {
        entered.resolve()
        await release.promise
      }
    })
    const server = createMcpFacade({
      service: {
        execute: /* 初始化阶段绝不允许任何业务执行。 */ async () => {
          throw new Error('unexpected_test_service')
        }
      },
      context: { resolve: /* 没有业务认证上下文，初始化测试不能获得权限。 */ () => null }
    })
    await server.connect(transport)
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'early-close', version: '1' } }
    }
    const reservation = transport.reserve(message)
    assert(reservation)
    const response = transport.handleReservedRequest(
      new Request('http://127.0.0.1:1/mcp', {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
      }),
      { parsedBody: message },
      reservation
    )
    try {
      await entered.promise
      await transport.close()
      release.resolve()
      assert.equal((await response).status, 404)
      const sdk = transport as unknown as { _requestToStreamMapping: Map<string | number, string> }
      assert.equal(sdk._requestToStreamMapping.size, 0)
    } finally {
      release.resolve()
      await response
      await server.close()
    }
  }
)

test('HTTP transport 只重建固定超限 data，SDK 的其它字段、文案和 data 继续剥离', async () => {
  const transport = new FacadeHttpTransport({ sessionIdGenerator: () => 'error-data-test', keepAliveMs: 0 })
  const server = new Server({ name: 'error-data-test', version: '1' }, { capabilities: { tools: {} } })
  let code = ErrorCode.InvalidParams
  let data: unknown
  server.setRequestHandler(ListToolsRequestSchema, () => {
    throw new McpError(code, 'SYNTHETIC_SECRET_DO_NOT_PRINT', data)
  })
  await server.connect(transport)
  const send = async (message: JSONRPCMessage) => {
    const reservation = transport.reserve(message)
    assert.notEqual(reservation, false)
    return transport.handleReservedRequest(
      new Request('http://127.0.0.1:1/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': 'error-data-test',
          'mcp-protocol-version': '2025-11-25'
        }
      }),
      { parsedBody: message },
      reservation || undefined
    )
  }
  try {
    await rpcResponse(
      await send({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'error-data-test', version: '1' }
        }
      })
    )
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    for (const [errorCode, errorData, allow] of [
      [
        ErrorCode.InvalidParams,
        {
          reason: 'arguments_too_large',
          limit_bytes: 65536,
          hint: 'SYNTHETIC_SECRET_DO_NOT_PRINT',
          private_path: 'SYNTHETIC_SECRET_DO_NOT_PRINT'
        },
        true
      ],
      [ErrorCode.InternalError, { reason: 'arguments_too_large', limit_bytes: 65536 }, false],
      [ErrorCode.InvalidParams, { reason: 'arguments_too_large', limit_bytes: 65537 }, false],
      [ErrorCode.InvalidParams, { reason: 'SYNTHETIC_SECRET_DO_NOT_PRINT', limit_bytes: 65536 }, false]
    ] as const) {
      code = errorCode
      data = errorData
      const reply = await rpcResponse(await send({ jsonrpc: '2.0', id: 'check', method: 'tools/list' }))
      assert('error' in reply)
      assert.deepEqual(reply.error, {
        code,
        message: code === ErrorCode.InvalidParams ? 'Invalid params' : 'Internal error',
        ...(allow
          ? {
              data: {
                reason: 'arguments_too_large',
                limit_bytes: 65536,
                hint: 'reduce tool arguments; split into smaller calls only when supported by the native method'
              }
            }
          : {})
      })
      assert(!JSON.stringify(reply).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
    }
  } finally {
    await server.close()
  }
})
