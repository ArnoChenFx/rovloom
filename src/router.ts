// 依据宿主可信身份及双方当前 provider 策略路由持久调用、派发和结果操作，逐次授权并保留登记版本边界。
import { canonical, GatewayError, validateRequest } from './contracts.js'
import type { NativeRequest } from './contracts.js'
import { boundedJson, providerScopeAllowed, validateTarget } from './wire/index.js'
import type { JsonObject, ProviderAction, ProviderPolicy, V2Target } from './wire/types.js'
import { Store } from './store.js'
import type { Call, CallOptions, CallAdmissionOptions, CallAdmission } from './store.js'

// 设备可见性收窄：只接受稳定 machine_id，名字可变因此不参与授权；缺省表示不收窄。
export type DeviceScope = { mode: 'selected'; machine_ids: string[] }
// 身份与策略来自认证宿主，不能由 runtime_call 的 JSON 参数构造。
export type Principal = {
  id: string
  policy: ProviderPolicy
  permissions?: { discard_response?: boolean }
  device_scope?: DeviceScope
}
export type LocalPolicies = (target: V2Target) => ProviderPolicy
export class Router {
  // 绑定持久 Store 与宿主本地策略解析器，供每次操作重新执行双方策略检查。
  constructor(
    private readonly store: Store,
    private readonly localPolicies: LocalPolicies
  ) {}
  // 要求有效主体，并按完整 provider 目标及操作类型同时核对调用方和宿主当前策略。
  private check(
    principal: Principal,
    target: V2Target,
    method: string,
    action: ProviderAction,
    local?: ProviderPolicy
  ): void {
    if (!principal.id.trim()) {
      throw new GatewayError('unauthenticated')
    }
    // 范围只是可见性过滤器：不扩大任何 grant，越界目标与无授权同样返回 forbidden。
    if (principal.device_scope !== undefined && !principal.device_scope.machine_ids.includes(target.machine_id)) {
      throw new GatewayError('forbidden')
    }
    // 只使用完整 tuple；revision 由 Store 和真实 native gate 另行核对。
    const binding = { target } as Parameters<typeof providerScopeAllowed>[0]
    if (
      !providerScopeAllowed(binding, method, action, {
        caller: principal.policy,
        local: local ?? this.localPolicies(target)
      })
    ) {
      throw new GatewayError('forbidden')
    }
  }
  // 在宿主策略解析前快照完整登记输入，事务内再以同一份当前本地策略核对授权和版本。
  private registration<T extends Omit<CallOptions, 'caller_policy_revision' | 'local_policy_revision'>>(
    principal: Principal,
    target: V2Target,
    request: NativeRequest,
    options: T
  ) {
    const snapshot = JSON.parse(
      canonical({
        target,
        request,
        principal: { id: principal.id, policy: principal.policy },
        options: {
          binding_revision: options.binding_revision,
          contract_ref: options.contract_ref,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.validation === undefined ? {} : { validation: options.validation }),
          ...(options.client_request_key === undefined ? {} : { client_request_key: options.client_request_key }),
          ...('deadline' in options ? { deadline: options.deadline } : {})
        }
      })
    ) as { target: V2Target; request: NativeRequest; principal: Principal; options: T }
    validateTarget(snapshot.target)
    validateRequest(snapshot.request)
    // 策略解析器只获得独立目标副本，不能改变已快照的登记意图。
    const expectedLocal = JSON.parse(canonical(this.localPolicies({ ...snapshot.target }))) as ProviderPolicy
    const registered = {
      ...snapshot.options,
      caller_policy_revision: snapshot.principal.policy.revision,
      local_policy_revision: expectedLocal.revision
    }
    const authorize = /* writer 已持锁后重取策略；同次检查只使用一个本地策略快照。 */ () => {
      const local = JSON.parse(canonical(this.localPolicies({ ...snapshot.target }))) as ProviderPolicy
      // 快照也携带当前范围：登记与提交之间收窄范围时，提交仍按最新可见性拒绝越界目标。
      const caller = JSON.parse(
        canonical({
          id: principal.id,
          policy: principal.policy,
          ...(principal.device_scope === undefined ? {} : { device_scope: principal.device_scope })
        })
      ) as Principal
      if (
        caller.id !== snapshot.principal.id ||
        caller.policy.revision !== registered.caller_policy_revision ||
        local.revision !== registered.local_policy_revision
      ) {
        throw new GatewayError('policy_revision_changed')
      }
      this.check(caller, snapshot.target, snapshot.request.method, 'dispatch', local)
    }
    return { ...snapshot, options: registered, authorize }
  }
  // 登记与取消只返回状态元数据；原文须另经当前 read 授权读取，不能借重复 key 或终态取消旁路。
  private metadata(call: Call): Call {
    return { ...call, response: null }
  }
  // 为内部调用保留相对 timeout 和原有 Call 返回值，授权复验与登记共用 writer 事务。
  create(
    principal: Principal,
    target: V2Target,
    request: NativeRequest,
    options: Omit<CallOptions, 'caller_policy_revision' | 'local_policy_revision'>
  ) {
    const intent = this.registration(principal, target, request, options)
    return this.metadata(
      this.store.createCall(intent.principal.id, intent.target, intent.request, intent.options, intent.authorize)
    )
  }
  // 将绝对 deadline 原样登记；created 只表示首次意图提交，宿主仍须单独取得派发锚点。
  admit(
    principal: Principal,
    target: V2Target,
    request: NativeRequest,
    options: Omit<CallAdmissionOptions, 'caller_policy_revision' | 'local_policy_revision'>,
    preflight?: (request: JsonObject) => void
  ): CallAdmission {
    if (!Number.isSafeInteger(options.deadline) || options.deadline <= 0 || options.timeoutMs !== undefined) {
      throw new GatewayError('invalid_deadline')
    }
    const intent = this.registration(principal, target, request, options)
    const admitted = this.store.admitCall(
      intent.principal.id,
      intent.target,
      intent.request,
      intent.options,
      intent.authorize,
      preflight
    )
    return { ...admitted, call: this.metadata(admitted.call) }
  }
  // 读取主体所属调用，并按其已登记目标重新核对指定操作的当前双方策略。
  private authorized(principal: Principal, callId: string, action: ProviderAction) {
    const call = this.store.call(principal.id, callId)
    this.check(principal, JSON.parse(call.target_json), call.method, action)
    return call
  }
  // 在持久归属、期限和 provider 校验通过后，重新执行读取策略并返回调用视图。
  get(principal: Principal, callId: string) {
    return this.authorized(principal, callId, 'read')
  }
  // 重验派发策略并核对登记时双方版本，提交持久派发锚点后返回有界 JSON 绑定快照。
  dispatch(principal: Principal, callId: string, epoch: string) {
    const call = this.authorized(principal, callId, 'dispatch')
    // 策略 revision 变更必须作为新意图登记，不能悄悄刷新已登记 attempt。
    const target = JSON.parse(call.target_json) as V2Target
    const binding = this.store.dispatch(principal.id, callId, epoch, {
      caller: principal.policy.revision,
      local: this.localPolicies(target).revision
    })
    return JSON.parse(boundedJson(binding)) as typeof binding
  }
  // 重新确认调用可读后读取已有句柄元数据；缺失时才经原写事务签发，固定期限不刷新。
  saveResult(principal: Principal, callId: string) {
    this.get(principal, callId)
    return this.store.findResult(principal.id, callId) ?? this.store.saveResult(principal.id, callId)
  }
  // 同时要求当前读取授权与独立丢弃权限，再删除结果句柄和调用原文。
  discardResponse(principal: Principal, callId: string): void {
    this.get(principal, callId)
    if (principal.permissions?.discard_response !== true) {
      throw new GatewayError('discard_forbidden')
    }
    this.store.discardResponse(principal.id, callId)
  }
  // 先按句柄解析所属调用并重验读取策略，再返回受字节上限约束的响应分块。
  readResult(principal: Principal, resultId: string, cursor = 0, maxBytes = 65_536) {
    const call = this.store.resultCall(principal.id, resultId)
    this.get(principal, call.call_id)
    return this.store.readResult(principal.id, resultId, cursor, maxBytes)
  }
  // 预检沿用分页的归属、当前双端 ACL、期限和参数门禁，不准备或缓存正文页。
  checkResultRead(principal: Principal, resultId: string, cursor = 0, maxBytes = 65_536): void {
    const call = this.store.resultCall(principal.id, resultId)
    this.get(principal, call.call_id)
    this.store.checkResultRead(principal.id, resultId, cursor, maxBytes)
  }
  // 重新核对取消权限后持久停止调用，返回未派发或结果未知等实际状态。
  cancel(principal: Principal, callId: string) {
    this.authorized(principal, callId, 'cancel')
    return this.metadata(this.store.stop(principal.id, callId))
  }
  // 在限定时长内轮询调用，每轮重新授权；终态或单调等待期限到达时返回当前视图。
  async wait(principal: Principal, callId: string, waitMs = 1000) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new GatewayError('invalid_wait')
    }
    const until = performance.now() + waitMs
    while (true) {
      const call = this.get(principal, callId)
      if (!['created', 'dispatching', 'connector_accepted'].includes(call.state) || performance.now() >= until) {
        return call
      }
      await new Promise(
        /* 按剩余等待时间安排 1 至 50 毫秒的下一次轮询唤醒。 */ (resolve) =>
          setTimeout(resolve, Math.min(50, Math.max(1, until - performance.now())))
      )
    }
  }
}
