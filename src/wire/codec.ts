// 校验并编解码 Wire v2 握手、认证消息、原生载荷及有界逻辑对象。
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedEnvelope,
  CodecContext,
  JsonObject,
  NativeValidationContext,
  ProviderSnapshot,
  ProviderBinding,
  WireEnvelope
} from './types.js'
import { boundedJson, fields, object, id, uint, sha, text, oneOf, fail, parseJson, LIMITS } from './validation.js'
import { validateNegotiated, validateOffer, WIRE_MAJOR } from './negotiation.js'
import {
  assertProviderAccess,
  providerFor,
  validateContractSource,
  validateProvider,
  validateTarget,
  validatorFor
} from './provider.js'

const BASE = ['protocol_major', 'protocol_minor', 'type', 'message_id', 'payload']
const CONNECTION = ['machine_id', 'recovery_generation', 'connection_epoch']
const ATTEMPT = [
  'call_id',
  'attempt_id',
  'native_request_id',
  'target',
  'provider_kind',
  'binding_revision',
  'contract_ref',
  'registration'
]
const REQUEST = ['attempt', 'expected_binding_revision', 'native_request', 'validation']
const DIRECTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  enroll: ['connector_to_gateway'],
  authenticate: ['connector_to_gateway'],
  welcome: ['gateway_to_connector'],
  provider_snapshot: ['connector_to_gateway'],
  terminal_execution_state: ['connector_to_gateway'],
  provider_fenced: ['gateway_to_connector', 'connector_to_gateway'],
  request: ['gateway_to_connector'],
  accepted: ['connector_to_gateway'],
  dispatch_refused: ['connector_to_gateway'],
  response: ['connector_to_gateway'],
  cancel: ['gateway_to_connector'],
  heartbeat: ['gateway_to_connector', 'connector_to_gateway'],
  error: ['gateway_to_connector', 'connector_to_gateway']
})

// 校验连接绑定中的机器、恢复代次和连接纪元均为合法标识。
function connection(v: JsonObject): void {
  for (const k of CONNECTION) {
    id(v[k])
  }
}

/** 只校验单 provider 快照的严格数据形状；静态 pin、真实能力和来源的可信接纳仍由当前宿主完成。 */
export function validateProviderSnapshot(value: unknown): asserts value is ProviderSnapshot {
  const snapshot = object(value)
  fields(snapshot, ['binding', 'target', 'source', 'capabilities', 'capability_revision'])
  validateProvider(snapshot.binding)
  validateTarget(snapshot.target)
  validateContractSource(snapshot.source)
  const binding = snapshot.binding
  const target = snapshot.target
  const source = snapshot.source
  if (
    binding.kind !== 'luvus' ||
    target.profile !== 'session' ||
    binding.machine_id !== target.machine_id ||
    binding.provider_id !== target.provider_id
  ) {
    fail('provider_snapshot_binding_mismatch')
  }
  if (
    source.provider_kind !== 'luvus' ||
    source.protocol_family !== 'uhp' ||
    source.schema_command !== 'luvus uhp schema' ||
    source.support_basis !== 'live_catalog' ||
    source.native_protocol_version === null ||
    source.runtime_generation === null ||
    source.classification_revision === null
  ) {
    fail('provider_snapshot_source_invalid')
  }
  boundedJson(object(snapshot.capabilities))
  sha(snapshot.capability_revision)
}

// 严格校验调用身份、目标和登记条件，拒绝缺失字段或非法取值。
export function validateAttempt(value: unknown): asserts value is AttemptIdentity {
  const a = object(value)
  fields(a, ATTEMPT)
  for (const k of ['call_id', 'attempt_id']) {
    id(a[k])
  }
  if (typeof a.native_request_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(a.native_request_id)) {
    fail('invalid_native_id')
  }
  sha(a.contract_ref)
  uint(a.binding_revision, true)
  oneOf(a.provider_kind, ['luvus', 'herdr'])
  validateTarget(a.target)
  const r = object(a.registration)
  fields(r, ['deadline', 'caller_policy_revision', 'local_policy_revision'])
  uint(r.deadline, true)
  id(r.caller_policy_revision)
  id(r.local_policy_revision)
}

