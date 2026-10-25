/** MCP/CLI 与 WebUI 共用的管理契约；类型按管理面提供方维护，不实现身份或后台服务。 */
import type { Principal } from '../router.js'
import type { CallState } from '../contracts.js'

export type CallerIdentity = Readonly<{ principal_id: string }>
export type Page<T> = { items: T[]; next_cursor?: string }
export type AdminPage = { cursor?: string; limit?: number }
export type ResourceTarget = { machine_id: string; provider_id?: string }
export type ProviderView = {
  machine_id: string
  provider_id: string
  kind: 'luvus' | 'herdr'
  binding_revision: number
  enabled: boolean
  readiness: 'unavailable' | 'unverified' | 'ready'
}
export type ManagementPermission =
  | 'gateway_read'
  | 'devices_read'
  | 'devices_register'
  | 'devices_rename'
  | 'devices_disconnect'
  | 'devices_revoke'
  | 'providers_read'
  | 'providers_manage'
  | 'permissions_read'
  | 'calls_read'
export type ManagementGrant =
  | { action: 'gateway_read' | 'devices_register' }
  | {
      action:
        | 'devices_read'
        | 'devices_rename'
        | 'devices_disconnect'
        | 'devices_revoke'
        | 'permissions_read'
        | 'calls_read'
      machine_id: string
    }
  | { action: 'providers_read' | 'providers_manage'; machine_id: string; provider_id: string }
export type Administrator = {
  principal_id: string
  session_ref: string
  assurance: 'administrator'
  policy_revision: string
  grants: readonly ManagementGrant[]
}
export interface GatewayIdentitySource {
  /** 从同一身份/政策后端重新解析现有 Principal，失效返回 null。 */
  principal(caller: CallerIdentity): Principal | null
  /** 验证独立管理员会话及当前资源授权，设备/MCP 身份不能替代。 */
  administrator(caller: CallerIdentity, sessionRef: string): Administrator | null
}
export type AdminContext = Readonly<{
  caller: CallerIdentity
  /** 仅由管理认证中间件注入，不属于浏览器请求体。 */
  management_session_ref: string
  wait_signal: AbortSignal
}>
export type GatewayMode = 'active' | 'storage_degraded'
export type Observed<T> =
  | {
      verification: 'verified'
      observed_at: number
      source: 'store' | 'gateway_transport' | 'native_adapter'
      value: T
    }
  | { verification: 'unverified'; reason_code: 'backend_unavailable' | 'not_recorded' | 'stale' }
export type DeviceSnapshot = {
  machine_id: string
  name: string
  labels: readonly string[] | null
  persisted_state: 'pending' | 'offline' | 'online' | 'revoked'
  resource_revision: number | null
  observed_at: number
  connection: Observed<{
    state: 'connecting' | 'reconnecting' | 'online' | 'degraded' | 'offline'
    connection_epoch_ref: string | null
    last_heartbeat_at: number | null
  }>
  authentication: Observed<{
    state: 'pending' | 'authenticated' | 'failed' | 'expired' | 'revoked'
    last_failure: {
      reason_code:
        | 'auth_failed'
        | 'credential_expired'
        | 'heartbeat_timeout'
        | 'protocol_error'
        | 'connection_closed'
        | 'binding_mismatch'
      occurred_at: number
    } | null
  }>
}
export type ProviderSnapshot = ProviderView & {
  config_ref: string | null
  observed_at: number
  runtime: Observed<{
    state: 'ready' | 'unreachable' | 'binding_mismatch' | 'migration_unresolved'
    contract_ref: string | null
    binary_sha256: string | null
    schema_sha256: string | null
    classification_revision: string | null
    supported_transports: readonly 'rpc'[]
  }>
}
export type ManagementStatus = {
  server_time: number
  observed_at: number
  mode: GatewayMode
  recovery_generation: string
  policy_revision: string
  refresh_after_ms: 5000
  stale_after_ms: 15000
  history: { history_epoch: string; accept_new_until: number } | null
  components: {
    store: 'available' | 'degraded'
    transport: 'available' | 'degraded' | 'unavailable' | 'unverified'
    native: 'available' | 'degraded' | 'unavailable' | 'unverified'
  }
}
export type PermissionDecision = {
  action: ManagementPermission
  allowed: boolean
  reason_code: 'allowed' | 'forbidden' | 'backend_unavailable' | 'storage_degraded'
}
/**
 * 管理面调用记录投影：只含账本元数据与调用方已提交的命令名，
 * 不含请求正文、响应正文、凭据或原生会话引用。
 */
