// 使用真实HTTP listener及受控服务stub验证协议、身份、输入和等待边界，不接用户或原生实例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseToolArguments, toolDefinition } from '../../src/mcp/schema.js'
import { FacadeServiceError, type ServiceContext, type ToolName } from '../../src/mcp/types.js'
import { HTTP_BODY_BYTES, createHttpFacade } from '../../src/mcp/http.js'
import { rawHttp, rpcResponse, syntheticHeaders } from './http-fixture.js'

// 测试异步状态通过显式握手推进，不猜测网络或服务已经开始。
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(
    /* 保留本例独立通知入口。 */ (done) => {
      resolve = done
    }
  )
  return { promise, resolve }
}
const unused = {
  execute: /* 非法请求不能进入服务；若发生即由计数或断言暴露。 */ async () => {
    throw new Error('unused_test_stub')
  }
}

test(
  'GET已有排队SSE注释且无人pull时，deadline仍释放SDK流并允许同会话重新GET',
  /* 覆盖空闲响应反压，不能依赖pull异常才清理资源。 */ async () => {
    const facade = createHttpFacade({
      origin: 'http://127.0.0.1:1',
      service: unused,
      requestTimeoutMs: 30,
      authentication: {
        authenticate: /* 合成认证只测试会话资源，不接入真实凭据。 */ () => ({ principal_id: 'isolated' })
      }
    })
    const headers: Record<string, string> = {
      host: '127.0.0.1:1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    }
    const request = /* 直接走正式Web Request处理器，保持初始响应无人消费。 */ (method: string, body?: unknown) =>
      facade.handleRequest(
        new Request('http://127.0.0.1:1/mcp', { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
      )
    try {
      const init = await request('POST', {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'queued-get', version: '1' } }
      })
      headers['mcp-session-id'] = init.headers.get('mcp-session-id')!
      headers['mcp-protocol-version'] = '2025-11-25'
      await rpcResponse(init)
      await request('POST', { jsonrpc: '2.0', method: 'notifications/initialized' })
      const first = await request('GET')
      assert.equal(first.status, 200)
      await new Promise(
        /* 等待该响应真实deadline，初始SSE注释始终留在外层队列。 */ (resolve) => setTimeout(resolve, 60)
      )
      const second = await request('GET')
      assert.equal(second.status, 200)
      assert.equal(await first.text(), ': connected\n\n')
      await second.body!.cancel()
    } finally {
      await facade.close()
    }
  }
)

test(
  'HTTP固定路径、Host/Origin及认证逐请求拒绝，sessionID不是身份且不信转发头',
  /* 验证远程身份只来自受信认证宿主。 */ async () => {
    let identity = 'alice'
    let reads = 0
    const harness = rawHttp(unused, {
      authentication: {
        authenticate: /* 只读合成header并记录每次认证；不读取业务参数中的身份。 */ (request) => {
          reads++
          return request.headers.get('authorization') === syntheticHeaders.authorization
            ? { principal_id: identity }
            : null
        }
      }
    })
    try {
      await harness.initialize()
      const url = harness.running.url
      assert.equal((await fetch(url, { headers: { ...harness.headers(), authorization: 'Bearer wrong' } })).status, 401)
      identity = 'bob'
      assert.equal((await fetch(url, { headers: harness.headers() })).status, 403)
      identity = 'alice'
      for (const headers of [
        { origin: 'null' },
        { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }
      ] as Record<string, string>[]) {
        assert.equal((await fetch(url, { headers: { ...harness.headers(), ...headers } })).status, 403)
      }
      assert.equal(
        (await fetch(url + '?token=SYNTHETIC_SECRET_DO_NOT_PRINT', { headers: harness.headers() })).status,
        403
      )
      assert.equal((await fetch(url.replace('/mcp', '/admin'), { headers: harness.headers() })).status, 403)
      assert.equal(
        (await fetch(url, { method: 'DELETE', headers: { ...harness.headers(), 'x-forwarded-user': 'administrator' } }))
          .status,
        200
      )
      assert(reads >= 5)
      assert.equal((await fetch(url, { headers: harness.headers() })).status, 404)
      assert.equal((await fetch(url)).status, 401)
    } finally {
      await harness.close()
    }
  }
)

test(
  '严格HTTP原始字节边界拒绝坏JSON、重复键、截断UTF8及超体积，不回显秘密或派发',
  /* 解析前施加体积上限，合法Unicode跨chunk保持原值。 */ async () => {
    let calls = 0
    let observed: unknown
    const harness = rawHttp({
      execute: /* 只记录合法请求快照，不模拟生产后端成功。 */ async (_name, args) => {
        calls++
        observed = args
        throw new FacadeServiceError('unavailable')
      }
    })
    try {
      await harness.initialize()
      for (const body of [
        Buffer.from('{"SYNTHETIC_SECRET_DO_NOT_PRINT":'),
        Buffer.from([0xff]),
        Buffer.from([0xe4]),
        Buffer.from('{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}'),
        Buffer.from('x'.repeat(HTTP_BODY_BYTES + 1))
      ]) {
        const response = await fetch(harness.running.url, { method: 'POST', headers: harness.headers(), body })
        assert([400, 413].includes(response.status))
        assert(!(await response.text()).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      }
      assert.equal(calls, 0)
      const bytes = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'unicode',
          method: 'tools/call',
          params: { name: 'machines_get', arguments: { name: '前😀后' } }
        })
      )
      const stream = new ReadableStream<Uint8Array>({
        start: /* 逐字节输入覆盖多字节字符的所有chunk边界。 */ (controller) => {
          for (const byte of bytes) {
            controller.enqueue(new Uint8Array([byte]))
          }
          controller.close()
        }
      })
      const response = await fetch(harness.running.url, {
        method: 'POST',
        headers: harness.headers(),
        body: stream,
        duplex: 'half'
      } as RequestInit)
      await response.text()
      assert.deepEqual(observed, { name: '前😀后' })
      assert.equal(calls, 1)
    } finally {
      await harness.close()
    }
  }
)

