/** Herdr 固定评审 RPC 的原生编解码与 Wire 接缝；其它能力继续逐项取得原生证据。 */
import type { NativeWireBackend, TrustedAttempt } from '../../integration/luvus-wire.js'
import type { LedgerInvalidation } from '../../storage/model.js'
import type { ResponseAnchor } from '../../wire/evidence.js'
import {
  assertBinding,
  boundedJson,
  contractRef,
  fail,
  fields,
  LIMITS,
  object,
  parseJson,
  planResponseEvidence,
  providerFor,
  text,
  validateAttempt,
  validateContractSource
} from '../../wire/index.js'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedContext,
  AuthenticatedEnvelope,
  ContractRecord,
  ContractSource,
  Direction,
  JsonObject,
  NativePayloadValidator,
  NativeValidationContext,
  ResolvedAttempt
} from '../../wire/types.js'

export { HERDR_READONLY_REVIEW } from './review.js'
import { HERDR_READONLY_REVIEW } from './review.js'
import { isReviewedHerdrSource } from './review.js'
import { isCompiledHerdrSchemas } from './compiler-api.js'
import { herdrResponseRule, reviewedHerdrRequest } from './methods.js'
import { isAuthenticatedHerdrSource } from './source.js'
import type { HerdrSource } from './source.js'

/** 宿主从安装 schema 完整根编译的校验器；编译须先满足独立 worker 的资源门禁。 */
export interface HerdrSchemas {
  readonly protocol: number
  readonly schema_sha256: string
  readonly dialect: 'https://json-schema.org/draft/2020-12/schema'
  /** 校验完整 request 根，不使用 describe 裁剪或仅 method/params 分支。 */
  request(value: JsonObject): boolean
  /** 校验原生 success_response 或 error_response 完整根，不包装成 UHP。 */
  response(value: JsonObject): boolean
}

/** 与共享 ContractRecord 共用来源和摘要，不另建 provider/设备身份。 */
export type HerdrContractRecord = { wire: ContractRecord; schemas: HerdrSchemas }

/** 本机安装与 Gateway 认证通道来源分属不同角色；业务帧不能自行发行来源。 */
export type HerdrNativeSource = HerdrSource

/** 复用 Store attempt 与当前认证；宿主负责本地实例来源、契约编译及完整上下文。 */
export interface HerdrReadonlyBackend extends Pick<
  NativeWireBackend,
  'attempt' | 'now' | 'currentPrincipal' | 'contentStatus'
> {
  /** 每次重新读取认证和双端精确 grants；resolveProvider 须先核对 registry 与本机配置同值。 */
  context(principal: string, direction: Direction): AuthenticatedContext
  /** 只从受信 registry 取安装契约；缺少完整编译器时返回 unavailable。 */
  contract(ref: string): HerdrContractRecord | undefined
  /** 按原 attempt 独立解析本机配置及来源，实例/连接变化必须替换 token。 */
  nativeSource(binding: AttemptBinding): HerdrNativeSource | undefined
  /** 只取 Store 原派发锚点与固定期限，不能从消息重建或刷新保留时间。 */
  responseAnchor(binding: AttemptBinding): ResponseAnchor | undefined
  /** 使用 Store 已提交的回收及身份失效通知；关闭时必须解除订阅。 */
  subscribeInvalidation(listener: (event: LedgerInvalidation) => void): () => void
}

/** 核对实际 schema/协议与适配分类修订；版本只作诊断，不接受虚构 generation 或 catalog 声明。 */
function reviewedSource(source: ContractSource, schemas: HerdrSchemas): void {
  validateContractSource(source)
  if (
    !isReviewedHerdrSource(source) ||
    schemas.schema_sha256 !== source.schema_sha256 ||
    String(schemas.protocol) !== source.native_protocol_version ||
    schemas.dialect !== 'https://json-schema.org/draft/2020-12/schema'
  ) {
    fail('herdr_contract_unreviewed')
  }
}

/** Gateway 通道必须有私有发行品牌；本机来源的实际核对由 installation 所有者逐次完成。 */
function reviewedNativeSource(source: HerdrNativeSource): void {
  if (
    source.role !== 'local_installation' &&
    (source.role !== 'authenticated_connector' || !isAuthenticatedHerdrSource(source))
  ) {
    fail('native_source_untrusted')
  }
}

