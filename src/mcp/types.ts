// 定义 MCP 与 CLI 宿主共享的参数、公开 DTO、受信 caller 和服务拒绝契约，不发行身份或权限。
import type { JsonObject, ProviderKind, V2Target, ValidationMode } from '../wire/types.js'
import type { CallerIdentity, Page, ProviderView } from './management.js'
export type { CallerIdentity, Page, ProviderView } from './management.js'

export type PageArguments = { cursor?: string; limit?: number }
export type TargetArguments = { target: V2Target; expected_binding_revision: number }
export type ToolArguments = {
  machines_list: PageArguments
  machines_get: { machine_id: string; name?: never } | { name: string; machine_id?: never }
  providers_list: PageArguments & { machine_id: string }
  providers_get: { machine_id: string; provider_id: string }
  runtime_discover: TargetArguments & PageArguments
  runtime_describe: TargetArguments & { method: string }
  runtime_call: TargetArguments & {
    contract_ref: string
    native_request: { method: string; params?: unknown }
    deadline: number
    wait_ms?: number
    validation?: ValidationMode
    client_request_key?: string
  }
  runtime_call_get: { call_id: string; wait_ms?: number }
  runtime_call_cancel: { call_id: string }
  runtime_result_read: { result_id: string; cursor?: string; max_bytes?: number }
  runtime_response_discard: { call_id: string }
}
export type ToolName = keyof ToolArguments

export type MachineView = {
  machine_id: string
  name: string
  status: 'pending' | 'active' | 'revoked'
  link: 'offline' | 'unverified' | 'connected' | 'ready'
  // 当前调用方在该设备上被授权的完整 target；runtime_* 工具必须原样回传其中之一。
  targets: TargetView[]
}
// 只描述调用方已获授权的完整 tuple，让 runtime_* 的 target 参数可以原样回传，不必猜 session 名。
export type TargetView = V2Target
export type CallView = JsonObject & {
  call_id: string
  target: V2Target
  provider_kind: ProviderKind
  binding_revision: number
  contract_ref: string | null
  state: string
  delivery: string
  content_status: string
}
export type ReplyData = {
  machines_list: Page<MachineView>
  machines_get: MachineView
  providers_list: Page<ProviderView>
  providers_get: ProviderView
  runtime_discover: Page<JsonObject>
  runtime_describe: JsonObject
  runtime_call: CallView
  runtime_call_get: CallView
  runtime_call_cancel: {
    call_id: string
    cancellation: 'waiting_stopped' | 'bridge_stopped' | 'native_confirmed' | 'unsupported' | 'outcome_unknown'
  }
  runtime_result_read: {
    result_id: string
    chunk: string
    encoding: 'utf8' | 'base64'
    // 本页字节本身是合法 UTF-8 时额外给出的文本形式，与 chunk 的 base64 解码逐字节一致；页边界切开多字节字符时不提供，整页回复超 MCP 字节预算时由门面省略，调用方用 chunk 还原。
    text?: string
    next_cursor?: string
    eof: boolean
    total_bytes: number
    sha256: string
    expires_at: number
  }
  runtime_response_discard: { call_id: string; content_status: 'discarded' }
}

export type ServiceContext = Readonly<{
  caller: CallerIdentity
  // 只结束前端等待；不能将它连接到原生执行的取消或重试。
  wait_signal: AbortSignal
}>
// HTTP认证宿主逐请求建立上下文；arguments、_meta、sessionID及本机UID均不能建立远程身份。
export interface McpContextProvider {
  // 组合本请求和SDK取消信号，只结束前端等待；缺少当前认证上下文返回null。
  resolve(signal: AbortSignal): ServiceContext | null | Promise<ServiceContext | null>
}
export type ServiceReply<K extends ToolName> = { data: ReplyData[K]; is_error?: boolean }

// 实现者负责完整 provider Target 的当前双端 ACL、管理权限、确认、读取/保留门禁和持久事务。
// execute 每次只调用一次；history/cursor 必须绑定 caller、查询范围和持久历史，不能由 facade 补造。
export interface GatewayService {
  // 执行当前授权与持久化门禁后返回可公开数据；每次请求只处理一次，不在此接口隐式重试。
  execute<K extends ToolName>(name: K, args: ToolArguments[K], context: ServiceContext): Promise<ServiceReply<K>>
}

export const SERVICE_ERROR_CODES = [
  'backend_unavailable',
  'invalid_arguments',
  'native_request_invalid',
  'internal_error',
  'unauthenticated',
  'forbidden',
  'unavailable',
  'not_found',
  'conflict',
  'invalid_cursor',
  'binding_revision_conflict',
  'contract_unavailable',
  'unsupported',
  'confirmation_required',
  'storage_exhausted',
  'storage_degraded',
  'content_unavailable',
  'deadline_exceeded',
  'busy'
] as const
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number]
export class FacadeServiceError extends Error {
  // 保存允许公开的服务拒绝码，固定异常文本以免泄露后端详情。
  constructor(readonly code: ServiceErrorCode) {
    super('Gateway service rejected the request')
    this.name = 'FacadeServiceError'
  }
}

export class NativeRequestNotDispatchedError extends FacadeServiceError {
  readonly outcome = 'not_dispatched' as const

  /** 仅投影已完成登记前拒绝的固定结果，不把普通后端异常声明为未派发。 */
  constructor() {
    super('native_request_invalid')
  }
}
