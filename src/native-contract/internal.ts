// 维护原生校验器的内部句柄登记、可撤销许可分组与最小响应约束，阻止同形消息伪造校验能力。
import type { ValidateFunction } from 'ajv'
import type {
  CapabilityView,
  CheckedRequest,
  CompiledContract,
  JsonObject,
  Limits,
  MethodDescriptor,
  RawRequestCandidate,
  NativeBinding,
  ResponseOnlyContext
} from './types.js'

export const UHP = 'https://luvus.dev/protocol/uhp/v1/'
export const SCOPES = new Set(['read', 'workspace', 'agent', 'terminal', 'orchestration', 'extensions', 'admin'])
export type ContractData = {
  limits: Limits
  validators: Map<string, ValidateFunction>
  requestMethods: readonly string[]
  branches: Map<string, readonly string[]>
  // 只用于 describe 的原始已核验 schema；首次读取后以文档缓存替代原文本，不参与执行授权。
  schemaSource: string
  schemaDocuments?: ReadonlyMap<string, unknown>
}
export type ViewData = {
  contract: CompiledContract
  capabilities: JsonObject
  methods: Map<string, MethodDescriptor>
}
export type CandidateData = {
  view: CapabilityView
  descriptor: MethodDescriptor
}
// WeakMap 防止从 JSON 伪造 handle；来源仍按各 handle 的 contract/binding 核对。
export const contracts = new WeakMap<CompiledContract, ContractData>()
export const views = new WeakMap<CapabilityView, ViewData>()
export const candidates = new WeakMap<CheckedRequest | RawRequestCandidate, CandidateData>()

// 结果匹配所需的最小字段；封存时另行限制身份值的类型和编码大小。
export type ResponseRules = {
  terminal: boolean
  bind_native_identity: boolean
  expected_type?: string
  identities: JsonObject
}
export type ResponseContextData = {
  contract: CompiledContract
  binding: NativeBinding
  native_id: string
  method: string
  frame_bytes: number | null
  rules: ResponseRules
}
// 仅保存编译契约及复制的响应约束，不保留 candidate、permit、request 或 capabilities 引用。
export const responseContexts = new WeakMap<ResponseOnlyContext, ResponseContextData>()
