/** 管理六项读取的受保护 HTTP 薄桥；服务、会话与错误分类由可信宿主注入，不建立身份或查询后端。 */
import { managementRequestOrigin } from './http-origin.js'
import type { AdminContext, GatewayManagementService } from '../mcp/management.js'
import { parseManagementReadPath, MANAGEMENT_URL_BYTES } from '../webui/http-contract.js'
import { checkManagementReadReply } from '../webui/validate.js'
import { ReadError, type ReadProblem } from '../webui/reader.js'
import { canonicalLoopbackHost } from '../mcp/listen.js'

export type ManagementHttpIdentity = Pick<AdminContext, 'caller' | 'management_session_ref'>
export type ManagementAssets = ReadonlyMap<string, Uint8Array<ArrayBuffer>>
export type ManagementHttpProblem = ReadProblem | 'not_found' | 'invalid_request' | 'invalid_cursor' | 'busy'
export type ManagementHttpOptions = {
  service: GatewayManagementService
  /** 从既有身份后端验证 HTTP 会话；null 代表未登录/已过期，不接收浏览器自报身份。 */
  authenticate(request: Request, signal: AbortSignal): Promise<ManagementHttpIdentity | null>
  /** 把共享服务的公共失败归类；省略时未知服务异常只返回 unavailable。 */
  publicError?(error: unknown): ManagementHttpProblem
  assets?: ManagementAssets
  /** 仅初始化现有根HTML；仍受本handler的Origin、取消、五秒截止和在途额度约束。 */
  initializePage?(request: Request, page: Response, signal: AbortSignal): Promise<Response>
}

const headers = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin'
}
const statuses: Record<ManagementHttpProblem, number> = {
  not_found: 404,
  invalid_request: 400,
  invalid_cursor: 400,
  busy: 503,
  unauthenticated: 401,
  forbidden: 403,
  conflict: 409,
  unavailable: 503,
  invalid_response: 502,
  timeout: 504
}

/** 固定失败不带请求参数、cookie、宿主异常或后端正文。 */
function failure(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }
  })
}

/** 只允许当前交付的常量静态资源；路径绝不转为请求指定的磁盘文件。 */
export function managementAssetType(path: string): string | null {
  if (path === '/' || path === '/index.html') {
    return 'text/html; charset=utf-8'
  }
  if (path === '/manage.css') {
    return 'text/css; charset=utf-8'
  }
  if (path === '/theme.js' || path === '/browser.js' || /^\/chunk-[a-zA-Z0-9]+\.js$/u.test(path)) {
    return 'text/javascript; charset=utf-8'
  }
  if (path === '/rovloom-mark-transparent.png' || path === '/rovloom-logo.png') {
    return 'image/png'
  }
  return null
}

/** 显式克隆并约束宿主静态产物，不将 fixtures、任意文件或可变缓冲区暴露到 listener。 */
function assets(input: ManagementAssets | undefined): Map<string, Uint8Array<ArrayBuffer>> {
  const result = new Map<string, Uint8Array<ArrayBuffer>>()
  let bytes = 0
  if (input && input.size > 32) {
    throw new Error('management_assets_invalid')
  }
  for (const [path, body] of input ?? []) {
    if (!managementAssetType(path) || !(body instanceof Uint8Array) || body.byteLength > 1_048_576) {
      throw new Error('management_assets_invalid')
    }
    bytes += body.byteLength
    if (bytes > 4_194_304) {
      throw new Error('management_assets_invalid')
    }
    result.set(path, new Uint8Array(body))
  }
  return result
}

/** 不以 Origin 作为身份；请求不绑定代理内部 origin；浏览器跨站请求在会话解析前拒绝。 */
function allowed(request: Request): URL | null {
  if (managementRequestOrigin(request) === null) {
    return null
  }
  if (new TextEncoder().encode(request.url).byteLength > MANAGEMENT_URL_BYTES) {
    return null
  }
  const url = new URL(request.url)
  if (url.username || url.password || url.hash) {
    return null
  }
  let size = 0
  let count = 0
  for (const [name, value] of request.headers) {
    size += new TextEncoder().encode(name + value).byteLength
    if (++count > 48 || size > 16_384) {
      return null
    }
  }
  return url
}

