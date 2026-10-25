// 把 CLI 的首次引导接到唯一运行时：Connector 的 --join 单命令配对与 Gateway 的 --issue-code 签发都在这里进入。
import type { RoleConfig } from './config.js'
import type { CliIo, CliPrepareOptions, RunningConnector } from './run.js'
import { joinConnector } from './join-connector.js'
import { cliMessages, formatMessage } from './messages.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import { HerdrLocalError } from '../connector/herdr/local.js'

export class CliSetup {
  #io: CliIo | undefined
  #issueCode = false
  #issued = false
  #observation: ReturnType<typeof setInterval> | undefined

  // 仅角色命令在读到实际用户文件后调用；join 是唯一的首配路径，普通启动不需要本地终端。
  async prepare(config: RoleConfig, path: string, io: CliIo, options?: CliPrepareOptions): Promise<RoleConfig> {
    // 两个角色都记录 io：Connector 的 observe（connector_transport/provider_ready）也经它输出。
    this.#io = io
    if (config.role === 'connector') {
      if (options?.join !== undefined) {
        const joined = await joinConnector(config, path, io, options.join)
        io.stderr.write('\n')
        return joined
      }
      // 已配对设备的日常启动：配对状态由运行时装配校验，CLI 不再问答。
      return config
    }
    this.#issueCode = options?.issueCode === true
    return config
  }

  // Gateway 真实监听后按需签发一张一机一码并打印完整加入命令；每次进程只打印一次，重载不重复签发。
  async gatewayListening(issue: () => Promise<string | undefined>): Promise<void> {
    const io = this.#io
    if (!io || !this.#issueCode || this.#issued || io.signal.aborted) {
      return
    }
    const value = await issue()
    if (value !== undefined) {
      this.#issued = true
      io.stderr.write(
        formatMessage(cliMessages(io.language)['setup.gateway.joinCommandBlock'], {
          command: 'rovloom connector --join ' + value
        })
      )
    }
  }

  // 原生失败只交付现有适配器的有界固定代码；不打印child输出、异常message/stack、路径或请求。
  nativeFailed(error: unknown): void {
    if ((error instanceof LuvusAdapterError || error instanceof HerdrLocalError) && /^[a-z_]{1,80}$/.test(error.code)) {
      this.#io?.stderr.write('native_unavailable ' + error.code + '\n')
    }
  }

  // 仅观察正式Connector持有的transport，不认证HTTP、不创建新epoch、不根据静态配置自报ready。
  observe(running: RunningConnector): void {
    if (!running.transport) {
      return
    }
    let previous = ''
    this.#observation = setInterval(
      /* 状态变化才输出固定阶段和布尔值，不输出设备凭据、epoch或原生正文。 */ () => {
        try {
          const status = running.transport!.status()
          const ready = status.providers.some(
            /* 采用原transport已经核验的当前provider就绪值。 */ (provider) => provider.ready
          )
          const current = status.phase + ':' + ready + ':' + (status.failure ?? '')
          if (current !== previous) {
            previous = current
            this.#io?.stderr.write(
              'connector_transport ' +
                status.phase +
                ' provider_ready=' +
                String(ready) +
                (status.capacity
                  ? ' capacity=' + status.capacity.resource + ' reclaim_at=' + String(status.capacity.reclaim_at)
                  : '') +
                (status.failure ? ' reason=' + status.failure : '') +
                '\n'
            )
          }
        } catch {
          clearInterval(this.#observation)
          this.#observation = undefined
        }
      },
      250
    )
    void running.closed.then(
      /* 原owner结束即停止观察，不延长其生命周期。 */ () => {
        clearInterval(this.#observation)
        this.#observation = undefined
      },
      /* 只停止观察，原close/closed仍交付相同失败。 */ () => {
        clearInterval(this.#observation)
        this.#observation = undefined
      }
    )
  }

  // 主进程所有退出路径清理观察计时器。
  close(): void {
    clearInterval(this.#observation)
    this.#observation = undefined
    this.#io = undefined
  }
}
