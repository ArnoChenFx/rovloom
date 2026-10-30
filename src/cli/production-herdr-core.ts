/**
 * 唯一 CLI 的 herdr-core 生产来源：只交付中性端口资源（Gateway 侧 Wire 会话、准入与证据保留）。
 * 本阶段不启动或附着 core 进程，也不交付 Connector 执行端口：Connector 选择 herdr-core 会明确
 * backend_unavailable，而不是给一个不执行的会话。
 */
import { createHerdrCoreGatewayResources, parseHerdrCoreProviderRefConfig } from '../connector/herdr-core/provider.js'
import { boundedJson, fields, object, parseJson } from '../wire/index.js'
import { CliError } from './config.js'
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
      return createHerdrCoreGatewayResources({ config: reference(references) })
    }
    // 故意不提供 connector：本阶段没有 herdr-core 的原生执行端口，选择它必须失败而不是空转。
  })
}
