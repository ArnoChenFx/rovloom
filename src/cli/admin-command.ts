// rovloom admin：管理页管理员的签发、列表与撤销；口令原值只在 create 时写入 stdout 一次，Gateway 热读，无需重启。
import type { Writable } from 'node:stream'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { boundedJson, fields, object } from '../wire/index.js'
import { canonicalLoopbackHost } from '../mcp/listen.js'
import { CLI_ERROR_CODES, CliError, readConfig, type GatewayConfig } from './config.js'
import { cliMessages, formatMessage, type CliLanguage } from './messages.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { runtimeReference } from './runtime-files.js'
import { readSetupJson, setupFileStamp, writeSetupFile } from './setup-files.js'
import {
  emptyManagement,
  issueAdmin,
  revokeAdmin,
  summarizeAdmins,
  type ManagementFile,
  DEFAULT_ADMIN_TTL_DAYS
} from './admin-registry.js'
import { REGISTRY_MAX_BYTES, parseRegistry } from './token-registry.js'

type Flags = { sub: string; config?: string; principal?: string; days?: number }

function parse(args: readonly string[]): Flags {
  const sub = args[1]
  if (!sub || !['list', 'create', 'revoke'].includes(sub)) {
    throw new CliError('invalid_arguments')
  }
  const flags: Flags = { sub }
  for (let index = 2; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (value === undefined) {
      throw new CliError('invalid_arguments')
    }
    if (name === '--config' && flags.config === undefined) {
      flags.config = value
    } else if (name === '--principal' && flags.principal === undefined) {
      flags.principal = value
    } else if (name === '--ttl-days' && flags.days === undefined && /^[0-9]{1,6}$/.test(value)) {
      flags.days = Number(value)
    } else {
      throw new CliError('invalid_arguments')
    }
  }
  const allowed: Record<string, readonly (keyof Flags)[]> = {
    list: [],
    create: ['principal', 'days'],
    revoke: ['principal']
  }
  for (const key of ['principal', 'days'] as const) {
    if (flags[key] !== undefined && !allowed[sub]!.includes(key)) {
      throw new CliError('invalid_arguments')
    }
  }
  return flags
}

/** 读取已有来源文件并做形状校验；缺失时返回空来源。Gateway 读取时还会做完整校验。 */
function loadManagement(path: string, port: number): { file: ManagementFile; exists: boolean } {
  const raw = readSetupJson(path)
  if (raw === undefined) {
    return { file: emptyManagement(port), exists: false }
  }
  const value = object(raw)
  fields(value, ['schema_version', 'kind', 'port', 'sessions', 'pairing_policy_refs'])
  if (
    value.schema_version !== 1 ||
    value.kind !== 'management-session-source' ||
    value.port !== port ||
    !Array.isArray(value.sessions)
  ) {
    throw new CliError('invalid_config')
  }
  return { file: value as unknown as ManagementFile, exists: true }
}

/** 本机 caller 的资源地址用规范回环地址；与首次配对发布及认证门禁使用同一 URL。 */
export function callerResource(config: GatewayConfig): string {
  const hostname = canonicalLoopbackHost(config.mcp_hostname)
  return new URL('http://' + hostname + ':' + config.mcp_port + '/mcp').href
}

/** 全新 Gateway 的空调用方注册表：只含空本机策略，不含任何 MCP 主体或令牌摘要。 */
export function emptyCallerRegistry(resource: string): import('./token-registry.js').CallerRegistry {
  return {
    schema_version: 2,
    kind: 'mcp-caller-source',
    resource,
    callers: []
  }
}