// 从完整连接绑定中提取可随消息传输的调用身份。
function pickAttempt(a: AttemptBinding): AttemptIdentity {
  return {
    call_id: a.call_id,
    attempt_id: a.attempt_id,
    native_request_id: a.native_request_id,
    target: a.target,
    provider_kind: a.provider_kind,
    binding_revision: a.binding_revision,
    contract_ref: a.contract_ref,
    registration: a.registration
  }
}

// 核对连接及调用身份的全部字段，不一致时拒绝关联。
export function assertBinding(actual: AttemptBinding, expected: AttemptBinding): void {
  connection(object(actual))
  connection(object(expected))
  validateAttempt(pickAttempt(actual))
  validateAttempt(pickAttempt(expected))
  if (
    CONNECTION.some(
      /* 判断任一连接字段是否与独立锚点不符。 */ (k) =>
        actual[k as keyof AttemptBinding] !== expected[k as keyof AttemptBinding]
    ) ||
    boundedJson(pickAttempt(actual)) !== boundedJson(pickAttempt(expected))
  ) {
    fail('attempt_binding_mismatch')
  }
}

// 校验调用目标所属机器，并将调用身份与当前帧的连接身份绑定。
function bind(frame: JsonObject, attempt: unknown): AttemptBinding {
  validateAttempt(attempt)
  if (attempt.target.machine_id !== frame.machine_id) {
    fail('target_machine_mismatch')
  }
  return {
    machine_id: frame.machine_id as string,
    recovery_generation: frame.recovery_generation as string,
    connection_epoch: frame.connection_epoch as string,
    ...attempt
  }
}

// 校验网关或传输错误载荷，允许附带关联消息标识。
function errorPayload(p: JsonObject): void {
  fields(p, ['source', 'code', 'retryable'], ['cause_message_id'])
  oneOf(p.source, ['gateway', 'transport'])
  if (typeof p.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(p.code) || typeof p.retryable !== 'boolean') {
    fail('invalid_error')
  }
  if (Object.hasOwn(p, 'cause_message_id')) {
    id(p.cause_message_id)
  }
}

type AuthContext = Extract<CodecContext, { phase: 'authenticated' }>

// 执行原生校验回调，仅透传合法错误码并为其他异常返回固定错误码。
function nativeCall<T>(fn: () => T, fallback: string): T {
  try {
    return fn()
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined
    fail(typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : fallback)
  }
}

// 执行只应返回 undefined 的原生校验，拒绝异常返回值。
function nativeVoid(fn: () => void, fallback: string): void {
  if (nativeCall(fn, fallback) !== undefined) {
    fail('invalid_native_validator_result')
  }
}

// 从可信解析器恢复调用锚点，核对绑定、传输类型及协商能力。
function anchored(frame: JsonObject, p: JsonObject, ctx: AuthContext): NativeValidationContext {
  // attempt 必须来自独立 resolver；消息里的字段不能自行建立调用身份。
  const binding = bind(frame, p.attempt)
  const anchor = ctx.resolveAttempt?.(p.attempt as AttemptIdentity)
  if (!anchor) {
    fail('attempt_anchor_unavailable')
  }
  assertBinding(binding, anchor.binding)
  providerFor(binding, ctx)
  text(anchor.method, 256)
  oneOf(anchor.mode, ['strict', 'raw-contract'])
  capability(ctx, 'rpc')
  return {
    binding,
    method: anchor.method,
    mode: anchor.mode
  }
}

