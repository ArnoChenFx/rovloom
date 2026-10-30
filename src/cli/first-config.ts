// 仅在角色文件缺失时独占创建单份用户配置；不读取stdin、不生成凭据、不写runtime/ref文档。
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensurePrivateDirectory } from '../storage/files.js'
import { CliError, configDocument, configTemplate, parseConfig, readConfig, type RoleConfig } from './config.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'

// 只创建缺失目录，沿用已有目录的正常权限与内容。
export function privateDirectory(path: string): void {
  try {
    ensurePrivateDirectory(path)
  } catch {
    throw new CliError('config_unreadable')
  }
}

export type RoleInitialization = Readonly<{ provider?: 'luvus' | 'herdr' | 'herdr-core' | 'mixed'; container?: true }>

// 容器镜像通过环境变量声明自身：首次生成的 Gateway 配置直接采用容器监听默认值，
// 让镜像默认入口（rovloom gateway）无需额外子命令即可从宿主机端口映射访问。
// 与 --container 标志取并集；npm 安装的二进制不受影响。
function containerEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.ROVLOOM_CONTAINER === '1'
}

// 角色和状态目录分离；显式config只覆盖用户文件位置，默认数据仍属于当前用户的home。
function defaults(
  role: RoleConfig['role'],
  environment: ConfigPathEnvironment | undefined,
  initialization: RoleInitialization
): RoleConfig {
  let home: string | undefined
  try {
    home = environment ? environment.home : homedir()
  } catch {
    throw new CliError('config_home_unavailable')
  }
  resolveRoleConfigPath(role, undefined, { home, platform: process.platform })
  const config = parseConfig({
    ...configDocument(configTemplate(role)),
    data: { directory: join(home!, '.local', 'share', 'rovloom', role) }
  })
  if (config.role === 'connector' && initialization.provider) {
    return { ...config, native: { ...config.native, provider: initialization.provider } }
  }
  if (config.role === 'gateway' && (initialization.container || containerEnvironment())) {
    return {
      ...config,
      mcp_hostname: '0.0.0.0',
      device_hostname: '0.0.0.0',
      management_hostname: '0.0.0.0'
    }
  }
  return config
}

// 只有缺失错误触发首次生成；完整临时文件通过原子link发布，不覆盖已有文件或留下写入残片。
export function readOrCreateRoleConfig(
  role: RoleConfig['role'],
  path: string,
  environment?: ConfigPathEnvironment,
  initialization: RoleInitialization = {}
): RoleConfig {
  try {
    return readConfig(path)
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'config_not_found') {
      throw error
    }
  }
  const config = defaults(role, environment, initialization)
  const directory = dirname(path)
  privateDirectory(directory)
  const temporary = join(directory, '.rovloom-config-' + randomUUID() + '.tmp')
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(temporary, 'wx', 0o600)
    created = true
    writeFileSync(fd, JSON.stringify(configDocument(config), null, 2) + '\n')
    fsyncSync(fd)
    const written = fd
    fd = undefined
    closeSync(written)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
    unlinkSync(temporary)
    created = false
    // 校验并发获胜者的内容与角色，不以自己的默认值覆盖它。
    return readConfig(path)
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    throw new CliError('config_unreadable')
  } finally {
    try {
      if (fd !== undefined) {
        closeSync(fd)
      }
    } finally {
      if (created) {
        unlinkSync(temporary)
      }
    }
  }
}
