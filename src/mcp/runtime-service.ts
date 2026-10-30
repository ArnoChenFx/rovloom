// 将MCP动作投影到既有常驻宿主；准入、取消和原Wire结果门禁均复用同一运行实例。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { GatewayError } from '../contracts.js'
import { WireError } from '../wire/index.js'
import { ProviderAdapterError } from '../connector/provider-error.js'
import { NativeRequestPreflightError } from '../connector/preflight.js'
import type { createProviderGatewayRuntime } from '../runtime/gateway.js'
import type { Store } from '../store.js'
import { StoreGatewayService, type StoreGatewayOptions } from './store-service.js'
import { isToolName, parseToolArguments } from './schema.js'
import { callRefusalReason, publicCallView } from './call-view.js'
import {
  FacadeServiceError,
  NativeRequestNotDispatchedError,
  SERVICE_ERROR_CODES,
  type CallView,
  type GatewayService,
  type ReplyData,
  type ServiceContext,
  type ServiceErrorCode,
  type ServiceReply,
  type ToolArguments,
  type ToolName
} from './types.js'

export type RuntimeGateway = Awaited<ReturnType<typeof createProviderGatewayRuntime>>
export type RuntimeGatewayPort = Pick<
  RuntimeGateway,
  'router' | 'principal' | 'runAuthenticated' | 'admit' | 'get' | 'cancel' | 'results' | 'targets'
> & {
  store: Store
  terminalExecutionState?: RuntimeGateway['terminalExecutionState']
  refusalReason?: RuntimeGateway['refusalReason']
}
export type RuntimeGatewayServiceOptions = Omit<StoreGatewayOptions, 'store' | 'router' | 'targets'> & {
  runtime: RuntimeGatewayPort
}
type Request = { [K in ToolName]: { name: K; args: ToolArguments[K] } }[ToolName]
const errors: Record<string, ServiceErrorCode> = {
  runtime_closed: 'unavailable',
  machine_offline: 'unavailable',
  connection_unavailable: 'unavailable',
  provider_binding_mismatch: 'binding_revision_conflict',
  call_not_found: 'not_found',
  request_key_conflict: 'conflict',
  result_not_found: 'content_unavailable',
  result_not_ready: 'content_unavailable',
  result_quota: 'storage_exhausted',
  result_context_unavailable: 'content_unavailable',
  result_retention_context_unavailable: 'content_unavailable',
  discard_forbidden: 'forbidden',
  clock_untrusted: 'storage_degraded',
  // herdr-core 的固定拒绝码只投影为稳定的公开码，不把原生方法表或参数规则带到 MCP。
  herdr_core_method_unavailable: 'not_found',
  runtime_method_unavailable: 'not_found',
  herdr_core_param_blocked: 'native_request_invalid',
  herdr_core_read_history_unsupported: 'native_request_invalid',
  herdr_core_native_request_invalid: 'native_request_invalid',
  herdr_core_timeout_invalid: 'invalid_arguments',
  herdr_core_timeout_exceeds_limit: 'invalid_arguments',
  // 控制档的栅栏与参数规则同样只投影为固定公开码，不把原生方法表带到 MCP。
  herdr_core_terminal_fence_required: 'native_request_invalid',
  herdr_core_terminal_fence_invalid: 'native_request_invalid',
  herdr_core_terminal_address_unsupported: 'native_request_invalid',
  herdr_core_force_unsupported: 'native_request_invalid',
  herdr_core_text_too_large: 'native_request_invalid',
  herdr_core_param_invalid: 'native_request_invalid',
  herdr_core_parent_unsupported: 'native_request_invalid',
  herdr_core_template_required: 'native_request_invalid',
  herdr_core_read_history_exceeds_limit: 'native_request_invalid',
  herdr_core_template_unavailable: 'not_found',
  herdr_core_template_ambiguous: 'native_request_invalid',
  herdr_core_run_capacity: 'busy',
  herdr_core_terminal_blocked: 'unavailable',
  herdr_core_terminal_identity_mismatch: 'conflict',
  herdr_core_terminal_unavailable: 'unavailable',
  herdr_core_connection_closed: 'unavailable',
  herdr_core_contract_unavailable: 'contract_unavailable',
  // 本机直接终端输入开关关闭：Gateway 在登记前拒绝，公开码只说明本机策略不允许。
  terminal_execution_disabled: 'forbidden'
}

