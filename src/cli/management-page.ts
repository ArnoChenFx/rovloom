// 只将既有受保护管理员租期交付同源根页面，复用原authority，不建立身份库或公开bootstrap端点。
import { ReadError } from '../webui/reader.js'
import type { ManagementHttpOptions } from '../admin/read-http.js'
import type {
  ManagementSessionAuthority,
  ManagementSessionLease,
  ManagementSessionBootstrap
} from '../runtime/management-session.js'

export const MANAGEMENT_COOKIE_NAME = 'rovloom_management'
export const MANAGEMENT_BOOTSTRAP_META = 'rovloom-management-bootstrap'
export type ManagementPageLeaseSource = (
  request: Request,
  signal: AbortSignal
) => Promise<ManagementSessionLease | null>

/** lease来源必须核验该页面请求的既有受保护会话；不得按本机UID、普通header或浏览器参数默认选管理员。 */
export function createManagementPageInitializer(
  authority: ManagementSessionAuthority,
  resolveLease: ManagementPageLeaseSource,
  options: Readonly<{ challenge?: 'basic' | (() => 'basic' | undefined) }> = {}
): NonNullable<ManagementHttpOptions['initializePage']> {
  if (typeof resolveLease !== 'function') {
    throw new Error('management_page_source_required')
  }
  // 只在本initializer内存保留有界交付，authority仍仅按摘要查验；每次取回均重新认证来源和当前cookie。
  const deliveries = new Map<string, { upstream: ManagementSessionLease; bootstrap: ManagementSessionBootstrap }>()
  return /* 原handler先检查固定Origin并建立取消范围；无有效既有lease时仅交付原只读页面。 */ async (
    request,
    page,
    signal
  ) => {
    try {
      const html = await page.text()
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      if (!html.includes('</head>') || html.includes(MANAGEMENT_BOOTSTRAP_META)) {
        throw new ReadError('unavailable')
      }
      const lease = await resolveLease(request, signal)
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      if (lease === null) {
        // challenge 可以是随每次请求重新计算的函数：尚无管理员时不挑战，仍交付只读页面壳。
        const challenge = typeof options.challenge === 'function' ? options.challenge() : options.challenge
        if (challenge === 'basic') {
          const headers = new Headers(page.headers)
          headers.delete('content-length')
          headers.set('cache-control', 'no-store')
          headers.set('content-type', 'application/json; charset=utf-8')
          headers.set('www-authenticate', 'Basic realm="Rovloom management", charset="UTF-8"')
          return new Response('{"error":"unauthenticated"}', { status: 401, headers })
        }
        return new Response(html, { status: page.status, headers: page.headers })
      }
      const name = JSON.stringify([lease.caller.principal_id, lease.management_session_ref])
      const previous = deliveries.get(name)
      let bootstrap: ManagementSessionBootstrap
      if (previous) {
        if (lease.issued_at !== previous.upstream.issued_at || lease.expires_at !== previous.upstream.expires_at) {
          throw new ReadError('unauthenticated')
        }
        const current = await authority.sessions.resolveCookie(previous.bootstrap.cookie, signal)
        if (signal.aborted) {
          throw new ReadError('unavailable')
        }
        if (current) {
          bootstrap = await authority.runAuthenticated(
            previous.bootstrap.cookie,
            signal,
            /** 返回同一交付，不旋转或延长任何截止。 */ () => previous.bootstrap
          )
        } else {
          const latest = deliveries.get(name)
          if (latest && latest !== previous) {
            // 同轮并发请求已完成重认证时复用新交付，旧响应不得删除它或再旋转。
            bootstrap = await authority.runAuthenticated(
              latest.bootstrap.cookie,
              signal,
              /** 验证当前代次后复用同一结果。 */ () => latest.bootstrap
            )
          } else {
            deliveries.delete(name)
            bootstrap = authority.bootstrap(lease, { signal, reauthenticate: true })
            deliveries.set(name, { upstream: structuredClone(lease), bootstrap })
          }
        }
      } else {
        if (deliveries.size >= 4096) {
          throw new ReadError('unavailable')
        }
        bootstrap = authority.bootstrap(lease, { signal, rotate: false })
        deliveries.set(name, { upstream: structuredClone(lease), bootstrap })
      }
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      // authority只生成base64url原值；HTML不包含cookie、principal或管理session引用。
      const metadata = `<meta name="${MANAGEMENT_BOOTSTRAP_META}" content="${bootstrap.csrf}" data-expires-at="${bootstrap.expires_at}">`
      const headers = new Headers(page.headers)
      headers.delete('content-length')
      headers.set('cache-control', 'no-store')
      headers.set(
        'set-cookie',
        // Path=/ 让根页面也能带上该 cookie，刷新与重启后不必重输密码；HttpOnly 与 SameSite=Strict 不变。
        `${MANAGEMENT_COOKIE_NAME}=${bootstrap.cookie}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(bootstrap.expires_at).toUTCString()}`
      )
      return new Response(html.replace('</head>', metadata + '</head>'), { status: page.status, headers })
    } catch (error) {
      if (error instanceof ReadError) {
        throw error
      }
      throw new ReadError('unauthenticated')
    }
  }
}
