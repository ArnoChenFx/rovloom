/** 隔离验证七项 HTTP 读取与浏览器传输边界；合成身份/DTO 不能证明真实登录后端完成。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GatewayManagementService, ManagementArguments } from '../../src/mcp/management.js'
import { createManagementReadHandler, startManagementReadListener } from '../../src/admin/read-http.js'
import type { ManagementHttpOptions, ManagementHttpProblem } from '../../src/admin/read-http.js'
import { createManagementHttpRead } from '../../src/webui/http-client.js'
import { managementReadPath, parseManagementReadPath } from '../../src/webui/http-contract.js'
import type { ManagementReadOperation } from '../../src/webui/read.js'
import { checkManagementReadReply } from '../../src/webui/validate.js'
import { fixtureReply } from './fixtures.js'
import { statusWithHost } from '../mcp/wildcard-listener.js'

const origin = 'http://127.0.0.1:43210'
const identity = { caller: { principal_id: 'fixture-principal' }, management_session_ref: 'fixture-session' }

/** 为接口测试注入共享形状的服务，绝不导出到生产代码。 */
function options(overrides: Partial<ManagementHttpOptions> = {}): ManagementHttpOptions {
  return {
    service: {
      execute: /* 合成 DTO 只验证传输，不实现业务查询。 */ async (name, args) =>
        fixtureReply(name as ManagementReadOperation, args as ManagementArguments[ManagementReadOperation])
    } as GatewayManagementService,
    authenticate: /* 此身份仅限本测试，真实宿主必须验证自己的既有会话。 */ async () => identity,
    ...overrides
  }
}

/** 构造符合实际 listener Host 的请求，允许逐项覆盖边界字段。 */
function request(path = '/admin/v1/status', init: RequestInit = {}): Request {
  return new Request(origin + path, { ...init, headers: { host: '127.0.0.1:43210', ...init.headers } })
}

/** 创建可控异步工作，模拟忽略取消或迟到失败的后端。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>(
    /* 只由测试推进完成或失败。 */ (done, fail) => {
      resolve = done
      reject = fail
    }
  )
  return { promise, resolve, reject }
}

test(
  '七项固定路径往返与权限目标，不把身份或写操作塞入查询',
  /** 七 read 的共享参数只经固定 GET 资源。 */ () => {
    const cases: [ManagementReadOperation, ManagementArguments[ManagementReadOperation]][] = [
      ['status', {}],
      ['devices_list', { cursor: 'opaque/游标', limit: 200, states: ['pending', 'revoked'] }],
      ['devices_get', { machine_id: 'opaque/device' }],
      ['providers_list', { machine_id: 'm', limit: 1 }],
      ['providers_get', { machine_id: 'm', provider_id: 'p/1' }],
      ['permissions_get', { machine_id: 'm', provider_id: 'p' }],
      ['calls_list', { cursor: 'opaque/call', limit: 20, machine_id: 'm', states: ['responded', 'outcome_unknown'] }]
    ]
    for (const [operation, args] of cases) {
      assert.deepEqual(parseManagementReadPath(managementReadPath(operation, args)), { operation, args })
    }
    for (const path of [
      '/admin/v1/status?principal_id=admin',
      '/admin/v1/devices?limit=201',
      '/admin/v1/devices?limit=1&limit=2',
      '/admin/v1/devices?states=online,online',
      '/admin/v1/devices/%zz',
      '/admin/v1/calls?states=responded,responded',
      '/admin/v1/calls?states=bogus',
      '/admin/v1/calls?limit=201',
      '/admin/v1/calls?principal_id=admin',
      '//evil/admin/v1/status',
      'https://evil/admin/v1/status'
    ]) {
      assert.throws(/* 非固定资源或非法参数在传输边界拒绝。 */ () => parseManagementReadPath(path))
    }
    assert.equal(parseManagementReadPath('/admin/v1/operations/x'), null)
    assert.throws(/* 自报身份不会静默接受。 */ () => managementReadPath('status', { principal_id: 'admin' } as never))
    assert.throws(
      /* 隐藏属性同样不能携带额外身份。 */ () =>
        managementReadPath('status', Object.defineProperty({}, 'principal_id', { value: 'admin' }))
    )
  }
)

