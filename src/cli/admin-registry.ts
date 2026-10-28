import { CliError } from './config.js'
import { MAX_CALLERS, digestToken, newToken, type CallerRegistry } from './token-registry.js'
import { DEFAULT_PAIRING_POLICY_REF } from '../pairing-policy.js'

export const ADMIN_POLICY_REVISION = 'rovloom_admin_v1'
export const MAX_ADMINS = 16
export const DEFAULT_ADMIN_TTL_DAYS = 30
const DAY = 86_400_000
const PRINCIPAL = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export type ManagementSessionRecord = {
  credential_sha256: string
  lease: { caller: { principal_id: string }; management_session_ref: string; issued_at: number; expires_at: number }
  administrator: {
    principal_id: string
    session_ref: string
    assurance: 'administrator'
    policy_revision: string
    grants: []
  }
  scope: 'all_devices'
}
export type ManagementFile = {
  schema_version: 1
  kind: 'management-session-source'
  port: number
  sessions: ManagementSessionRecord[]
  pairing_policy_refs: string[]
}

/** 尚无任何管理员的来源文件；端口必须与 Gateway 配置的管理端口一致。 */
export function emptyManagement(port: number): ManagementFile {
  return {
    schema_version: 1,
    kind: 'management-session-source',
    port,
    sessions: [],
    pairing_policy_refs: [DEFAULT_PAIRING_POLICY_REF]
  }
}

/** 管理员主体在 MCP 注册表里的占位条目：策略为空且令牌无人知晓，因此不能经 MCP 调用任何东西。 */
export function isAdminPlaceholder(entry: CallerRegistry['callers'][number]): boolean {
  return entry.management_only === true
}

function ttl(days: number | undefined): number {
  const value = days ?? DEFAULT_ADMIN_TTL_DAYS
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new CliError('invalid_arguments')
  }
  return value * DAY
}

/** 签发或重新签发一个管理员：同名记录被替换，旧口令与旧 Cookie 立即失效；返回口令原值仅此一次。 */
export function issueAdmin(
  callers: CallerRegistry,
  management: ManagementFile,
  principal: string,
  now: number,
  days?: number
): { callers: CallerRegistry; management: ManagementFile; secret: string; expires_at: number } {
  if (!PRINCIPAL.test(principal)) {
    throw new CliError('invalid_arguments')
  }
  const existing = callers.callers.find(/* 同名主体。 */ (entry) => entry.principal.id === principal)
  // 不得把管理员口令附到一个真实的 MCP 调用方上：身份与权限必须分开。
  if (existing && !isAdminPlaceholder(existing)) {
    throw new CliError('invalid_arguments')
  }
  const others = management.sessions.filter(/* 其余管理员。 */ (entry) => entry.lease.caller.principal_id !== principal)
  if (others.length >= MAX_ADMINS || (!existing && callers.callers.length >= MAX_CALLERS)) {
    throw new CliError('invalid_arguments')
  }
  const expires_at = now + ttl(days)
  const secret = newToken()
  const placeholder = {
    principal: { id: principal },
    management_only: true as const,
    token_sha256: digestToken(newToken()),
    issued_at: now,
    expires_at
  }
  const ref = 'adm_' + digestToken(newToken()).slice(0, 16)
  const session: ManagementSessionRecord = {
    credential_sha256: digestToken(secret),
    lease: { caller: { principal_id: principal }, management_session_ref: ref, issued_at: now, expires_at },
    administrator: {
      principal_id: principal,
      session_ref: ref,
      assurance: 'administrator',
      policy_revision: ADMIN_POLICY_REVISION,
      grants: []
    },
    scope: 'all_devices'
  }
  return {
    callers: {
      ...callers,
      callers: [
        ...callers.callers.filter(/* 替换同名占位。 */ (entry) => entry.principal.id !== principal),
        placeholder
      ]
    },
    management: {
      ...management,
      sessions: [...others, session],
      // 显式签发管理员时为尚未选过策略的来源提供产品默认；保留已有自定义允许列表。
      pairing_policy_refs: management.pairing_policy_refs.length
        ? management.pairing_policy_refs
        : [DEFAULT_PAIRING_POLICY_REF]
    },
    secret,
    expires_at
  }
}

/** 撤销一个管理员：删除其管理记录与占位主体；其 Cookie 在下一次请求即失效。 */
export function revokeAdmin(
  callers: CallerRegistry,
  management: ManagementFile,
  principal: string
): { callers: CallerRegistry; management: ManagementFile } {
  if (
    !management.sessions.some(/* 目标必须是已有管理员。 */ (entry) => entry.lease.caller.principal_id === principal)
  ) {
    throw new CliError('invalid_arguments')
  }
  return {
    callers: {
      ...callers,
      callers: callers.callers.filter(
        /* 只删除管理员占位，绝不删除同名的真实 MCP 调用方。 */ (entry) =>
          !(entry.principal.id === principal && isAdminPlaceholder(entry))
      )
    },
    management: {
      ...management,
      sessions: management.sessions.filter(
        /* 保留其余管理员。 */ (entry) => entry.lease.caller.principal_id !== principal
      )
    }
  }
}

export type AdminSummary = { principal: string; issued_at: number; expires_at: number; status: 'active' | 'expired' }

/** 列表只含非秘密字段。 */
export function summarizeAdmins(management: ManagementFile, now: number): AdminSummary[] {
  return management.sessions.map(
    /* 不输出摘要、会话引用或任何口令材料。 */ (entry) => ({
      principal: entry.lease.caller.principal_id,
      issued_at: entry.lease.issued_at,
      expires_at: entry.lease.expires_at,
      status: now < entry.lease.expires_at ? ('active' as const) : ('expired' as const)
    })
  )
}