/** 会话返回值只投影到既有共享 context；等待信号由本次 HTTP 请求控制。 */
function context(identity: ManagementHttpIdentity, signal: AbortSignal): AdminContext {
  const principal = identity?.caller?.principal_id
  const session = identity?.management_session_ref
  if (
    typeof principal !== 'string' ||
    !principal.length ||
    principal.length > 1024 ||
    typeof session !== 'string' ||
    !session.length ||
    session.length > 1024 ||
    [...(principal + session)].some(
      /** 宿主引用不得携带控制码进入共享 context。 */
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) {
    throw new ReadError('unavailable')
  }
  return Object.freeze({
    caller: Object.freeze({ principal_id: principal }),
    management_session_ref: session,
    wait_signal: signal
  })
}

/** async边界捕获宿主同步异常，但立即调用初始化器，不改变既有API读取开始执行的时序。 */
async function initialize(
  implementation: NonNullable<ManagementHttpOptions['initializePage']>,
  request: Request,
  body: Uint8Array<ArrayBuffer>,
  signal: AbortSignal
): Promise<Response> {
  return implementation(
    request,
    new Response(body.slice().buffer, { headers: { ...headers, 'content-type': managementAssetType('/')! } }),
    signal
  )
}

/** 配置缺失时先失败，保证 start 包装器还没有打开任何端口。 */
function prepare(options: ManagementHttpOptions) {
  if (!options || typeof options.authenticate !== 'function') {
    throw new Error('management_authentication_required')
  }
  if (
    !options.service ||
    typeof options.service.execute !== 'function' ||
    (options.publicError !== undefined && typeof options.publicError !== 'function') ||
    (options.initializePage !== undefined && typeof options.initializePage !== 'function')
  ) {
    throw new Error('management_service_required')
  }
  const files = assets(options.assets)
  const pending = new Set<AbortController>()
  let stopped = false
  let tokens = 32
  let sampledAt = performance.now()

  /** 全局只读准入桶最多突发32次、每秒补充8次；未认证请求也计费，不建立身份限流数据库。 */
  function admit(): boolean {
    const now = performance.now()
    tokens = Math.min(32, tokens + Math.max(0, now - sampledAt) * 0.008)
    sampledAt = now
    if (tokens < 1) {
      return false
    }
    tokens--
    return true
  }

  /** 回收实际任务之后才释放额度；忽略 AbortSignal 的后端不能被取消请求无限堆积。 */
  async function execute(request: Request, controller: AbortController, path: string): Promise<Response> {
    const read = parseManagementReadPath(path)
    if (!read) {
      return failure('not_found', 404)
    }
    const identity = await options.authenticate(request, controller.signal)
    if (controller.signal.aborted) {
      throw new ReadError('unavailable')
    }
    if (identity === null) {
      throw new ReadError('unauthenticated')
    }
    const reply = await options.service.execute(read.operation, read.args, context(identity, controller.signal))
    if (controller.signal.aborted) {
      throw new ReadError('unavailable')
    }
    const value = checkManagementReadReply(read.operation, reply, read.args)
    return new Response(JSON.stringify(value), {
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }
    })
  }

  /** 所有异常只经固定错误分类，未知或分类器自身失败不暴露细节。 */
  function rejected(error: unknown): Response {
    let problem: ManagementHttpProblem = 'unavailable'
    try {
      problem = error instanceof ReadError ? error.problem : (options.publicError?.(error) ?? 'unavailable')
    } catch {
      /* 宿主错误不离开边界。 */
    }
    return typeof problem === 'string' && Object.hasOwn(statuses, problem)
      ? failure(problem, statuses[problem])
      : failure('unavailable', 503)
  }

  /** 按固定路径和预算处理一次读取；超时、断开或停止后不交付迟到响应。 */
  async function fetch(request: Request): Promise<Response> {
    if (stopped) {
      return failure('unavailable', 503)
    }
    let url: URL | null
    try {
      url = allowed(request)
    } catch {
      url = null
    }
    if (!url) {
      return failure('forbidden', 403)
    }
    if (request.method !== 'GET') {
      return failure('method_not_allowed', 405)
    }
    if (
      request.headers.has('transfer-encoding') ||
      (request.headers.has('content-length') && request.headers.get('content-length') !== '0')
    ) {
      return failure('invalid_request', 400)
    }
    const path = url.pathname + url.search
    const file = files.get(url.pathname)
    const initializePage =
      file && !url.search && (url.pathname === '/' || url.pathname === '/index.html') && options.initializePage
    if (file && !url.search) {
      if (!initializePage) {
        return new Response(file.slice().buffer, {
          headers: { ...headers, 'content-type': managementAssetType(url.pathname)! }
        })
      }
    }
    try {
      if (!initializePage && !parseManagementReadPath(path)) {
        return failure('not_found', 404)
      }
    } catch {
      return failure('invalid_request', 400)
    }
    if (!admit()) {
      const response = failure('busy', 429)
      response.headers.set('retry-after', '1')
      return response
    }
    if (pending.size >= 16) {
      return failure('unavailable', 503)
    }
    if (request.signal.aborted) {
      return failure('unavailable', 408)
    }
    const controller = new AbortController()
    pending.add(controller)
    return new Promise(
      /** 清理响应观察而保留尚未结束的真实任务额度，避免 Promise.race 丢失迟到拒绝。 */
      (resolve) => {
        let finished = false
        /** 响应只结算一次，并释放本请求的定时器和断开监听。 */
        function finish(response: Response): void {
          if (finished) {
            void response.body?.cancel().catch(
              /** 已结束的请求不再向宿主传播正文回收错误。 */
              () => {}
            )
            return
          }
          finished = true
          clearTimeout(timer)
          request.signal.removeEventListener('abort', abort)
          controller.signal.removeEventListener('abort', cancelled)
          resolve(response)
        }
        /** 客户端断开取消共享只读等待，不撤销设备或原生工作。 */
        function abort(): void {
          controller.abort()
        }
        /** listener 停止或请求取消后立即结束 HTTP 观察。 */
        function cancelled(): void {
          finish(failure('unavailable', stopped ? 503 : 408))
        }
        const timer = setTimeout(
          /** 五秒截止先固定结果，再传播取消，迟到宿主不能覆盖 timeout。 */
          () => {
            finish(failure('timeout', 504))
            controller.abort()
          },
          5000
        )
        request.signal.addEventListener('abort', abort, { once: true })
        controller.signal.addEventListener('abort', cancelled, { once: true })
        const work = initializePage
          ? initialize(initializePage, request, file!, controller.signal)
          : execute(request, controller, path)
        void work.then(
          /** 真实任务结束才释放额度；已取消时不写回旧响应。 */
          (response) => {
            pending.delete(controller)
            finish(response)
          },
          /** 消费迟到拒绝，避免宿主错误成为未处理异常或泄露内容。 */
          (error: unknown) => {
            pending.delete(controller)
            finish(rejected(error))
          }
        )
      }
    )
  }

  return {
    fetch,
    /** 幂等停止新请求并取消全部在途只读等待，不销毁宿主的服务或身份后端。 */
    stop(): void {
      stopped = true
      for (const controller of pending) {
        controller.abort()
      }
    }
  }
}

