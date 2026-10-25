// 解析固定 CLI 命令并调用显式角色宿主；缺后端明确拒绝，标准输出与诊断通道分离。
import type { Readable, Writable } from 'node:stream'
import type { GatewayService } from '../mcp/types.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import type { ServiceCommandHost } from '../service/command.js'
import { ServiceError } from '../service/types.js'
import { PRODUCT_VERSION } from '../mcp/version.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { cliMessages, formatMessage, type CliLanguage } from './messages.js'
import { serviceDiagnostic } from './service-output.js'
import { readOrCreateRoleConfig } from './first-config.js'
import { readRuntimeConfig } from './runtime-config.js'
import { isWildcardHostname } from '../mcp/listen.js'
import {
  CLI_ERROR_CODES,
  CliCancelled,
  CliError,
  configTemplate,
  configDocument,
  readConfig,
  type ConnectorConfig,
  type GatewayConfig
} from './config.js'

// 主帮助按当前语言输出；文案与翻译统一在 messages 词典维护。
export function cliHelp(language: CliLanguage = 'en'): string {
  return formatMessage(cliMessages(language)['help.main'], { version: PRODUCT_VERSION })
}

export type RunningConnector = {
  closed: Promise<void>
  transport?: Pick<ReturnType<typeof import('../transport/connector.js').createConnector>, 'status'>
  // 释放本地宿主资源并报告关闭失败，不伪造原生取消结果。
  close(): Promise<void>
}
export type GatewayRuntime = {
  service: GatewayService
  authentication: HttpAuthenticationProvider
  closed?: Promise<void>
  setupRequired?: boolean
  reconfigure?: Promise<void>
  // 宿主实际启动管理listener后上报的本机管理页地址；未启动管理页时不提供，CLI 不按配置自报。
  managementUrl?: string
  // 宿主可观察实际MCP地址以发布本机就绪状态；此回调不提供认证或权限。
  listening?(url: string): void | Promise<void>
  // 在前端关闭后释放宿主拥有的资源，保留可能已送达工作的历史证据。
  close(): Promise<void>
}
// 服务宿主提供真实监管器及已验证默认路径；诊断由唯一CLI固定写入stderr。
export type CliServiceHost = Omit<ServiceCommandHost, 'diagnostic'>
// 宿主负责单 writer、transport/native 接线、配置来源和资源释放；不从配置加载可执行模块。
export type CliRuntime = {
  service?: CliServiceHost
  // 只在角色启动调用本机引导；help/check/template不创建状态或读取stdin。
  prepare?(
    config: GatewayConfig | ConnectorConfig,
    path: string,
    io: CliIo,
    options?: CliPrepareOptions
  ): Promise<GatewayConfig | ConnectorConfig>
  // 建立受信服务及 caller 绑定并交出资源所有权；未提供时角色启动明确拒绝。
  gateway?: (config: GatewayConfig) => Promise<GatewayRuntime>
  // 启动受信出站宿主并返回其生命周期；具体认证和传输不由 CLI 补造。
  connector?: (config: ConnectorConfig) => Promise<RunningConnector>
}
// Connector 首次配对：`rovloom connector --join <ws://host:port#code>` 单命令完成并直接运行。
// Gateway 手动签发一张一机一码：`rovloom gateway --issue-code` 启动时打印完整加入命令。
export type CliPrepareOptions = { join?: string; issueCode?: true }
export type CliIo = {
  stdin: Readable
  stdout: Writable
  stderr: Writable
  signal: AbortSignal
  // 显示语言由入口按环境解析一次；省略视为英文，保证库调用与测试不依赖宿主 locale。
  language?: CliLanguage
}
type Command =
  | { action: 'help' | 'version' }
  | { action: 'template'; role: 'gateway' | 'connector' }
  | { action: 'check' | 'check-runtime'; checks: readonly { role?: 'gateway' | 'connector'; path: string }[] }
  | {
      action: 'gateway' | 'connector'
      path: string
      nonInteractive?: true
      serviceId?: string
      join?: string
      issueCode?: true
      unpair?: true
    }

