/**
 * 唯一 CLI 的 herdr-core 生产来源：Gateway 交付中性端口资源（Wire 会话、准入与证据保留）；
 * Connector 只附着本机已在运行的 core，按内核 peer 与 /proc 事实核对身份后执行已开放的 5 个读取。
 * 不启动、停止或接管 core 进程。
 */
import { createHerdrCoreConnectorResources } from '../connector/herdr-core/connector.js'
import { createHerdrCoreGatewayResources, parseHerdrCoreProviderRefConfig } from '../connector/herdr-core/provider.js'
import { boundedJson, fields, object, parseJson } from '../wire/index.js'
import { resolveTerminalExecution } from '../connector/terminal-execution.js'
import { findHerdrCoreBinary, herdrCoreManagedDirs } from '../connector/herdr-core/managed.js'
import { CliError, herdrCoreConfigHome, herdrCoreMode, herdrCoreSession } from './config.js'
import type { ProductionCliSources, ProductionProviderReference } from './production.js'

/** 只复制受保护引用；JSON 只能选择已登记 kind，不能构造契约、身份或原生连接。 */
function reference(input: readonly ProductionProviderReference[]) {
  try {
    if (input.length !== 1) {
      throw new CliError('invalid_config')
    }
    const entry = object(parseJson(boundedJson(input[0], 65_536)))
    fields(entry, ['reference', 'value'])
    const value = object(entry.value)
    fields(value, ['kind', 'config'], ['native'])
    if (value.kind !== 'herdr-core') {
      throw new CliError('invalid_config')
    }
    const config = parseHerdrCoreProviderRefConfig(value.config)
    if (config.config_ref !== entry.reference) {
      throw new CliError('invalid_config')
    }
    return config
  } catch {
    throw new CliError('invalid_config')
  }
}

/** 由唯一 loader 在认证与设备凭据前置校验后调用；本模块不创建身份或凭据。 */
export function createHerdrCoreProductionSources(): ProductionCliSources {
  return Object.freeze({
    /** Gateway 侧：端口层资源交付描述、目录、Wire 会话、身份核对与释放。 */
    async gateway(_config, references) {
      const resources = await createHerdrCoreGatewayResources({ config: reference(references) })
      const binding = resources.providers[0]!.binding
      return {
        ...resources,
        /** 运行时建立后晚绑定本机开关；绑定前控制档一律拒绝。 */
        started(gateway) {
          const lookup = 'terminalExecutionState' in gateway ? gateway.terminalExecutionState.bind(gateway) : undefined
          resources.bindTerminalExecution(lookup ? () => lookup(binding) : () => false)
        }
      }
    },
    /** Connector 侧只交付附着执行端；端点、会话与摘要都在本地受保护配置里。 */
    async connector(config, references) {
      const managed =
        herdrCoreMode(config) === 'managed'
          ? {
              dirs: herdrCoreManagedDirs({
                state_dir: config.state_dir,
                session: herdrCoreSession(config),
                ...(herdrCoreConfigHome(config) === undefined ? {} : { config_home: herdrCoreConfigHome(config)! })
              }),
              // 只把显式配置的目录交给发现逻辑；省略时它按 PATH 找。
              binary: findHerdrCoreBinary(
                config.native?.runtime_bin_dirs ? { runtime_bin_dirs: [...config.native.runtime_bin_dirs] } : {}
              ),
              ...(config.native?.agent_bin_dirs ? { agent_bin_dirs: [...config.native.agent_bin_dirs] } : {})
            }
          : undefined
      return createHerdrCoreConnectorResources({
        config: reference(references),
        now: Date.now,
        // 本机开关只来自 Connector 自己的配置；目录、Gateway 登记与最终写入共用这个观察值。
        allow_terminal_execution: resolveTerminalExecution(config.allow_terminal_execution),
        /** 与 Herdr 附着路径相同的固定标记，e2e 与运维都按它判断崩溃后的接管。 */
        claims_lock_recovered: () => {
          process.stderr.write('claims_lock_recovered\n')
        },
        ...(managed ? { managed } : {})
      })
    }
  })
}
