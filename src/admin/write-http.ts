// 在既有管理读桥旁组合受信写 handler；不启动 listener、不建立登录或会话产品。
import { parseJson } from '../wire/index.js'
import type { ManagementArguments, ManagementOperation, AdminContext } from '../mcp/management.js'
import {
  createManagementReadHandler,
  lanAwareOrigin,
  type ManagementHttpOptions,
  type ManagementHttpIdentity
} from './read-http.js'
import { ManagementServiceError } from './write-service.js'

export type ManagementWriteHttpOptions = ManagementHttpOptions & {
  origin: string
  resources?: {
    execute(operation: string, args: unknown, identity: ManagementHttpIdentity, signal: AbortSignal): unknown
  }
  /** 复用既有管理员会话的 CSRF 后端，缺失或非 true 均拒绝；请求体不能自报通过。 */
  verifyCsrf(request: Request, identity: ManagementHttpIdentity, signal: AbortSignal): Promise<boolean>
}
const routes = new Map<string, ManagementOperation>([
  ['/admin/v1/actions/history_open', 'history_open'],
  ['/admin/v1/actions/write_state_get', 'write_state_get'],
  ['/admin/v1/actions/pairings_get', 'pairings_get'],
  ['/admin/v1/actions/operations_get', 'operations_get'],
  ['/admin/v1/actions/confirmations_create', 'confirmations_create'],
  ['/admin/v1/actions/confirmations_confirm', 'confirmations_confirm'],
  ['/admin/v1/actions/pairings_create', 'pairings_create'],
  ['/admin/v1/actions/pairings_cancel', 'pairings_cancel'],
  ['/admin/v1/actions/pairings_claim_approve', 'pairings_claim_approve'],
  ['/admin/v1/actions/devices_rename', 'devices_rename'],
  ['/admin/v1/actions/devices_disconnect', 'devices_disconnect'],
  ['/admin/v1/actions/devices_revoke', 'devices_revoke'],
  ['/admin/v1/actions/providers_disable', 'providers_disable'],
  ['/admin/v1/actions/providers_enable', 'providers_enable']
])
const statuses: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_arguments: 400,
  idempotency_conflict: 409,
  revision_conflict: 409,
  connection_epoch_conflict: 409,
  provider_binding_mismatch: 409,
  confirmation_required: 409,
  confirmation_mismatch: 409,
  confirmation_expired: 409,
  management_history_unavailable: 409,
  operation_unconfirmed: 409,
  invalid_machine_state: 409,
  pairing_conflict: 409,
  constraint_conflict: 409,
  pairing_not_found: 404,
  machine_not_found: 404,
  storage_degraded: 503,
  backend_unavailable: 503
}
const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin'
}
/** 固定错误不携带 cookie、参数、secret 或底层异常正文。 */
function failure(error: string, status: number) {
  return new Response(JSON.stringify({ error }), { status, headers })
}