// 只映射受信错误类中的固定公共码，未知原生异常及code不进入MCP诊断。
function publicError(error: unknown): FacadeServiceError {
  if (error instanceof NativeRequestPreflightError) {
    return new NativeRequestNotDispatchedError(error.parameterDiagnostic)
  }
  if (error instanceof FacadeServiceError && SERVICE_ERROR_CODES.includes(error.code)) {
    return error
  }
  if (error instanceof GatewayError || error instanceof WireError || error instanceof ProviderAdapterError) {
    if (SERVICE_ERROR_CODES.includes(error.code as ServiceErrorCode)) {
      return new FacadeServiceError(error.code as ServiceErrorCode)
    }
    if (Object.hasOwn(errors, error.code)) {
      return new FacadeServiceError(errors[error.code]!)
    }
  }
  return new FacadeServiceError('internal_error')
}

export class RuntimeGatewayService implements GatewayService {
  readonly management: StoreGatewayService['management']
  private readonly reads: StoreGatewayService
  private readonly cursorKey = randomBytes(32)
  private closed = false

  // 同一宿主已拥有Store/Router，查询服务不再创建第二个writer或transport。
  constructor(private readonly options: RuntimeGatewayServiceOptions) {
    this.reads = new StoreGatewayService({
      ...options,
      store: options.runtime.store,
      targets: options.runtime.targets,
      router: options.runtime.router,
      terminalExecutionState: options.terminalExecutionState ?? options.runtime.terminalExecutionState
    })
    this.management = this.reads.management
  }

  // 显式关闭销毁门面游标签名密钥，底层资源仍由角色宿主按顺序释放。
  close(): void {
    this.closed = true
    this.cursorKey.fill(0)
    this.reads.close()
  }

  // 每次操作核对等待和真实身份；终止等待不能进入runtime.cancel。
  private current(context: ServiceContext): string {
    if (this.closed || context.wait_signal.aborted) {
      throw new FacadeServiceError('unavailable')
    }
    return this.options.runtime.principal().id
  }

  // 短等复用既有查询实现；正文仅打开原Wire许可保护的真实结果句柄，不直接读取call.response。
  private async callView(callId: string, wait: number | undefined, context: ServiceContext): Promise<CallView> {
    await this.reads.execute(
      'runtime_call_get',
      { call_id: callId, ...(wait === undefined ? {} : { wait_ms: wait }) },
      context
    )
    this.current(context)
    const runtime = this.options.runtime
    const call = runtime.get(callId)
    let view = publicCallView(call, callRefusalReason(runtime.refusalReason?.(callId)))
    view.contract_ref = runtime.store.callContractRef(runtime.principal().id, callId)
    if (call.state === 'responded' && call.content_status === 'available') {
      try {
        const result = runtime.results.open(callId)
        view.result = {
          result_id: result.result_id,
          bytes: result.bytes,
          sha256: result.hash,
          expires_at: result.expires
        }
        view.content_delivery = 'result_handle'
      } catch (error) {
        // 句柄配额/正文门禁失败不能抹掉已登记call_id；重新授权元数据，不借此交付任何正文。
        await this.reads.execute('runtime_call_get', { call_id: callId }, context)
        this.current(context)
        view = publicCallView(runtime.get(callId))
        view.content_reason_code = publicError(error).code
      }
    }
    this.current(context)
    return view
  }

  // 完整绑定当前主体、结果、页大小、偏移与固定期限；只签名服务产生的位置，不承担读取授权。
  private cursorTag(caller: string, result: string, bytes: number, offset: number, expires: number): string {
    return createHmac('sha256', this.cursorKey)
      .update(JSON.stringify([caller, result, bytes, offset, expires]))
      .digest('base64url')
  }

