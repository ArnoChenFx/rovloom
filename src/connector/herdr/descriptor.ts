/**
 * Herdr TUI 的 provider 中性端口描述：档位只从现有已审核表派生，
 * 不新增方法、不放宽参数规则，也不把「读取」一律当作观察档。
 */
import type { ProviderDescriptor, ProviderMethodTier } from '../../runtime/provider-port.js'
import { requiresTerminalExecution } from '../terminal-execution.js'
import { HERDR_RESPONSE_TYPES } from './methods.js'
import { HERDR_READONLY_REVIEW } from './review.js'

/** 目录里只有原生方法名可直接映射；参数敏感方法的具体请求仍由预检复核。 */
function tier(method: string): ProviderMethodTier {
  if (method === 'ping') {
    // 协议探测只返回值与有限能力，不触发终端状态变化。
    return 'observe'
  }
  // 直接终端输入与可启动程序的方法属于控制档；其它已接入方法按 ADR 0004 只到有条件的观察。
  return requiresTerminalExecution('herdr', method, {}) ? 'control' : 'conditional'
}

export const HERDR_PROVIDER_DESCRIPTOR: ProviderDescriptor = Object.freeze({
  kind: 'herdr',
  protocol_family: 'herdr-json',
  methods: Object.freeze(
    Object.fromEntries(
      /** 方法集合就是已接入的普通 RPC 表，不从发布的 schema 枚举开放。 */ Object.keys(HERDR_RESPONSE_TYPES).map(
        (method) => [method, tier(method)]
      )
    )
  ),
  guarantees: HERDR_READONLY_REVIEW.guarantees
})
