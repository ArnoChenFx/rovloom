/** 本机显式离线运维入口；身份源为操作系统文件访问，不提供远程 SQL、MCP 管理或任意动作。 */
import type { Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, sep } from 'node:path'
import { existsSync, realpathSync, lstatSync } from 'node:fs'
import { GatewayError } from '../contracts.js'
import { Store } from '../store.js'
import { databasePath, privatePath } from '../storage/files.js'
import { configuredSnapshotDirectory } from '../storage/snapshot-directory.js'
import { inspectStorage } from '../storage/inspect.js'
import { CLI_ERROR_CODES, CliError, readConfig } from './config.js'
import { cliMessages, type CliLanguage } from './messages.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { readRuntimeConfig } from './runtime-config.js'
import { runtimeReference } from './runtime-files.js'

type Flags = {
  action: 'doctor' | 'check' | 'backup' | 'resume'
  role: 'gateway' | 'connector'
  config?: string
  output?: string
  json: boolean
}

/** 参数只能选择固定本地操作；角色与配置须一致，未知/重复字段拒绝。 */
function parse(args: readonly string[]): Flags {
  const action = args[0] === 'doctor' ? 'doctor' : args[1]
  if (!['doctor', 'check', 'backup', 'resume'].includes(action ?? '')) {
    throw new CliError('invalid_arguments')
  }
  let role: Flags['role'] | undefined
  let config: string | undefined
  let output: string | undefined
  let json = false
  for (let index = args[0] === 'doctor' ? 1 : 2; index < args.length; index++) {
    const name = args[index]
    if (name === '--json' && !json) {
      json = true
      continue
    }
    const value = args[++index]
    if (value === undefined) {
      throw new CliError('invalid_arguments')
    }
    if (name === '--role' && role === undefined && (value === 'gateway' || value === 'connector')) {
      role = value
    } else if (name === '--config' && config === undefined) {
      config = value
    } else if (name === '--output' && output === undefined) {
      output = value
    } else {
      throw new CliError('invalid_arguments')
    }
  }
  if (!role || (action !== 'doctor' && role !== 'gateway') || (action === 'backup') !== (output !== undefined)) {
    throw new CliError('invalid_arguments')
  }
  return { action: action as Flags['action'], role, config, output, json }
}

const STORAGE_ERRORS = new Set([
  'storage_missing',
  'storage_writer_locked',
  'storage_lock_changed',
  'unsupported_database_version',
  // 迁移自身的固定失败码：只报类别，不带 SQL、路径或旧库内容。
  'database_migration_failed',
  'migration_snapshot_failed',
  'migration_chain_invalid',
  'migration_foreign_key_violation',
  'database_integrity_failed',
  'database_mode_invalid',
  'clock_untrusted',
  'storage_degraded',
  'storage_exhausted',
  'content_quota',
  'result_quota',
  'backup_quota',
  'backup_count_quota',
  'backup_exists',
  'separate_backup_directory_required',
  'invalid_storage_path',
  'database_hardlink_unsupported',
  'invalid_backup_directory',
  'managed_backup_directory_required'
])

