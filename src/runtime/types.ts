// 定义角色宿主的稳定装配边界；配置解析、HTTP/MCP 协议与管理写服务由各自入口维护。
import type { NativeRequest } from '../contracts.js'
import type { NativeWireBackend, NativeContractRecord } from '../integration/luvus-wire.js'
import type { TrustedNativeContext } from '../native-contract/index.js'
import type { GatewayIdentitySource, CallerIdentity } from '../mcp/management.js'
import type { Principal } from '../router.js'
import type { CallAdmissionOptions, Store } from '../store.js'
import type {
  ChannelRegistry,
  SocketChannel,
  Session,
  DeviceLifecycleWiring,
  GatewayOptions,
  Connection,
  Readiness,
  WireConnectorOptions
} from '../transport/index.js'
import type { ProviderSnapshot, TerminalExecutionState } from '../wire/types.js'
import type { LuvusLocalConfig, LuvusDispatchClaims, LuvusRpcHost, LuvusNativeAuth } from '../connector/luvus/index.js'
import type { AttemptBinding, JsonObject, ProviderBinding, V2Target } from '../wire/types.js'

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
  preflightRequest?(request: JsonObject): void
}>
export type RuntimeProvider = RuntimeProviderBinding &
  Readonly<{
    contract: NativeContractRecord
    /** 本 provider 实际实现的目录；它是后端暴露面，不是 caller 权限清单。 */
    catalog_methods?: readonly string[]
    // Connector 复核本机实例；远端 Gateway 复核受保护 pin 和实际认证 epoch，不由广告 JSON 自证。
    source(binding: AttemptBinding): TrustedNativeContext | undefined
    // 目录直接绑定当前实际连接，不编造完整 attempt；旧有限 custody provider 可省略。
    catalogSource?(connection: Connection): TrustedNativeContext
    validateAttempt?: NativeWireBackend['validateAttempt']
  }>
// 受保护 pin 与当前认证 epoch 分离；此接缝不接受本机 Owner、编译句柄或原生许可的 JSON。
export type RemoteLuvusRuntimeProvider = RuntimeProviderBinding &
  Readonly<{
    remote_luvus: true
    open(
      connection: Connection,
      assertCurrent: () => void
    ): Readonly<{
      accept(snapshot: ProviderSnapshot): RuntimeProvider
      close(): void
    }>
  }>
export type RuntimeCatalogProvider = Readonly<{
  resolve(
    target: V2Target,
    principal: Principal
  ):
    | Readonly<{
        record: NativeContractRecord
        source: TrustedNativeContext
        local_provider: ProviderBinding
        expires_at: number
        supported_methods?: readonly string[]
      }>
    | undefined
}>
export type GatewayProviderServices = Readonly<{
  store: Store
  router: import('../router.js').Router
  localProvider(target: V2Target): ProviderBinding | undefined
  currentPrincipal(): string | undefined
}>
export type ProviderGatewayRuntimeOptions = Omit<GatewayRuntimeOptions, 'lifecycle' | 'providers' | 'hosted'> &
  Readonly<{
    lifecycle: Pick<DeviceLifecycleWiring, 'store' | 'identityHost'>
    providers: readonly (RuntimeProviderBinding & { max_response_bytes: number })[]
    // 异步安装在宿主准备阶段完成；这里只交付当前认证 epoch 的实际 Wire 会话。
    session(connection: Connection, channel: SocketChannel, services: GatewayProviderServices): Session
  }>
// 只交付原provider会话及其精确路由覆盖；Luvus原生注册表不放入此组。
export type GatewayHostedProviders = Pick<ProviderGatewayRuntimeOptions, 'providers' | 'session'>
export type GatewayRuntimeOptions = Readonly<{
  lifecycle: DeviceLifecycleWiring
  channels?: ChannelRegistry
  identities: GatewayIdentitySource
  providers: readonly (RuntimeProvider | RemoteLuvusRuntimeProvider)[]
  hosted?: readonly GatewayHostedProviders[]
  listener: Pick<GatewayOptions, 'hostname' | 'port' | 'developmentLoopback' | 'limits' | 'offer' | 'setupRequest'>
  // 仅在显式关闭角色时释放所交付的 Store/身份库；HTTP 客户端断开不调用此端口。
  release(): Promise<void>
}>
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
export type ConnectorRuntimeOptions = Readonly<{
  transport: Omit<WireConnectorOptions, 'session'>
  // 生产来源可交付固定实测快照；能力仅按双方 offer 协商，不给旧本机模式补造广告。
  provider_snapshot?: true
  // 来源被后台替换（用户的 Luvus 重启/重建）后结束当前连接周期，使下一个认证 epoch 取到新实例。
  session_replaced?(listener: () => void): () => void
  // 每个 epoch 使用独立 backend；来源由可信宿主提供，不重复打开 Gateway writer。
  session(connection: Connection): Readonly<{
    backend: NativeWireBackend
    // 当前宿主只接已验证 IPC；CLI proxy 需要另行交付可信归属，不能借 verifyPeer 放行。
    config: LuvusLocalConfig & { readonly transport: 'ipc' }
    claims: LuvusDispatchClaims
    verifyPeer: NonNullable<LuvusRpcHost['verifyPeer']>
    // 本机受保护配置的同步读取器；省略时使用本 epoch 固定的本地显式开关。
    terminalExecution?: LuvusRpcHost['terminalExecution']
    // 固定 dedup 截止必须来自受保护准入记录；不得按重连时间重新计算。
    dedupExpires(binding: Parameters<LuvusRpcHost['claimDispatch']>[0]): number
    // 独立验证同一 socket 的实测证据后才可认证或登记 claim。
    assertEvidence: (
      binding: Parameters<LuvusRpcHost['claimDispatch']>[0],
      evidence: Parameters<LuvusRpcHost['claimDispatch']>[1]
    ) => void
    readiness(): Readiness
    providerSnapshot?(): readonly ProviderSnapshot[]
    /** 与同一执行端guard共用的本地开关观察值，不包含路径或秘密。 */
    terminalExecutionState?(): readonly TerminalExecutionState[]
    close(): void
    // 当前只支持官方本机 Owner 认证；peer 与 socket 证据由宿主另行核验。
    authentication: 'local_owner'
    nativeAuth(
      binding: AttemptBinding,
      evidence: Parameters<LuvusRpcHost['claimDispatch']>[1]
    ): LuvusNativeAuth | Promise<LuvusNativeAuth>
  }>
  // 停止重连和全部 epoch 资源之后释放长期 claims/custody；不能清除墓碑或自动撤销原生工作。
  release(): Promise<void>
}>
export type GatewayState = Readonly<{ store: Store; lifecycle: DeviceLifecycleWiring }>