/** 复用当前 loopback 读桥的会话与服务；写侧增加强制Origin/CSRF、有界流式正文与超时。 */
export function createManagementHandler(options: ManagementWriteHttpOptions) {
  if (typeof options.verifyCsrf !== 'function') {
    throw new Error('management_csrf_required')
  }
  const reads = createManagementReadHandler(options)
  /** 回环始终按固定来源；显式 LAN 时按本次请求的 Host 推导同源来源，跨站 Origin 仍被拒绝。 */
  const expected = (request: Request): string | null => lanAwareOrigin(request, options.origin, options.lan === true)
  const pending = new Set<AbortController>()
  let stopped = false
  let tokens = 16
  let sampled = performance.now()

  /** 实际异步任务完成前保留额度；取消只停止前端等待，已提交操作由原回执对账。 */
  async function perform(
    request: Request,
    operation: ManagementOperation | `resources/${string}`,
    controller: AbortController
  ): Promise<Response> {
    const identity = await options.authenticate(request, controller.signal)
    if (!identity) {
      return failure('unauthenticated', 401)
    }
    if (controller.signal.aborted) {
      return failure('outcome_unconfirmed', 503)
    }
    if ((await options.verifyCsrf(request, identity, controller.signal)) !== true) {
      return failure('forbidden', 403)
    }
    if (controller.signal.aborted) {
      return failure('outcome_unconfirmed', 503)
    }
    const reader = request.body?.getReader()
    if (!reader) {
      return failure('invalid_arguments', 400)
    }
    const chunks: Uint8Array[] = []
    let length = 0
    /** 请求超时/断开同时取消慢正文读取，不继续占用socket输入。 */
    const cancel = () => {
      void reader.cancel().catch(/** 取消失败的原文不输出。 */ () => {})
    }
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      while (true) {
        const chunk = await reader.read()
        if (controller.signal.aborted) {
          return failure('outcome_unconfirmed', 503)
        }
        if (chunk.done) {
          break
        }
        length += chunk.value.byteLength
        if (length > 16_384) {
          cancel()
          return failure('invalid_arguments', 413)
        }
        chunks.push(chunk.value)
      }
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
    let args: unknown
    try {
      args = parseJson(Buffer.concat(chunks), 16_384)
    } catch {
      return failure('invalid_arguments', 400)
    }
    const context: AdminContext = { ...identity, wait_signal: controller.signal }
    const reply = operation.startsWith('resources/')
      ? await options.resources!.execute(operation.slice('resources/'.length), args, identity, controller.signal)
      : await options.service.execute(
          operation as ManagementOperation,
          args as ManagementArguments[ManagementOperation],
          context
        )
    if (controller.signal.aborted) {
      return failure('outcome_unconfirmed', 503)
    }
    const output = JSON.stringify(reply)
    if (Buffer.byteLength(output) > 32_768) {
      return failure('outcome_unconfirmed', 503)
    }
    return new Response(output, { headers })
  }

  return {
    /** 固定路由不从 URL 读取确认/凭据；所有动作只接受受保护 POST JSON。 */
    async fetch(request: Request): Promise<Response> {
      if (stopped) {
        return failure('backend_unavailable', 503)
      }
      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        return failure('forbidden', 403)
      }
      if (!url.pathname.startsWith('/admin/v1/actions/') && !url.pathname.startsWith('/admin/v1/resources/')) {
        return reads.fetch(request)
      }
      let size = 0
      let count = 0
      for (const [name, value] of request.headers) {
        size += Buffer.byteLength(name + value)
        count++
      }
      if (
        request.url.length > 2048 ||
        size > 16_384 ||
        count > 48 ||
        url.origin !== expected(request) ||
        request.headers.get('origin') !== url.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')
      ) {
        return failure('forbidden', 403)
      }
      if (request.method !== 'POST') {
        return failure('method_not_allowed', 405)
      }
      const resource = url.pathname.startsWith('/admin/v1/resources/')
        ? url.pathname.slice('/admin/v1/resources/'.length)
        : null
      const operation =
        resource !== null &&
        options.resources &&
        [
          'tokens_list',
          'tokens_create',
          'tokens_delete',
          'tokens_rotate',
          'pairing_codes_list',
          'pairing_codes_create',
          'pairing_codes_revoke',
          'pairings_list',
          'pairings_delete',
          'devices_delete'
        ].includes(resource)
          ? (`resources/${resource}` as const)
          : routes.get(url.pathname)
      if (!operation) {
        return failure('not_found', 404)
      }
      if (
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
        request.headers.has('content-encoding') ||
        request.headers.has('transfer-encoding') ||
        !request.headers.get('x-rovloom-csrf') ||
        (request.headers.has('content-length') &&
          !/^(?:0|[1-9][0-9]{0,4})$/.test(request.headers.get('content-length')!))
      ) {
        return failure('invalid_arguments', 400)
      }
      if (Number(request.headers.get('content-length')) > 16_384) {
        return failure('invalid_arguments', 413)
      }
      const now = performance.now()
      tokens = Math.min(16, tokens + Math.max(0, now - sampled) * 0.004)
      sampled = now
      if (tokens < 1 || pending.size >= 8) {
        return failure('busy', 429)
      }
      tokens--
      if (request.signal.aborted) {
        return failure('outcome_unconfirmed', 503)
      }
      const controller = new AbortController()
      pending.add(controller)
      /** 本次客户端断开只取消等待，不将已提交业务描述为回滚。 */
      const abort = () => controller.abort()
      request.signal.addEventListener('abort', abort, { once: true })
      return new Promise<Response>(
        /** 独立等待期限不释放忽略取消的真实任务额度。 */ (resolve) => {
          let settled = false
          /** 只交付第一个等待结果，迟到的提交结果仍能从原操作回执查询。 */
          function finish(response: Response) {
            if (settled) {
              return
            }
            settled = true
            clearTimeout(timer)
            request.signal.removeEventListener('abort', abort)
            controller.signal.removeEventListener('abort', interrupted)
            resolve(response)
          }
          /** 等待结束时保留原请求关联，不能暗中重发操作。 */
          const interrupted = () => finish(failure('outcome_unconfirmed', 503))
          const timer = setTimeout(abort, 5000)
          controller.signal.addEventListener('abort', interrupted, { once: true })
          void perform(request, operation, controller).then(
            /** 实际任务收尾才释放并发额度。 */ (response) => {
              pending.delete(controller)
              finish(response)
            },
            /** 只有本模块服务错误的固定码可以公开，宿主异常不能自报认证成功或细节。 */ (error: unknown) => {
              pending.delete(controller)
              finish(
                error instanceof ManagementServiceError && statuses[error.code]
                  ? failure(error.code, statuses[error.code]!)
                  : failure('backend_unavailable', 503)
              )
            }
          )
        }
      )
    },
    /** 幂等关闭组合handler的等待与读桥，不关闭共享Store或其它宿主。 */
    stop() {
      stopped = true
      reads.stop()
      for (const controller of pending) {
        controller.abort()
      }
    }
  }
}
