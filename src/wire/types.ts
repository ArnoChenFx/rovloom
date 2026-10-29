// 定义独立的 Wire v2 消息、调用身份、provider 权限及原生校验接口类型。
export type JsonObject = Record<string, unknown>
export type Direction = 'gateway_to_connector' | 'connector_to_gateway'
export type ProviderKind = 'luvus' | 'herdr'
// Wire v2 隔离类型，不扩展尚待统一迁移的公共 contracts.Target。
export type V2Target = { machine_id: string; provider_id: string } & (
  | { profile: 'session'; session: string }
  | { profile: 'host'; session?: never }
)
export type ProviderBinding = {
  machine_id: string
  provider_id: string
  kind: ProviderKind
  config_ref: string
  binding_revision: number
  enabled: boolean
}
export type ContractSource = {
  provider_kind: ProviderKind
  protocol_family: 'uhp' | 'herdr-json'
  binary_version: string
  binary_sha256: string
  schema_sha256: string
  schema_origin: 'installed_cli'
  schema_command: 'luvus uhp schema' | 'herdr api schema --json'
  server_version: string | null
  native_protocol_version: string | null
  runtime_generation: string | null
  adapter_revision: string
  classification_revision: string | null
  support_basis: 'live_catalog' | 'schema_and_version'
}
export type ContractRecord = { source: ContractSource; support_status: 'candidate' | 'validated' }
export type Capability =
  | 'rpc'
  | 'provider_fence'
  | 'dispatch_refusal'
  | 'provider_snapshot'
  | 'terminal_execution_state'
  | 'late_evidence'
  | 'device_platform'
  | 'host_profile'
  | 'host_cpu_quota'
export type VersionOffer = {
  major: number
  minor: number
  capabilities: string[]
  required: string[]
}
export type Negotiated = { major: number; minor: number; capabilities: Capability[] }
export type ConnectionIdentity = {
  machine_id: string
  recovery_generation: string
  connection_epoch: string
}
export type AttemptRegistration = {
  deadline: number
  caller_policy_revision?: string
  local_policy_revision?: string
}
export type AttemptIdentity = {
  call_id: string
  attempt_id: string
  native_request_id: string
  target: V2Target
  provider_kind: ProviderKind
  binding_revision: number
  contract_ref: string
  registration: AttemptRegistration
}
export type AttemptBinding = ConnectionIdentity & AttemptIdentity
export type ValidationMode = 'strict' | 'raw-contract'
export type NativeValidationContext = {
  binding: AttemptBinding
  mode: ValidationMode
  method: string
}
export type ResolvedAttempt = NativeValidationContext
export interface NativePayloadValidator {
  validateRequest(request: JsonObject, context: NativeValidationContext): void
  validateResponse(response: JsonObject, context: NativeValidationContext): void
}
export type RequestPayload = {
  attempt: AttemptIdentity
  expected_binding_revision: number
  native_request: JsonObject
  validation: ValidationMode
}
export type DispatchRefusalCode = 'terminal_execution_disabled'
export type TerminalExecutionState = Readonly<{ binding: ProviderBinding; enabled: boolean }>
/** 设备最近一次上报的平台；distribution 只在 Linux 且 os-release 可读时出现。 */
export type DevicePlatformPayload = Readonly<{
  os: 'linux' | 'darwin' | 'win32'
  arch: 'x64' | 'arm64'
  distribution: Readonly<{ id: string; version_id: string | null }> | null
}>
/** 连接时采集的最小主机信息，不含网络、路径、用户、环境或工具清单。 */
export type HostProfileReport = Readonly<{
  os: Readonly<{ family: 'linux' | 'darwin' | 'win32'; distribution: string | null; kernel: string | null }>
  arch: 'x86_64' | 'aarch64'
  /** os.cpus().length 的系统可见逻辑 CPU 数量；不是物理核数或容器 CPU 配额。 */
  cpus: number | null
  /** 可见 cgroup 层级中的最紧 CPU 带宽上界；须结合 status，null 不能单独解释为未限额。 */
  cpu_quota?: number | null
  cpu_quota_status?: 'limited' | 'unlimited' | 'unknown' | 'partial' | 'unsupported'
  memory_bytes: number | null
  container: 'docker' | 'podman' | 'none' | 'unknown'
  agent_version: string
  providers: readonly Readonly<{ provider_id: string; native_version: string | null }>[]
}>
/** reported_at 由 Gateway 在接收该认证帧时记下，不信任远端时钟，也不在读取时刷新。 */
export type HostProfile = HostProfileReport & Readonly<{ reported_at: number; source: 'connector_handshake' }>
export type Payloads = {
  provider_fenced: { binding: ProviderBinding }
  terminal_execution_state: TerminalExecutionState
  device_platform: DevicePlatformPayload
  host_profile: HostProfileReport
  provider_snapshot: {
    binding: ProviderBinding
    target: V2Target
    source: ContractSource
    capabilities: JsonObject
    capability_revision: string
  }
  request: RequestPayload
  accepted: { attempt: AttemptIdentity }
  dispatch_refused: { attempt: AttemptIdentity; code: DispatchRefusalCode }
  response: { attempt: AttemptIdentity; native_response: JsonObject }
  cancel: { attempt: AttemptIdentity; reason: 'caller_cancelled' | 'deadline_exceeded' }
  heartbeat: { sequence: number }
  error: WireErrorPayload
}
/** 同一认证 epoch 的单 provider 来源快照；不包含 schema、原生凭据或任何执行许可。 */
export type ProviderSnapshot = Payloads['provider_snapshot']
export type WireErrorPayload = {
  source: 'gateway' | 'transport'
  code: string
  retryable: boolean
  cause_message_id?: string
}
type Base<K extends string, P> = {
  protocol_major: number
  protocol_minor: number
  type: K
  message_id: string
  payload: P
}
export type AuthenticatedEnvelope = {
  [K in keyof Payloads]: Base<K, Payloads[K]> & ConnectionIdentity
}[keyof Payloads]
export type PreAuthEnvelope =
  | Base<
      'enroll',
      {
        registration_id: string
        connector_instance_id: string
        enrollment_credential: string
        offer: VersionOffer
      }
    >
  | Base<
      'authenticate',
      {
        machine_id: string
        recovery_generation: string
        connector_instance_id: string
        device_credential: string
        offer: VersionOffer
      }
    >
  | Base<'welcome', ConnectionIdentity & { in_reply_to: string; selected: Negotiated }>
  | Base<'error', WireErrorPayload>
export type WireEnvelope = PreAuthEnvelope | AuthenticatedEnvelope
export type AuthenticatedContext = {
  phase: 'authenticated'
  direction: Direction
  // 外部认证事实，不是 codec 产生的认证证明。
  connection: ConnectionIdentity & { authenticated: true; active: true; negotiated: Negotiated }
  resolveProvider?: (target: V2Target) => ProviderBinding | undefined
  resolveContract?: (contract_ref: string) => ContractRecord | undefined
  validators?: Partial<Record<ProviderKind, NativePayloadValidator>>
  resolveAttempt?: (attempt: AttemptIdentity) => ResolvedAttempt | undefined
}
export type CodecContext =
  | { phase: 'preauth'; direction: Direction; offer?: VersionOffer; handshake_message_id?: string }
  | AuthenticatedContext
