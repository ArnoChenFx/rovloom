// MCP Bearer registry: authentication uses hashes; newly issued tokens remain available to administrators.
import { createHash, randomBytes } from 'node:crypto'
import type { DeviceScope, Principal } from '../router.js'
import type { ProviderPolicy } from '../wire/types.js'
import { fields, id, LIMITS, object, validatePolicies } from '../wire/index.js'
import { CliError } from './config.js'
import { SIMPLE_SETUP_ACTOR, allExposedMethods } from './setup-policy.js'

export const REGISTRY_MAX_BYTES = 262_144
export const MAX_CALLERS = 64
export const DEFAULT_TTL_DAYS = 30
const DAY = 86_400_000

export type CallerEntry = {
  principal: Principal
  token_sha256: string
  token?: string
  scope?: 'gateway'
  // 可选可见性收窄：缺省表示今天的行为（当前 grants 覆盖的全部设备）。
  device_scope?: DeviceScope
  issued_at: number
  expires_at: number
  // 轮换后的有界重叠期：旧令牌在此之前仍可认证，之后自动失效。
  previous?: { token_sha256: string; expires_at: number }
}
export type CallerRegistry = {
  schema_version: 1
  kind: 'mcp-caller-source'
  resource: string
  local_policy: ProviderPolicy
  gateway_policy?: ProviderPolicy
  callers: CallerEntry[]
}

const HEX = /^[a-f0-9]{64}$/
const PRINCIPAL = /^[a-zA-Z0-9_-]{1,128}$/
/** 设备范围只接受稳定 machine_id 形状；设备名可变，因此永不参与授权。 */
const MACHINE = /^[a-zA-Z0-9_-]{1,128}$/

/** Authentication digest; recoverable tokens are stored separately in the private registry. */
export function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 43 字符 base64url（256 位随机数），与 Bearer 头校验格式一致。 */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function invalid(): never {
  throw new CliError('invalid_config')
}

/** 严格校验设备范围：允许空的 selected 列表，元素须为去重的 machine_id 形状。 */
function deviceScope(value: unknown): DeviceScope {
  const scope = object(value)
  fields(scope, ['mode', 'machine_ids'])
  const ids = scope.machine_ids
  if (
    scope.mode !== 'selected' ||
    !Array.isArray(ids) ||
    ids.length > LIMITS.scope_machines ||
    ids.some(
      /* 只接受稳定 ID 形状，不接受设备名或路径。 */ (item) => typeof item !== 'string' || !MACHINE.test(item)
    ) ||
    new Set(ids).size !== ids.length
  ) {
    invalid()
  }
  return { mode: 'selected', machine_ids: [...(ids as string[])] }
}

/** 精确校验注册表；配置本身不能声明 authenticated 或 source_verified。 */
export function parseRegistry(value: unknown, resource?: string): CallerRegistry {
  try {
    const source = object(value)
    fields(source, ['schema_version', 'kind', 'resource', 'local_policy', 'callers'], ['gateway_policy'])
    if (
      source.schema_version !== 1 ||
      source.kind !== 'mcp-caller-source' ||
      typeof source.resource !== 'string' ||
      (resource !== undefined && source.resource !== resource) ||
      !Array.isArray(source.callers) ||
      source.callers.length > MAX_CALLERS
    ) {
      invalid()
    }
    const local = source.local_policy as ProviderPolicy
    if (source.gateway_policy !== undefined) {
      validatePolicies({ caller: source.gateway_policy as ProviderPolicy, local })
    }
    const principals = new Set<string>()
    const digests = new Set<string>()
    for (const input of source.callers) {
      const caller = object(input)
      fields(
        caller,
        ['principal', 'token_sha256', 'issued_at', 'expires_at'],
        ['previous', 'token', 'scope', 'device_scope']
      )
      if (
        (caller.scope !== undefined && caller.scope !== 'gateway') ||
        (caller.token !== undefined &&
          (typeof caller.token !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(caller.token) ||
            digestToken(caller.token) !== caller.token_sha256))
      ) {
        invalid()
      }
      const principal = object(caller.principal)
      fields(principal, ['id', 'policy'], ['permissions'])
      if (principal.permissions !== undefined) {
        const permissions = object(principal.permissions)
        fields(permissions, ['discard_response'])
        if (typeof permissions.discard_response !== 'boolean') {
          invalid()
        }
      }
      id(principal.id)
      if (
        !PRINCIPAL.test(principal.id as string) ||
        typeof caller.token_sha256 !== 'string' ||
        !HEX.test(caller.token_sha256) ||
        !Number.isSafeInteger(caller.issued_at) ||
        (caller.issued_at as number) < 0 ||
        !Number.isSafeInteger(caller.expires_at) ||
        (caller.expires_at as number) <= (caller.issued_at as number) ||
        principals.has(principal.id as string) ||
        digests.has(caller.token_sha256)
      ) {
        invalid()
      }
      if (caller.previous !== undefined) {
        const previous = object(caller.previous)
        fields(previous, ['token_sha256', 'expires_at'])
        if (
          typeof previous.token_sha256 !== 'string' ||
          !HEX.test(previous.token_sha256) ||
          !Number.isSafeInteger(previous.expires_at) ||
          digests.has(previous.token_sha256) ||
          previous.token_sha256 === caller.token_sha256
        ) {
          invalid()
        }
        digests.add(previous.token_sha256)
      }
      validatePolicies({ caller: principal.policy as ProviderPolicy, local })
      // 范围只校验形状；已撤销或不存在的 machine_id 按不匹配处理，不视为配置错误。
      if (caller.device_scope !== undefined) {
        deviceScope(caller.device_scope)
      }
      principals.add(principal.id as string)
      digests.add(caller.token_sha256)
    }
    const registry = source as unknown as CallerRegistry
    // Older simple-pairing registries keep the authoritative caller policy on the pairing actor.
    // Persist it independently on the next registry write so revoking that token does not revoke other tokens.
    const paired = registry.callers.find(
      (entry) => entry.scope === undefined && entry.principal.id === SIMPLE_SETUP_ACTOR
    )
    const current =
      registry.gateway_policy === undefined && paired
        ? { ...registry, gateway_policy: structuredClone(paired.principal.policy) }
        : registry
    return {
      ...current,
      local_policy: allExposedMethods(current.local_policy),
      ...(current.gateway_policy ? { gateway_policy: allExposedMethods(current.gateway_policy) } : {}),
      callers: current.callers.map((entry) => ({
        ...entry,
        principal: { ...entry.principal, policy: allExposedMethods(entry.principal.policy) }
      }))
    }
  } catch {
    throw new CliError('invalid_config')
  }
}

