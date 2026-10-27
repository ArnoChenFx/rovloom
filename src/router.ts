// 依据当前 token 身份与设备范围路由调用、派发和结果操作。
import { canonical, GatewayError, validateRequest } from './contracts.js'
import type { NativeRequest } from './contracts.js'
import { boundedJson, validateTarget } from './wire/index.js'
import type { JsonObject, V2Target } from './wire/types.js'
import { Store } from './store.js'
import type { Call, CallOptions, CallAdmissionOptions, CallAdmission } from './store.js'

// 设备可见性收窄：只接受稳定 machine_id，名字可变因此不参与授权；缺省表示不收窄。
export type DeviceScope = { mode: 'selected'; machine_ids: string[] }
// 身份与设备范围来自认证宿主，不能由 runtime_call 的 JSON 参数构造。
export type Principal = {
  id: string
  device_scope?: DeviceScope
}
export class Router {
  constructor(private readonly store: Store) {}
  // 唯一调用权限来自当前 token 的设备范围。
  private check(principal: Principal, target: V2Target): void {
    if (!principal.id.trim()) {
      throw new GatewayError('unauthenticated')
    }
    if (principal.device_scope && !principal.device_scope.machine_ids.includes(target.machine_id)) {
      throw new GatewayError('forbidden')
    }
  }
  // 快照完整登记输入，并在事务内复核当前身份与设备范围。
  private registration<T extends CallOptions>(
    principal: Principal,
    target: V2Target,
    request: NativeRequest,
    options: T
  ) {
    const snapshot = JSON.parse(
      canonical({
        target,
        request,
        principal: { id: principal.id, ...(principal.device_scope ? { device_scope: principal.device_scope } : {}) },
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
    const authorize = () => {
      if (principal.id !== snapshot.principal.id) {
        throw new GatewayError('unauthenticated')
      }
      this.check(principal, snapshot.target)
    }
    return { ...snapshot, options: snapshot.options, authorize }
  }

  // 登记与取消只返回状态元数据；原文须另经结果读取入口取得，不能借重复 key 或终态取消旁路。
  private metadata(call: Call): Call {
    return { ...call, response: null }
  }
  // 为内部调用保留相对 timeout 和原有 Call 返回值，授权复验与登记共用 writer 事务。
  create(principal: Principal, target: V2Target, request: NativeRequest, options: CallOptions) {
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
    options: CallAdmissionOptions,
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
  // 读取主体所属调用，并按其已登记目标重新核对设备范围。
  private authorized(principal: Principal, callId: string) {
    const call = this.store.call(principal.id, callId)
    this.check(principal, JSON.parse(call.target_json))
    return call
  }
  // 在持久归属、期限和 provider 校验通过后，核对设备范围并返回调用视图。
  get(principal: Principal, callId: string) {
    return this.authorized(principal, callId)
  }
  // 核对当前身份、设备范围与实例状态，提交持久派发锚点后返回有界 JSON 绑定快照。
  dispatch(principal: Principal, callId: string, epoch: string) {
    this.authorized(principal, callId)
    const binding = this.store.dispatch(principal.id, callId, epoch)
    return JSON.parse(boundedJson(binding)) as typeof binding
  }
  // 重新确认调用可读后读取已有句柄元数据；缺失时才经原写事务签发，固定期限不刷新。
  saveResult(principal: Principal, callId: string) {
    this.get(principal, callId)
    return this.store.findResult(principal.id, callId) ?? this.store.saveResult(principal.id, callId)
  }
  // 核对当前身份、设备范围和结果归属，再删除结果句柄和调用原文。
  discardResponse(principal: Principal, callId: string): void {
    this.get(principal, callId)
    this.store.discardResponse(principal.id, callId)
  }
  // 先按句柄解析所属调用并核对设备范围，再返回受字节上限约束的响应分块。
  readResult(principal: Principal, resultId: string, cursor = 0, maxBytes = 65_536) {
    const call = this.store.resultCall(principal.id, resultId)
    this.get(principal, call.call_id)
    return this.store.readResult(principal.id, resultId, cursor, maxBytes)
  }
  // 预检沿用分页的归属、设备范围、期限和参数门禁，不准备或缓存正文页。
  checkResultRead(principal: Principal, resultId: string, cursor = 0, maxBytes = 65_536): void {
    const call = this.store.resultCall(principal.id, resultId)
    this.get(principal, call.call_id)
    this.store.checkResultRead(principal.id, resultId, cursor, maxBytes)
  }
  // 重新核对取消权限后持久停止调用，返回未派发或结果未知等实际状态。
  cancel(principal: Principal, callId: string) {
    this.authorized(principal, callId)
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