test(
  '缺少可信认证适配器或非 loopback 配置在开端口前失败',
  /** 启动没有默认身份，且绑定范围不能被配置扩大。 */ async () => {
    assert.throws(
      /* 缺少 adapter 必须失败。 */ () => startManagementReadListener({ service: options().service, port: 0 } as never),
      /management_authentication_required/u
    )
    assert.throws(
      /* 非回环且非通配的地址仍禁止。 */ () =>
        startManagementReadListener({ ...options(), port: 0, hostname: '192.0.2.1' } as never),
      /management_listener_invalid/u
    )
    const wildcard = startManagementReadListener({ ...options(), port: 0, hostname: '0.0.0.0' })
    try {
      assert.match(wildcard.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
      // Host 不作域名白名单；此 fixture 已注入有效身份，代理域名与回环均正常读取。
      const port = Number(new URL(wildcard.url).port)
      for (const host of ['example.com', `192.0.2.10:${port}`]) {
        const status = await statusWithHost(port, host, '/admin/v1/status')
        assert.equal(status, 200, `${host} -> ${status}`)
      }
      assert.equal(await statusWithHost(port, `127.0.0.1:${port}`, '/admin/v1/status'), 200)
    } finally {
      wildcard.stop()
    }
    assert.throws(
      /* handler 也不允许公网来源。 */ () =>
        createManagementReadHandler({ ...options(), origin: 'http://example.com' }),
      /management_listener_invalid/u
    )
  }
)

test(
  'Host Origin 方法 参数和输入预算在认证与服务之前拒绝',
  /** 不将被拒绝的边界输入送入会话解析器。 */ async () => {
    let calls = 0
    const handler = createManagementReadHandler({
      ...options({
        authenticate: /* 记录是否越过边界。 */ async () => {
          calls++
          return identity
        }
      }),
      origin
    })
    for (const [input, status] of [
      [request('/admin/v1/status', { headers: { host: 'evil' } }), 403],
      [request('/admin/v1/status', { headers: { origin: 'https://evil', 'sec-fetch-site': 'cross-site' } }), 403],
      [request('/admin/v1/status', { headers: { origin: 'null' } }), 403],
      [request('/admin/v1/status', { headers: { 'sec-fetch-site': 'cross-site' } }), 403],
      [request('/admin/v1/status', { method: 'POST' }), 405],
      [request('/admin/v1/status', { headers: { 'content-length': '2' } }), 400],
      [request('/admin/v1/status?caller=admin'), 400],
      [request('/admin/v1/devices?cursor=' + 'x'.repeat(33_000)), 403],
      [request('/admin/v1/status', { headers: { cookie: 'x'.repeat(17_000) } }), 403],
      [request('/admin/v1/operations/x'), 404]
    ] as const) {
      const response = await handler.fetch(input)
      assert.equal(response.status, status)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('access-control-allow-origin'), null)
      assert(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"))
    }
    assert.equal(calls, 0)
    handler.stop()
  }
)

test(
  '每个请求重取可信会话并仅执行共享服务一次，过期立即401',
  /** 会话引用与等待信号只由宿主生成。 */ async () => {
    let authenticated = true
    let calls = 0
    const service: GatewayManagementService = {
      execute: /* 检查服务收到的 context，不接受浏览器身份。 */ async (name, args, context) => {
        calls++
        assert.deepEqual(context.caller, identity.caller)
        assert.equal(context.management_session_ref, identity.management_session_ref)
        assert(context.wait_signal instanceof AbortSignal)
        return fixtureReply(
          name as ManagementReadOperation,
          args as ManagementArguments[ManagementReadOperation]
        ) as never
      }
    }
    const handler = createManagementReadHandler({
      ...options({
        service,
        authenticate: /* 模拟既有宿主当前会话失效。 */ async () => (authenticated ? identity : null)
      }),
      origin
    })
    assert.equal((await handler.fetch(request())).status, 200)
    authenticated = false
    const response = await handler.fetch(request())
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'unauthenticated' })
    assert.equal(calls, 1)
    handler.stop()
  }
)