// 核对请求与登记锚点、当前双端权限和原生参数门禁。
function validateRequestPayload(frame: JsonObject, payload: JsonObject, ctx: AuthContext): void {
  fields(payload, REQUEST)
  const nativeRequest = object(payload.native_request)
  if (Object.hasOwn(nativeRequest, 'auth') || Object.hasOwn(nativeRequest, 'id')) {
    fail('reserved_request_field')
  }

  // 先从受信账本找回 attempt，再核对消息中的方法、revision 与传输。
  const native = anchored(frame, payload, ctx)
  uint(payload.expected_binding_revision, true)
  if (payload.expected_binding_revision !== native.binding.binding_revision) {
    fail('provider_binding_mismatch')
  }
  oneOf(payload.validation, ['strict', 'raw-contract'])
  text(nativeRequest.method, 256)
  if (nativeRequest.method !== native.method || payload.validation !== native.mode) {
    fail('attempt_binding_mismatch')
  }
  assertProviderAccess(native.binding, native.method, 'dispatch', ctx)
  if (
    ctx.policies!.caller.revision !== native.binding.registration.caller_policy_revision ||
    ctx.policies!.local.revision !== native.binding.registration.local_policy_revision
  ) {
    fail('policy_revision_stale')
  }

  // Wire 授权通过后仍须由原生校验器执行方法表、策略与参数校验。
  const validator = validatorFor(native.binding, ctx)
  const full = { ...nativeRequest, id: native.binding.native_request_id }
  nativeVoid(
    /* 调用原生校验器检查补入可信 ID 后的完整请求。 */ () => validator.validateRequest(full, native),
    'native_request_invalid'
  )
}

// 要求当前连接已协商指定能力，否则拒绝该消息。
function capability(ctx: AuthContext, name: string): void {
  if (!(ctx.connection.negotiated.capabilities as string[]).includes(name)) {
    fail('unsupported_capability')
  }
}

// 握手只检查消息与协商关联；认证事实仍由宿主建立。
function decodeHandshake(
  frame: JsonObject,
  p: JsonObject,
  context: Extract<CodecContext, { phase: 'preauth' }>
): PreAuthResult {
  fields(frame, BASE)
  if (frame.type === 'enroll' || frame.type === 'authenticate') {
    const enroll = frame.type === 'enroll'
    fields(
      p,
      enroll
        ? ['registration_id', 'connector_instance_id', 'enrollment_credential', 'offer']
        : ['machine_id', 'recovery_generation', 'connector_instance_id', 'device_credential', 'offer']
    )
    id(p.connector_instance_id)
    if (enroll) {
      id(p.registration_id)
    } else {
      id(p.machine_id)
      id(p.recovery_generation)
    }
    text(p[enroll ? 'enrollment_credential' : 'device_credential'], 4096)
    validateOffer(p.offer)
    if (p.offer.major !== frame.protocol_major || p.offer.minor !== frame.protocol_minor) {
      fail('invalid_negotiation')
    }
  } else if (frame.type === 'welcome') {
    fields(p, [...CONNECTION, 'in_reply_to', 'selected'])
    connection(p)
    id(p.in_reply_to)
    if (!context.offer || !context.handshake_message_id) {
      fail('handshake_context_required')
    }
    if (p.in_reply_to !== context.handshake_message_id) {
      fail('handshake_mismatch')
    }
    validateNegotiated(p.selected, context.offer)
    if (p.selected.major !== frame.protocol_major || p.selected.minor !== frame.protocol_minor) {
      fail('invalid_negotiation')
    }
  } else if (frame.type === 'error') {
    errorPayload(p)
  } else {
    fail('authentication_required')
  }
  return frame as PreAuthResult
}