test(
  '最大会话数、空闲过期和HTTP请求deadline均有界，关闭幂等且不占用持久Gateway生命周期',
  /* 小预算只由本测试显式配置，不改变产品或既有测试超时。 */ async () => {
    const harness = rawHttp(unused, { maxSessions: 1, idleMs: 30, requestTimeoutMs: 100 })
    try {
      await harness.initialize()
      const init = {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'capacity', version: '1' } }
      }
      const headers = { ...harness.headers() }
      delete (headers as Partial<typeof headers>)['mcp-session-id']
      assert.equal(
        (await fetch(harness.running.url, { method: 'POST', headers, body: JSON.stringify(init) })).status,
        429
      )
      await new Promise(/* 覆盖两轮真实空闲扫描，随后检验旧会话失效。 */ (resolve) => setTimeout(resolve, 90))
      assert.equal((await fetch(harness.running.url, { headers: harness.headers() })).status, 404)
      await harness.running.close()
      await harness.running.close()
    } finally {
      await harness.close()
    }
    let activeSignal: AbortSignal | undefined
    const facade = createHttpFacade({
      origin: 'http://127.0.0.1:1',
      service: unused,
      requestTimeoutMs: 20,
      authentication: {
        authenticate: /* 故意不完成的认证stub验证deadline，真实宿主必须观察signal并释放资源。 */ (_request, signal) => {
          activeSignal = signal
          return new Promise(/* 保持认证待定，不产生身份。 */ () => {})
        }
      }
    })
    try {
      assert.equal(
        (await facade.handleRequest(new Request('http://127.0.0.1:1/mcp', { headers: { host: '127.0.0.1:1' } })))
          .status,
        408
      )
      assert.equal(activeSignal?.aborted, true)
    } finally {
      await facade.close()
    }
  }
)

