// 在持久Gateway上提供唯一Streamable HTTP入口；会话共享业务服务，逐请求认证而不共享协议实例。
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { JSONRPCMessageSchema, InitializeRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { parseNativeJson } from '../native-contract/json.js'
import { createMcpFacade, type DiagnosticCode } from './facade.js'
import { FacadeHttpTransport, type RequestReservation } from './http-transport.js'
import { canonicalLoopbackHost } from './listen.js'
import { requestOrigin } from '../http/request-origin.js'
import type { CliLanguage } from '../cli/messages.js'
import type { CallerIdentity, GatewayService, ServiceContext } from './types.js'

export const HTTP_BODY_BYTES = 1_048_576
export type HttpAuthenticationProvider = {
  // 宿主验证真实凭据、期限、资源及scope后映射既有principal；不能信任转发头或会话ID。
  authenticate(request: Request, signal: AbortSignal): CallerIdentity | null | Promise<CallerIdentity | null>
}
export type HttpFacadeOptions = {
  service: GatewayService
  authentication: HttpAuthenticationProvider
  // 显示语言由唯一 CLI 入口解析后透传给工具目录与说明；省略时按英文输出。
  language?: CliLanguage
  maxSessions?: number
  idleMs?: number
  requestTimeoutMs?: number
  // 日志只接收固定诊断码，不包含请求、凭据、会话ID或异常原文。
  diagnostic?: (code: DiagnosticCode) => void
}
type Session = {
  principal: string
  transport: FacadeHttpTransport
  server: ReturnType<typeof createMcpFacade>
  initialized: boolean
  touched: number
  requests: Set<AbortController>
  closing?: Promise<void>
}
export type RunningHttp = {
  url: string
  closed: Promise<void>
  // 只由Gateway宿主关闭listener和所有MCP等待；客户端退出不调用它。
  close(): Promise<void>
}

// 固定错误正文不反射SDK异常、认证头、URL或输入参数。
function denied(status: number): Response {
  const code = status === 413 ? -32600 : status === 400 ? -32700 : -32000
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  if (status === 405) {
    headers.allow = 'GET, POST, DELETE'
  }
  if (status === 401) {
    headers['www-authenticate'] = 'Bearer realm="rovloom"'
  }
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code, message: 'Request rejected' } },
    {
      status,
      headers
    }
  )
}

// 验证受信的资源预算，拒绝无界、非整数或超出产品上限的配置。
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const number = value ?? fallback
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error('invalid_http_options')
  }
  return number
}

// 认证及输入读取都受同一请求deadline约束，忽略取消的外部Promise也不会占住HTTP等待。
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort!: (reason: Error) => void
  const aborted = new Promise<never>(
    /* 保存单次拒绝入口，不把外部取消reason写入错误。 */ (_resolve, reject) => {
      rejectAbort = reject
    }
  )
  const stop = /* 中断等待但观察底层Promise的晚到结果。 */ () => rejectAbort(new Error('http_wait_stopped'))
  signal.addEventListener('abort', stop, { once: true })
  try {
    if (signal.aborted) {
      stop()
    }
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

// 在任何JSON解析前计数原始字节；复用现有严格JSON边界拒绝重复键、截断UTF8和过深对象。
async function readMessage(request: Request, signal: AbortSignal): Promise<JSONRPCMessage | Response> {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > HTTP_BODY_BYTES)) {
    return denied(413)
  }
  const reader = request.body?.getReader()
  if (!reader) {
    return denied(400)
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await untilAborted(reader.read(), signal)
      if (part.done) {
        break
      }
      bytes += part.value.byteLength
      if (bytes > HTTP_BODY_BYTES) {
        return denied(413)
      }
      chunks.push(part.value)
    }
    const parsed = parseNativeJson(Buffer.concat(chunks, bytes))
    if (!parsed.ok || Array.isArray(parsed.value)) {
      return denied(400)
    }
    const message = JSONRPCMessageSchema.safeParse(parsed.value)
    return message.success ? message.data : denied(400)
  } catch {
    return denied(signal.aborted ? 408 : 400)
  } finally {
    // 不等待对端继续发送；cancel的拒绝始终被观察。
    void reader.cancel().catch(/* 连接已断开时不输出底层异常。 */ () => {})
    reader.releaseLock()
  }
}