function ttl(days: number | undefined): number {
  const value = days ?? DEFAULT_TTL_DAYS
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new CliError('invalid_arguments')
  }
  return value * DAY
}

function find(registry: CallerRegistry, principal: string): number {
  const index = registry.callers.findIndex(/* 按主体精确匹配。 */ (entry) => entry.principal.id === principal)
  if (index < 0) {
    throw new CliError('invalid_arguments')
  }
  return index
}

/** 新主体：策略克隆自已有主体，防止 CLI 凭空扩大权限；保留原文供管理员后续查看。 */
export function createCaller(
  registry: CallerRegistry,
  principal: string,
  like: string,
  now: number,
  days?: number
): { registry: CallerRegistry; token: string; expires_at: number } {
  if (!PRINCIPAL.test(principal) || registry.callers.some(/* 主体不得重复。 */ (e) => e.principal.id === principal)) {
    throw new CliError('invalid_arguments')
  }
  if (registry.callers.length >= MAX_CALLERS) {
    throw new CliError('invalid_arguments')
  }
  const template = registry.callers[find(registry, like)]!
  const token = newToken()
  const expires_at = now + ttl(days)
  const entry: CallerEntry = {
    principal: { ...structuredClone(template.principal), id: principal },
    ...(template.scope ? { scope: template.scope } : {}),
    // 克隆范围与克隆策略同源，同样不会扩大权限；--like 的收窄一并继承。
    ...(template.device_scope ? { device_scope: structuredClone(template.device_scope) } : {}),
    token_sha256: digestToken(token),
    token,
    issued_at: now,
    expires_at
  }
  return { registry: { ...registry, callers: [...registry.callers, entry] }, token, expires_at }
}

/** 本机操作员显式授予/撤回结果删除权限；不改变调用方法策略、令牌或到期时间。 */
export function setDiscardPermission(registry: CallerRegistry, principal: string, allowed: boolean): CallerRegistry {
  const index = find(registry, principal)
  if (typeof allowed !== 'boolean') {
    throw new CliError('invalid_arguments')
  }
  return {
    ...registry,
    callers: registry.callers.map(
      /* 只修改选定主体，旧注册表缺省仍为无权。 */ (entry, at) =>
        at === index
          ? { ...entry, principal: { ...entry.principal, permissions: { discard_response: allowed } } }
          : entry
    )
  }
}

/** 本机操作员显式收窄/清除设备可见性；不改变策略修订、方法授权、令牌或到期时间。 */
export function setDeviceScope(
  registry: CallerRegistry,
  principal: string,
  machineIds: readonly string[] | null
): CallerRegistry {
  const index = find(registry, principal)
  let device_scope: DeviceScope | undefined
  if (machineIds !== null) {
    // 空列表拒绝全部设备；null 明确清除过滤器。
    if (
      !Array.isArray(machineIds) ||
      machineIds.length > LIMITS.scope_machines ||
      machineIds.some(
        /* 只接受稳定 machine_id，不接受设备名。 */ (item) => typeof item !== 'string' || !MACHINE.test(item)
      ) ||
      new Set(machineIds).size !== machineIds.length
    ) {
      throw new CliError('invalid_arguments')
    }
    device_scope = { mode: 'selected', machine_ids: [...machineIds] }
  }
  return {
    ...registry,
    callers: registry.callers.map(
      /* 只修改选定主体；清除时删除字段回到缺省语义。 */ (value, at) => {
        if (at !== index) {
          return value
        }
        const { device_scope: _previous, ...rest } = value
        return device_scope === undefined ? rest : { ...rest, device_scope }
      }
    )
  }
}