/** 为已有可信宿主提供 handler；origin 只能是明确的 IPv4/IPv6 回环 HTTP 地址或通配绑定的规范回环来源。 */
export function createManagementReadHandler(options: ManagementHttpOptions & { origin: string }) {
  const url = new URL(options.origin)
  if (
    url.origin !== options.origin ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('management_listener_invalid')
  }
  return prepare(options)
}

/** 只在配置可信会话适配器与共享服务后打开独立管理 listener；没有默认管理员或 token。 */
export function startManagementReadListener(
  options: ManagementHttpOptions & { port: number; hostname?: '127.0.0.1' | '::1' | '0.0.0.0' | '::' }
) {
  if (!options) {
    throw new Error('management_listener_invalid')
  }
  const handler = prepare(options)
  try {
    return startManagementListener({
      port: options.port,
      hostname: options.hostname,
      maxRequestBodySize: 1,
      handler: /** 只读入口仍复用同一 handler。 */ () => handler
    })
  } catch (error) {
    handler.stop()
    throw error
  }
}
export type ManagementListenerHandler = { fetch(request: Request): Promise<Response>; stop(): void }
export type ManagementListenerOptions = {
  port: number
  hostname?: '127.0.0.1' | '::1' | '0.0.0.0' | '::'
  maxRequestBodySize: 1 | 16_384
  /** 实际绑定后交付规范本机 origin，供受信组合代码装配管理 handler。 */
  handler(origin: string): ManagementListenerHandler
}

/** 读写管理面共用唯一绑定与关闭顺序；正文上限只允许现行只读或窄写契约。 */
export function startManagementListener(options: ManagementListenerOptions) {
  if (
    !options ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535 ||
    (options.hostname !== undefined && !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(options.hostname)) ||
    ![1, 16_384].includes(options.maxRequestBodySize) ||
    typeof options.handler !== 'function'
  ) {
    throw new Error('management_listener_invalid')
  }
  let handler: ManagementListenerHandler | undefined
  let stopped = false
  const bun = (
    globalThis as unknown as {
      Bun: {
        serve(options: {
          hostname: string
          port: number
          maxRequestBodySize: number
          idleTimeout: number
          /** 将原生请求交给已配置的管理handler。 */
          fetch(request: Request): Promise<Response>
          /** 原生 listener 的意外失败仍只返回固定公开错误。 */
          error(error: unknown): Response
        }): { port: number; stop(closeActiveConnections: boolean): void }
      }
    }
  ).Bun
  const server = bun.serve({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port,
    maxRequestBodySize: options.maxRequestBodySize,
    idleTimeout: 10,
    fetch: /** 创建handler前若发生重入请求仍拒绝，不使用未验证origin。 */ (request) =>
      handler ? handler.fetch(request) : Promise.resolve(failure('unavailable', 503)),
    /** 不使用 Bun 默认错误页，防止堆栈或请求信息离开边界。 */
    error: () => failure('unavailable', 503)
  })
  // 返回实际监听端口的规范回环地址，不将它作为代理域名白名单。
  const url = new URL(`http://${canonicalLoopbackHost(options.hostname)}:${server.port}`).origin
  try {
    handler = options.handler(url)
    if (typeof handler?.fetch !== 'function' || typeof handler.stop !== 'function') {
      throw new Error('management_listener_invalid')
    }
  } catch (error) {
    server.stop(true)
    throw error
  }
  return {
    url,
    /** 先停止组合handler，再关闭唯一listener；重复关闭不触发额外清理。 */
    stop(): void {
      if (!stopped) {
        stopped = true
        try {
          handler!.stop()
        } finally {
          server.stop(true)
        }
      }
    }
  }
}
