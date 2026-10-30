/**
 * herdr-core 的 Wire 核心：只从 Store 原 attempt 解析身份，按本仓库审核的档位与参数规则建立许可，
 * 结果用本次实例 `rpc.discover` 编译出的审核 schema 复验。这里不连接原生 core、不发送输入，
 * 也不把事件或终端流当作完成证明。
 */
import type { LedgerInvalidation } from '../../storage/model.js'
import type { TrustedAttempt } from '../../wire/backend.js'
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
  validateAttempt
} from '../../wire/index.js'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedContext,
  AuthenticatedEnvelope,
  ContractRecord,
  Direction,
  JsonObject,
  NativePayloadValidator,
  NativeValidationContext,
  ResolvedAttempt,
  V2Target
} from '../../wire/types.js'
import type { ResponseAnchor, ResponseEvidencePlan } from '../../wire/evidence.js'
import type { ProviderBinding } from '../../wire/types.js'
import { herdrCoreExposed, reviewHerdrCoreParams } from './methods.js'
import type { HerdrCoreContract } from './schema.js'

/** 与共享 ContractRecord 共用来源和摘要；编译结果只来自本次实例的 rpc.discover。 */
export type HerdrCoreContractRecord = Readonly<{ wire: ContractRecord; contract: HerdrCoreContract }>

/** 宿主交付的持久事实；本模块不打开 Gateway Store、不建立设备身份或原生连接。 */
export type HerdrCoreBackend = Readonly<{
  currentPrincipal(): string | undefined
  /** 独立查询本地受保护配置，不能以设备广告或 caller Target 建立新 binding。 */
  localProvider(target: V2Target): ProviderBinding | undefined
  /** 每次重新读取认证和双端精确配置；调用方不能把另一个 epoch 拼到原身份上。 */
  context(principal: string, direction: Direction): AuthenticatedContext
  /** 只从受信资源取本次实例的审核契约；缺少编译结果时返回 undefined。 */
  contract(ref: string): HerdrCoreContractRecord | undefined
  attempt(call: string, attempt: string): TrustedAttempt | undefined
  now(): number
  responseAnchor(binding: AttemptBinding): ResponseAnchor
  contentStatus(binding: AttemptBinding): ResponseAnchor['content_status']
  subscribeInvalidation(listener: (event: LedgerInvalidation) => void): () => void
}>

/** 私有 attempt 状态只保存共享身份与固定期限，不缓存原生结果或重派队列。 */
type State = {
  key: string
  binding: AttemptBinding
  principal: string
  method: string
  mode: 'strict' | 'raw-contract'
  permitted: boolean
  responseOnly: boolean
  contentExpires: number
  dedupExpires: number
}

/**
 * 审核请求只允许 method/params，以及 Wire 在准备派发时补入的可信原生 id；
 * 其它字段属于协议不符，不会被静默忽略。
 */
function reviewedRequest(value: unknown): JsonObject & { method: string; params: JsonObject } {
  const request = object(parseJson(boundedJson(value, LIMITS.frame_bytes)))
  fields(request, ['method', 'params'], ['id'])
  if (request.id !== undefined && typeof request.id !== 'string') {
    fail('herdr_core_native_request_invalid')
  }
  if (typeof request.method !== 'string' || !herdrCoreExposed(request.method)) {
    fail('herdr_core_method_unavailable')
  }
  const params = object(request.params)
  reviewHerdrCoreParams(request.method, params)
  return { method: request.method, params }
}

/** 只投影共享 AttemptIdentity，保留 validateAttempt 对额外字段的严格拒绝。 */
function identityOf(binding: AttemptBinding): AttemptIdentity {
  const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...identity } = binding
  return identity
}

/**
 * 建立本 epoch 的 Wire 核心。`contract` 必须已由本次实例的 `rpc.discover` 编译，
 * 不能沿用仓库 fixture 或历史版本的文档。
 */