// 建立固定HTTP endpoint的可嵌入处理器；独立管理UI不得复用本处理器的认证即获得管理员权限。
export function createHttpFacade(options: HttpFacadeOptions & { origin: string }) {
  if (typeof options.authentication?.authenticate !== 'function' || typeof options.service?.execute !== 'function') {
    throw new Error('invalid_http_options')
  }
  const origin = new URL(options.origin)
  if (
    origin.origin !== options.origin ||
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password
  ) {
    throw new Error('invalid_http_origin')
  }
  const maxSessions = bounded(options.maxSessions, 64, 256)
  const idleMs = bounded(options.idleMs, 15 * 60_000, 60 * 60_000)
  const timeoutMs = bounded(options.requestTimeoutMs, 35_000, 60_000)
  const sessions = new Map<string, Session>()
  const scope = new AsyncLocalStorage<ServiceContext>()
  const pending = new Set<AbortController>()
  let closing: Promise<void> | undefined
  const closeSession = /* 同一会话并发DELETE、过期和宿主关闭只执行一次清理。 */ (
    id: string,
    session: Session
  ): Promise<void> => {
    session.closing ??= Promise.resolve().then(
      /* 先移除会话并终止等待，之后关闭SDK，不改变共享服务的持久状态。 */ async () => {
        sessions.delete(id)
        for (const stop of session.requests) {
          stop.abort()
        }
        await session.server.close()
      }
    )
    return session.closing
  }
  const sweep = setInterval(
    /* 空闲会话即使没有客户端DELETE也会被回收；活动请求另有独立deadline。 */ () => {
      const now = performance.now()
      for (const [id, session] of sessions) {
        if (!session.requests.size && now - session.touched >= idleMs) {
          void closeSession(id, session).catch(
            /* 清理失败只报告固定代码，不记录会话标识。 */ () => options.diagnostic?.('mcp_shutdown_error')
          )
        }
      }
    },
    Math.min(idleMs, 30_000)
  )
  sweep.unref()

  const makeSession = /* 每个会话新建独立SDK协议状态，所有会话共用既有业务service。 */ async (
    caller: CallerIdentity
  ): Promise<Session> => {
    const id = randomUUID()
    const transport = new FacadeHttpTransport({
      sessionIdGenerator: /* 会话标识只用于路由，绝不充当身份。 */ () => id,
      onsessioninitialized: /* 官方SDK成功完成初始化后才允许后续请求引用本会话。 */ () => {
        session.initialized = true
      },
      onsessionclosed: /* DELETE只关闭当前MCP会话；不关闭Gateway或发起native取消。 */ () => closeSession(id, session),
      maxRequestBodySize: HTTP_BODY_BYTES,
      keepAliveMs: 15_000
    })
    const server = createMcpFacade({
      service: options.service,
      diagnostic: options.diagnostic,
      ...(options.language ? { language: options.language } : {}),
      context: {
        resolve: /* 只取本HTTP请求认证后建立的作用域；不读取请求自报principal或本机UID。 */ (signal) => {
          const context = scope.getStore()
          return context && context.caller.principal_id === session.principal
            ? Object.freeze({ caller: context.caller, wait_signal: AbortSignal.any([signal, context.wait_signal]) })
            : null
        }
      }
    })
    const session: Session = {
      principal: caller.principal_id,
      transport,
      server,
      initialized: false,
      touched: performance.now(),
      requests: new Set()
    }
    sessions.set(id, session)
    const onclose = server.onclose
    server.onclose = /* 保留门面状态更新并移除本会话，协议关闭不能扩大到持久Gateway。 */ () => {
      onclose?.()
      sessions.delete(id)
    }
    try {
      await server.connect(transport)
      return session
    } catch (error) {
      await closeSession(id, session)
      throw error
    }
  }

  const handleRequest = /* 按固定路径、Host/Origin及认证顺序处理请求，拒绝身份跨会话迁移。 */ async (
    request: Request
  ): Promise<Response> => {
    const url = new URL(request.url)
    if (closing) {
      return denied(503)
    }
    // 域名与 TLS 终止方式不影响 Bearer；浏览器跨站元数据与非法来源仍在认证前拒绝。
    if (requestOrigin(request) === null || url.pathname !== '/mcp' || url.search || url.hash) {
      return denied(403)
    }
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      return denied(405)
    }
    if (
      Array.from(request.headers).reduce(
        /* 限制总header字节，包括未使用的认证及转发字段。 */ (sum, [key, value]) =>
          sum + Buffer.byteLength(key) + Buffer.byteLength(value),
        0
      ) > 16_384 ||
      pending.size >= 256
    ) {
      return denied(429)
    }
    const stop = new AbortController()
    const signal = AbortSignal.any([request.signal, stop.signal])
    const timer = setTimeout(/* 请求deadline只停止前端等待，不连接native取消。 */ () => stop.abort(), timeoutMs)
    timer.unref()
    pending.add(stop)
    let session: Session | undefined
    let message: JSONRPCMessage | undefined
    let reservation: RequestReservation | undefined
    let completed = false
    let streaming = false
    let cancelBody: (() => void) | undefined
    const finish = /* 完成或取消响应后回收本请求计时器及引用，不停止会话或Gateway。 */ () => {
      if (!completed) {
        completed = true
        clearTimeout(timer)
        pending.delete(stop)
        session?.requests.delete(stop)
        signal.removeEventListener('abort', onAbort)
      }
    }
    const onAbort = /* 精确终止相应请求的等待和HTTP流，保留共享服务与其它请求。 */ () => {
      if (session && reservation) {
        session.transport.cancelReservation(reservation)
      }
      cancelBody?.()
      finish()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const authenticated = await untilAborted(
        Promise.resolve(options.authentication.authenticate(request, signal)),
        signal
      )
      if (closing || signal.aborted) {
        return denied(408)
      }
      const principalId = authenticated?.principal_id
      if (typeof principalId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(principalId)) {
        return denied(401)
      }
      const caller = Object.freeze({ principal_id: principalId })
      const id = request.headers.get('mcp-session-id')
      if (id !== null) {
        session = sessions.get(id)
        if (!session?.initialized || session.closing) {
          return denied(404)
        }
        if (session.principal !== caller.principal_id) {
          return denied(403)
        }
      } else if (request.method !== 'POST') {
        return denied(400)
      }
      if (request.method === 'POST') {
        const body = await readMessage(request, signal)
        if (body instanceof Response) {
          return body
        }
        message = body
        if (!session) {
          if (!InitializeRequestSchema.safeParse(message).success) {
            return denied(400)
          }
          if (sessions.size >= maxSessions) {
            return denied(429)
          }
          session = await makeSession(caller)
        }
        const reserved = session.transport.reserve(message)
        if (reserved === false) {
          return denied(409)
        }
        reservation = reserved
      }
      if (!session || signal.aborted || session.closing) {
        return denied(408)
      }
      session.touched = performance.now()
      session.requests.add(stop)
      const context = Object.freeze({ caller, wait_signal: signal })
      const response = await scope.run(
        context,
        /* parsedBody已经过HTTP原始字节上限；每个POST使用自己拥有的关联。 */ () =>
          session!.transport.handleReservedRequest(request, { parsedBody: message }, reservation)
      )
      session.transport.releaseUndelivered(reservation)
      if (response.status >= 400) {
        if (!session.initialized) {
          await closeSession(session.transport.sessionId ?? '', session)
        }
        return denied(response.status)
      }
      if (!response.body) {
        return response
      }
      const reader = response.body.getReader()
      let sourceClosed = false
      let output: ReadableStreamDefaultController<Uint8Array> | undefined
      cancelBody = /* 即使外层队列已有数据且没有pull等待，也立即取消SDK源流和keepalive。 */ () => {
        if (!sourceClosed) {
          sourceClosed = true
          void reader
            .cancel()
            .catch(/* 断开时源流拒绝已观察，不反射底层错误。 */ () => {})
            .finally(/* pending read已经被cancel结清，再释放源reader锁。 */ () => reader.releaseLock())
          output?.close()
        }
      }
      const body = new ReadableStream<Uint8Array>({
        start: /* SSE注释只刷新响应头，不发送MCP通知或建立可重放事件。 */ (controller) => {
          output = controller
          if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
            controller.enqueue(new TextEncoder().encode(': connected\n\n'))
          }
        },
        pull: /* 逐块转交SDK响应，按消费速度读取并保留原始HTTP/SSE协议。 */ async (controller) => {
          try {
            const part = await untilAborted(reader.read(), signal)
            if (sourceClosed) {
              return
            }
            if (part.done) {
              sourceClosed = true
              finish()
              controller.close()
              reader.releaseLock()
            } else {
              controller.enqueue(part.value)
            }
          } catch {
            stop.abort()
          }
        },
        cancel: /* 客户端断开仅取消本响应等待，SDK会话仍可用于后续请求。 */ () => {
          // 外层流已在cancel状态，不再次关闭其controller。
          output = undefined
          stop.abort()
        }
      })
      if (signal.aborted) {
        onAbort()
      }
      const headers = new Headers(response.headers)
      headers.set('cache-control', 'no-store')
      headers.set('x-content-type-options', 'nosniff')
      streaming = true
      return new Response(body, { status: response.status, headers })
    } catch {
      return denied(signal.aborted ? 408 : 500)
    } finally {
      session?.transport.releaseUndelivered(reservation)
      // SSE成功响应由消费结束/断开清理；其它路径立即归还请求预算。
      if (!streaming) {
        finish()
      }
    }
  }

  const close = /* 由持久Gateway关闭所有会话，绝不因单个客户端退出调用共享service.close。 */ (): Promise<void> => {
    closing ??= Promise.resolve().then(
      /* 停止接收和过期扫描，观察每个会话的关闭结果后释放身份作用域。 */ async () => {
        clearInterval(sweep)
        for (const stop of pending) {
          stop.abort()
        }
        const results = await Promise.allSettled(
          Array.from(
            sessions,
            /* 每个会话独立关闭，避免某个错误中断其余清理。 */ ([id, session]) => closeSession(id, session)
          )
        )
        scope.disable()
        if (results.some(/* 保留真实清理失败，宿主不能误报正常关闭。 */ (result) => result.status === 'rejected')) {
          throw new Error('http_shutdown_failed')
        }
      }
    )
    return closing
  }
  return { handleRequest, close }
}

