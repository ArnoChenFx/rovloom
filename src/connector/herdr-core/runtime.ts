/**
 * herdr-core 的 Connector 执行端：把已准入的普通 Wire 请求转成一次 framed JSON-RPC 调用，
 * 结果用本次实例 `rpc.discover` 编译出的审核 schema 复验。这里不订阅事件、不发送输入、
 * 不宣称 turn 完成，也不把超时解释成原生停止。
 */
import { DispatchClaims } from '../claims.js'
import { ProviderAdapterError } from '../provider-error.js'
import { GatewayError } from '../../contracts.js'
import { assertBinding, boundedJson, fail, object } from '../../wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope, JsonObject } from '../../wire/types.js'
import type { ConnectorWireSession, WireExecutionResult } from '../../transport/connector.js'
import { createProviderWireAdapter } from '../../runtime/provider-wire.js'
import { ConnectorAttemptBook, createConnectorAdmissionBackend } from '../../runtime/connector-attempts.js'
import type { Connection } from '../../transport/index.js'
import { createHerdrCoreAdapter } from './readonly.js'
import type { HerdrCoreBackend } from './readonly.js'
import type { HerdrCoreAttachment } from './installation.js'
import { HERDR_CORE_REATTACH_WINDOW_MS } from './installation.js'
import { contractRef } from '../../wire/index.js'
import type { V2Target } from '../../wire/types.js'
import { herdrCoreRequestTimeout, herdrCoreControl, reviewHerdrCoreParams } from './methods.js'
import { assertHerdrCoreTerminal, herdrCoreControlNativeParams } from './control.js'
import { assertTerminalExecutionAllowed } from '../terminal-execution.js'

/** 已验证的 herdr-core 本机来源与当前 epoch 的受保护路由。 */
export type HerdrCoreConnectorOptions = Readonly<{
  installation: HerdrCoreAttachment
  connection: Connection
  target: V2Target & { profile: 'session' }
  principal_id: string
  binding: Readonly<{
    machine_id: string
    provider_id: string
    kind: 'herdr-core'
    config_ref: string
    binding_revision: number
    enabled: boolean
  }>
  now(): number
  /** 本机直接终端输入开关；省略即关闭。目录、Gateway 登记与最终写入三处共用同一个观察值。 */
  terminalExecution?: () => boolean
}>

/** 只允许 method/params 与 Wire 注入的原生 id；未知字段是协议不符。 */
function reviewedRequest(value: unknown): Readonly<{ method: string; params: JsonObject }> {
  const request = object(value)
  for (const key of Object.keys(request)) {
    if (key !== 'method' && key !== 'params' && key !== 'id') {
      fail('herdr_core_native_request_invalid')
    }
  }
  if (request.id !== undefined && typeof request.id !== 'string') {
    fail('herdr_core_native_request_invalid')
  }
  if (typeof request.method !== 'string') {
    fail('herdr_core_method_unavailable')
  }
  const params = object(request.params)
  reviewHerdrCoreParams(request.method, params)
  return { method: request.method, params }
}