test(
  '固定错误映射与 DTO 白名单防止秘密或后端异常泄露',
  /** 服务错误仅接受宿主映射到允许的公开分类。 */ async () => {
    for (const [problem, status] of [
      ['not_found', 404],
      ['invalid_cursor', 400],
      ['forbidden', 403],
      ['conflict', 409],
      ['timeout', 504],
      ['unavailable', 503]
    ] as [ManagementHttpProblem, number][]) {
      const handler = createManagementReadHandler({
        ...options({
          service: {
            execute: /* 伪造私有错误内容以检查边界。 */ async () => {
              throw new Error('SECRET-cookie')
            }
          },
          publicError: /* 宿主将已识别服务错误归到固定分类。 */ () => problem
        }),
        origin
      })
      const response = await handler.fetch(request())
      assert.equal(response.status, status)
      assert.equal((await response.text()).includes('SECRET'), false)
      handler.stop()
    }
    const handler = createManagementReadHandler({
      ...options({
        service: {
          execute: /* 多余秘密字段必须整份拒绝。 */ async () =>
            ({ ...fixtureReply('status', {}), token: 'SECRET' }) as never
        }
      }),
      origin
    })
    const response = await handler.fetch(request())
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: 'invalid_response' })
    handler.stop()
    const value = fixtureReply('status', {})
    Object.defineProperty(value, 'toJSON', {
      value: /* 隐藏序列化钩子不能绕过输出字段检查。 */ () => ({ token: 'SECRET' })
    })
    assert.throws(/* 序列化之前拒绝钩子。 */ () => checkManagementReadReply('status', value, {}), {
      problem: 'invalid_response'
    })
  }
)

test(
  '取消和停止立即结束观察，迟到任务保留额度且拒绝被消费',
  /** 忽略取消的后端不能让反复取消绕过并发上限。 */ async () => {
    const tasks: ReturnType<typeof deferred<never>>[] = []
    const signals: AbortSignal[] = []
    const handler = createManagementReadHandler({
      ...options({
        service: {
          execute: /* 模拟尚未结束的实际任务。 */ (_name, _args, context) => {
            const task = deferred<never>()
            tasks.push(task)
            signals.push(context.wait_signal)
            return task.promise
          }
        }
      }),
      origin
    })
    for (let index = 0; index < 16; index++) {
      const controller = new AbortController()
      const pending = handler.fetch(request('/admin/v1/status', { signal: controller.signal }))
      await Promise.resolve()
      controller.abort()
      assert.equal((await pending).status, 408)
    }
    assert.equal((await handler.fetch(request())).status, 503)
    assert.equal(tasks.length, 16)
    assert(signals.every(/* 每项等待都必须收到取消。 */ (signal) => signal.aborted))
    for (const task of tasks) {
      task.reject(new Error('late private failure'))
    }
    await new Promise(/* 清空异步完成回调再检查容量。 */ (resolve) => setTimeout(resolve, 0))
    const pending = handler.fetch(request())
    await Promise.resolve()
    handler.stop()
    assert.equal((await pending).status, 503)
    tasks.at(-1)!.reject(new Error('late after stop'))
    assert.equal((await handler.fetch(request())).status, 503)
  }
)