export type CallSummary = {
  call_id: string
  principal: string
  machine_id: string
  provider_id: string
  provider_kind: 'luvus' | 'herdr'
  method: string
  state: CallState
  /** 派发尝试是否已登记；不证明原生已接收或执行，原始 epoch 引用不离开账本。 */
  dispatched: boolean
  /** 目标只保留 profile 与调用方声明的 session 名，不含原生句柄或凭据。 */
  target: { profile: 'session' | 'host'; session: string | null }
  /** 已落盘响应类别；未响应或原文不可用时为 null。 */
  outcome: 'result' | 'error' | null
  created_at: number
  deadline: number
  /** 账本内容保留状态；不授予管理员正文读取权限，到期或丢弃后不复活原文。 */
  content_status: 'available' | 'expired' | 'discarded' | 'unavailable'
}
/** 单次采样内的分布统计，覆盖当前授权设备范围，不受分页影响。 */
export type CallAggregate = {
  total: number
  by_state: readonly { state: CallState; count: number }[]
  by_provider: readonly { machine_id: string; provider_id: string; kind: 'luvus' | 'herdr'; count: number }[]
  by_principal: readonly { principal: string; count: number }[]
  by_method: readonly { method: string; count: number }[]
}
export type CallWindow = {
  /** 统计窗口起点；更早的调用已不在窗口内或已被清理。 */
  since: number
  /** 窗口中最早与最晚一条调用的登记时间；窗口为空时为 null。 */
  first_at: number | null
  last_at: number | null
  /** 实际纳入统计的行数，与 `sampled` 一起说明是否为窗口全量。 */
  sampled: number
  /** 窗口内行数超过单次采样上限；列表仍可分页，但统计只覆盖采样的最新部分。 */
  truncated: boolean
}
export type CallListReply = Page<CallSummary> & {
  observed_at: number
  aggregate: CallAggregate
  window: CallWindow
}
export type CallListArguments = AdminPage & {
  /** 可选设备范围；缺省覆盖当前管理员全部 devices_read 授权。 */
  machine_id?: string
  states?: readonly CallState[]
}
export type PermissionSnapshot = {
  target: ResourceTarget
  principal_id: string
  policy_revision: string
  caller_policy_revision: string
  local_policy_revision: string | null
  recovery_generation: string
  observed_at: number
  expires_at: number
  decisions: readonly PermissionDecision[]
}
export type ManagementAction =
  | 'device_rename'
  | 'pairing_create'
  | 'pairing_cancel'
  | 'pairing_claim_approve'
  | 'device_disconnect'
  | 'device_revoke'
  | 'provider_disable'
  | 'provider_enable'
export type ManagementIntent =
  | { action: 'device_rename'; target: { machine_id: string }; name: string }
  | { action: 'pairing_create'; target: { name: string; policy_ref: string; labels: readonly string[] } }
  | { action: 'pairing_create'; target: { machine_id: string; policy_ref: string } }
  | { action: 'pairing_cancel'; target: { machine_id: string; pairing_id: string } }
  | {
      action: 'pairing_claim_approve'
      target: { machine_id: string; pairing_id: string; claim_id: string; user_code: string }
    }
  | { action: 'device_disconnect'; target: { machine_id: string }; expected_connection_epoch: string }
  | { action: 'device_revoke'; target: { machine_id: string } }
  | {
      action: 'provider_disable' | 'provider_enable'
      target: { machine_id: string; provider_id: string; kind: 'luvus' | 'herdr' }
      expected_binding_revision: number
    }
