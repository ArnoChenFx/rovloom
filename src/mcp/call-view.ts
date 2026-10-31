// 两种MCP服务共用同一调用元数据投影；原文及结果句柄必须另经当前内容门禁。
import type { Call } from '../store.js'
import type { CallRefusalReason, CallView } from './types.js'

/**
 * 逐调用拒绝原因的公开闭合集合：控制端据此决定「读屏 / 重取 created_ms / 找人开开关」，
 * 不含 core 的自由文本、参数值或方法表之外的信息。
 */
export const CALL_REFUSAL_REASONS = [
  'blocked',
  'status_mismatch',
  'terminal_finished',
  'not_found',
  'machine_unknown',
  'invalid_params',
  'fence_mismatch',
  'terminal_unavailable',
  'terminal_execution_disabled',
  'template_unavailable',
  'template_ambiguous',
  'capacity',
  'name_taken',
  'invalid_template',
  'unavailable'
] as const satisfies readonly CallRefusalReason[]

/** 内部固定码到公开原因的映射；表外码不给原因，不猜。 */
const REFUSAL_REASONS: Readonly<Record<string, CallRefusalReason>> = Object.freeze({
  terminal_execution_disabled: 'terminal_execution_disabled',
  herdr_core_terminal_blocked: 'blocked',
  herdr_core_native_blocked: 'blocked',
  herdr_core_native_status_mismatch: 'status_mismatch',
  herdr_core_native_finished: 'terminal_finished',
  herdr_core_native_not_found: 'not_found',
  herdr_core_native_machine_unknown: 'machine_unknown',
  herdr_core_native_invalid_params: 'invalid_params',
  herdr_core_terminal_identity_mismatch: 'fence_mismatch',
  herdr_core_core_identity_mismatch: 'fence_mismatch',
  herdr_core_core_id_required: 'invalid_params',
  herdr_core_terminal_unavailable: 'terminal_unavailable',
  herdr_core_template_unavailable: 'template_unavailable',
  herdr_core_template_ambiguous: 'template_ambiguous',
  herdr_core_run_capacity: 'capacity',
  herdr_core_native_name_taken: 'name_taken',
  herdr_core_native_invalid_template: 'invalid_template',
  herdr_core_connection_closed: 'unavailable',
  herdr_core_events_closed: 'unavailable'
})

/** 只投影闭合集合里的原因；未知码返回 undefined，不把内部码带到公开面。 */
export function callRefusalReason(code: string | undefined): CallRefusalReason | undefined {
  return code === undefined ? undefined : REFUSAL_REASONS[code]
}

// 只投影同一次已授权读取的公开字段，不混合前后两个账本状态。
export function publicCallView(call: Call, reason?: CallRefusalReason): CallView {
  return {
    call_id: call.call_id,
    target: JSON.parse(call.target_json),
    provider_kind: call.provider_kind,
    binding_revision: call.binding_revision,
    contract_ref: null,
    state: call.state,
    ...(reason ? { reason } : {}),
    delivery:
      call.state === 'created' || call.state === 'not_dispatched'
        ? 'not_dispatched'
        : call.state === 'responded'
          ? 'responded'
          : 'possibly_dispatched',
    content_status: call.content_status,
    content_delivery: 'unavailable',
    content_expires_at: call.content_expires
  }
}