/** 只在本 epoch 内保存已观察的完整绑定；连接关闭即丢弃。 */
export function createHerdrCoreConnectorRuntime(
  options: HerdrCoreConnectorOptions,
  claims: DispatchClaims,
  book: ConnectorAttemptBook
) {
  const { installation, target, binding, principal_id } = options
  const reference = contractRef(installation.record().wire.source)
  const admission = createConnectorAdmissionBackend({
    connection: options.connection,
    routes: [{ target, principal_id }],
    book,
    source: { now: options.now }
  })
  const listeners = new Set<(event: import('../../storage/model.js').LedgerInvalidation) => void>()
  const backend: HerdrCoreBackend = {
    ...admission,
    contract: /** 只解析本资源实际连接的契约摘要。 */ (ref) => (ref === reference ? installation.record() : undefined),
    now: options.now,
    currentPrincipal: admission.currentPrincipal,
    localProvider: /** 固定受保护目标；不读取 Gateway Store 或 caller 参数。 */ (value) =>
      boundedJson(value) === boundedJson(target) ? binding : undefined,
    context: /** 每次使用准入后端当前 epoch；关闭后旧连接不能继续通过认证。 */ (principal, direction) => ({
      phase: 'authenticated',
      direction,
      connection: admission.connection(),
      resolveProvider: /** 只解析这一个完整固定目标。 */ (value) =>
        boundedJson(value) === boundedJson(target) ? binding : undefined,
      resolveContract: /** 原生契约只来自实际连接与本机审核。 */ (ref) =>
        ref === reference ? installation.record().wire : undefined
    }),
    /** Connector 没有 Gateway 锚点：以已解码的本机 attempt 合成，期限取原请求 deadline。 */
    responseAnchor(value: AttemptBinding) {
      const stored = admission.attempt(value.call_id, value.attempt_id)
      if (!stored) {
        fail('attempt_anchor_unavailable')
      }
      assertBinding(value, stored.binding)
      return {
        binding: structuredClone(stored.binding),
        method: stored.method,
        mode: stored.mode,
        state: 'connector_accepted',
        content_status: options.now() < value.registration.deadline ? 'available' : 'expired',
        content_expires_at: value.registration.deadline,
        dedup_expires_at: value.registration.deadline
      }
    },
    subscribeInvalidation: /** 只转接本 epoch 的关闭通知。 */ (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const core = createHerdrCoreAdapter(backend)
  const adapter = createProviderWireAdapter(core, 'herdr_core_transport_unsupported', options.now)
  // 执行侧独立消息窗口；与 adapter 共用同一 core permit，避免已观察消息二次执行。
  const execution = createProviderWireAdapter(core, 'herdr_core_transport_unsupported', options.now)
  const seen = new Map<string, number>()
  const active = new Set<AbortController>()
  let closed = false
  let highWater = -1

  /** 不回退的宿主时钟；回拨直接拒绝，不修正期限。 */
  function now(): number {
    const value = options.now()
    if (!Number.isSafeInteger(value) || value < 0 || value < highWater) {
      throw new ProviderAdapterError('clock_untrusted')
    }
    highWater = value
    return value
  }

  function checkSignal(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ProviderAdapterError('herdr_core_cancelled')
    }
  }

  /** 在每次原生写入前重新核对本机来源与当前 epoch，不缓存旧许可。 */
  async function executeWire(input: string, signal: AbortSignal): Promise<WireExecutionResult> {
    let dispatched = false
    const controller = new AbortController()
    const cancel = /** 只结束本地等待；不向 core 发送取消或控制请求。 */ () => controller.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
    }
    active.add(controller)
    try {
      if (closed) {
        throw new ProviderAdapterError('herdr_core_runtime_closed')
      }
      checkSignal(controller.signal)
      const decoded = execution.decode(input, 'gateway_to_connector')
      if (decoded.type !== 'request' || !('connection_epoch' in decoded)) {
        throw new ProviderAdapterError('herdr_core_request_required')
      }
      const frame = decoded as Extract<AuthenticatedEnvelope, { type: 'request' }>
      const observedBinding: AttemptBinding = {
        machine_id: frame.machine_id,
        recovery_generation: frame.recovery_generation,
        connection_epoch: frame.connection_epoch,
        ...frame.payload.attempt
      }
      if (!installation.source(observedBinding)) {
        throw new ProviderAdapterError('herdr_core_binding_mismatch')
      }
      const observed = now()
      const remaining = observedBinding.registration.deadline - observed
      if (remaining <= 0) {
        throw new ProviderAdapterError('herdr_core_timeout')
      }
      for (const [previous, expires] of seen) {
        if (expires <= observed) {
          seen.delete(previous)
        }
      }
      const key = boundedJson(observedBinding)
      if (seen.has(key)) {
        throw new ProviderAdapterError('attempt_already_observed')
      }
      if (seen.size >= 4096 || active.size > 8) {
        throw new ProviderAdapterError('herdr_core_runtime_limit')
      }
      if (execution.observeMessage(frame, 'gateway_to_connector') !== 'new') {
        throw new ProviderAdapterError('duplicate_message')
      }
      seen.set(key, observedBinding.registration.deadline)
      const request = reviewedRequest(frame.payload.native_request)
      // 直接输入与控制档必须显式打开本机开关；关闭时在原生写入前拒绝，结果确定未派发。
      assertTerminalExecutionAllowed(
        'herdr-core',
        { method: request.method, params: request.params },
        options.terminalExecution ? options.terminalExecution() : false
      )
      // core 退出或被 holder 重建后先重新附着：退避与上限在附着层，预算不超过调用方剩余期限。
      await installation.ensure(Math.min(Math.max(1, remaining - 1000), HERDR_CORE_REATTACH_WINDOW_MS))
      const left = observedBinding.registration.deadline - now()
      if (left < 1) {
        throw new ProviderAdapterError('herdr_core_timeout')
      }
      const timeout = Math.min(left, herdrCoreRequestTimeout(request.method, request.params))
      if (timeout < 1) {
        throw new ProviderAdapterError('herdr_core_timeout')
      }
      const context = core.resolve(frame.payload.attempt)
      // 唯一发送墓碑与实际写入在同一同步边界前准备；失败不自动重放。
      core.encodeRequest(
        { method: request.method, params: request.params, id: observedBinding.native_request_id },
        context
      )
      // 先复核本机来源，再写发送墓碑：来源已变化时不能把一次未发送的意图记成已发送。
      installation.assert()
      // 控制档在写入前自己核对终端三元组并判断 blocked：core 只在 send 上拦 blocked（spike 3f）。
      if (herdrCoreControl(request.method)) {
        await assertHerdrCoreTerminal({
          client: installation.client(),
          contract: installation.record().contract,
          method: request.method,
          params: request.params,
          timeout_ms: timeout
        })
        installation.assert()
      }
      const anchor = backend.responseAnchor(observedBinding)
      claims.claim(observedBinding, anchor.dedup_expires_at)
      checkSignal(controller.signal)
      dispatched = true
      // 栅栏字段只属于 rovloom，core 不认识它们；发送前显式剥离，不依赖 core 静默忽略未知字段。
      const result = await installation
        .client()
        .request(request.method, herdrCoreControlNativeParams(request.params), timeout)
      checkSignal(controller.signal)
      installation.assert()
      core.validator.validateResponse(result, context)
      return Object.freeze({ binding: observedBinding, native_response: result })
    } catch (error) {
      const code =
        error instanceof ProviderAdapterError || error instanceof GatewayError
          ? error.code
          : ((error as { code?: string })?.code ?? 'herdr_core_runtime_unavailable')
      if (code === 'herdr_core_connection_closed') {
        // 连接已断：丢弃当前值，下一次调用重新走完整身份核对；原调用不重放。
        installation.invalidate()
      }
      throw new ProviderAdapterError(code, dispatched ? 'outcome_unknown' : 'not_dispatched')
    } finally {
      signal.removeEventListener('abort', cancel)
      active.delete(controller)
    }
  }

  const session: ConnectorWireSession = {
    adapter,
    executeWire,
    nativeVersions: /** 连接上报固定来源的已实测版本；不重新探测 core。 */ () => [
      { provider_id: binding.provider_id, native_version: installation.record().wire.source.binary_version }
    ],
    readiness:
      /**
       * 只在附着能力仍存在时报告可用：core 正在被 holder 重建时不能报告不可用，
       * 否则 transport 会永久撤回 provider。真实身份仍由每次写入前的 ensure/assert 核对，
       * 断线期间的调用明确失败（未派发），不重放、不悬挂。
       */ () => {
        if (closed) {
          fail('herdr_core_runtime_closed')
        }
        const status = installation.status()
        if (status.state === 'closed') {
          fail('herdr_core_installation_closed')
        }
        if (status.state === 'detached') {
          void installation.ensure(HERDR_CORE_REATTACH_WINDOW_MS).catch(/** 重新附着失败由调用路径报告。 */ () => {})
        }
        return { providers: [{ expected: binding, local: binding, native_ready: true }] }
      },
    /** 目录与 Gateway 共用这一个本机开关观察值；最终写入仍由 executeWire 再检查。 */
    terminalExecutionState: () => [
      { binding, enabled: options.terminalExecution ? options.terminalExecution() : false }
    ],
    close: /** 只关闭本 epoch 的桥接与等待；外部 core 与共享墓碑仍归宿主所有。 */ () => {
      closed = true
      for (const controller of active) {
        controller.abort('closed')
      }
      execution.close()
      adapter.close()
      admission.close()
      for (const listener of listeners) {
        listener({ kind: 'closed' })
      }
      listeners.clear()
    }
  }
  return { session, admission, core }
}
