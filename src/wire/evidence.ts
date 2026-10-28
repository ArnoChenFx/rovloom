// 根据独立调用锚点和当前内容权限规划响应证据及原文保留意图。
import type { AttemptBinding, AuthenticatedEnvelope, CodecContext, JsonObject, ValidationMode } from './types.js'
import { assertBinding, decodeWireFrame } from './codec.js'
import { boundedJson, uint, hash, fail, LIMITS, sha } from './validation.js'

export type ResponseAnchor = {
  binding: AttemptBinding
  method: string
  mode: ValidationMode
  state: 'dispatching' | 'connector_accepted' | 'outcome_unknown' | 'responded' | 'not_dispatched'
  content_status: 'available' | 'expired' | 'discarded' | 'unavailable'
  content_expires_at: number
  dedup_expires_at: number
  evidence?: { response_hash: string; response_bytes: number }
}

export type ResponseEvidencePlan = {
  action: 'append' | 'duplicate'
  late_evidence: boolean
  dispatch: false
  evidence: {
    binding: AttemptBinding
    received_at: number
    response_hash: string
    response_bytes: number
    category: 'result' | 'error'
  }
  content: {
    status: ResponseAnchor['content_status']
    expires_at: number
    delivery: 'payload' | 'metadata_only'
    native_response?: JsonObject
  }
}

// 返回响应证据的待提交计划；存储层负责事务持久化与保留，宿主、Router 和 adapter 负责当前读取授权及最终发布。
export function planResponseEvidence(
  frame: Extract<AuthenticatedEnvelope, { type: 'response' }>,
  context: CodecContext,
  anchor: ResponseAnchor | undefined,
  now: number
): ResponseEvidencePlan {
  if (!anchor) {
    fail('attempt_anchor_unavailable')
  }
  uint(now)
  uint(anchor.content_expires_at, true)
  uint(anchor.dedup_expires_at, true)
  if (context.phase !== 'authenticated' || context.direction !== 'connector_to_gateway') {
    fail('authentication_required')
  }
  if (anchor.state === 'outcome_unknown' && !context.connection.negotiated.capabilities.includes('late_evidence')) {
    fail('unsupported_capability')
  }
  // 响应帧必须再走一遍受限 codec，不能通过 typed 参数绕过。
  const checked = decodeWireFrame(Buffer.from(boundedJson(frame, LIMITS.frame_bytes)), context)
  if (checked.type !== 'response') {
    fail('invalid_evidence')
  }
  const binding = {
    machine_id: checked.machine_id,
    recovery_generation: checked.recovery_generation,
    connection_epoch: checked.connection_epoch,
    ...checked.payload.attempt
  }
  assertBinding(binding, anchor.binding)
  const resolved = context.resolveAttempt?.(checked.payload.attempt)
  if (!resolved || resolved.method !== anchor.method || resolved.mode !== anchor.mode) {
    fail('attempt_binding_mismatch')
  }
  if (now >= anchor.dedup_expires_at || anchor.state === 'not_dispatched') {
    fail('evidence_not_applicable')
  }
  if (!['dispatching', 'connector_accepted', 'outcome_unknown', 'responded'].includes(anchor.state)) {
    fail('evidence_not_applicable')
  }
  const raw = boundedJson(checked.payload.native_response, LIMITS.object_bytes)
  const response_hash = hash(raw)
  const response_bytes = Buffer.byteLength(raw)

  if (anchor.evidence) {
    sha(anchor.evidence.response_hash)
    uint(anchor.evidence.response_bytes, true)
    if (anchor.evidence.response_hash !== response_hash || anchor.evidence.response_bytes !== response_bytes) {
      fail('response_evidence_conflict')
    }
  } else if (anchor.state === 'responded') {
    fail('evidence_anchor_unavailable')
  }
  // 证据能否追加与原文能否保存分别判断；晚到结果不会恢复过期或 discarded 内容。
  const status =
    anchor.content_status === 'available' && now >= anchor.content_expires_at ? 'expired' : anchor.content_status
  if (!['available', 'expired', 'discarded', 'unavailable'].includes(status)) {
    fail('invalid_content_status')
  }
  const duplicate = anchor.evidence !== undefined
  const retain = status === 'available' && !duplicate
  return {
    action: duplicate ? 'duplicate' : 'append',
    late_evidence: anchor.state === 'outcome_unknown',
    dispatch: false,
    evidence: {
      binding,
      received_at: now,
      response_hash,
      response_bytes,
      category: Object.hasOwn(checked.payload.native_response, 'error') ? 'error' : 'result'
    },
    // 重复消息不生成任何原文写入/句柄意图，也不刷新期限。
    content: {
      status,
      expires_at: anchor.content_expires_at,
      delivery: retain ? 'payload' : 'metadata_only',
      ...(retain ? { native_response: checked.payload.native_response } : {})
    }
  }
}