/** 共用有界 JSON、方向、版本和消息 ID 校验；此步骤不建立原生许可。 */
function readEnvelope(input: string | Uint8Array, context: CodecContext, limit: number): JsonObject {
  const frame = object(parseJson(input, limit))
  id(frame.message_id)
  uint(frame.protocol_major, true)
  uint(frame.protocol_minor)
  if (typeof frame.type !== 'string' || !Object.hasOwn(DIRECTIONS, frame.type)) {
    fail('unsupported_frame_type')
  }
  if (!DIRECTIONS[frame.type]!.includes(context.direction)) {
    fail('wrong_direction')
  }
  if (frame.protocol_major !== WIRE_MAJOR) {
    fail('protocol_major_unsupported')
  }
  object(frame.payload)
  return frame
}

/** 只校验当前认证连接和完整 envelope header，供正常解码与失效后丢弃共用。 */
function authenticateEnvelope(frame: JsonObject, context: CodecContext): asserts context is AuthContext {
  if (
    context.phase !== 'authenticated' ||
    context.connection?.authenticated !== true ||
    context.connection.active !== true
  ) {
    fail('authentication_required')
  }
  fields(frame, [...BASE, ...CONNECTION])
  connection(frame)
  connection(object(context.connection))
  validateNegotiated(context.connection.negotiated)
  if (
    frame.protocol_minor !== context.connection.negotiated.minor ||
    frame.protocol_major !== context.connection.negotiated.major
  ) {
    fail('protocol_version_unsupported')
  }
  if (
    CONNECTION.some(
      /* 检测帧是否使用了当前认证连接以外的身份字段。 */ (k) =>
        frame[k] !== context.connection[k as keyof typeof context.connection]
    )
  ) {
    fail('connection_binding_mismatch')
  }
}

// context 是受信外部输入；逐帧检查 active/epoch 不代替 TLS、认证或撤销查询。
function decode(input: string | Uint8Array, context: CodecContext, limit: number): WireEnvelope {
  const frame = readEnvelope(input, context, limit)
  const p = object(frame.payload)
  if (context.phase === 'preauth') {
    return decodeHandshake(frame, p, context)
  }
  authenticateEnvelope(frame, context)

  switch (frame.type) {
    case 'terminal_execution_state':
      capability(context, 'terminal_execution_state')
      fields(p, ['binding', 'enabled'])
      validateProvider(p.binding)
      if (typeof p.enabled !== 'boolean' || p.binding.machine_id !== frame.machine_id) {
        fail('terminal_execution_state_invalid')
      }
      break
    case 'provider_fenced':
      capability(context, 'provider_fence')
      fields(p, ['binding'])
      validateProvider(p.binding)
      if (p.binding.machine_id !== frame.machine_id) {
        fail('target_machine_mismatch')
      }
      // 完整 binding 是否属于本 epoch 原配置仍由 session 的同步失效端口独立核对。
      break
    case 'provider_snapshot':
      capability(context, 'provider_snapshot')
      validateProviderSnapshot(p)
      if (p.binding.machine_id !== frame.machine_id) {
        fail('target_machine_mismatch')
      }
      break
    case 'request':
      capability(context, 'rpc')
      validateRequestPayload(frame, p, context)
      break
    case 'heartbeat':
      fields(p, ['sequence'])
      uint(p.sequence)
      break
    case 'error':
      errorPayload(p)
      break
    case 'accepted':
      fields(p, ['attempt'])
      anchored(frame, p, context)
      break
    case 'dispatch_refused':
      capability(context, 'dispatch_refusal')
      fields(p, ['attempt', 'code'])
      oneOf(p.code, ['terminal_execution_disabled', 'policy_revision_stale'])
      anchored(frame, p, context)
      break
    case 'cancel': {
      fields(p, ['attempt', 'reason'])
      oneOf(p.reason, ['caller_cancelled', 'deadline_exceeded'])
      const n = anchored(frame, p, context)
      assertProviderAccess(n.binding, n.method, 'cancel', context)
      break
    }
    case 'response': {
      fields(p, ['attempt', 'native_response'])
      const n = anchored(frame, p, context)
      const r = object(p.native_response)
      const validator = validatorFor(n.binding, context)
      nativeVoid(
        /* 以登记的原请求上下文校验完整响应。 */ () => validator.validateResponse(r, n),
        'native_response_invalid'
      )
      break
    }
    default:
      fail('handshake_after_authentication')
  }
  return frame as AuthenticatedEnvelope
}