/** 已有调用方注册表时返回其字节代次；尚未配对时不存在，首次发布用 link 排他写入。 */
function callersStamp(path: string): string | undefined {
  try {
    return setupFileStamp(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** 在 Gateway 状态目录签发（或重新签发）一个管理员：先写调用方注册表再写来源文件；返回口令原值仅此一次。 */
export function writeAdminFiles(
  config: GatewayConfig,
  principal: string,
  at: number,
  days?: number
): { secret: string; expires_at: number } {
  const callersPath = runtimeReference(config.state_dir, 'mcp-callers')
  const managementPath = runtimeReference(config.state_dir, 'management')
  // 尚未首次启动的 Gateway 还没有 managed/ 状态目录：按运行时同样的私有目录权限先建立，
  // 否则文档允许的「配对/启动前创建管理员」在全新安装上以 runtime_failed 失败且不落盘。
  mkdirSync(dirname(managementPath), { recursive: true, mode: 0o700 })
  const stamp = callersStamp(callersPath)
  // 首次配对前也允许签发管理员：缺失的注册表按空来源初始化，随后管理页即可完成在线配对。
  const callers = parseRegistry(
    readSetupJson(callersPath, REGISTRY_MAX_BYTES) ?? emptyCallerRegistry(callerResource(config))
  )
  const { file, exists } = loadManagement(managementPath, config.management_port)
  const managementStamp = exists ? setupFileStamp(managementPath) : undefined
  const issued = issueAdmin(callers, file, principal, at, days)
  // 先写注册表再写来源：中途失败至多留下无权限的占位主体，重跑 create 会替换它。
  // 注册表缺失时首次发布；已存在时按原代次替换，与配对后行为一致。
  if (stamp === undefined) {
    writeSetupFile(callersPath, boundedJson(issued.callers, REGISTRY_MAX_BYTES), false)
  } else {
    writeSetupFile(callersPath, boundedJson(issued.callers, REGISTRY_MAX_BYTES), true, stamp)
  }
  writeSetupFile(managementPath, boundedJson(issued.management, 65_536), exists, managementStamp)
  return { secret: issued.secret, expires_at: issued.expires_at }
}

/** 管理页的来源文件是否已存在（首次引导只在没有任何管理员记录时才自动创建）。 */
export function managementSourceExists(config: GatewayConfig): boolean {
  return readSetupJson(runtimeReference(config.state_dir, 'management')) !== undefined
}

/** 处理 admin 子命令并返回退出码；诊断只含固定错误码。 */
export async function handleAdminCommand(
  args: readonly string[],
  io: { stdout: Writable; stderr: Writable; language?: CliLanguage },
  environment?: ConfigPathEnvironment,
  now: () => number = Date.now
): Promise<number> {
  try {
    if (args.length === 2 && args[1] === '--help') {
      io.stderr.write(formatMessage(cliMessages(io.language)['help.admin'], { ttlDays: DEFAULT_ADMIN_TTL_DAYS }))
      return 0
    }
    const flags = parse(args)
    const config = readConfig(resolveRoleConfigPath('gateway', flags.config, environment))
    if (config.role !== 'gateway' || !config.management_enabled) {
      throw new CliError(config.role !== 'gateway' ? 'config_role_mismatch' : 'invalid_arguments')
    }
    const callersPath = runtimeReference(config.state_dir, 'mcp-callers')
    const managementPath = runtimeReference(config.state_dir, 'management')
    const at = now()
    const principal = flags.principal ?? 'admin'
    if (flags.sub === 'create') {
      const issued = writeAdminFiles(config, principal, at, flags.days)
      io.stderr.write(
        formatMessage(cliMessages(io.language)['admin.create.created'], {
          principal,
          expires: new Date(issued.expires_at).toISOString()
        }) +
          formatMessage(cliMessages(io.language)['admin.create.login'], {
            url: 'http://127.0.0.1:' + config.management_port + '/',
            user: principal
          })
      )
      io.stdout.write(issued.secret + '\n')
      return 0
    }
    const registryStamp = callersStamp(callersPath)
    // 全新安装尚无注册表文件时按空来源列出（输出零行），与 create 的初始化语义一致。
    const callers = parseRegistry(
      readSetupJson(callersPath, REGISTRY_MAX_BYTES) ?? emptyCallerRegistry(callerResource(config))
    )
    const { file, exists } = loadManagement(managementPath, config.management_port)
    if (flags.sub === 'list') {
      for (const row of summarizeAdmins(file, at)) {
        io.stdout.write([row.principal, row.status, new Date(row.expires_at).toISOString()].join('\t') + '\n')
      }
      return 0
    }
    const stamp = exists ? setupFileStamp(managementPath) : undefined
    const revoked = revokeAdmin(callers, file, principal)
    writeSetupFile(managementPath, boundedJson(revoked.management, 65_536), true, stamp)
    writeSetupFile(callersPath, boundedJson(revoked.callers, REGISTRY_MAX_BYTES), true, registryStamp)
    io.stderr.write(formatMessage(cliMessages(io.language)['admin.revoked'], { principal }))
    return 0
  } catch (error) {
    if (error instanceof CliError && CLI_ERROR_CODES.includes(error.code)) {
      io.stderr.write(error.code + '\n')
      return error.exitCode
    }
    io.stderr.write('runtime_failed\n')
    return 1
  }
}
