// 热读 MCP 令牌注册表：每次认证、身份和策略读取都以文件当前内容为准，吊销/续期/轮换无需重启。
import { createHash, timingSafeEqual } from 'node:crypto'
import type { CallerIdentity, GatewayIdentitySource } from '../mcp/management.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import type { Principal } from '../router.js'
import { CliError } from './config.js'
import { readRuntimeFile } from './runtime-files.js'
import { parseNativeJson } from '../native-contract/json.js'
import { gatewayCallerPolicy, parseRegistry, REGISTRY_MAX_BYTES } from './token-registry.js'
import type { CallerEntry, CallerRegistry } from './token-registry.js'

// 固定资源的只读 adapter；文件缺失、损坏或时钟回拨使该次读取失败（拒绝），文件恢复后下一次读取自动恢复。
export function openCallerSource(
  path: string,
  resource: string,
  administrator?: GatewayIdentitySource['administrator']
) {
  let closed = false
  let observed = 0
  let cached: { text: string; registry: CallerRegistry } | undefined
  const time = /* 同步IO前后及最后交付都核对当前时间，回拨后不能靠新请求重置本轮高水位。 */ () => {
    const at = Date.now()
    if (closed || !Number.isSafeInteger(at) || at < observed) {
      closed = true
      throw new CliError('backend_unavailable', 3)
    }
    observed = at
    return at
  }
  // 每次读取文件字节；内容变化才重新解析，解析失败不保留旧注册表（fail closed）。
  const load = /* 返回当前注册表，不缓存最近成功的身份。 */ (): CallerRegistry => {
    const bytes = readRuntimeFile(path, REGISTRY_MAX_BYTES)
    try {
      const text = bytes.toString('utf8')
      if (cached?.text === text) {
        return cached.registry
      }
      cached = undefined
      const parsed = parseNativeJson(bytes, {
        object_bytes: REGISTRY_MAX_BYTES,
        object_depth: 32,
        object_nodes: 100_000
      })
      if (!parsed.ok) {
        throw new CliError('invalid_config')
      }
      const registry = parseRegistry(parsed.value, resource)
      cached = { text, registry }
      return registry
    } finally {
      bytes.fill(0)
    }
  }
  const current = /* 每次使用前复验时钟并重读注册表。 */ (): { now: number; registry: CallerRegistry } => {
    try {
      time()
      const registry = load()
      return { now: time(), registry }
    } catch {
      throw new CliError('backend_unavailable', 3)
    }
  }
  const active = (entry: CallerEntry, now: number) => now >= entry.issued_at && now < entry.expires_at
  // 打开时必须得到一份有效且资源匹配的注册表；之后文件变化按下一次读取生效。
  load()
  const identities: GatewayIdentitySource = Object.freeze({
    // 只返回该来源中当前仍有效的既有主体，交付后不共享可变政策对象。
    principal(caller: CallerIdentity): Principal | null {
      try {
        const { now, registry } = current()
        const found = registry.callers.find(
          /* 吊销（删除）或到期都撤去当前身份，旧MCP会话或长等待不能滑动续期。 */ (entry) =>
            entry.principal.id === caller.principal_id && active(entry, now)
        )
        const principal = found
          ? structuredClone({
              ...found.principal,
              policy: found.scope === 'gateway' ? gatewayCallerPolicy(registry) : found.principal.policy
            })
          : null
        return found && time() < found.expires_at ? principal : null
      } catch {
        return null
      }
    },
    // 独立管理员回调前后都复验caller，回调中的同步撤权不能留下旧角色。
    administrator(caller: CallerIdentity, sessionRef: string) {
      // 普通caller文件没有管理角色；只消费独立宿主已验证的现有管理员来源。
      if (!identities.principal(caller) || !administrator) {
        return null
      }
      const admin = administrator(caller, sessionRef)
      return identities.principal(caller) ? admin : null
    }
  })
  const authentication: HttpAuthenticationProvider = Object.freeze({
    // 注册表仍绑定本机资源；实际 HTTP 地址允许反代，身份只来自当前有效的 Bearer。
    authenticate(request, signal) {
      const url = new URL(request.url)
      if (
        signal.aborted ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/mcp' ||
        url.search ||
        url.hash
      ) {
        return null
      }
      const authorization = request.headers.get('authorization')
      if (!authorization || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) {
        return null
      }
      try {
        const { now, registry } = current()
        const digest = createHash('sha256').update(authorization.slice(7)).digest()
        const found = registry.callers.find(
          /* 摘要比较不反射credential；当前令牌或轮换重叠期内的旧令牌均可认证，且主体本身须未到期。 */ (entry) =>
            active(entry, now) &&
            (timingSafeEqual(digest, Buffer.from(entry.token_sha256, 'hex')) ||
              (entry.previous !== undefined &&
                now < entry.previous.expires_at &&
                timingSafeEqual(digest, Buffer.from(entry.previous.token_sha256, 'hex'))))
        )
        return found && time() < found.expires_at && !signal.aborted
          ? Object.freeze({ principal_id: found.principal.id })
          : null
      } catch {
        return null
      }
    }
  })
  return Object.freeze({
    identities,
    authentication,
    localPolicies: /* 当前本机策略仍由同一受保护源持有，不从caller请求复制。 */ () => {
      return structuredClone(current().registry.local_policy)
    },
    close: /* 关闭只撤销本轮读取能力，不删除外部身份或修改既有凭据。 */ () => {
      closed = true
    }
  })
}