/** 续期：延长到期时间，令牌不变；到期后仍可续期（只要主体仍在注册表中）。 */
export function renewCaller(
  registry: CallerRegistry,
  principal: string,
  now: number,
  days?: number
): { registry: CallerRegistry; expires_at: number } {
  const index = find(registry, principal)
  const expires_at = now + ttl(days)
  const callers = registry.callers.map(
    /* 仅替换目标主体。 */ (entry, i) =>
      i === index ? { ...entry, issued_at: Math.min(entry.issued_at, now), expires_at } : entry
  )
  return { registry: { ...registry, callers }, expires_at }
}

/** 轮换：签发新令牌；旧令牌仅在 graceMinutes 内继续有效（0 表示立即失效）。 */
export function rotateCaller(
  registry: CallerRegistry,
  principal: string,
  now: number,
  options: { days?: number; graceMinutes?: number } = {}
): { registry: CallerRegistry; token: string; expires_at: number } {
  const index = find(registry, principal)
  const grace = options.graceMinutes ?? 0
  if (!Number.isInteger(grace) || grace < 0 || grace > 1440) {
    throw new CliError('invalid_arguments')
  }
  const old = registry.callers[index]!
  const token = newToken()
  const expires_at = now + ttl(options.days)
  const entry: CallerEntry = {
    principal: old.principal,
    ...(old.scope ? { scope: old.scope } : {}),
    // 轮换不改变可见性，也不因为签发新令牌而放宽范围。
    ...(old.device_scope ? { device_scope: structuredClone(old.device_scope) } : {}),
    token_sha256: digestToken(token),
    token,
    issued_at: now,
    expires_at,
    ...(grace > 0
      ? { previous: { token_sha256: old.token_sha256, expires_at: Math.min(now + grace * 60_000, old.expires_at) } }
      : {})
  }
  return {
    registry: {
      ...registry,
      callers: registry.callers.map(/* 仅替换目标主体。 */ (e, i) => (i === index ? entry : e))
    },
    token,
    expires_at
  }
}

/** 吊销：从注册表删除主体；运行中的 MCP 会话在下一次调用时即失效。 */
export function revokeCaller(registry: CallerRegistry, principal: string): CallerRegistry {
  const index = find(registry, principal)
  return { ...registry, callers: registry.callers.filter(/* 保留其余主体。 */ (_e, i) => i !== index) }
}

export type DeviceScopeView = { mode: 'all' } | DeviceScope

/** 把可选范围投影为列表视图；缺省即全部设备。 */
export function deviceScopeView(entry: { device_scope?: DeviceScope }): DeviceScopeView {
  return entry.device_scope ? { mode: 'selected', machine_ids: [...entry.device_scope.machine_ids] } : { mode: 'all' }
}

export type CallerSummary = {
  principal: string
  issued_at: number
  expires_at: number
  status: 'active' | 'expired'
  rotating: boolean
  device_scope: DeviceScopeView
}

/** 列表只含非秘密字段。 */
export function summarize(registry: CallerRegistry, now: number): CallerSummary[] {
  return registry.callers.map(
    /* 不输出摘要、策略或任何令牌材料。 */ (entry) => ({
      principal: entry.principal.id,
      issued_at: entry.issued_at,
      expires_at: entry.expires_at,
      status: now < entry.expires_at ? ('active' as const) : ('expired' as const),
      rotating: entry.previous !== undefined && now < entry.previous.expires_at,
      device_scope: deviceScopeView(entry)
    })
  )
}

/** All MCP tokens follow current paired targets; device_scope narrows visibility, never a method snapshot. */
export function gatewayCallerPolicy(registry: CallerRegistry): ProviderPolicy {
  if (registry.gateway_policy) {
    return allExposedMethods(registry.gateway_policy)
  }
  const revision = registry.local_policy.revision.startsWith('setup_local_')
    ? registry.local_policy.revision.replace('setup_local_', 'setup_caller_')
    : (registry.callers.find((entry) => entry.principal.policy.grants.length > 0)?.principal.policy.revision ??
      registry.local_policy.revision)
  return allExposedMethods({ revision, grants: registry.local_policy.grants })
}

export function createGatewayCaller(registry: CallerRegistry, principal: string, now: number, days = 365) {
  if (
    !PRINCIPAL.test(principal) ||
    registry.callers.some((entry) => entry.principal.id === principal) ||
    registry.callers.length >= MAX_CALLERS
  ) {
    throw new CliError('invalid_arguments')
  }
  const token = newToken()
  const expires_at = now + ttl(days)
  const entry: CallerEntry = {
    principal: { id: principal, policy: structuredClone(gatewayCallerPolicy(registry)) },
    scope: 'gateway',
    token,
    token_sha256: digestToken(token),
    issued_at: now,
    expires_at
  }
  return { registry: { ...registry, callers: [...registry.callers, entry] }, token, expires_at }
}