  // 无状态游标不占逐页名额；同一游标重试生成同一后继，所有后继沿用首次下载期限并重新验权。
  private readResult(
    args: ToolArguments['runtime_result_read'],
    context: ServiceContext
  ): ReplyData['runtime_result_read'] {
    const runtime = this.options.runtime
    const caller = this.current(context)
    const now = runtime.store.clock()
    const bytes = args.max_bytes ?? 4096
    let offset = 0
    let expires = now + 30_000
    if (args.cursor) {
      const parts = /^result_v1\.([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(args.cursor)
      if (!parts) {
        throw new FacadeServiceError('invalid_cursor')
      }
      offset = Number(parts[1])
      expires = Number(parts[2])
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(expires) ||
        now >= expires ||
        !timingSafeEqual(
          Buffer.from(parts[3]!),
          Buffer.from(this.cursorTag(caller, args.result_id, bytes, offset, expires))
        )
      ) {
        throw new FacadeServiceError('invalid_cursor')
      }
    }
    const page = runtime.results.read(args.result_id, offset, bytes)
    this.current(context)
    let next: string | undefined
    if (!page.eof) {
      expires = Math.min(page.expires, expires)
      next = `result_v1.${page.next_cursor}.${expires}.${this.cursorTag(caller, args.result_id, bytes, page.next_cursor, expires)}`
    }
    // 文本形式只是已授权页的附加表示：门禁、预算与 base64 原样不变；本页字节不是合法 UTF-8 时不提供，避免调用方误拼。
    let text: string | undefined
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(page.data, 'base64'))
    } catch {
      text = undefined
    }
    return {
      result_id: page.result_id,
      chunk: page.data,
      encoding: page.encoding,
      ...(text === undefined ? {} : { text }),
      ...(next ? { next_cursor: next } : {}),
      eof: page.eof,
      total_bytes: page.bytes,
      sha256: page.hash,
      expires_at: page.expires
    }
  }

  // 只做参数投影和受信请求作用域组合，不实现第二份准入、取消、结果存储或管理写事务。
  async execute<K extends ToolName>(
    name: K,
    args: ToolArguments[K],
    context: ServiceContext
  ): Promise<ServiceReply<K>> {
    try {
      if (!isToolName(name)) {
        throw new FacadeServiceError('unsupported')
      }
      let request: Request
      try {
        request = { name, args: parseToolArguments(name, args) } as Request
      } catch {
        throw new FacadeServiceError('invalid_arguments')
      }
      const data = await this.options.runtime.runAuthenticated(
        context.caller,
        /* 身份仅来自HTTP受信上下文。 */ async () => {
          this.current(context)
          const runtime = this.options.runtime
          if (request.name === 'runtime_call') {
            const input = request.args
            const admitted = runtime.admit({
              target: input.target,
              native_request: input.native_request,
              options: {
                binding_revision: input.expected_binding_revision,
                contract_ref: input.contract_ref,
                deadline: input.deadline,
                ...(input.validation ? { validation: input.validation } : {}),
                ...(input.client_request_key ? { client_request_key: input.client_request_key } : {})
              }
            })
            return this.callView(admitted.call.call_id, input.wait_ms, context)
          }
          if (request.name === 'runtime_call_get') {
            return this.callView(request.args.call_id, request.args.wait_ms, context)
          }
          if (request.name === 'runtime_call_cancel') {
            const call = runtime.cancel(request.args.call_id)
            this.current(context)
            return {
              call_id: call.call_id,
              // transport没有取消ack，不能把尝试发送通知称为bridge/native已停。
              cancellation:
                call.state === 'not_dispatched'
                  ? 'waiting_stopped'
                  : call.state === 'outcome_unknown'
                    ? 'outcome_unknown'
                    : 'unsupported'
            }
          }
          if (request.name === 'runtime_result_read') {
            return this.readResult(request.args, context)
          }
          if (request.name === 'runtime_response_discard') {
            runtime.results.discard(request.args.call_id)
            this.current(context)
            return { call_id: request.args.call_id, content_status: 'discarded' }
          }
          const reply = await this.reads.execute(name, args, context)
          this.current(context)
          return reply.data
        }
      )
      return { data: data as ReplyData[K] }
    } catch (error) {
      throw publicError(error)
    }
  }
}