export type IntentFence = { recovery_generation: string; expected_revision: number; reason: string }
export type ConfirmationDraft = ManagementIntent & IntentFence & { request_id: string; history_epoch: string }
export type ConfirmationView = {
  /** 撤销影响的当前实例摘要；不含config路径或秘密，资源变化使确认失效。 */
  affected_providers?: readonly {
    provider_id: string
    kind: 'luvus' | 'herdr'
    binding_revision: number
    enabled: boolean
  }[]
  confirmation_id: string
  state: 'pending' | 'confirmed' | 'consumed' | 'expired'
  operation_digest: string
  summary: ManagementIntent & IntentFence
  expires_at: number
}
export type ManagementWrite = IntentFence & { request_id: string; history_epoch: string; confirmation_id: string }
export type OperationReceipt = {
  request_id: string
  history_epoch: string
  recovery_generation: string
  operation_digest: string
  action: ManagementAction
  target: ResourceTarget | { pairing_id: string }
  operation_state: 'committed' | 'not_committed' | 'outcome_unknown'
  new_revision: number | null
  new_binding_revision: number | null
  observed_at: number
  audit_event_ids: readonly string[]
  evidence: 'current_durable' | 'backup_history'
  effects: {
    persistent_authorization: 'unchanged' | 'revoked' | 'unconfirmed'
    channel: 'unchanged' | 'disconnected' | 'unconfirmed'
    provider: 'unchanged' | 'disabled' | 'enabled' | 'unconfirmed'
    native_work: 'may_continue'
  }
}
export type ManagementArguments = {
  history_open: Record<string, never>
  write_state_get: ResourceTarget
  pairings_get: { machine_id: string; pairing_id: string }
  devices_rename: ManagementWrite & { machine_id: string; name: string }
  status: Record<string, never>
  devices_list: AdminPage & { states?: readonly DeviceSnapshot['persisted_state'][] }
  devices_get: { machine_id: string }
  providers_list: AdminPage & { machine_id: string }
  providers_get: { machine_id: string; provider_id: string }
  permissions_get: ResourceTarget
  calls_list: CallListArguments
  operations_get: { request_id: string; history_epoch: string; recovery_generation: string }
  confirmations_create: ConfirmationDraft
  confirmations_confirm: ManagementWrite & { operation_digest: string }
  pairings_create: ManagementWrite &
    (
      | { name: string; policy_ref: string; labels: readonly string[]; machine_id?: never }
      | { machine_id: string; policy_ref: string; name?: never; labels?: never }
    )
  pairings_cancel: ManagementWrite & { machine_id: string; pairing_id: string }
  pairings_claim_approve: ManagementWrite & {
    machine_id: string
    pairing_id: string
    claim_id: string
    user_code: string
  }
  devices_disconnect: ManagementWrite & { machine_id: string; expected_connection_epoch: string }
  devices_revoke: ManagementWrite & { machine_id: string }
  providers_disable: ManagementWrite & {
    machine_id: string
    provider_id: string
    kind: 'luvus' | 'herdr'
    expected_binding_revision: number
  }
  providers_enable: ManagementArguments['providers_disable']
}
export type ManagementReply = {
  history_open: { history_epoch: string; recovery_generation: string; accept_new_until: number }
  write_state_get: {
    target: ResourceTarget
    resource_revision: number
    recovery_generation: string
    connection_epoch: string | null
    binding_revision: number | null
  }
  pairings_get: {
    machine_id: string
    pairing_id: string
    status: 'pending' | 'paired' | 'cancelled' | 'expired' | 'failed'
    expires_at: number
    issuance: 'issued' | 'unissued'
    requires_local_issuance: false
    claim?: {
      claim_id: string
      user_code: string
      status: 'pending' | 'approved' | 'delivered' | 'activated' | 'failed' | 'cancelled'
      expires_at: number
      // 在线原生激活已完成时出现；值只表示网关侧已按批准策略落盘并定义 provider。
      activation?: 'configured'
    }
  }
  devices_rename: OperationReceipt
  status: ManagementStatus
  devices_list: Page<DeviceSnapshot>
  devices_get: DeviceSnapshot
  providers_list: Page<ProviderSnapshot>
  providers_get: ProviderSnapshot
  permissions_get: PermissionSnapshot
  calls_list: CallListReply
  operations_get: OperationReceipt
  confirmations_create: ConfirmationView
  confirmations_confirm: ConfirmationView
  pairings_create: OperationReceipt & {
    machine_id: string
    pairing_id: string
    status: 'pending'
    expires_at: number
    requires_local_issuance: false
  }
  pairings_cancel: OperationReceipt
  pairings_claim_approve: OperationReceipt & {
    machine_id: string
    pairing_id: string
    claim_id: string
    status: 'approved'
  }
  devices_disconnect: OperationReceipt
  devices_revoke: OperationReceipt
  providers_disable: OperationReceipt
  providers_enable: OperationReceipt
}
export type ManagementOperation = keyof ManagementArguments
export interface GatewayManagementService {
  /** 每次重新认证授权；失败抛固定公共错误，不自动重放写入。 */
  execute<K extends ManagementOperation>(
    name: K,
    args: ManagementArguments[K],
    context: AdminContext
  ): Promise<ManagementReply[K]>
}