// 默认只开放本机回环；显式通配绑定用于容器等隔离环境，对外暴露由宿主网络层收口。
export function startHttpFacade(
  options: HttpFacadeOptions & { hostname?: '127.0.0.1' | '::1' | '0.0.0.0' | '::'; port?: number }
): RunningHttp {
  const hostname = options.hostname ?? '127.0.0.1'
  if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(hostname)) {
    throw new Error('invalid_http_listener')
  }
  const port = options.port ?? 9444
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('invalid_http_listener')
  }
  type Listener = { port: number; stop(force?: boolean): void }
  const bun = (
    globalThis as unknown as {
      Bun: {
        // 使用Bun原生Web Request/Response接口，不引入Express、Hono或另一套MCP协议栈。
        serve(config: {
          hostname: string
          port: number
          maxRequestBodySize: number
          idleTimeout: number
          // 将固定listener的请求交给已经建立的HTTP facade。
          fetch(request: Request): Promise<Response>
        }): Listener
      }
    }
  ).Bun
  let facade: ReturnType<typeof createHttpFacade> | undefined
  const listener = bun.serve({
    hostname,
    port,
    maxRequestBodySize: HTTP_BODY_BYTES,
    idleTimeout: 60,
    fetch: /* listener创建后才接受请求，拒绝意外的未初始化窗口。 */ (request) =>
      facade ? facade.handleRequest(request) : Promise.resolve(denied(503))
  })
  // 本机提示地址使用规范回环地址；它不限制客户端经代理访问的域名。
  const origin = new URL(`http://${canonicalLoopbackHost(hostname)}:${listener.port}`).origin
  try {
    facade = createHttpFacade({ ...options, origin })
  } catch (error) {
    listener.stop(true)
    throw error
  }
  let resolveClosed!: () => void
  const closed = new Promise<void>(
    /* 保存宿主关闭完成通知，不与任何客户端连接绑定。 */ (resolve) => {
      resolveClosed = resolve
    }
  )
  let closing: Promise<void> | undefined
  const close = /* 共享同一清理Promise，先拒绝请求、释放会话，再关闭listener。 */ (): Promise<void> => {
    closing ??= Promise.resolve().then(
      /* 即使会话关闭失败也停止listener并唤醒持久角色等待。 */ async () => {
        try {
          await facade!.close()
        } finally {
          listener.stop(true)
          resolveClosed()
        }
      }
    )
    return closing
  }
  return { url: origin + '/mcp', closed, close }
}