// 解析固定命令形状，未知参数只返回稳定错误，不回显 argv。
export function parseCommand(args: readonly string[], environment?: ConfigPathEnvironment): Command {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!))) {
    return { action: 'help' }
  }
  if (args.length === 1 && args[0] === '--version') {
    return { action: 'version' }
  }
  if (args.length === 2 && ['gateway', 'connector'].includes(args[0]!) && args[1] === '--help') {
    return { action: 'help' }
  }
  if (
    args.length === 3 &&
    args[0] === 'config' &&
    args[1] === 'template' &&
    (args[2] === 'gateway' || args[2] === 'connector')
  ) {
    return { action: 'template', role: args[2] }
  }
  if (args[0] === 'config' && (args[1] === 'check' || args[1] === 'check-runtime')) {
    let role: 'gateway' | 'connector' | undefined
    let explicit: string | undefined
    for (let index = 2; index < args.length; index += 2) {
      const value = args[index + 1]
      if (value === undefined) {
        throw new CliError('invalid_arguments')
      }
      if (args[index] === '--role' && role === undefined && (value === 'gateway' || value === 'connector')) {
        role = value
      } else if (args[index] === '--config' && explicit === undefined) {
        explicit = value
      } else {
        throw new CliError('invalid_arguments')
      }
    }
    return {
      action: args[1],
      checks:
        role || explicit !== undefined
          ? [{ ...(role ? { role } : {}), path: explicit ?? resolveRoleConfigPath(role!, undefined, environment) }]
          : (['gateway', 'connector'] as const).map(
              /* 无歧义地逐个选择两份用户文件，不选择任一角色作为隐式默认。 */ (selected) => ({
                role: selected,
                path: resolveRoleConfigPath(selected, undefined, environment)
              })
            )
    }
  }
  const serviceId = args.at(-2) === '--service-id' ? args.at(-1) : undefined
  const serviceArgs = serviceId !== undefined ? args.slice(0, -2) : args
  const nonInteractive = serviceArgs.at(-1) === '--non-interactive'
  if (serviceId !== undefined && (!nonInteractive || !/^[a-f0-9]{64}$/u.test(serviceId))) {
    throw new CliError('invalid_arguments')
  }
  const withoutNonInteractive = nonInteractive ? serviceArgs.slice(0, -1) : serviceArgs
  // Connector 用 --join <value> 单命令配对、--unpair 干净重置；Gateway 用 --issue-code 启动时签发一张一机一码。
  const role = withoutNonInteractive[0]
  if (role !== 'gateway' && role !== 'connector') {
    throw new CliError('invalid_arguments')
  }
  let explicit: string | undefined
  let joinValue: string | undefined
  let issueCode = false
  let unpair = false
  for (let index = 1; index < withoutNonInteractive.length; index++) {
    const option = withoutNonInteractive[index]
    if (option === '--config' && explicit === undefined) {
      explicit = withoutNonInteractive[++index]
      if (explicit === undefined || explicit.startsWith('--')) {
        throw new CliError('invalid_arguments')
      }
    } else if (option === '--join' && role === 'connector' && joinValue === undefined && !unpair) {
      joinValue = withoutNonInteractive[++index]
      if (joinValue === undefined || !/^wss?:\/\/[^#\s]+#[A-Za-z0-9_.-]+$/.test(joinValue)) {
        throw new CliError('invalid_arguments')
      }
    } else if (option === '--issue-code' && role === 'gateway' && !issueCode) {
      issueCode = true
    } else if (option === '--unpair' && role === 'connector' && !unpair && joinValue === undefined) {
      unpair = true
    } else {
      throw new CliError('invalid_arguments')
    }
  }
  return {
    action: role,
    path: resolveRoleConfigPath(role, explicit, environment),
    ...(nonInteractive ? { nonInteractive: true } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(joinValue !== undefined ? { join: joinValue } : {}),
    ...(issueCode ? { issueCode: true as const } : {}),
    ...(unpair ? { unpair: true as const } : {})
  }
}

// 等待角色结束或本地终止信号，最终释放桥接资源并传播关闭失败。
async function untilStopped(running: RunningConnector, signal: AbortSignal): Promise<void> {
  let wake!: () => void
  const stopped = new Promise<void>(
    /* 保存本地终止通知，供 AbortSignal 唤醒角色等待。 */ (resolve) => {
      wake = resolve
    }
  )
  signal.addEventListener('abort', wake, { once: true })
  try {
    if (!signal.aborted) {
      await Promise.race([running.closed, stopped])
    }
  } finally {
    signal.removeEventListener('abort', wake)
    await running.close()
  }
}

// 执行配置和角色分支；缺宿主明确拒绝，所有失败仅输出固定诊断。
export async function runCli(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime = {},
  environment?: ConfigPathEnvironment
): Promise<number> {
  try {
    if (args[0] === 'service') {
      const { handleServiceCommand } = await import('../service/command.js')
      if (args.length === 2 && args[1] === '--help') {
        io.stderr.write(cliMessages(io.language)['help.service'])
        return 0
      }
      if (!runtime.service) {
        throw new CliError('backend_unavailable', 3)
      }
      const host = runtime.service
      const code = await handleServiceCommand(args, {
        ...host,
        language: io.language ?? 'en',
        resolveDefaultConfig: host.resolveDefaultConfig
          ? /* 仅统一共享helper的明确身份缺失；其它宿主故障保留失败语义。 */ (role, account) => {
              try {
                return host.resolveDefaultConfig!(role, account)
              } catch (error) {
                if (error instanceof CliError && error.code === 'config_home_unavailable') {
                  throw new ServiceError('config_path_required')
                }
                throw error
              }
            }
          : undefined,
        diagnostic: /* 重建固定错误或监管状态，畸形code/状态不会泄露到stderr。 */ (text) =>
          io.stderr.write(serviceDiagnostic(text))
      })
      if (code !== undefined) {
        return code
      }
      throw new CliError('invalid_arguments')
    }
    if (args[0] === 'admin') {
      const { handleAdminCommand } = await import('./admin-command.js')
      return await handleAdminCommand(args, io, environment)
    }
    if (args[0] === 'doctor' || args[0] === 'storage') {
      const { handleStorageCommand } = await import('./storage-command.js')
      return await handleStorageCommand(args, io, environment)
    }
    if (args[0] === 'token') {
      const { handleTokenCommand } = await import('./token-command.js')
      return await handleTokenCommand(args, io, environment)
    }
    if (args[0] === 'config' && args[1] === 'init') {
      const { initializeRoleConfig } = await import('./config-init.js')
      initializeRoleConfig(args, environment)
      io.stderr.write('config_ready\n')
      return 0
    }
    const command = parseCommand(args, environment)
    if (command.action === 'help') {
      io.stderr.write(cliHelp(io.language))
      return 0
    }
    if (command.action === 'version') {
      io.stderr.write(`Rovloom ${PRODUCT_VERSION}\n`)
      return 0
    }
    if (command.action === 'template') {
      io.stdout.write(JSON.stringify(configDocument(configTemplate(command.role)), null, 2) + '\n')
      return 0
    }
    if ('checks' in command) {
      let code = 0
      for (const selected of command.checks) {
        const prefix = command.checks.length > 1 ? selected.role + ' ' : ''
        try {
          const config = readConfig(selected.path)
          if (selected.role && config.role !== selected.role) {
            throw new CliError('config_role_mismatch')
          }
          if (command.action === 'check-runtime') {
            readRuntimeConfig(config)
          }
          io.stderr.write(prefix + (command.action === 'check' ? 'config_valid\n' : 'runtime_config_valid\n'))
        } catch (error) {
          if (!(error instanceof CliError) || !CLI_ERROR_CODES.includes(error.code)) {
            throw error
          }
          io.stderr.write(prefix + error.code + '\n')
          code = error.exitCode
        }
      }
      return code
    }
    if (!('path' in command)) {
      throw new CliError('invalid_arguments')
    }
    let config = readOrCreateRoleConfig(command.action, command.path, environment)
    if (config.role !== command.action) {
      throw new CliError('config_role_mismatch')
    }
    if (io.signal.aborted) {
      return 0
    }
    if (command.unpair) {
      // 一次性命令：退役本地配对状态并清空地址，不进入角色启动或引导。
      const { handleConnectorUnpair } = await import('./unpair.js')
      return await handleConnectorUnpair(command.path, io)
    }
    if (!command.nonInteractive || command.join !== undefined || command.issueCode) {
      config =
        (await runtime.prepare?.(config, command.path, io, {
          ...(command.join !== undefined ? { join: command.join } : {}),
          ...(command.issueCode ? { issueCode: true as const } : {})
        })) ?? config
    }
    if (config.role !== command.action) {
      throw new CliError('config_role_mismatch')
    }
    if (config.role === 'connector') {
      if (!config.gateway_url) {
        throw new CliError('configuration_required')
      }
      if (!runtime.connector) {
        throw new CliError('backend_unavailable', 3)
      }
      await untilStopped(await runtime.connector(config), io.signal)
      return 0
    }
    if (!runtime.gateway) {
      throw new CliError('backend_unavailable', 3)
    }
    let reload = false
    let warnedWildcard = false
    let shownDashboard = false
    do {
      reload = false
      const gateway = await runtime.gateway(config)
      // 通配监听是明文 HTTP 暴露到所有网卡：提示一次，防护靠 Bearer/管理员密码与宿主机防火墙或 TLS 反代。
      if (
        !warnedWildcard &&
        (isWildcardHostname(config.mcp_hostname) ||
          (config.management_enabled && isWildcardHostname(config.management_hostname)))
      ) {
        warnedWildcard = true
        io.stderr.write(cliMessages(io.language)['run.wildcardListenWarning'])
      }
      try {
        // 只有宿主建立后才加载HTTP SDK；stdin EOF和客户端断开均不结束Gateway。
        const { startHttpFacade } = await import('../mcp/http.js')
        const http = startHttpFacade({
          service: gateway.service,
          authentication: gateway.authentication,
          hostname: config.mcp_hostname,
          port: config.mcp_port,
          ...(config.mcp_public_url ? { publicUrl: config.mcp_public_url } : {}),
          ...(config.mcp_lan ? { lan: true } : {}),
          ...(io.language ? { language: io.language } : {}),
          diagnostic: /* 只把受限诊断码写入stderr，不输出凭据、URL或协议正文。 */ (code) => io.stderr.write(code + '\n')
        })
        try {
          await gateway.listening?.(http.url)
          // 管理页地址来自宿主实际启动的listener；重载沿用同一地址，只公布一次。
          if (!shownDashboard && gateway.managementUrl) {
            shownDashboard = true
            io.stderr.write('dashboard_listening ' + new URL(gateway.managementUrl).href + '\n')
          }
          if (gateway.setupRequired) {
            io.stderr.write(
              'gateway_listening ' +
                http.url +
                '\npairing_required\n' +
                cliMessages(io.language)['run.pairingRequiredHint']
            )
          }
          await untilStopped(
            {
              closed: Promise.race([
                http.closed,
                ...(gateway.closed ? [gateway.closed] : []),
                ...(gateway.reconfigure
                  ? [
                      gateway.reconfigure.then(
                        /* 新配置提交后只唤醒本轮关闭，不复用旧provider或epoch。 */ () => {
                          reload = true
                        }
                      )
                    ]
                  : [])
              ]),
              close: http.close
            },
            io.signal
          )
        } finally {
          await http.close()
        }
      } finally {
        await gateway.close()
      }
    } while (reload && !io.signal.aborted)
    return 0
  } catch (error) {
    if (error instanceof CliCancelled && io.signal.aborted) {
      return 0
    }
    if (error instanceof CliError && CLI_ERROR_CODES.includes(error.code)) {
      // 错误只由固定代码组成，绝不打印 argv、配置内容、异常 message 或 stack。
      io.stderr.write(error.code + '\n')
      if (error.code === 'configuration_required') {
        io.stderr.write(cliMessages(io.language)['run.configurationRequiredHint'])
      }
      return error.exitCode
    }
    io.stderr.write('runtime_failed\n')
    return 1
  }
}
