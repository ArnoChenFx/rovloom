// 定义只供可信宿主消费的 transport 观测；快照不提供管理权限、原生状态或可执行的连接 fence。
import type { HostProfile } from '../wire/types.js'
export type MachineObservationRequest = Readonly<{ machine_ids: readonly string[]; include_host: boolean }>
export type MachineMetadataObservation = Readonly<{
  machine_id: string
  platform: string | null
  last_seen_at: number
  link_since?: number
  host?: HostProfile
}>
export type TransportObserved<T> =
  | Readonly<{
      verification: 'verified'
      observed_at: number
      source: 'gateway_transport'
      value: T
    }>
  | Readonly<{
      verification: 'unverified'
      reason_code: 'backend_unavailable' | 'not_recorded' | 'stale'
    }>

export type GatewayTransportSnapshot = Readonly<{
  observed_at: number
  recovery_generation: string
  transport: TransportObserved<'available' | 'unavailable'>
  /** 仅在宿主明确请求已授权范围时提供；不与当前连接列表混淆，列表采样不复制完整 host。 */
  machine_metadata?: readonly MachineMetadataObservation[]
  devices: readonly Readonly<{
    machine_id: string
    connection: TransportObserved<
      Readonly<{ state: 'online'; connection_epoch_ref: string; last_heartbeat_at: number | null }>
    >
    authentication: TransportObserved<Readonly<{ state: 'authenticated'; last_failure: null }>>
    providers: readonly Readonly<{
      provider_id: string
      binding_revision: number
      dispatch_ready: TransportObserved<boolean>
    }>[]
  }>[]
}>

export interface GatewayTransportObservationSource {
  /** 重新核对该 Gateway 实际连接与当前可信事实；没有对应来源的字段不由持久状态补齐。 */
  readonly snapshot: (metadata?: MachineObservationRequest) => GatewayTransportSnapshot
}