/** 统一 CLI 输出；安全码白名单之外的异常不反射路径、SQL、配置或私有文本。 */
export async function handleStorageCommand(
  args: readonly string[],
  io: { stdout: Writable; stderr: Writable; language?: CliLanguage },
  environment?: ConfigPathEnvironment
): Promise<number> {
  let json = args.includes('--json')
  try {
    if (args.length === 2 && args[1] === '--help') {
      io.stderr.write(cliMessages(io.language)['help.storage'])
      return 0
    }
    const flags = parse(args)
    json = flags.json
    const config = readConfig(resolveRoleConfigPath(flags.role, flags.config, environment))
    if (config.role !== flags.role) {
      throw new CliError('config_role_mismatch')
    }
    let data: Record<string, unknown>
    let healthy = true
    if (config.role === 'connector') {
      const runtime = readRuntimeConfig(config)
      const credentialPresent = existsSync(runtimeReference(config.state_dir, 'device'))
      healthy = Boolean(config.gateway_url) && runtime.providers.length > 0 && credentialPresent
      data = {
        role: 'connector',
        config: 'valid',
        configured: healthy,
        managed_providers: runtime.providers.length,
        credential_present: credentialPresent,
        native_checked: false
      }
    } else {
      const configuredPath = join(config.state_dir, 'gateway.db')
      if (!existsSync(configuredPath)) {
        throw new GatewayError('storage_missing')
      }
      const path = databasePath(configuredPath)
      if (!existsSync(path)) {
        throw new GatewayError('storage_missing')
      }
      if (flags.action === 'doctor' || flags.action === 'check') {
        const storage = inspectStorage(path)
        healthy = storage.healthy
        data = { role: 'gateway', config: 'valid', ...storage }
      } else {
        const backupDirectory = configuredSnapshotDirectory(path)
        if (flags.output) {
          privatePath(flags.output)
          const directory = realpathSync(dirname(flags.output))
          const sourceDirectory = realpathSync(dirname(path))
          if (
            directory === sourceDirectory ||
            directory.startsWith(sourceDirectory + sep) ||
            sourceDirectory.startsWith(directory + sep)
          ) {
            throw new GatewayError('separate_backup_directory_required')
          }
          if (directory !== backupDirectory) {
            throw new GatewayError('managed_backup_directory_required')
          }
          flags.output = join(directory, basename(flags.output))
          try {
            lstatSync(flags.output)
            throw new GatewayError('backup_exists')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error
            }
          }
        }
        // 创建 Store 本身会收敛旧 epoch / 在途状态，故仅显式的离线写操作进入这里。
        let confirmation: { action: string; target: string; fence: string } | undefined
        const store = new Store(path, Date.now, {
          backupDirectory,
          management(request) {
            // 一次本地命令仅批准它所选操作和当前恢复代次，不能被复用为其它管理权限。
            if (
              !confirmation ||
              request.action !== confirmation.action ||
              request.target !== confirmation.target ||
              request.fence !== confirmation.fence
            ) {
              throw new GatewayError('management_authorization_required')
            }
            confirmation = undefined
            return { actor: 'local_storage_cli', confirmation_id: 'local_storage_' + randomUUID() }
          }
        })
        try {
          confirmation = {
            action: flags.action === 'backup' ? 'backup_create' : 'storage_resume',
            target: 'database',
            fence: store.generation()
          }
          if (flags.action === 'backup') {
            // 同步离线命令不会等待维护 timer；先回收已到期快照和业务状态，再检查两份配额。
            store.expire()
            store.backup(flags.output!)
            data = {
              role: 'gateway',
              operation: 'backup',
              kind: 'redacted_snapshot',
              retention_ms: store.limits.backup_ttl,
              completed: true
            }
          } else {
            store.resumeStorage()
            data = { role: 'gateway', operation: 'resume', mode: store.health().mode, completed: true }
          }
        } finally {
          confirmation = undefined
          store.close()
        }
      }
    }
    io.stdout.write(
      json
        ? JSON.stringify({ ok: healthy, ...data }) + '\n'
        : Object.entries(data)
            .map(([key, value]) => key + '=' + String(value))
            .join('\n') + '\n'
    )
    return healthy ? 0 : 3
  } catch (error) {
    const code =
      error instanceof CliError && CLI_ERROR_CODES.includes(error.code)
        ? error.code
        : error instanceof GatewayError && STORAGE_ERRORS.has(error.code)
          ? error.code
          : (error as NodeJS.ErrnoException)?.code === 'EEXIST'
            ? 'storage_writer_locked'
            : 'storage_check_failed'
    const exit = error instanceof CliError ? error.exitCode : 3
    if (json) {
      io.stdout.write(JSON.stringify({ ok: false, code }) + '\n')
    } else {
      io.stderr.write(code + '\n')
    }
    return exit
  }
}