export function createHerdrCoreAdapter(backend: HerdrCoreBackend) {
  const states = new Map<string, State>()
  let closed = false
  let invalidationRevision = 0
  let unsubscribe: (() => void) | undefined
  let maintenance: ReturnType<typeof setInterval> | undefined

  /** 销毁能力句柄；释放不发送原生 cancel，也不重派原工作。 */
  function drop(state: State): void {
    states.delete(state.key)
  }

  /** 只保留身份与固定期限，原请求正文立即脱离缓存。 */
  function compact(state: State): void {
    if (state.responseOnly) {
      return
    }
    if (!state.permitted) {
      drop(state)
      return
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
        state.binding.machine_id === event.machine_id &&
        (event.kind === 'device_fence' || state.binding.call_id === event.call_id)
      ) {
        if (event.kind === 'content') {
          compact(state)
        } else {
          drop(state)
        }
      }
    }
  }

  /** 空闲维护只依据可信时钟和已固定期限。 */
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
      } else if (!state.responseOnly && now >= state.contentExpires) {
        compact(state)
      }
    }
  }

  /** 锚点始终来自原 Store 记录；固定方法、模式和期限不允许被晚到消息改写。 */
  function retainedAnchor(state: State): ResponseAnchor {
    const found = backend.responseAnchor(state.binding)
    assertBinding(found.binding, state.binding)
    if (
      found.method !== state.method ||
      found.mode !== state.mode ||
      found.content_expires_at !== state.contentExpires ||
      found.dedup_expires_at !== state.dedupExpires ||
      found.state === 'not_dispatched'
    ) {
      fail('attempt_binding_mismatch')
    }
    return found
  }

  /** 从可信账本恢复完整身份；不使用消息构造新 attempt。 */
  function anchor(identity: AttemptIdentity): TrustedAttempt {
    validateAttempt(identity)
    const found = backend.attempt(identity.call_id, identity.attempt_id)
    if (!found) {
      fail('attempt_anchor_unavailable')
    }
    const attempt = JSON.parse(boundedJson(found, LIMITS.frame_bytes)) as TrustedAttempt
    const ctx = backend.context(attempt.principal_id, 'gateway_to_connector')
    if (!ctx.connection.authenticated || !ctx.connection.active) {
      fail('authentication_required')
    }
    assertBinding({ ...ctx.connection, ...identity }, attempt.binding)
    if (
      attempt.binding.provider_kind !== 'herdr-core' ||
      attempt.binding.target.profile !== 'session' ||
      attempt.binding.target.machine_id !== attempt.binding.machine_id ||
      attempt.mode !== 'strict' ||
      attempt.native_request.method !== attempt.method
    ) {
      fail('herdr_core_attempt_unsupported')
    }
    reviewedRequest(attempt.native_request)
    return attempt
  }

  /** 按完整 binding 取得已登记状态；消息不能创建状态，也不能改用另一条 binding。 */
  function stateFor(context: NativeValidationContext): State {
    maintain()
    const state = states.get(boundedJson(context.binding))
    if (!state) {
      fail('attempt_anchor_unavailable')
    }
    assertBinding(context.binding, state.binding)
    if (state.method !== context.method || state.mode !== context.mode) {
      fail('attempt_binding_mismatch')
    }
    return state
  }

  /** 每次调用重新核对许可阶段与内容状态；不能靠缓存放宽读取。 */
  function current(context: NativeValidationContext, phase: 'resolve' | 'read' | 'evidence'): State {
    const state = stateFor(context)
    if (closed) {
      fail('native_adapter_closed')
    }
    if (phase !== 'resolve' && !state.permitted) {
      fail('dispatch_permit_unavailable')
    }
    if (phase === 'read' && backend.contentStatus(state.binding) !== 'available') {
      fail('content_unavailable')
    }
    return state
  }

  const validator: NativePayloadValidator = Object.freeze({
    /** 固定来源方法逐次验证完整参数；普通 RPC 不建立事件订阅或终端流保证。 */
    validateRequest(request: JsonObject, context: NativeValidationContext) {
      const state = current(context, 'resolve')
      const checked = reviewedRequest(request)
      const record = backend.contract(state.binding.contract_ref)
      if (!record) {
        fail('herdr_core_contract_unavailable')
      }
      record.contract.validateParams(checked.method, checked.params)
    },
    /** 回包只能用本次实例的审核结果 schema 复验；来源由宿主可信回调复核。 */
    validateResponse(response: JsonObject, context: NativeValidationContext) {
      const state = current(context, 'read')
      const record = backend.contract(state.binding.contract_ref)
      if (!record) {
        fail('herdr_core_contract_unavailable')
      }
      record.contract.validateResult(state.method, response)
    }
  })

  const api = Object.freeze({
    validator,
    /** 仅显式准备派发时建立 permit；Wire 的纯校验回调不改变已派发状态。 */
    encodeRequest(request: JsonObject, context: NativeValidationContext): void {
      const state = current(context, 'resolve')
      const checked = reviewedRequest(request)
      if (checked.method !== state.method) {
        fail('attempt_binding_mismatch')
      }
      const record = backend.contract(state.binding.contract_ref)
      if (!record) {
        fail('herdr_core_contract_unavailable')
      }
      record.contract.validateParams(checked.method, checked.params)
      state.permitted = true
    },
    /** 注册有界私有句柄；只有后续共享 provider/授权门禁通过才会产生原生请求。 */
    resolve(identity: AttemptIdentity): ResolvedAttempt {
      maintain()
      // 解析期间若收到 Store 失效通知，不能用旧许可建立新状态。
      const observedInvalidation = invalidationRevision
      const key = boundedJson(identity)
      const previous = [...states.values()].find(
        /** 同一 call/attempt 必须仍属于本连接和本 epoch。 */ (entry) => {
          if (entry.binding.call_id !== identity.call_id || entry.binding.attempt_id !== identity.attempt_id) {
            return false
          }
          if (boundedJson(identityOf(entry.binding)) !== key) {
            return false
          }
          const connection = backend.context(entry.principal, 'gateway_to_connector').connection
          return (
            entry.binding.machine_id === connection.machine_id &&
            entry.binding.connection_epoch === connection.connection_epoch &&
            entry.binding.recovery_generation === connection.recovery_generation
          )
        }
      )
      if (previous) {
        const context = Object.freeze({
          binding: previous.binding,
          method: previous.method,
          mode: previous.mode
        })
        current(context, 'resolve')
        return context
      }
      const attempt = anchor(identity)
      providerFor(attempt.binding, backend.context(attempt.principal_id, 'gateway_to_connector'))
      const stateKey = boundedJson(attempt.binding)
      if (states.size >= 128) {
        fail('adapter_limit')
      }
      const record = backend.contract(attempt.binding.contract_ref)
      if (!record || contractRef(record.wire.source) !== attempt.binding.contract_ref) {
        fail('herdr_core_contract_unavailable')
      }
      if (record.wire.support_status !== 'validated' || record.wire.source.provider_kind !== 'herdr-core') {
        fail('herdr_core_contract_unavailable')
      }
      const retention = backend.responseAnchor(attempt.binding)
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
      const checked = reviewedRequest(attempt.native_request)
      record.contract.validateParams(checked.method, checked.params)
      const state: State = {
        key: stateKey,
        binding: JSON.parse(boundedJson(attempt.binding)) as AttemptBinding,
        principal: attempt.principal_id,
        method: attempt.method,
        mode: attempt.mode,
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
      states.set(stateKey, state)
      return Object.freeze({ binding: state.binding, method: state.method, mode: state.mode })
    },
    /** Wire 复用原认证连接；逐 attempt 解析后再注入原调用者当前策略，不从帧导入授权。 */
    wireContext(direction: Direction): AuthenticatedContext {
      maintain()
      const ctx: AuthenticatedContext = {
        ...backend.context(backend.currentPrincipal() ?? '', direction),
        direction,
        validators: { 'herdr-core': validator },
        /** 每次以原账本身份解析上下文，并读取该 principal 当前双端配置。 */
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
      current(context, 'read')
    },
    /** 只在现有 Store 事务中生成证据计划；仅响应上下文不能重新保留原文。 */
    planEvidence(frame: Extract<AuthenticatedEnvelope, { type: 'response' }>): ResponseEvidencePlan {
      const context = api.resolve(frame.payload.attempt)
      const state = current(context, 'evidence')
      const ctx = backend.context(state.principal, 'connector_to_gateway')
      const wire: AuthenticatedContext = {
        ...ctx,
        direction: 'connector_to_gateway',
        validators: { ...ctx.validators, 'herdr-core': validator },
        resolveAttempt: /** 只解析本适配器已登记的原 attempt，不能由响应帧生成新许可。 */ (identity) =>
          api.resolve(identity)
      }
      return planResponseEvidence(frame, wire, retainedAnchor(state), backend.now())
    },
    /** 仅以原完整 binding 释放缓存；清理不依赖仍有效的调用者授权或可恢复请求原文。 */
    releaseBinding(binding: AttemptBinding): void {
      const state = [...states.values()].find(
        /** 只匹配原 call/attempt；匹配后仍核对其余完整绑定，防止跨连接释放。 */ (entry) =>
          entry.binding.call_id === binding.call_id && entry.binding.attempt_id === binding.attempt_id
      )
      if (state) {
        assertBinding(binding, state.binding)
        drop(state)
      }
    },
    /** 关闭本 adapter 的缓存与通知，不停止 core 实例或模拟原生取消。 */
    close(): void {
      invalidate({ kind: 'closed' })
    },
    /** 仅暴露计数供资源验收，不输出请求或原生响应。 */
    stats() {
      if (!closed) {
        maintain()
      }
      return {
        closed,
        executions: [...states.values()].filter(/** 只计尚未压缩的执行上下文。 */ (state) => !state.responseOnly)
          .length,
        responses: [...states.values()].filter(/** 只计最小仅响应上下文。 */ (state) => state.responseOnly).length
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