test(
  '浏览器只发固定同源 GET，使用 cookie 并禁止重定向和缓存',
  /** 真正 loopback listener 传递六 read，仍只使用合成 DTO 与会话。 */ async () => {
    const listener = startManagementReadListener({ ...options(), port: 0 })
    try {
      const read = createManagementHttpRead(
        /* 浏览器等价传输将相对路径接到真实 listener。 */ async (path, init) => {
          assert.equal(init.method, 'GET')
          assert.equal(init.credentials, 'same-origin')
          assert.equal(init.mode, 'same-origin')
          assert.equal(init.redirect, 'error')
          assert.equal(init.cache, 'no-store')
          assert.deepEqual(init.headers, { accept: 'application/json' })
          return fetch(listener.url + path, init)
        }
      )
      const signal = new AbortController().signal
      assert.equal((await read('status', {}, signal)).mode, 'active')
      assert.equal((await read('devices_list', {}, signal)).items.length, 2)
      assert.equal((await read('devices_get', { machine_id: 'fixture-a' }, signal)).machine_id, 'fixture-a')
      assert.equal((await read('providers_list', { machine_id: 'fixture-a' }, signal)).items.length, 3)
      assert.equal(
        (await read('providers_get', { machine_id: 'fixture-a', provider_id: 'fixture-luvus' }, signal)).provider_id,
        'fixture-luvus'
      )
      assert.equal(
        (await read('permissions_get', { machine_id: 'fixture-a' }, signal)).principal_id,
        'fixture-principal'
      )
      const calls = await read('calls_list', { limit: 2, states: ['responded'] }, signal)
      assert.equal(calls.aggregate.total, 1)
      assert.equal(calls.items[0]?.state, 'responded')
      assert.equal(calls.window.sampled, 1)
    } finally {
      listener.stop()
    }
  }
)

test(
  '浏览器区分网络 HTTP 与无效响应，不把正文错误或秘密显示给页面',
  /** 响应必须先限制类型和字节数再验证共享 DTO。 */ async () => {
    const signal = new AbortController().signal
    const network = createManagementHttpRead(
      /* 原生网络失败没有可用响应。 */ async () => {
        throw new Error('private network')
      }
    )
    await assert.rejects(network('status', {}, signal), { problem: 'unavailable' })
    for (const [status, problem] of [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [400, 'conflict'],
      [404, 'not_found'],
      [409, 'conflict'],
      [502, 'invalid_response'],
      [503, 'unavailable'],
      [504, 'timeout']
    ] as const) {
      const read = createManagementHttpRead(
        /* 服务错误正文不应被解析。 */ async () => new Response('SECRET', { status })
      )
      await assert.rejects(read('status', {}, signal), { problem })
    }
    for (const response of [
      new Response('<html>'),
      new Response('{bad', { headers: { 'content-type': 'application/json' } }),
      new Response('x'.repeat(524_289), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '524289' } })
    ]) {
      const read = createManagementHttpRead(/* 注入错误响应但不放宽生产解析器。 */ async () => response)
      await assert.rejects(read('status', {}, signal), { problem: 'invalid_response' })
    }
  }
)

test(
  '响应正文读取中取消与忽略请求信号的迟到响应都不能交付数据',
  /** 浏览器信号在 fetch 返回后仍然约束正文和最终 DTO。 */ async () => {
    const controller = new AbortController()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel: /* 确认底层正文取消。 */ () => {
        cancelled = true
      }
    })
    const read = createManagementHttpRead(
      /* 模拟仅返回头而永不发送正文。 */ async () =>
        new Response(stream, { headers: { 'content-type': 'application/json' } })
    )
    const pending = read('status', {}, controller.signal)
    await Promise.resolve()
    controller.abort()
    await assert.rejects(pending, { problem: 'unavailable' })
    assert(cancelled)
    const late = deferred<Response>()
    const readLate = createManagementHttpRead(/* 故意忽略 signal 的网络替身。 */ () => late.promise)
    const another = new AbortController()
    const latePending = readLate('status', {}, another.signal)
    another.abort()
    late.resolve(Response.json(fixtureReply('status', {})))
    await assert.rejects(latePending, { problem: 'unavailable' })
  }
)