type PreAuthResult = Extract<WireEnvelope, { type: 'enroll' | 'authenticate' | 'welcome' | 'error' }>

// 规范化序列化并完整验证帧，返回可发送的 JSON 文本。
export function encodeWireFrame(frame: WireEnvelope, context: CodecContext): string {
  const raw = boundedJson(frame)
  decodeWireFrame(raw, context)
  return raw
}

// 在单帧大小上限内解码并校验 Wire 消息。
export function decodeWireFrame(input: string | Uint8Array, context: CodecContext): WireEnvelope {
  return decode(input, context, LIMITS.frame_bytes)
}

/**
 * 准入拒绝发生在原 adapter 登记执行锚点之前，编码只绑定当前连接与 attempt 结构。
 * 执行锚点、双端策略与 revision 的全量复核由网关接收端 anchored 链在其自身账本上完成。
 */
export function encodeDispatchRefusalFrame(
  frame: Extract<WireEnvelope, { type: 'dispatch_refused' }>,
  context: AuthContext
): string {
  const snapshot = object(parseJson(boundedJson(frame)))
  authenticateEnvelope(snapshot, context)
  if (context.direction !== 'connector_to_gateway') {
    fail('direction_not_allowed')
  }
  capability(context, 'dispatch_refusal')
  const p = object(snapshot.payload)
  fields(p, ['attempt', 'code'])
  oneOf(p.code, ['terminal_execution_disabled', 'policy_revision_stale'])
  bind(snapshot, p.attempt)
  return boundedJson(snapshot)
}

/** 只丢弃已永久失效 provider 的迟到 RPC 数据；不返回 payload、原生上下文或任何执行/读取许可。 */
export function discardFencedWireFrame(
  input: string | Uint8Array,
  context: CodecContext,
  fenced: readonly ProviderBinding[]
): boolean {
  const frame = readEnvelope(input, context, LIMITS.frame_bytes)
  authenticateEnvelope(frame, context)
  capability(context, 'provider_fence')
  const p = object(frame.payload)
  if (frame.type === 'provider_snapshot') {
    capability(context, 'provider_snapshot')
    validateProviderSnapshot(p)
    return fenced.some(
      /** 旧快照只能被丢弃，不能由重复广告恢复已失效来源。 */ (binding) =>
        boundedJson(binding) === boundedJson(p.binding)
    )
  }
  if (!['request', 'accepted', 'dispatch_refused', 'response', 'cancel'].includes(frame.type as string)) {
    return false
  }
  const binding = bind(frame, p.attempt)
  if (
    !fenced.some(
      /** 只丢弃当前连接原配置中已失效的同一 provider/kind/revision。 */ (provider) =>
        provider.machine_id === binding.machine_id &&
        provider.provider_id === binding.target.provider_id &&
        provider.kind === binding.provider_kind &&
        provider.binding_revision === binding.binding_revision
    )
  ) {
    return false
  }
  switch (frame.type) {
    case 'request':
      fields(p, REQUEST)
      uint(p.expected_binding_revision, true)
      oneOf(p.validation, ['strict', 'raw-contract'])
      object(p.native_request)
      break
    case 'accepted':
      fields(p, ['attempt'])
      break
    case 'dispatch_refused':
      capability(context, 'dispatch_refusal')
      fields(p, ['attempt', 'code'])
      oneOf(p.code, ['terminal_execution_disabled', 'policy_revision_stale'])
      break
    case 'response':
      fields(p, ['attempt', 'native_response'])
      object(p.native_response)
      break
    case 'cancel':
      fields(p, ['attempt', 'reason'])
      oneOf(p.reason, ['caller_cancelled', 'deadline_exceeded'])
      break
  }
  return true
}
