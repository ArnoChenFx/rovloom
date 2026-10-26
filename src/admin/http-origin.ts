// 管理页不绑定部署域名或代理内部地址；浏览器跨站元数据、会话与 CSRF 分别核验。
/** Origin 描述浏览器看到的地址，不要求它等于代理的 HTTP upstream。 */
export function managementRequestOrigin(request: Request): string | null {
  try {
    const host = request.headers.get('host')
    const url = new URL(request.url)
    if (
      !host ||
      host.length > 2048 ||
      url.host.toLowerCase() !== host.toLowerCase() ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null
    }
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && site !== 'none') {
      return null
    }
    const source = request.headers.get('origin')
    if (source === null) {
      return url.origin
    }
    if (source.length > 2048) {
      return null
    }
    const origin = new URL(source)
    return ['http:', 'https:'].includes(origin.protocol) && source === origin.origin ? source : null
  } catch {
    return null
  }
}

/** 转发的协议只影响 Cookie 的 Secure 属性，不作为登录、权限或 CSRF 证明。 */
export function managementSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === 'https:' || request.headers.get('origin')?.startsWith('https://')) {
    return true
  }
  if (request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https') {
    return true
  }
  const forwarded = request.headers.get('forwarded')?.split(',')[0] ?? ''
  return /(?:^|;)\s*proto=(?:https|"https")\s*(?:;|$)/iu.test(forwarded)
}
