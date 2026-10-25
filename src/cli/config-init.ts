/** 显式首次生成所选 provider / 容器监听配置，不启动角色、不创建状态或批准任何设备。 */
import { CliError, type RoleConfig } from './config.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { readOrCreateRoleConfig, type RoleInitialization } from './first-config.js'

/** 已有配置只校验，不覆盖；与显式请求冲突时固定报 config_exists。 */
export function initializeRoleConfig(args: readonly string[], environment?: ConfigPathEnvironment): RoleConfig {
  const role = args[2]
  if (role !== 'gateway' && role !== 'connector') {
    throw new CliError('invalid_arguments')
  }
  let configPath: string | undefined
  let provider: RoleInitialization['provider']
  let container: true | undefined
  for (let index = 3; index < args.length; index++) {
    const name = args[index]
    if (name === '--container' && container === undefined && role === 'gateway') {
      container = true
    } else {
      const value = args[++index]
      if (name === '--config' && configPath === undefined && value !== undefined) {
        configPath = value
      } else if (
        name === '--provider' &&
        provider === undefined &&
        role === 'connector' &&
        ['luvus', 'herdr', 'mixed'].includes(value ?? '')
      ) {
        provider = value as RoleInitialization['provider']
      } else {
        throw new CliError('invalid_arguments')
      }
    }
  }
  const config = readOrCreateRoleConfig(role, resolveRoleConfigPath(role, configPath, environment), environment, {
    provider,
    container
  })
  if (config.role !== role) {
    throw new CliError('config_role_mismatch')
  }
  if (config.role === 'connector' && provider && (config.native?.provider ?? 'luvus') !== provider) {
    throw new CliError('config_exists')
  }
  if (
    config.role === 'gateway' &&
    container &&
    [config.mcp_hostname, config.device_hostname, config.management_hostname].some((host) => host !== '0.0.0.0')
  ) {
    throw new CliError('config_exists')
  }
  return config
}