/** 只接纳已评审方法和参数记录；具体参数逐次交给完整安装 schema 验证。 */
function readonlyRequest(value: unknown): JsonObject & { id: string; method: string } {
  const request = object(parseJson(boundedJson(value, HERDR_READONLY_REVIEW.frame_bytes)))
  fields(request, ['id', 'method', 'params'])
  const { id, method, params } = request
  text(id, 128)
  text(method, 256)
  if (!reviewedHerdrRequest({ method, params })) {
    fail('herdr_method_unreviewed')
  }
  return { id, method, params }
}

/** 密封响应规则只有固定类型集合；不保存原参数或用于重新构造请求的材料。 */
type ResponseRule = readonly string[]

/** 验证完整原生响应根与原 ID；成功类型由已验证请求的规则约束，不依赖已回收的正文。 */
function responseFrame(
  bytes: Uint8Array,
  expectedId: string,
  rule: ResponseRule,
  source: ContractSource,
  schemas: HerdrSchemas
): JsonObject {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > HERDR_READONLY_REVIEW.frame_bytes ||
    bytes.at(-1) !== 10 ||
    bytes.subarray(0, -1).includes(10)
  ) {
    fail('herdr_native_framing')
  }
  const response = object(parseJson(bytes, HERDR_READONLY_REVIEW.frame_bytes))
  const error = Object.hasOwn(response, 'error')
  fields(response, ['id', error ? 'error' : 'result'])
  if (response.id !== expectedId || !schemas.response(response)) {
    fail('herdr_native_response_invalid')
  }
  if (error) {
    const body = object(response.error)
    text(body.code, 128)
    if (typeof body.message !== 'string') {
      fail('herdr_native_response_invalid')
    }
  } else {
    const result = object(response.result)
    if (typeof result.type !== 'string' || !rule.includes(result.type)) {
      fail('herdr_native_response_invalid')
    }
    if (result.type === 'pong' || result.type === 'session_snapshot') {
      const state = result.type === 'pong' ? result : object(result.snapshot)
      if (String(state.protocol) !== source.native_protocol_version) {
        fail('herdr_native_response_invalid')
      }
    }
  }
  return response
}

/** 原生协议组件可独立离线回放；它只做验证，不建立生产授权或连接。 */
export function createHerdrCodec(source: ContractSource, schemas: HerdrSchemas) {
  reviewedSource(source, schemas)
  const requestRoot = schemas.request
  return Object.freeze({
    /** 先检查精确评审参数和完整安装 schema，再生成单条有界 JSON LF。 */
    encode(request: JsonObject): Uint8Array {
      const checked = readonlyRequest(request)
      if (!requestRoot(checked)) {
        fail('herdr_native_request_invalid')
      }
      return Buffer.from(boundedJson(checked, HERDR_READONLY_REVIEW.frame_bytes - 1) + '\n')
    },
    /** EOF/超时由传输层报告；只接收单条完整原生响应，保留 result/error 和原生值。 */
    decode(bytes: Uint8Array, request: JsonObject): JsonObject {
      const checked = readonlyRequest(request)
      if (!requestRoot(checked)) {
        fail('herdr_native_request_invalid')
      }
      const rule = herdrResponseRule(checked.method)
      if (!rule) {
        fail('herdr_method_unreviewed')
      }
      return responseFrame(bytes, checked.id, rule, source, schemas)
    }
  })
}

/** 私有 attempt 状态只保存共享身份，不缓存原生结果或重新派发队列。 */
type State = {
  key: string
  attempt: Omit<TrustedAttempt, 'native_request'> & { native_request?: TrustedAttempt['native_request'] }
  contract: HerdrContractRecord
  source: HerdrNativeSource
  requestRoot: HerdrSchemas['request']
  responseRoot: HerdrSchemas['response']
  permitted: boolean
  responseRule?: ResponseRule
  responseOnly: boolean
  contentExpires: number
  dedupExpires: number
}

