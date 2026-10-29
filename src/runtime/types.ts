// 定义角色宿主的稳定装配边界；配置解析、HTTP/MCP 协议与管理写服务由各自入口维护。
import type { NativeRequest } from '../contracts.js'
import type { GatewayIdentitySource, CallerIdentity } from '../mcp/management.js'
import type { Principal } from '../router.js'
import type { CallAdmissionOptions, Store } from '../store.js'
import type {
  ChannelRegistry,
  SocketChannel,
  Session,
  DeviceLifecycleWiring,
  GatewayOptions,
  Connection
} from '../transport/index.js'
import type { JsonObject, ProviderBinding, V2Target } from '../wire/types.js'

export type RuntimeProviderBinding = Readonly<{
  binding: ProviderBinding
  target: V2Target
  // 来自独立受保护设备配置的预期政策修订，不从本机政策复制或设备广告自证。
  peer_policy_revision?: string
  // 就绪由各 provider 的受保护实际来源重新核对，不能由设备认证或广告建立。
  ready(): boolean
  // 旧 Luvus 入口固定为 1MiB；中性入口必须显式提供此预算。
  max_response_bytes?: number
  // 配对时批准的实测来源所对应的契约引用；存在时，准入只接受带此引用的调用，任何版本的 provider 都以其批准的实测契约为准。
  contract_ref?: string
  // 可选原生完整根预检只验证登记候选，不创建 permit；接收 Store 本次真实 native request ID。
  preflightRequest?(request: JsonObject, options?: CallAdmissionOptions): void
  admissionOptions?(request: NativeRequest, options: CallAdmissionOptions): CallAdmissionOptions
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
  providers: readonly (RuntimeProviderBinding & { max_response_bytes: number })[]
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
