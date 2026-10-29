/** Luvus/UHP 契约及独立实证接缝。 */
import type { NativeBinding, TrustedNativeContext, CompiledContract } from './contract/index.js'
import type { AttemptBackend } from '../../wire/backend.js'
import type { TrustedAttempt } from '../../wire/backend.js'
import type { AuthenticatedContext, ContractRecord, ProviderBinding, V2Target } from '../../wire/types.js'
export type NativeContractRecord = {
  wire: ContractRecord
  compiled: CompiledContract
  capabilities: unknown
  capability_revision: string
}

// 仅由宿主认证、双端配置及账本实现。这里没有默认授权、设备广告或从消息导入上下文的工厂。
// persistence 模块只提供持久化事实；当前认证、配置与原生来源仍必须由宿主独立实现。
export interface NativeWireBackend extends AttemptBackend {
  // 取得宿主已认证连接，调用方仍须核对当前 epoch 与恢复 generation。
  connection(): AuthenticatedContext['connection']
  // 查询网关登记的目标 provider 绑定及其当前 revision。
  provider(target: V2Target): ProviderBinding | undefined
  // 查询连接器本机配置，用于与网关 provider 绑定逐项核对。
  localProvider(target: V2Target): ProviderBinding | undefined
  // 按固定引用查找 Wire 来源、离线编译契约及当前能力广告。
  contract(ref: string): NativeContractRecord | undefined
  // 独立核验指定尝试所连接的原生 endpoint 和身份。
  nativeSource(callId: string, attemptId: string): TrustedNativeContext | undefined
  // 可选的 provider 参数与来源预检；不承担 caller/local 方法授权。
  validateAttempt?(attempt: TrustedAttempt, binding: NativeBinding): void
}

/** Luvus Connector 的完整来源端口。 */
export type LuvusConnectorAdmissionSource = Pick<
  NativeWireBackend,
  'provider' | 'localProvider' | 'contract' | 'nativeSource' | 'validateAttempt' | 'now'
>
