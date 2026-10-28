// 定义当前 Luvus 原生契约、宿主可信来源、校验证明、派发许可及仅响应上下文的类型边界。
import type { Target } from '../../../contracts.js'
import type { Check, JsonFailure, JsonObject } from '../../../json/bounds.js'

export type { Check, Json, JsonObject } from '../../../json/bounds.js'
export type NativeContractFailure = JsonFailure
export type ContractIdentity = Readonly<{
  binary_sha256: string
  schema_sha256: string
  revision: string
}>
export type NativeBinding = Readonly<{
  kind: 'luvus'
  provider_id: string
  binding_revision: string | number
  contract_source_ref: string
  target: Target
  server_generation: string | null
  connection_epoch: string
  recovery_generation: string
  capability_revision: string
  caller_policy_revision?: string
  local_policy_revision?: string
  classification_revision: string
  contract: ContractIdentity
}>
// 这是受信调用方提供的证明输入；本模块不执行 socket、TLS 或身份认证。
export type TrustedNativeContext = Readonly<{
  binding: NativeBinding
  authenticated: boolean
  source_verified: boolean
}>
export type Limits = Readonly<{
  object_bytes: number
  object_depth: number
  object_nodes: number
  bundle_bytes: number
  bundle_nodes: number
  documents: number
  document_bytes: number
  references: number
  reference_depth: number
  terminal_frame_bytes: number
}>
export type CompileOptions = Readonly<{
  identity: ContractIdentity
  limits?: Partial<Limits>
}>
export type ParameterValidation = 'schema' | 'generic' | 'unavailable'
export type SchemaStatus = 'conditional_branch' | 'generic_params_only' | 'unavailable'
export type NativeTransport = 'single_request_rpc' | 'host_stdio_proxy'
export type NativeMethodContract = Readonly<{
  method: string
  access: 'read' | 'write'
  scope: string
  idempotent: boolean
}>
export type MethodDescriptor = Readonly<{
  method: string
  profile: 'session' | 'host'
  transport: NativeTransport | 'unclassified'
  schema_status: SchemaStatus
  branch_paths: readonly string[]
  native_contract: NativeMethodContract
}>
// handle 仅由内存工厂建立；反序列化的同形对象不能用作校验或派发凭证。
export type CompiledContract = Readonly<{
  identity: ContractIdentity
  documents: readonly string[]
}>
export type CapabilityView = Readonly<{
  binding: NativeBinding
  methods: readonly MethodDescriptor[]
}>
export type CheckedRequest = Readonly<{
  kind: 'request'
  request: JsonObject
  binding: NativeBinding
  method: string
  validation: 'schema' | 'generic'
  schema_status: SchemaStatus
}>
export type RawRequestCandidate = Readonly<{
  kind: 'raw_request'
  request: JsonObject
  binding: NativeBinding
  method: string
  validation: 'unavailable'
  schema_status: 'unavailable'
}>
export type DispatchCandidate = CheckedRequest | RawRequestCandidate
export type CheckedResponse = Readonly<{
  response: JsonObject
  identity: ContractIdentity
  bound: boolean
}>

export type DispatchAuthorization = Readonly<{
  source: TrustedNativeContext
  principal_id: string
  mode: 'strict' | 'raw_contract'
  now: number
}>
// 一次派发授权的结果：携带通过门禁的候选与授权主体，供响应校验、封存和结果读取复核使用。
export type DispatchPermit = Readonly<{
  kind: 'permit'
  candidate: DispatchCandidate
  principal_id: string
  binding: NativeBinding
  method: string
  mode: 'strict' | 'raw_contract'
  validation: ParameterValidation
}>
// 只能由真实 RPC permit 封存；独立 WeakMap 校验，不能用于派发或读取原文。
// retained_bytes 是封存元数据按契约身份编码后的 JSON 字节数，不代表共享编译状态或堆内存大小。
export type ResponseOnlyContext = Readonly<{ kind: 'response_context'; retained_bytes: number }>
export type ResultAuthorization = Readonly<{
  principal_id: string
  content_status: 'available' | 'expired' | 'discarded'
}>

export interface NativeValidator {
  // 已知方法检查完整根、未知方法只检查 raw 最小信封；不创建能力视图、候选、来源或许可。
  checkRequestShape(request: unknown): Check<void>
  // 只校验能力响应、目录和预期目标身份，不认证来源或创建能力/响应句柄。
  checkCapabilitiesShape(input: unknown, expected: Pick<NativeBinding, 'target' | 'server_generation'>): Check<void>
  // 把独立验证的原生来源与能力广告绑定为当前契约的内存视图。
  bindCapabilities(response: unknown, source: TrustedNativeContext): Check<CapabilityView>
  // 返回能力视图中的方法描述，描述信息本身不授予执行权限。
  describe(view: CapabilityView, method: string): Check<MethodDescriptor>
  // 按现行参数 schema 校验请求，保留 schema/generic 覆盖状态供派发门禁判断。
  checkRequest(view: CapabilityView, request: unknown): Check<CheckedRequest>
  // 允许未收录方法产生 unavailable 候选，已有 schema/generic 结果不降级，raw 授权另过门禁。
  checkRawRequest(view: CapabilityView, request: unknown): Check<CheckedRequest | RawRequestCandidate>
  // 只校验指定响应族的结构，不声称其已与请求、许可或原生来源绑定。
  checkResponseShape(response: unknown, family?: 'general' | 'terminal'): Check<CheckedResponse>
  // 复核原请求上下文、来源、在线帧预算及结果约束。
  checkResponse(
    context: CheckedRequest | DispatchPermit,
    response: unknown,
    source: TrustedNativeContext
  ): Check<CheckedResponse>
  // 从真实非流 RPC 许可封存最小响应约束，身份值或总编码大小超限即失败，不能从 JSON 重建。
  sealResponseContext(permit: DispatchPermit): Check<ResponseOnlyContext>
  // 用密封元数据校验迟到响应并仅返回校验结论，不产生读取或派发能力。
  checkResponseOnly(context: ResponseOnlyContext, response: unknown, source: TrustedNativeContext): Check<void>
  // 删除密封响应句柄的私有登记，使其不能继续验证迟到响应。
  releaseResponseContext(context: ResponseOnlyContext): Check<void>
}
