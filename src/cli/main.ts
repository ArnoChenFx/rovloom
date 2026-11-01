#!/usr/bin/env bun
// 提供同一产物的双角色命令入口，将进程信号接到本地桥接关闭并设置退出码。
import './startup-directory.js'
import './runtime-guard.js'
import { parseCommand, runCli } from './run.js'
import { createProductServiceHost } from './service-host.js'
import { resolveCliLanguage } from './messages.js'
import { openStopPipe, windowsStopPipe } from '../service/windows-control.js'
import { realpathSync } from 'node:fs'
import type { CliRuntime } from './run.js'

const stop = new AbortController()
const onSignal = /* 将进程终止信号转换为前端关闭请求，不直接取消原生工作。 */ () => stop.abort()
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
// 锁定Bun把Windows控制台关闭映射为SIGHUP；也接入原Abort，服务停止另由登记专用管道交付。
if (process.platform === 'win32') {
  process.once('SIGHUP', onSignal)
}
let runtime: CliRuntime | undefined
let setup: import('./setup-runtime.js').CliSetup | undefined
let closeControl: (() => Promise<void>) | undefined
// 只有正常角色启动才绑定本地控制端口；离线命令和服务控制不创建端口或读取另一份配置。
async function control(role: 'gateway' | 'connector'): Promise<void> {
  if (process.platform !== 'win32' || closeControl) {
    return
  }
  const command = parseCommand(process.argv.slice(2))
  if ((command.action === 'gateway' || command.action === 'connector') && command.serviceId) {
    closeControl = await openStopPipe(
      windowsStopPipe(role, realpathSync(process.execPath), command.path, command.serviceId),
      onSignal
    )
  }
}
// 仅角色命令加载真实静态工厂和TTY引导；同一进程复用本机确认对象，重开不重复签发。
async function product(): Promise<CliRuntime> {
  if (!runtime) {
    const { createProductSources } = await import('./product-sources.js')
    const { CliSetup } = await import('./setup-runtime.js')
    setup = new CliSetup()
    runtime = (await import('./production.js')).createProductionCliRuntime(createProductSources(), setup)
  }
  return runtime
}
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      signal: stop.signal,
      // 语言在入口按环境解析一次；后续所有输出只读此字段，不再各自读取进程环境。
      language: resolveCliLanguage(process.env)
    },
    {
      // 只有显式服务动作才装配控制器；构造不授权、不读写注册或配置。
      ...(process.argv[2] === 'service' && process.argv[3] !== '--help' ? { service: createProductServiceHost() } : {}),
      prepare: /* CLI解析及真实配置核验后才准备当前角色，不影响help/check模板。 */ async (config, path, io, options) =>
        (await product()).prepare!(config, path, io, options),
      gateway: /* 只有角色启动才加载静态工厂；help/version/template保持离线且不打开状态。 */ async (config) => {
        await control('gateway')
        return (await product()).gateway!(config)
      },
      connector: /* 真实provider负责既有配置与资源，CLI不提供native成功替身。 */ async (config) => {
        await control('connector')
        const running = await (await product()).connector!(config)
        setup?.observe(running)
        return running
      }
    }
  )
} finally {
  setup?.close()
  try {
    await closeControl?.()
  } catch {
    process.stderr.write('runtime_failed\n')
    process.exitCode = 1
  }
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  if (process.platform === 'win32') {
    process.off('SIGHUP', onSignal)
  }
}
