// 把 CLI 的首次引导接到唯一运行时：Connector 的 --join 单命令配对与 Gateway 的 --issue-code 签发都在这里进入。
import type { RoleConfig } from './config.js'
import type { CliIo, CliPrepareOptions, RunningConnector } from './run.js'
import { joinConnector } from './join-connector.js'
import { appendNativeProviders } from './provider-append.js'
import type { AppendOutcome } from './provider-append.js'
import { loadCredential } from '../transport/credentials.js'
import { runtimeReference } from './runtime-files.js'
import { CliError, type ConnectorConfig, type NativeProviderKind } from './config.js'
import { silentConsole } from './setup-console.js'
import { cliMessages, formatMessage } from './messages.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import { HerdrLocalError } from '../connector/herdr/local.js'
import { boundedDisconnect } from '../transport/disconnect.js'

/** 计数与事件游标仅接受非负安全整数，不把宿主异常值打印到诊断。 */
function observationCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

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

  /**
   * 启动时追加 `native.provider` 点名但没配对过的来源：用本机设备凭据自动登记，失败非致命。
   * 打印只含 kind 与固定码，不含路径、异常文本或凭据。
   */
  async appendProviders(config: ConnectorConfig, kinds: readonly NativeProviderKind[]): Promise<AppendOutcome> {
    const io = this.#io
    if (!io || kinds.length === 0) {
      return Object.freeze({ appended: Object.freeze([]), failed: Object.freeze([]) })
    }
    let outcome: AppendOutcome
    try {
      const credential = loadCredential(runtimeReference(config.state_dir, 'device'))
      outcome = await appendNativeProviders({
        config,
        kinds,
        credential,
        console: silentConsole(io),
        signal: io.signal
      })
    } catch (error) {
      // 只投影固定码；其它异常统一成 append_internal，不带异常文本。
      const code =
        error instanceof CliError && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
          ? error.code
          : 'append_internal'
      outcome = Object.freeze({
        appended: Object.freeze([]),
        failed: Object.freeze(kinds.map((kind) => Object.freeze({ kind, code })))
      })
    }
    const messages = cliMessages(io.language)
    if (outcome.appended.length) {
      io.stderr.write(formatMessage(messages['run.nativeProviderAppended'], { kinds: outcome.appended.join(', ') }))
    }
    for (const failure of outcome.failed) {
      io.stderr.write(
        formatMessage(messages['run.nativeProviderAppendFailed'], { kind: failure.kind, code: failure.code })
      )
    }
    return outcome
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

  /** 后台维护失败只报告固定码；后续小时自动重试，不把私有状态打印出来。 */
  schemaCleanupDeferred(): void {
    this.#io?.stderr.write('schema_cleanup_deferred\n')
  }

  // 仅观察正式Connector持有的transport，不认证HTTP、不创建新epoch、不根据静态配置自报ready。
  observe(running: RunningConnector): void {
    if (!running.transport) {
      return
    }
    let previous = ''
    let observationUnavailable = false
    const unavailable = () => {
      previous = ''
      if (observationUnavailable) {
        return
      }
      observationUnavailable = true
      try {
        this.#io?.stderr.write('connector_observation unavailable\n')
      } catch {
        // 诊断端口故障不得让定时回调抛出，也不能输出底层异常正文。
      }
    }
    // 同步建立订阅基线；之后首个采样窗口里的事件也属于新事件。
    let observedChanges: number | undefined
    try {
      const initial = running.transport.status()
      observedChanges = observationCount(initial.disconnect_change_sequence)
    } catch {
      // 首次状态取样失败（降级宿主可能抛 provider limit 等）不能静默废掉整个观察：
      // 继续采样，改由首个成功的取样建立基线并输出首条相位行。
      observedChanges = undefined
      unavailable()
    }
    this.#observation = setInterval(
      /* 状态变化才输出固定阶段、布尔值与已知容量；断开与订正按独立事件序号补报，不输出凭据、epoch或原生正文。 */ () => {
        try {
          const status = running.transport!.status()
          const ready = status.providers.some(
            /* 采用原transport已经核验的当前provider就绪值。 */ (provider) => provider.ready
          )
          // 先取基线再判增量：采样相位与断开时刻无关，窗口内完成的断开/重连不会丢。
          const changeSequence = observationCount(status.disconnect_change_sequence)
          if (changeSequence !== undefined && Array.isArray(status.disconnect_changes)) {
            for (const change of status.disconnect_changes.slice(-16)) {
              const sequence = observationCount(change?.sequence)
              if (
                sequence === undefined ||
                observedChanges === undefined ||
                sequence <= observedChanges ||
                sequence > changeSequence ||
                typeof change.correction !== 'boolean'
              ) {
                continue
              }
              const disconnect = boundedDisconnect(change.observation)
              if (!disconnect) {
                continue
              }
              this.#io?.stderr.write(
                (change.correction ? 'connector_disconnect_update' : 'connector_disconnect') +
                  (disconnect.code === undefined ? '' : ' code=' + String(disconnect.code)) +
                  ' close_reason=' +
                  disconnect.reason +
                  '\n'
              )
            }
            observedChanges = Math.max(observedChanges ?? changeSequence, changeSequence)
          }
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
          observationUnavailable = false
        } catch {
          unavailable()
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
