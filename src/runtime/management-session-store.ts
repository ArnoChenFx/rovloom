// 只把管理会话的摘要绑定持久化到角色私有状态；原 cookie/CSRF 值不落盘，重启后仍逐次复验原管理员记录。
import type { ManagementSessionLease } from './management-session.js'

/** 一条可恢复的会话绑定：只含摘要与租期，足以让浏览器既有 cookie 在重启后重新生效。 */
export type PersistedManagementSession = Readonly<{
  principal_id: string
  session_ref: string
  issued_at: number
  expires_at: number
  cookie_sha256: string
  csrf_sha256: string
  policy: string
  upstream: ManagementSessionLease
}>

export type ManagementSessionPersistence = Readonly<{
  /** 返回当前可恢复的绑定；文件缺失、损坏或超限一律返回空集，不阻塞启动也不放行未验证会话。 */
  load(): readonly PersistedManagementSession[]
  /** 以当前内存会话覆盖写入；只保存摘要，失败不影响本轮进程内的会话。 */
  save(sessions: readonly PersistedManagementSession[]): void
}>

export type ManagementSessionPersistenceOptions = Readonly<{
  read(): unknown | undefined
  write(value: unknown): void
  now?: () => number
  max_sessions?: number
}>

export const MANAGEMENT_SESSIONS_MAX = 1024
const MAX_BYTES = 262_144
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const sha256 = /^[a-f0-9]{64}$/

/** 只接受普通数据属性，不执行来源对象上的 getter 或原型链。 */
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  )
}

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!plain(value)) {
    return false
  }
  const names = Object.getOwnPropertyNames(value)
  return names.length === fields.length && fields.every((field) => Object.hasOwn(value, field))
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 逐字段校验一条绑定；任何不符都丢弃该条，而不是整份文件失败或放行。 */
function session(value: unknown, at: number): PersistedManagementSession | null {
  if (
    !exact(value, [
      'principal_id',
      'session_ref',
      'issued_at',
      'expires_at',
      'cookie_sha256',
      'csrf_sha256',
      'policy',
      'upstream'
    ])
  ) {
    return null
  }
  const upstream = value.upstream
  if (
    !exact(upstream, ['caller', 'management_session_ref', 'issued_at', 'expires_at']) ||
    !exact(upstream.caller, ['principal_id'])
  ) {
    return null
  }
  const principal = value.principal_id
  const ref = value.session_ref
  if (
    typeof principal !== 'string' ||
    !identifier.test(principal) ||
    typeof ref !== 'string' ||
    !identifier.test(ref) ||
    !integer(value.issued_at) ||
    !integer(value.expires_at) ||
    value.expires_at <= value.issued_at ||
    typeof value.cookie_sha256 !== 'string' ||
    !sha256.test(value.cookie_sha256) ||
    typeof value.csrf_sha256 !== 'string' ||
    !sha256.test(value.csrf_sha256) ||
    typeof value.policy !== 'string' ||
    !value.policy.length ||
    upstream.caller.principal_id !== principal ||
    upstream.management_session_ref !== ref ||
    upstream.issued_at !== value.issued_at ||
    upstream.expires_at !== value.expires_at
  ) {
    return null
  }
  // 已到期的绑定没有恢复价值；按当前时钟丢弃，不延长任何截止。
  if (at >= value.expires_at) {
    return null
  }
  return {
    principal_id: principal,
    session_ref: ref,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
    cookie_sha256: value.cookie_sha256,
    csrf_sha256: value.csrf_sha256,
    policy: value.policy,
    upstream: {
      caller: { principal_id: principal },
      management_session_ref: ref,
      issued_at: value.issued_at,
      expires_at: value.expires_at
    }
  }
}

/** 解析整份文档；结构不符或超限返回空集，保证损坏文件既不阻塞启动也不放行会话。 */
function parse(value: unknown, at: number, maximum: number): PersistedManagementSession[] {
  if (!exact(value, ['schema_version', 'sessions']) || value.schema_version !== 1 || !Array.isArray(value.sessions)) {
    return []
  }
  if (value.sessions.length > maximum) {
    return []
  }
  const seen = new Set<string>()
  const result: PersistedManagementSession[] = []
  for (const entry of value.sessions) {
    const row = session(entry, at)
    if (!row) {
      continue
    }
    // 同一 cookie 摘要或同一 (principal, session_ref) 只保留首次出现，避免歧义寻址。
    const name = row.principal_id + '\u0000' + row.session_ref
    if (seen.has(name) || seen.has(row.cookie_sha256)) {
      continue
    }
    seen.add(name)
    seen.add(row.cookie_sha256)
    result.push(row)
  }
  return result
}

/** 序列化前复验一遍，避免把内存中的异常记录写成可恢复状态。 */
function serialize(sessions: readonly PersistedManagementSession[], maximum: number): unknown {
  const rows = sessions.slice(0, maximum).map((row) => ({
    principal_id: row.principal_id,
    session_ref: row.session_ref,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    cookie_sha256: row.cookie_sha256,
    csrf_sha256: row.csrf_sha256,
    policy: row.policy,
    upstream: {
      caller: { principal_id: row.upstream.caller.principal_id },
      management_session_ref: row.upstream.management_session_ref,
      issued_at: row.upstream.issued_at,
      expires_at: row.upstream.expires_at
    }
  }))
  return { schema_version: 1, sessions: rows }
}

/** 构造持久化端口；读写由宿主提供的固定文件路径负责，模块本身不选择位置。 */
export function createManagementSessionPersistence(
  options: ManagementSessionPersistenceOptions
): ManagementSessionPersistence {
  const now = options.now ?? Date.now
  const maximum = options.max_sessions ?? MANAGEMENT_SESSIONS_MAX
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096) {
    throw new Error('management_session_limit')
  }
  return Object.freeze({
    load(): readonly PersistedManagementSession[] {
      try {
        const value = options.read()
        return value === undefined ? [] : parse(value, now(), maximum)
      } catch {
        // 读取失败只意味着本次没有可恢复会话，调用方仍按原有内存语义运行。
        return []
      }
    },
    save(sessions: readonly PersistedManagementSession[]): void {
      try {
        options.write(serialize(sessions, maximum))
      } catch {
        // 落盘失败不能让已建立的会话失效；下次成功写入会覆盖。
      }
    }
  })
}

export const MANAGEMENT_SESSIONS_MAX_BYTES = MAX_BYTES
