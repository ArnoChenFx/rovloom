/** Luvus 装配只交付已核验来源与私有 Wire 接缝；公共 runtime 不解释这些类型。 */
import type { NativeWireBackend, NativeContractRecord } from '../backend.js'
import type { TrustedNativeContext } from '../contract/index.js'
import type { LuvusLocalConfig, DispatchClaims, LuvusRpcHost, LuvusNativeAuth } from '../index.js'
import type { ProviderIdentity, GatewayHostedProviders } from '../../../runtime/types.js'
import type { CallAdmissionOptions } from '../../../store.js'
import type { JsonObject } from '../../../wire/types.js'
import type { GatewayIdentitySource } from '../../../mcp/management.js'
import type { Principal } from '../../../router.js'
import type {
  DeviceLifecycleWiring,
  ChannelRegistry,
  GatewayOptions,
  Connection,
  Readiness,
  WireConnectorOptions
} from '../../../transport/index.js'
import type {
  ProviderSnapshot,
  TerminalExecutionState,
  AttemptBinding,
  ProviderBinding,
  V2Target
} from '../../../wire/types.js'
/** Luvus 自己的契约检查接缝；不作为公共 Gateway 端口。 */
type LuvusProviderBinding = ProviderIdentity &
  Readonly<{
    contract_ref?: string
    preflightRequest?(request: JsonObject, options?: CallAdmissionOptions): void
  }>
export type RuntimeProvider = LuvusProviderBinding &
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
export type RemoteLuvusRuntimeProvider = LuvusProviderBinding &
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
/** 本机 Luvus 目录端口：只交付 provider 自己的原生事实，公共门禁与分页由 MCP 层统一处理。 */
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
    claims: DispatchClaims
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
