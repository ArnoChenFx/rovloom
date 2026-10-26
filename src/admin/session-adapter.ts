// 将宿主现有管理会话绑定到共享administrator来源；不签发cookie/token、不保存身份或创建listener。
import { managementRequestOrigin } from './http-origin.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { CallerIdentity, GatewayIdentitySource } from '../mcp/management.js'
import type { ManagementHttpIdentity } from './read-http.js'

export type ManagementSessionBinding = Readonly<{
  caller: CallerIdentity
  session_ref: string
  expires_at: number
  /**
   * 既有会话后端保存的 CSRF 摘要。同一租期可能已交付给多个页面（重启后新开标签页会追加一条），
   * 因此是集合：任一摘要匹配即接受，撤销时整个租期被清除。
   */
  csrf_sha256: readonly string[]
}>
export type ManagementSessionSource = Readonly<{
  /** 必须与运行宿主和StoreManagementWriteService使用完全相同的来源对象。 */
  identities: GatewayIdentitySource
  /** 仅解析受保护cookie的精确原值；返回当前绑定，过期/撤销/未知返回null。 */
  resolveCookie(cookie: string, signal: AbortSignal): Promise<ManagementSessionBinding | null>
}>
export type ManagementSessionAdapterOptions = Readonly<{
  identities: GatewayIdentitySource
  sessions: ManagementSessionSource
  cookie_name: string
  origin: string
  /** 监听器的局域网绑定提示；管理会话可经反向代理使用。 */
  lan?: boolean
  /** 可注入同Store可信时钟；测试时钟不构成生产认证。 */
  now?: () => number
}>
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const nonce = /^[a-zA-Z0-9_-]{32,256}$/
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{16,2048}$/

/** 只检查普通有界数据属性，不执行宿主对象上的getter或序列化秘密。 */
function record(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  ) {
    return false
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== fields.length) {
    return false
  }
  for (const field of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!fields.includes(field) || !descriptor?.enumerable || !('value' in descriptor)) {
      return false
    }
  }
  return true
}

/** 返回与既有HTTP薄桥兼容的两个函数；缺真实来源或不同身份来源在构造时拒绝。 */
export function createManagementSessionAdapter(options: ManagementSessionAdapterOptions) {
  if (
    !options?.sessions ||
    typeof options.sessions.resolveCookie !== 'function' ||
    !options.identities ||
    typeof options.identities.principal !== 'function' ||
    typeof options.identities.administrator !== 'function'
  ) {
    throw new Error('management_session_source_required')
  }
  if (options.sessions.identities !== options.identities) {
    throw new Error('management_identity_source_mismatch')
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(options.cookie_name)) {
    throw new Error('management_cookie_name_invalid')
  }
  const origin = new URL(options.origin)
  if (
    origin.origin !== options.origin ||
    origin.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password
  ) {
    throw new Error('management_listener_invalid')
  }
  const identities = options.identities
  const sessions = options.sessions
  const now = options.now ?? Date.now
  let observed = 0

  /** cookie只作为宿主查询键，不从其正文、Authorization、URL或请求JSON推导principal。 */
  function cookie(request: Request): string | null {
    if (managementRequestOrigin(request) === null) {
      return null
    }
    if (options.sessions !== sessions || sessions.identities !== identities) {
      return null
    }
    const raw = request.headers.get('cookie')
    if (!raw || Buffer.byteLength(raw) > 4096) {
      return null
    }
    const entries = raw.split(';')
    if (entries.length > 32) {
      return null
    }
    let result: string | null = null
    for (const entry of entries) {
      const delimiter = entry.indexOf('=')
      if (delimiter < 1) {
        return null
      }
      if (entry.slice(0, delimiter).trim() !== options.cookie_name) {
        continue
      }
      const value = entry.slice(delimiter + 1).trim()
      if (result !== null || !cookieValue.test(value)) {
        return null
      }
      result = value
    }
    return result
  }

  /** 每次实际查询会话并复验同一administrator，不缓存可重用的认证成功或CSRF摘要。 */
  async function resolve(request: Request, signal: AbortSignal): Promise<ManagementSessionBinding | null> {
    try {
      if (signal.aborted) {
        return null
      }
      const raw = cookie(request)
      if (!raw) {
        return null
      }
      const found = await sessions.resolveCookie(raw, signal)
      if (
        signal.aborted ||
        options.sessions !== sessions ||
        sessions.identities !== identities ||
        !record(found, ['caller', 'session_ref', 'expires_at', 'csrf_sha256']) ||
        !record(found.caller, ['principal_id'])
      ) {
        return null
      }
      const caller = found.caller.principal_id
      const session = found.session_ref
      const expires = found.expires_at
      const csrf = found.csrf_sha256
      const at = now()
      if (!Number.isSafeInteger(at) || at < observed || at < 0) {
        return null
      }
      observed = at
      if (
        typeof caller !== 'string' ||
        !identifier.test(caller) ||
        typeof session !== 'string' ||
        !identifier.test(session) ||
        typeof expires !== 'number' ||
        !Number.isSafeInteger(expires) ||
        expires <= at ||
        !Array.isArray(csrf) ||
        csrf.length === 0 ||
        csrf.length > 16 ||
        !csrf.every(
          /** 每条摘要都必须是完整 SHA-256 十六进制，不接受前缀或通配。 */ (value) =>
            typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
        )
      ) {
        return null
      }
      const identity = Object.freeze({ principal_id: caller })
      const principal = identities.principal(identity)
      const admin = identities.administrator(identity, session)
      if (
        !principal ||
        principal.id !== caller ||
        !admin ||
        admin.principal_id !== caller ||
        admin.session_ref !== session ||
        admin.assurance !== 'administrator' ||
        typeof admin.policy_revision !== 'string' ||
        !identifier.test(admin.policy_revision) ||
        !Array.isArray(admin.grants) ||
        admin.grants.length > 4096 ||
        signal.aborted
      ) {
        return null
      }
      return { caller: identity, session_ref: session, expires_at: expires, csrf_sha256: Object.freeze([...csrf]) }
    } catch {
      return null
    }
  }

  return Object.freeze({
    identities,
    /** HTTP认证只交付服务端context中的安全引用，不回显cookie或CSRF秘密。 */
    async authenticate(request: Request, signal: AbortSignal): Promise<ManagementHttpIdentity | null> {
      const current = await resolve(request, signal)
      return current ? Object.freeze({ caller: current.caller, management_session_ref: current.session_ref }) : null
    },
    /** 当前cookie、会话、administrator和CSRF都重查，旧认证对象不能绕过撤销或更换会话。 */
    async verifyCsrf(request: Request, identity: ManagementHttpIdentity, signal: AbortSignal): Promise<boolean> {
      if (request.method !== 'POST') {
        return false
      }
      if (
        !request.headers.has('origin') ||
        managementRequestOrigin(request) === null ||
        (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')
      ) {
        return false
      }
      const candidate = request.headers.get('x-rovloom-csrf')
      if (!candidate || !nonce.test(candidate)) {
        return false
      }
      const current = await resolve(request, signal)
      if (
        !current ||
        identity?.caller?.principal_id !== current.caller.principal_id ||
        identity.management_session_ref !== current.session_ref
      ) {
        return false
      }
      const digest = createHash('sha256').update(candidate).digest()
      // 逐条恒定时间比较：同一租期可能已向多个页面交付过不同 CSRF，任一匹配即接受。
      return current.csrf_sha256.some(
        /** 固定长度摘要的常数时间比较，不接受前缀匹配。 */ (csrf) => timingSafeEqual(digest, Buffer.from(csrf, 'hex'))
      )
    }
  })
}
