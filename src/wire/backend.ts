// 定义 provider 中性的原生校验/持久化后端接缝；不承载任何 Luvus/UHP 专属语义。
import type { NativeBinding, TrustedNativeContext } from '../connector/luvus/contract/index.js'
import type { LedgerInvalidation } from '../storage/model.js'
import type { ResponseAnchor } from './evidence.js'
import type {
  AttemptBinding,
  AuthenticatedContext,
  ContractRecord,
  JsonObject,
  ProviderBinding,
  V2Target
} from './types.js'

export type TrustedAttempt = {
  binding: AttemptBinding
  principal_id: string
  method: string
  mode: 'strict' | 'raw-contract'
  native_request: JsonObject
}

export type NativeContractRecord = {
  wire: ContractRecord
  compiled: import('../connector/luvus/contract/index.js').CompiledContract
  capabilities: unknown
  capability_revision: string
}

// 仅由宿主认证、双端配置及账本实现。这里没有默认授权、设备广告或从消息导入上下文的工厂。
// persistence 模块只提供持久化事实；当前认证、配置与原生来源仍必须由宿主独立实现。
export interface NativeWireBackend {
  // 取得宿主已认证连接，调用方仍须核对当前 epoch 与恢复 generation。
  connection(): AuthenticatedContext['connection']
  // 按调用与尝试 ID 查询仍有请求原文的可信账本记录。
  attempt(callId: string, attemptId: string): TrustedAttempt | undefined
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
  // 取得当前结果读取方身份，避免借用原调用者的派发许可。
  currentPrincipal(): string | undefined
  // 返回宿主可信时钟，用于不可延长的期限检查。
  now(): number
  // 查询调用原文的可见状态，过期或删除后不能由派发许可恢复。
  contentStatus(binding: AttemptBinding): 'available' | 'expired' | 'discarded' | 'unavailable'
  // 只查询原派发锚点及固定保留期限，不取回请求或响应正文。
  responseAnchor?(binding: AttemptBinding): ResponseAnchor | undefined
  // 订阅已提交的内容回收、绑定失效及关闭通知，返回取消订阅入口。
  subscribeInvalidation?(listener: (event: LedgerInvalidation) => void): () => void
}