/** 生产接缝逐次调用共享 provider gate，仅接纳固定已评审来源和真实完整根编译品牌。 */
export function createHerdrReadonlyAdapter(backend: HerdrReadonlyBackend) {
  const states = new Map<string, State>()
  let closed = false
  let invalidationRevision = 0
  let unsubscribe: (() => void) | undefined
  let maintenance: ReturnType<typeof setInterval> | undefined

  /** 销毁能力句柄；释放不发送 Herdr cancel，也不重派原工作。 */
  function drop(state: State): void {
    states.delete(state.key)
  }

  /** 只保留已许可 RPC 的固定响应规则与身份元数据，原请求及 token 正文立即脱离缓存。 */
  function compact(state: State): void {
    if (state.responseOnly) {
      return
    }
    if (!state.permitted) {
      drop(state)
      return
    }
    state.attempt = {
      binding: state.attempt.binding,
      principal_id: state.attempt.principal_id,
      method: state.attempt.method,
      mode: state.attempt.mode
    }
    state.responseOnly = true
  }

  /** Store 内容回收压缩原文，身份 fence 销毁能力，关闭停计时器并解除通知订阅。 */
  function invalidate(event: LedgerInvalidation): void {
    invalidationRevision++
    if (event.kind === 'closed') {
      closed = true
      clearInterval(maintenance)
      maintenance = undefined
      const stop = unsubscribe
      unsubscribe = undefined
      try {
        stop?.()
      } finally {
        states.clear()
      }
      return
    }
    for (const state of states.values()) {
      if (
        state.attempt.binding.machine_id === event.machine_id &&
        (event.kind === 'device_fence' || state.attempt.binding.call_id === event.call_id)
      ) {
        if (event.kind === 'content') {
          compact(state)
        } else {
          drop(state)
        }
      }
    }
  }

  /** 空闲维护只依据可信时钟和已固定期限；外部持久锚点仅在对应调用的操作边界复验。 */
  function maintain(): void {
    if (closed) {
      fail('native_adapter_closed')
    }
    const now = backend.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      invalidate({ kind: 'closed' })
      fail('deadline_exceeded')
    }
    for (const state of states.values()) {
      if (now >= state.dedupExpires) {
        drop(state)
      } else if (!state.responseOnly) {
        if (now >= state.contentExpires) {
          compact(state)
        }
      }
    }
  }

  /** 锚点始终来自原 Store 记录；固定方法、模式和期限不允许被晚到消息改写。 */
  function retainedAnchor(state: State): ResponseAnchor {
    const found = backend.responseAnchor(state.attempt.binding)
    if (!found) {
      fail('attempt_anchor_unavailable')
    }
    assertBinding(found.binding, state.attempt.binding)
    if (
      found.method !== state.attempt.method ||
      found.mode !== state.attempt.mode ||
      found.content_expires_at !== state.contentExpires ||
      found.dedup_expires_at !== state.dedupExpires ||
      found.state === 'not_dispatched'
    ) {
      fail('attempt_binding_mismatch')
    }
    return found
  }

  /** 只投影共享 AttemptIdentity，保留 validateAttempt 对额外字段的严格拒绝。 */
  function identityOf(binding: AttemptBinding): AttemptIdentity {
    const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...identity } = binding
    return identity
  }

  /** 从可信账本恢复完整身份；不使用消息构造新 attempt，不迁移旧 provider。 */
  function anchor(identity: AttemptIdentity): TrustedAttempt {
    validateAttempt(identity)
    const found = backend.attempt(identity.call_id, identity.attempt_id)
    if (!found) {
      fail('attempt_anchor_unavailable')
    }
    // 账本快照另含 binding/principal，复用内部 Wire 预算；原生 JSON+LF 仍由 codec 独立限为 64 KiB。
    const attempt = JSON.parse(boundedJson(found, LIMITS.frame_bytes)) as TrustedAttempt
    const ctx = backend.context(attempt.principal_id, 'gateway_to_connector')
    if (!ctx.connection.authenticated || !ctx.connection.active) {
      fail('authentication_required')
    }
    assertBinding({ ...ctx.connection, ...identity }, attempt.binding)
    if (
      attempt.binding.provider_kind !== 'herdr' ||
      attempt.binding.target.profile !== 'session' ||
      attempt.binding.target.machine_id !== attempt.binding.machine_id ||
      attempt.mode !== 'strict' ||
      attempt.native_request.method !== attempt.method
    ) {
      fail('herdr_attempt_unsupported')
    }
    fields(object(attempt.native_request), ['method', 'params'])
    readonlyRequest({ ...attempt.native_request, id: attempt.binding.native_request_id })
    if (!reviewedHerdrRequest(attempt.native_request)) {
      fail('herdr_method_unreviewed')
    }
    return attempt
  }

  /** 按完整 binding 取得已登记的状态；消息不能创建状态，也不能改用另一条 binding。 */
  function stateFor(context: NativeValidationContext): State {
    const state = states.get(boundedJson(context.binding))
    if (!state) {
      fail('native_context_unavailable')
    }
    assertBinding(context.binding, state.attempt.binding)
    if (context.method !== state.attempt.method || context.mode !== 'strict') {
      fail('attempt_binding_mismatch')
    }
    return state
  }

  /** 复用同一完整 binding 的状态，但从不把旧 epoch/recovery 改写为当前身份。 */
  function resolved(state: State): ResolvedAttempt {
    return {
      binding: JSON.parse(boundedJson(state.attempt.binding)) as AttemptBinding,
      method: state.attempt.method,
      mode: 'strict'
    }
  }

  /** 证据只查原 permit 与当前身份/来源；派发和内容交付另查各自的当前权限。 */
  function current(context: NativeValidationContext, access: 'resolve' | 'evidence' | 'dispatch' | 'read'): State {
    maintain()
    const state = stateFor(context)
    if (!state.responseOnly) {
      try {
        // 必须先处理当前调用的回收/fence；其原请求可能已由同一持久 receipt 删除。
        if (backend.contentStatus(state.attempt.binding) !== 'available') {
          compact(state)
        }
      } catch {
        drop(state)
        fail('native_context_unavailable')
      }
      // 宿主回调可能同步关闭或 fence 当前句柄，不能继续使用回调前的状态。
      stateFor(context)
    }
    const attempt = state.responseOnly ? state.attempt : anchor(identityOf(state.attempt.binding))
    if (!state.responseOnly && boundedJson(attempt) !== boundedJson(state.attempt)) {
      fail('attempt_binding_mismatch')
    }
    const ctx = backend.context(
      attempt.principal_id,
      access === 'dispatch' || access === 'resolve' ? 'gateway_to_connector' : 'connector_to_gateway'
    )
    if (!ctx.connection.authenticated || !ctx.connection.active) {
      fail('authentication_required')
    }
    assertBinding({ ...ctx.connection, ...identityOf(attempt.binding) }, attempt.binding)
    retainedAnchor(state)
    if (state.responseOnly && (access === 'dispatch' || access === 'read')) {
      fail('content_unavailable')
    }
    providerFor(attempt.binding, ctx)
    if (access === 'dispatch' || access === 'read') {
      if (backend.currentPrincipal() !== attempt.principal_id) {
        fail('attempt_binding_mismatch')
      }
    }
    const now = backend.now()
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (access === 'dispatch' && now >= attempt.binding.registration.deadline)
    ) {
      fail('deadline_exceeded')
    }
    const contract = backend.contract(attempt.binding.contract_ref)
    const source = backend.nativeSource(attempt.binding)
    if (
      !contract ||
      contractRef(contract.wire.source) !== attempt.binding.contract_ref ||
      boundedJson(contract.wire) !== boundedJson(state.contract.wire) ||
      contract.schemas !== state.contract.schemas ||
      contract.schemas.request !== state.requestRoot ||
      contract.schemas.response !== state.responseRoot ||
      !source ||
      source.role !== state.source.role ||
      source.token !== state.source.token ||
      boundedJson(source.binding) !== boundedJson(attempt.binding)
    ) {
      fail('native_source_untrusted')
    }
    reviewedNativeSource(source)
    reviewedSource(contract.wire.source, contract.schemas)
    if (contract.wire.support_status !== 'validated' || !isCompiledHerdrSchemas(contract.schemas)) {
      fail('herdr_schema_uncompiled')
    }
    if (closed || states.get(state.key) !== state) {
      fail('native_context_unavailable')
    }
    if (state.responseOnly && (access === 'dispatch' || access === 'read')) {
      fail('content_unavailable')
    }
    return state
  }

  /** 只准备原请求；是否真正写入由共享账本的 dispatch 边界与宿主传输保证一次执行。 */
  function checkedRequest(request: JsonObject, context: NativeValidationContext) {
    const state = current(context, 'dispatch')
    const expected = { ...state.attempt.native_request, id: state.attempt.binding.native_request_id }
    if (boundedJson(request) !== boundedJson(expected)) {
      fail('attempt_request_mismatch')
    }
    const bytes = createHerdrCodec(state.contract.wire.source, state.contract.schemas).encode(request)
    return { state, bytes }
  }

  /** 仅显式准备派发时建立 permit；Wire 的纯校验回调不改变已派发状态。 */
  function encodeRequest(request: JsonObject, context: NativeValidationContext): Uint8Array {
    const { state, bytes } = checkedRequest(request, context)
    const rule = herdrResponseRule(state.attempt.method)
    if (!rule) {
      fail('herdr_method_unreviewed')
    }
    state.responseRule = Object.freeze([...rule])
    state.permitted = true
    return bytes
  }

  /** 仅验证原生响应证据；当前读取权和保留状态由 checkResult/原 Store 事务分别处理。 */
  function decodeResponse(bytes: Uint8Array, context: NativeValidationContext): JsonObject {
    const state = current(context, 'evidence')
    if (!state.permitted || !state.responseRule) {
      fail('dispatch_permit_unavailable')
    }
    return responseFrame(
      bytes,
      state.attempt.binding.native_request_id,
      state.responseRule,
      state.contract.wire.source,
      state.contract.schemas
    )
  }

  const validator: NativePayloadValidator = Object.freeze({
    /** 固定来源方法逐次验证完整参数；普通 RPC 不建立事件订阅或终端流保证。 */
    validateRequest(request: JsonObject, context: NativeValidationContext) {
      checkedRequest(request, context)
    },
    /** Wire 回包的原生来源由 current 按宿主可信回调复核；不能由 caller 自报。 */
    validateResponse(response: JsonObject, context: NativeValidationContext) {
      decodeResponse(Buffer.from(boundedJson(response) + '\n'), context)
    }
  })

  const api = Object.freeze({
    validator,
    encodeRequest,
    decodeResponse,
    /** 注册有界私有句柄；只有后续共享 provider/授权门禁通过才会产生原生请求。 */
    resolve(identity: AttemptIdentity): ResolvedAttempt {
      maintain()
      const observedInvalidation = invalidationRevision
      validateAttempt(identity)
      // 仅响应状态可能已无 Store 请求正文，先按原身份和当前连接查找，仍不改写旧 epoch。
      const previous = [...states.values()].find(
        /** 缓存只复用相同身份和当前连接的原句柄。 */ (state) => {
          if (boundedJson(identityOf(state.attempt.binding)) !== boundedJson(identity)) {
            return false
          }
          const connection = backend.context(state.attempt.principal_id, 'gateway_to_connector').connection
          return (
            state.attempt.binding.machine_id === connection.machine_id &&
            state.attempt.binding.connection_epoch === connection.connection_epoch &&
            state.attempt.binding.recovery_generation === connection.recovery_generation
          )
        }
      )
      if (previous) {
        assertBinding({ ...previous.attempt.binding, ...identity }, previous.attempt.binding)
        const context = resolved(previous)
        current(context, 'resolve')
        return context
      }
      const attempt = anchor(identity)
      providerFor(attempt.binding, backend.context(attempt.principal_id, 'gateway_to_connector'))
      const key = boundedJson(attempt.binding)
      if (states.size >= 128) {
        fail('adapter_limit')
      }
      const contract = backend.contract(attempt.binding.contract_ref)
      const source = backend.nativeSource(attempt.binding)
      if (
        !contract ||
        contractRef(contract.wire.source) !== attempt.binding.contract_ref ||
        !source ||
        !source.token ||
        typeof source.token !== 'object' ||
        boundedJson(source.binding) !== boundedJson(attempt.binding)
      ) {
        fail('native_source_untrusted')
      }
      reviewedNativeSource(source)
      reviewedSource(contract.wire.source, contract.schemas)
      if (contract.wire.support_status !== 'validated' || !isCompiledHerdrSchemas(contract.schemas)) {
        fail('herdr_schema_uncompiled')
      }
      const retention = backend.responseAnchor(attempt.binding)
      if (!retention) {
        fail('attempt_anchor_unavailable')
      }
      assertBinding(retention.binding, attempt.binding)
      if (
        retention.method !== attempt.method ||
        retention.mode !== attempt.mode ||
        !Number.isSafeInteger(retention.content_expires_at) ||
        !Number.isSafeInteger(retention.dedup_expires_at) ||
        retention.content_expires_at <= backend.now() ||
        retention.dedup_expires_at <= backend.now() ||
        retention.content_status !== 'available' ||
        retention.state === 'not_dispatched'
      ) {
        fail('attempt_anchor_unavailable')
      }
      const state: State = {
        key,
        attempt,
        contract: { wire: JSON.parse(boundedJson(contract.wire)) as ContractRecord, schemas: contract.schemas },
        source: { ...source, binding: JSON.parse(boundedJson(source.binding)) as AttemptBinding },
        requestRoot: contract.schemas.request,
        responseRoot: contract.schemas.response,
        permitted: false,
        responseOnly: false,
        contentExpires: retention.content_expires_at,
        dedupExpires: retention.dedup_expires_at
      }
      if (closed) {
        fail('native_adapter_closed')
      }
      if (observedInvalidation !== invalidationRevision) {
        fail('attempt_context_invalidated')
      }
      states.set(key, state)
      return resolved(state)
    },
    /** Wire 复用原认证连接；逐 attempt 解析后再注入原调用者当前策略，不从帧导入授权。 */
    wireContext(direction: Direction): AuthenticatedContext {
      maintain()
      const ctx: AuthenticatedContext = {
        ...backend.context(backend.currentPrincipal() ?? '', direction),
        direction,
        validators: { herdr: validator },
        /** 每次以原账本身份解析上下文，并读取该 principal 当前双端策略。 */
        resolveAttempt(identity) {
          const found = api.resolve(identity)
          stateFor(found)
          return found
        }
      }
      return ctx
    },
    /** 实际交付前重查 Store 的原期限/discard；解析原生响应本身不建立可读内容。 */
    checkResult(context: NativeValidationContext): void {
      const state = current(context, 'read')
      if (!state.permitted || backend.contentStatus(state.attempt.binding) !== 'available') {
        fail('content_unavailable')
      }
    },
    /** 只在现有 Store 事务中生成证据计划；仅响应上下文不能重新保留原文。 */
    planEvidence(frame: Extract<AuthenticatedEnvelope, { type: 'response' }>) {
      const context = api.resolve(frame.payload.attempt)
      const state = current(context, 'evidence')
      const ctx = backend.context(state.attempt.principal_id, 'connector_to_gateway')
      const wire: AuthenticatedContext = {
        ...ctx,
        direction: 'connector_to_gateway',
        validators: { ...ctx.validators, herdr: validator },
        resolveAttempt: /** 只解析本适配器已登记的原 attempt，不能由响应帧生成新许可。 */ (identity) =>
          api.resolve(identity)
      }
      return planResponseEvidence(frame, wire, retainedAnchor(state), backend.now())
    },
    /** 释放桥接句柄，不关闭 pane/agent，也不向 Herdr 发送 cancel。 */
    release(context: NativeValidationContext): void {
      const state = states.get(boundedJson(context.binding))
      if (state) {
        drop(stateFor(context))
      }
    },
    /** 仅以原完整 binding 释放缓存；清理不依赖仍有效的调用者授权或可恢复请求原文。 */
    releaseBinding(binding: AttemptBinding): void {
      const state = [...states.values()].find(
        /** 只匹配原 call/attempt；匹配后仍核对其余完整绑定，防止跨连接释放。 */ (entry) =>
          entry.attempt.binding.call_id === binding.call_id && entry.attempt.binding.attempt_id === binding.attempt_id
      )
      if (state) {
        assertBinding(binding, state.attempt.binding)
        drop(state)
      }
    },
    /** 关闭原生桥接缓存与通知，不停止 Herdr 实例或模拟原生取消。 */
    close(): void {
      invalidate({ kind: 'closed' })
    },
    /** 仅暴露计数供资源验收，不输出请求、来源 token 或原生响应。 */
    stats() {
      if (!closed) {
        maintain()
      }
      return {
        closed,
        executions: [...states.values()].filter(/** 只计尚未压缩的执行上下文。 */ (state) => !state.responseOnly)
          .length,
        responses: [...states.values()].filter(/** 只计最小仅响应上下文。 */ (state) => state.responseOnly).length,
        attempt_bytes: [...states.values()].reduce(
          /** 计量已知 attempt 快照，不暴露原文或来源 token。 */ (sum, state) =>
            sum + Buffer.byteLength(boundedJson(state.attempt)),
          0
        )
      }
    }
  })
  unsubscribe = backend.subscribeInvalidation(invalidate)
  if (closed) {
    unsubscribe()
    unsubscribe = undefined
  } else {
    maintenance = setInterval(
      /** 空闲时同样回收固定期限；维护失败使本 adapter 关闭。 */ () => {
        try {
          maintain()
        } catch {
          invalidate({ kind: 'closed' })
        }
      },
      1000
    )
    maintenance.unref()
  }
  return api
}

export { persistentHerdrBackend, commitHerdrResponse } from './persistence.js'
export type { HerdrHostServices } from './persistence.js'
