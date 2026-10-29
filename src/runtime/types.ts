// 定义角色宿主的稳定装配边界；配置解析、HTTP/MCP 协议与管理写服务由各自入口维护。
import type { NativeRequest } from '../contracts.js'
import type { GatewayIdentitySource, CallerIdentity } from '../mcp/management.js'
import type { Principal } from '../router.js'
import type { CallAdmission, CallAdmissionOptions, Store } from '../store.js'
import type { ResponseEvidencePlan } from '../wire/evidence.js'
import type {
  ChannelRegistry,
  SocketChannel,
  Session,
  DeviceLifecycleWiring,
  GatewayOptions,
  Connection
} from '../transport/index.js'
import type { JsonObject, ProviderBinding, V2Target } from '../wire/types.js'

export type ProviderIdentity = Readonly<{
  binding: ProviderBinding
  target: V2Target
  // 就绪由各 provider 的受保护实际来源重新核对，不能由设备认证或广告建立。
  ready(): boolean
}>
/** 只交付本次已认证目标的登记能力；provider 不能改 caller、目标或绕过 Router 授权。 */
export type RegisterProviderCall = (
  options: CallAdmissionOptions,
  check: (request: JsonObject) => void
) => CallAdmission
/** Provider 完整履行准入与证据保留，公共宿主不猜默认策略或解释协议字段。 */
export type GatewayProviderPort = ProviderIdentity &
  Readonly<{
    admit(request: NativeRequest, options: CallAdmissionOptions, register: RegisterProviderCall): CallAdmission
    retainEvidence(plan: ResponseEvidencePlan): ResponseEvidencePlan
  }>
export type GatewayProviderServices = Readonly<{
  store: Store
  router: import('../router.js').Router
  localProvider(target: V2Target): ProviderBinding | undefined
  currentPrincipal(): string | undefined
}>
/** 每个 provider 交付已审会话；混合角色复用同一生命周期和调度。 */
export type ProviderGatewayRuntimeOptions = Readonly<{
  lifecycle: Pick<DeviceLifecycleWiring, 'store' | 'identityHost'>
  channels?: ChannelRegistry
  identities: GatewayIdentitySource
  providers: readonly GatewayProviderPort[]
  session(connection: Connection, channel: SocketChannel, services: GatewayProviderServices): Session
  hosted?: readonly GatewayHostedProviders[]
  provider_snapshot_machines?: readonly string[]
  listener: Pick<GatewayOptions, 'hostname' | 'port' | 'developmentLoopback' | 'limits' | 'offer' | 'setupRequest'>
  release(): Promise<void>
}>
export type GatewayHostedProviders = Pick<ProviderGatewayRuntimeOptions, 'providers' | 'session'>
export type RuntimeAdmissionOptions = CallAdmissionOptions
export type RuntimeCallInput = Readonly<{
  target: V2Target
  native_request: NativeRequest
  options: RuntimeAdmissionOptions
}>
export type AuthenticatedRuntimeOperation<T> = () => T | Promise<T>
export type TrustedRequestScope = {
  // 仅供完成认证的 HTTP/stdio adapter 使用；每次操作重新解析当前 principal，JSON 参数不得调用。
  runAuthenticated<T>(caller: CallerIdentity, operation: AuthenticatedRuntimeOperation<T>): Promise<T>
  // 当前请求之外、已结束的异步工作和开始关闭后均拒绝；不会记住最近 caller。
  principal(): Principal
}