test(
  '快速401也消耗全局准入预算，不绕过认证调用限额',
  /** 速率桶位于会话解析前，不创建第二套身份存储。 */ async () => {
    let calls = 0
    const handler = createManagementReadHandler({
      ...options({
        authenticate: /* 每次拒绝仍须计费。 */ async () => {
          calls++
          return null
        }
      }),
      origin
    })
    let rejected = false
    for (let index = 0; index < 40; index++) {
      const response = await handler.fetch(request())
      if (response.status === 429) {
        assert.equal(response.headers.get('retry-after'), '1')
        rejected = true
        break
      }
      assert.equal(response.status, 401)
    }
    assert(rejected)
    assert(calls < 40)
    handler.stop()
  }
)

test(
  '五秒 HTTP 截止取消实际等待并丢弃迟到成功',
  { timeout: 10000 },
  /** 超时结果先固定，不等待忽略信号的共享服务返回。 */ async () => {
    const task = deferred<never>()
    let signal: AbortSignal | undefined
    const handler = createManagementReadHandler({
      ...options({
        service: {
          execute: /* 保留任务直到测试显式完成。 */ (_name, _args, context) => {
            signal = context.wait_signal
            return task.promise
          }
        }
      }),
      origin
    })
    try {
      const response = await handler.fetch(request())
      assert.equal(response.status, 504)
      assert(signal?.aborted)
      task.reject(new Error('late ignored backend failure'))
    } finally {
      handler.stop()
    }
  }
)

test(
  '真实 loopback socket 断开传入共享等待信号，迟到失败被消费',
  /** 验证 Bun 原生 disconnect 与 Request.signal 的实际接线。 */ async () => {
    const started = deferred<AbortSignal>()
    const task = deferred<never>()
    const listener = startManagementReadListener({
      ...options({
        service: {
          execute: /* 服务保留真实 socket 对应的等待信号。 */ (_name, _args, context) => {
            started.resolve(context.wait_signal)
            return task.promise
          }
        }
      }),
      port: 0
    })
    try {
      const controller = new AbortController()
      const pending = fetch(listener.url + '/admin/v1/status', { signal: controller.signal })
      const signal = await started.promise
      controller.abort()
      await assert.rejects(pending)
      const deadline = performance.now() + 2000
      while (!signal.aborted && performance.now() < deadline) {
        await new Promise(/* 等待原生 socket 断开事件，保留有界截止。 */ (resolve) => setTimeout(resolve, 5))
      }
      assert(signal.aborted)
      task.reject(new Error('late socket backend failure'))
    } finally {
      listener.stop()
      task.reject(new Error('test cleanup'))
    }
  }
)

test(
  '共享输出校验拒绝跨目标 重复ID和数组序列化钩子',
  /** 服务输出与浏览器输入复用同一白名单，不能藏秘密字段或混合目标。 */ () => {
    const devices = fixtureReply('devices_list', {})
    devices.items.push(devices.items[0]!)
    assert.throws(/* 重复ID不允许被覆盖合并。 */ () => checkManagementReadReply('devices_list', devices, {}), {
      problem: 'invalid_response'
    })
    assert.throws(
      /* provider必须属于请求的精确机器。 */ () =>
        checkManagementReadReply('providers_list', fixtureReply('providers_list', { machine_id: 'other' }), {
          machine_id: 'fixture-a'
        }),
      { problem: 'invalid_response' }
    )
    const poisoned = fixtureReply('devices_list', {})
    Object.defineProperty(poisoned.items, 'toJSON', {
      value: /* 数组不能越过字段检查执行自己的序列化。 */ () => ['SECRET']
    })
    assert.throws(/* 隐藏钩子同样拒绝。 */ () => checkManagementReadReply('devices_list', poisoned, {}), {
      problem: 'invalid_response'
    })
  }
)