test(
  '合法falsey ID取消只停止对应等待，ID复用没有旧回复；同会话重复在途ID在SDK前拒绝',
  /* 保留旧协议关联及晚到结果断言，改由独立HTTP POST驱动。 */ async () => {
    for (const id of [0, '', 7]) {
      const started = gate()
      const release = gate()
      const finished = gate()
      const contexts: ServiceContext[] = []
      const harness = rawHttp({
        execute: /* 记录等待并故意延迟返回，不执行原生动作。 */ async (_name, _args, context) => {
          contexts.push(context)
          started.resolve()
          await release.promise
          finished.resolve()
          throw new FacadeServiceError('unavailable')
        }
      })
      try {
        await harness.initialize()
        const response = await harness.post({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'machines_list' }
        })
        await started.promise
        assert.equal((await harness.post({ jsonrpc: '2.0', id, method: 'ping' })).status, 409)
        assert.equal(contexts.length, 1)
        await harness.post({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'SYNTHETIC_SECRET_DO_NOT_PRINT' }
        })
        assert.equal(contexts[0]?.wait_signal.aborted, true)
        assert(!String(contexts[0]?.wait_signal.reason).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
        assert.equal((await response.text()).includes('data:'), false)
        const ping = await harness.request(id, 'ping')
        assert.equal(ping.id, id)
        assert.deepEqual(ping.result, {})
        release.resolve()
        await finished.promise
        assert.equal(contexts.length, 1)
        assert.equal(harness.wire.length, 2)
      } finally {
        release.resolve()
        await harness.close()
      }
    }
  }
)

test(
  '最多16个服务等待；断开单个HTTP响应只终止其等待，DELETE结束本会话而不发业务cancel',
  /* 保留容量、不可变caller及显式取消分离断言。 */ async () => {
    const ready = gate()
    const release = gate()
    const contexts: ServiceContext[] = []
    const operations: ToolName[] = []
    const harness = rawHttp({
      execute: /* 受控阻塞stub只记录调用与等待信号，不产生持久写入。 */ async (name, _args, context) => {
        contexts.push(context)
        operations.push(name)
        if (contexts.length === 16) {
          ready.resolve()
        }
        await release.promise
        throw new FacadeServiceError('unavailable')
      }
    })
    const responses: Response[] = []
    try {
      await harness.initialize()
      for (let id = 1; id <= 16; id++) {
        responses.push(
          await harness.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'machines_list' } })
        )
      }
      await ready.promise
      const busy = await harness.request(17, 'tools/call', { name: 'machines_list' })
      assert.deepEqual((busy.result as Record<string, unknown>).structuredContent, { gateway_error: { code: 'busy' } })
      await responses[0]!.body!.cancel()
      await new Promise(/* 等真实HTTP断开通知到达服务端，不推定native停止。 */ (resolve) => setTimeout(resolve, 20))
      assert.equal(contexts[0]!.wait_signal.aborted, true)
      assert(contexts.slice(1).every(/* 其它HTTP请求保持独立。 */ (context) => !context.wait_signal.aborted))
      assert.equal((await fetch(harness.running.url, { method: 'DELETE', headers: harness.headers() })).status, 200)
      assert(contexts.every(/* 会话关闭后所有等待均终止。 */ (context) => context.wait_signal.aborted))
      assert(Object.isFrozen(contexts[0]!.caller))
      assert.deepEqual(operations, Array(16).fill('machines_list'))
      assert.equal((await fetch(harness.running.url)).status, 401)
    } finally {
      release.resolve()
      for (const response of responses) {
        await response.body?.cancel().catch(/* 关闭后的流拒绝已观察。 */ () => {})
      }
      await harness.close()
    }
  }
)
test(
  '参数快照拒绝 getter/循环，目录 schema 副本不能改变运行时校验',
  /* 用访问器、循环和可修改 schema 副本验证参数快照边界。 */ () => {
    let reads = 0
    const poisoned = Object.defineProperty({}, 'principal', {
      enumerable: true,
      // 若校验错误触发访问器便增加计数，以暴露意外读取副作用。
      get() {
        reads++
        return 'admin'
      }
    })
    assert.throws(
      /* 提交带 getter 的参数，确认快照会拒绝而不求值。 */ () => parseToolArguments('machines_list', poisoned)
    )
    assert.equal(reads, 0)
    const cyclic: Record<string, unknown> = {}
    cyclic.cursor = cyclic
    assert.throws(/* 提交循环对象，确认 JSON 边界会有界拒绝。 */ () => parseToolArguments('machines_list', cyclic))
    const definition = toolDefinition('machines_list')
    definition.inputSchema.additionalProperties = true
    assert.throws(
      /* 提交身份字段，确认目录 schema 副本修改不能放宽校验。 */ () =>
        parseToolArguments('machines_list', { principal: 'admin' })
    )
    assert.throws(
      /* 同时提交 ID 和名称，确认只读查询选择不能产生歧义。 */ () =>
        parseToolArguments('machines_get', { machine_id: 'machine', name: 'name' })
    )
  }
)
