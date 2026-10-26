// 实现主动出站的 Connector 通道，隔离连接 epoch、原生执行与退避重连，禁止自动重放。
import { randomUUID } from 'node:crypto'
import { GatewayError } from '../contracts.js'
import { ConnectorCapacityError } from '../connector/capacity.js'
import type { ConnectorCapacity } from '../connector/capacity.js'
import {
  assertBinding,
  boundedJson,
  decodeWireFrame,
  encodeDispatchRefusalFrame,
  encodeWireFrame,
  fail,
  hash,
  LIMITS,
  object,
  parseJson,
  validateProviderSnapshot,
  validateProvider,
  validateOffer,
  WireError
} from '../wire/index.js'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedEnvelope,
  JsonObject,
  ProviderSnapshot,
  ProviderBinding,
  WireEnvelope,
  VersionOffer
} from '../wire/types.js'
import type { DeviceCredential } from './identity.js'
import { dispatchRefusal } from './dispatch-refusal.js'
import {
  budget,
  closeSession,
  discardProviderFrame,
  fenceSessionProvider,
  endpoint,
  envelope,
  OFFER,
  positive,
  providerHealth,
  ready,
  ReceiveWindow,
  socket
} from './common.js'
import type { Connection, Session, Socket } from './common.js'
import { DisconnectLog, remoteDisconnect } from './disconnect.js'
import type { DisconnectReason } from './disconnect.js'

export type WireExecutionResult = Readonly<{ binding: AttemptBinding; native_response: JsonObject }>
export type ConnectorWireSession = Session & {
  /** 将收到的原始已验证 Wire request 交给本会话原生 adapter；不得剥字段重包装或再次注入 auth。 */
  executeWire(wireRequest: string, signal: AbortSignal): Promise<WireExecutionResult>
}
type ConnectorBaseOptions = {
  url: string
  developmentLoopback?: boolean
  /** 从受保护启动输入取得稳定设备凭据，不能按自报 hostname 创建身份。 */
  credential(): DeviceCredential
  offer?: VersionOffer
  /** 提供有界退避的随机采样，不影响请求授权或派发去重。 */
  random?: () => number
  /** 提供独立可信时间，调用方仍须检查单调性和固定到期边界。 */
  now?: () => number
  /** 只供测试注入受控 socket 桩，以构造真实 runtime 不可复现的事件顺序；生产不传。 */
  socketFactory?: (socket: Socket) => Socket
  limits?: Partial<{
    heartbeat_ms: number
    idle_ms: number
    handshake_ms: number
    reconnect_ms: number
    reconnect_max_ms: number
    inflight: number
    frame_bytes: number
    messages_per_second: number
  }>
}
export type NativeConnectorOptions = ConnectorBaseOptions & {
  limits?: ConnectorBaseOptions['limits'] & { native_bytes?: number }
  /** 为当前认证连接创建独立 Wire adapter、可信 readiness 和资源清理接口。 */
  session(connection: Connection): Session & { executeWire?: never }
  /** 只向已校验请求注入受信原生 auth；调用方随后检查完整 JSON 帧预算。 */
  nativeInput(request: JsonObject, binding: AttemptBinding): JsonObject
  /** 按账本固定 binding 选择受信本机 adapter，接收观察中止并返回原生响应。 */
  execute(raw: string, signal: AbortSignal, binding: AttemptBinding): Promise<JsonObject>
}
export type WireConnectorOptions = ConnectorBaseOptions & {
  /** 为每个新 epoch 创建专用执行 hook；close 必须同时关闭该原生 adapter，不能复用旧会话状态。 */
  session(connection: Connection): ConnectorWireSession
  nativeInput?: never
  execute?: never
}
export type ConnectorOptions = NativeConnectorOptions | WireConnectorOptions
/**
 * 本机主动关闭的连接用 1000/空原因：Gateway 真实关闭是 1008/transport_closed，
 * 二者不重叠，本机关闭帧的回声因此不会被归为对端事件。
 */
const LOCAL_CLOSE_CODE = 1000
/** 初次发布前核对整个快照为不可变纯数据；后续 tick 可只比引用，不反复遍历大 capabilities。 */
function frozenSnapshot(value: unknown): void {
  if (value && typeof value === 'object') {
    if (!Object.isFrozen(value)) {
      fail('provider_snapshot_not_frozen')
    }
    for (const child of Object.values(value)) {
      frozenSnapshot(child)
    }
  }
}
/** 建立受信配置驱动的出站通道，管理握手、心跳、限额和退避；重连不迁入或重放原请求。 */
export function createConnector(options: ConnectorOptions) {
  const url = endpoint(options.url, options.developmentLoopback).href
  const limits = {
    heartbeat_ms: 5000,
    idle_ms: 20_000,
    handshake_ms: 5000,
    reconnect_ms: 250,
    reconnect_max_ms: 30_000,
    inflight: 8,
    frame_bytes: LIMITS.frame_bytes,
    native_bytes: LIMITS.frame_bytes,
    messages_per_second: 256,
    ...options.limits
  }
  Object.values(limits).forEach(
    /** 逐项验证 Connector 资源配置，拒绝非正数或不安全整数。 */
    (v) => positive(v)
  )
  positive(limits.frame_bytes, LIMITS.frame_bytes)
  positive(limits.native_bytes, LIMITS.frame_bytes)
  const offer = structuredClone(options.offer ?? OFFER)
  validateOffer(offer)
  const instance = randomUUID()
  let ws: Socket | undefined
  let connection: Connection | undefined
  let session: Session | ConnectorWireSession | undefined
  let stopped = false
  let phase = 'disconnected'
  let failure: string | undefined
  /** 累计断开记录与有界队列；只增计数让快速重连不被采样窗口吞掉，队列避免同窗口多次断开被覆盖。 */
  const disconnects = new DisconnectLog()
  /** 本机刚收敛的 socket：其远端关闭事件若早于下一个 epoch 到达，可纠正为实际观察值。 */
  let settled: Socket | undefined
  let capacity: ConnectorCapacity | undefined
  let next = 0
  let retries = 0
  let opened = 0
  let last = 0
  let sentAt = 0
  let sent = 0
  let sequence = 0
  let messages = 0
  let messageWindow = 0
  const running = new Map<string, { controller: AbortController; binding: AttemptBinding }>()
  const seen = new Map<string, number>()
  const providerFences = new Map<string, ProviderBinding>()
  let received = new ReceiveWindow()
  let observedTime = 0
  const terminalReported = new Map<string, string>()
  let published:
    | {
        connection: Connection
        session: Session
        socket: Socket
        snapshots: readonly ProviderSnapshot[]
        fingerprints: readonly string[]
      }
    | undefined
  /** 读取宿主可信时间并保持进程内高水位，回拨时拒绝继续执行。 */
  function trustedTime(): number {
    const now = (options.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < observedTime) {
      fail('clock_untrusted')
    }
    observedTime = now
    return now
  }
  /** 只永久撤回当前 epoch 的原 provider；同连接其它来源与在途观察保持独立。 */
  function fenceProvider(active: Connection, current: Session, binding: ProviderBinding, announce = true): void {
    validateProvider(binding)
    if (connection !== active || session !== current || stopped || binding.machine_id !== active.machine_id) {
      fail('connection_binding_mismatch')
    }
    const previous = providerFences.get(binding.provider_id)
    if (previous) {
      if (boundedJson(previous) !== boundedJson(binding)) {
        fail('provider_binding_mismatch')
      }
      return
    }
    providerFences.set(binding.provider_id, structuredClone(binding))
    fenceSessionProvider(current, binding)
    if (published?.connection === active && published.session === current) {
      const retained = published.snapshots
        .map(
          /** 保留健康来源的原引用与原摘要，不刷新 generation。 */ (snapshot, index) => ({
            snapshot,
            fingerprint: published!.fingerprints[index]!
          })
        )
        .filter(
          /** 已失效元数据不再作为活快照保留。 */ (entry) => entry.snapshot.binding.provider_id !== binding.provider_id
        )
      published.snapshots = Object.freeze(retained.map(/** 保留原纯数据对象。 */ (entry) => entry.snapshot))
      published.fingerprints = Object.freeze(retained.map(/** 保留对应原指纹。 */ (entry) => entry.fingerprint))
    }
    for (const runningCall of running.values()) {
      if (runningCall.binding.target.provider_id === binding.provider_id) {
        runningCall.controller.abort('provider_unavailable')
      }
    }
    if (connection !== active || session !== current || stopped) {
      fail('connection_unavailable')
    }
    if (announce) {
      write(envelope(active, 'provider_fenced', { binding }))
    }
  }
  /** 从原 owner 的当前健康和永久 fence 同步撤回，不由远端广告构造 ready 或替换 binding。 */
  function reconcileProviders(active: Connection, current: Session): void {
    if (!active.negotiated.capabilities.includes('provider_fence')) {
      return
    }
    const state = current.readiness()
    const health = providerHealth(active, state)
    const fenced = current.providerFences?.() ?? []
    if (fenced.length > 64) {
      fail('provider_limit')
    }
    for (const binding of fenced) {
      fenceProvider(active, current, binding)
    }
    for (const provider of state.providers) {
      if (
        !health.find(/** 只检查同一原 provider 的观测。 */ (row) => row.provider_id === provider.local.provider_id)!
          .ready
      ) {
        fenceProvider(active, current, provider.local)
      }
    }
  }
  /** 快照 getter 必须同步返回；违规异步来源的晚到拒绝被消费，但不当作来源已接纳。 */
  function snapshots(current: Session): readonly ProviderSnapshot[] {
    const values = current.providerSnapshot?.()
    if (
      !Array.isArray(values) ||
      (values.length < 1 && !connection?.negotiated.capabilities.includes('provider_fence')) ||
      values.length > 64
    ) {
      void Promise.resolve(values).catch(/** 关闭之外仍消费违规异步 getter 的晚到拒绝。 */ () => {})
      fail('provider_snapshot_source_required')
    }
    return values
  }
  /** tick 只复核稳定引用与实际 readiness；心跳和请求边界再完整比较固定 fingerprint。 */
  function assertSnapshots(active: Connection, current: Session, full = false): void {
    if (!active.negotiated.capabilities.includes('provider_snapshot')) {
      return
    }
    const captured = published
    if (
      !captured ||
      captured.connection !== active ||
      captured.session !== current ||
      connection !== active ||
      session !== current ||
      ws !== captured.socket ||
      stopped
    ) {
      fail('connection_unavailable')
    }
    let values = snapshots(current)
    reconcileProviders(active, current)
    if (active.negotiated.capabilities.includes('provider_fence')) {
      // getter 与健康复核之间来源也可能失效；只移除刚永久撤回的原条目，健康快照仍逐项比较。
      values = values.filter(
        /** 失效条目不再属于本 epoch 的已发布活来源。 */ (snapshot) => !providerFences.has(snapshot.binding.provider_id)
      )
    }
    if (values.length !== captured.snapshots.length) {
      fail('provider_snapshot_changed')
    }
    for (let index = 0; index < values.length; index++) {
      if (
        values[index] !== captured.snapshots[index] ||
        (full && hash(boundedJson(values[index])) !== captured.fingerprints[index])
      ) {
        fail('provider_snapshot_changed')
      }
    }
    const health = providerHealth(active, current.readiness())
    for (const value of active.negotiated.capabilities.includes('provider_fence') ? [] : values) {
      if (
        !health.some(
          /** 每个已发布目标都必须仍有真实 native readiness。 */ (item) =>
            item.provider_id === value.binding.provider_id && item.ready
        )
      ) {
        fail('provider_not_ready')
      }
    }
    if (published !== captured || connection !== active || session !== current || ws !== captured.socket || stopped) {
      fail('connection_unavailable')
    }
  }
  /** 只发布本 epoch 的本地有效开关；原生能力与执行许可仍走各自原接口。 */
  function publishTerminalExecution(active: Connection, current: Session): void {
    if (!active.negotiated.capabilities.includes('terminal_execution_state')) {
      return
    }
    const values = current.terminalExecutionState?.() ?? []
    if (!Array.isArray(values) || values.length > 64) {
      void Promise.resolve(values).catch(/** 不接受异步配置结果，也不遗留无人观察的拒绝。 */ () => {})
      fail('terminal_execution_state_invalid')
    }
    const seen = new Set<string>()
    for (const value of values) {
      validateProvider(value.binding)
      const provider = value.binding.provider_id
      if (value.binding.machine_id !== active.machine_id || typeof value.enabled !== 'boolean' || seen.has(provider)) {
        fail('terminal_execution_state_invalid')
      }
      seen.add(provider)
      if (providerFences.has(provider)) {
        continue
      }
      const payload = { binding: value.binding, enabled: value.enabled }
      const fingerprint = boundedJson(payload)
      if (terminalReported.get(provider) === fingerprint) {
        continue
      }
      if (connection !== active || session !== current || stopped) {
        fail('connection_unavailable')
      }
      write(envelope(active, 'terminal_execution_state', payload))
      terminalReported.set(provider, fingerprint)
    }
  }
  /** welcome 后仅向原 socket 各发布一次单 provider 快照；任何重入、替换或背压都关闭原 epoch。 */
  function publishSnapshots(active: Connection, current: Session): void {
    if (!active.negotiated.capabilities.includes('provider_snapshot')) {
      return
    }
    const values = snapshots(current)
    const seenProviders = new Set<string>()
    const fingerprints: string[] = []
    let bytes = 0
    for (const value of values) {
      validateProviderSnapshot(value)
      if (value.binding.machine_id !== active.machine_id || seenProviders.has(value.binding.provider_id)) {
        fail('provider_snapshot_binding_mismatch')
      }
      seenProviders.add(value.binding.provider_id)
      const raw = boundedJson(value)
      bytes += Buffer.byteLength(raw)
      if (bytes > LIMITS.buffered_bytes) {
        fail('provider_snapshot_limit')
      }
      fingerprints.push(hash(raw))
    }
    frozenSnapshot(values)
    if (!ws || connection !== active || session !== current || stopped) {
      fail('connection_unavailable')
    }
    published = { connection: active, session: current, socket: ws, snapshots: values, fingerprints }
    for (const value of values) {
      assertSnapshots(active, current)
      if (providerFences.has(value.binding.provider_id)) {
        continue
      }
      write(envelope(active, 'provider_snapshot', value))
    }
    assertSnapshots(active, current, true)
  }
  /** 中止旧会话观察、关闭宿主资源并清空连接去重状态；未完成原生工作仍占并发额度。 */
  function clearSession(): void {
    for (const { controller } of running.values()) {
      controller.abort()
    }
    const previous = session
    // 先撤下活动引用，避免宿主关闭回调重入时再次消费同一 epoch。
    session = undefined
    connection = undefined
    published = undefined
    try {
      closeSession(previous)
    } catch {
      /* 关闭错误不进入日志。 */
    }
    seen.clear()
    providerFences.clear()
    received = new ReceiveWindow()
  }
  /** 实际连接尝试失败或活动 socket 收敛后才推进退避；重复 disconnect 不调用它。 */
  function scheduleReconnect(): void {
    const random = (options.random ?? Math.random)()
    const jitter = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 1
    next =
      performance.now() +
      Math.max(1, jitter * Math.min(limits.reconnect_max_ms, limits.reconnect_ms * 2 ** Math.min(retries++, 16)))
  }

  /** 只记录实际存在的 socket；无连接时保留尚待订正的记录，停止仅更新全局相位。 */
  function close(reason: DisconnectReason = stopped ? 'connector_stopped' : 'connector_failure', code?: number): void {
    const previous = ws
    if (previous === undefined) {
      if (stopped) {
        phase = 'stopped'
        settled = undefined
      }
      return
    }
    ws = undefined
    // 底层 error 的后续 close 可订正记录；本机主动关闭已定性，不接受回声订正。
    settled = reason === 'transport_unavailable' ? previous : undefined
    clearSession()
    phase = stopped ? 'stopped' : 'disconnected'
    // 本机收敛的断开不带对端关闭码；对端事件定性时只附带实际观察到的有界码。
    disconnects.record(Object.freeze(code === undefined ? { reason } : { code, reason }))
    if (!stopped) {
      scheduleReconnect()
    }
    /**
     * 本机主动关闭用 1000：Gateway 真实关闭是 1008/transport_closed，
     * 所以这条帧的回声（码 1000）不会被当对端事件，也不会被当成网关主动关闭。
     */
    previous?.close(LOCAL_CLOSE_CODE, '')
    previous?.terminate()
  }
  /** 用当前认证上下文编码并写出单帧，预算或背压异常交给调用者收敛关闭。 */
  function write(frame: AuthenticatedEnvelope): void {
    if (!session || !connection || !ws || ws.readyState !== 1) {
      fail('connection_unavailable')
    }
    const raw = budget(session.adapter.encode(frame, 'connector_to_gateway'), limits.frame_bytes)
    if (ws.bufferedAmount + Buffer.byteLength(raw) > limits.frame_bytes || ws.send(raw) <= 0) {
      fail('transport_backpressure')
    }
  }
  /** 准入层确定性拒绝后仅提取固定 attempt 字段供拒绝帧回指；完整校验由网关 codec anchored 完成。 */
  function decodeStaleAttempt(raw: string): AttemptIdentity | undefined {
    try {
      const parsed = object(parseJson(budget(raw, limits.frame_bytes)))
      if (parsed.type !== 'request' || parsed.machine_id !== connection?.machine_id) {
        return undefined
      }
      const payload = object(parsed.payload)
      const attempt = object(payload.attempt)
      const target = object(attempt.target)
      const registration = object(attempt.registration)
      return {
        call_id: String(attempt.call_id),
        attempt_id: String(attempt.attempt_id),
        native_request_id: String(attempt.native_request_id),
        target: {
          machine_id: String(target.machine_id),
          provider_id: String(target.provider_id),
          ...(target.profile === 'host'
            ? { profile: 'host' as const }
            : { profile: 'session' as const, session: String(target.session) })
        },
        provider_kind: attempt.provider_kind === 'herdr' ? 'herdr' : 'luvus',
        binding_revision: Number(attempt.binding_revision),
        contract_ref: String(attempt.contract_ref),
        registration: {
          deadline: Number(registration.deadline),
          caller_policy_revision: String(registration.caller_policy_revision),
          local_policy_revision: String(registration.local_policy_revision)
        }
      }
    } catch {
      return undefined
    }
  }
  /**
   * 准入拒绝发生在原 adapter 登记执行锚点之前，拒绝帧不能经 session.adapter.encode
   * （anchored 需要从未建立的锚点）；只绑定当前连接编码，锚点复核由网关在其自身账本完成。
   */
  function writeStaleRefusal(stale: AttemptIdentity): void {
    if (!session || !connection || !ws || ws.readyState !== 1) {
      fail('connection_unavailable')
    }
    const raw = budget(
      encodeDispatchRefusalFrame(
        envelope(connection, 'dispatch_refused', { attempt: stale, code: 'policy_revision_stale' }),
        {
          phase: 'authenticated',
          direction: 'connector_to_gateway',
          connection: {
            machine_id: connection.machine_id,
            recovery_generation: connection.recovery_generation,
            connection_epoch: connection.connection_epoch,
            authenticated: true,
            active: true,
            negotiated: connection.negotiated
          }
        }
      ),
      limits.frame_bytes
    )
    if (ws.bufferedAmount + Buffer.byteLength(raw) > limits.frame_bytes || ws.send(raw) <= 0) {
      fail('transport_backpressure')
    }
  }
  /** 在原 Wire 上下文内发送单个响应帧；超过单帧上限的响应在 write 的预算检查处失败，不分片。 */
  function sendResponse(binding: AttemptBinding, response: JsonObject, active: Connection, current: Session): void {
    const { machine_id: _machine, recovery_generation: _generation, connection_epoch: _epoch, ...attempt } = binding
    current.adapter.checkResult(binding, response)
    write(envelope(active, 'response', { attempt, native_response: response }))
  }
  /** 消费单次 attempt，复验 ready/deadline 并在 auth 注入后检查完整预算；旧会话响应不再交付。 */
  async function request(
    frame: Extract<AuthenticatedEnvelope, { type: 'request' }>,
    wireRequest: string,
    active: Connection,
    current: Session | ConnectorWireSession
  ): Promise<void> {
    reconcileProviders(active, current)
    assertSnapshots(active, current, true)
    const binding: AttemptBinding = {
      machine_id: active.machine_id,
      recovery_generation: active.recovery_generation,
      connection_epoch: active.connection_epoch,
      ...frame.payload.attempt
    }
    const now = trustedTime()
    if (now >= binding.registration.deadline) {
      fail('deadline_exceeded')
    }
    // 已过期意图在执行门禁恒被拒绝；只回收去重索引，不取消仍在收敛的原生工作。
    for (const [key, deadline] of seen) {
      if (now >= deadline) {
        seen.delete(key)
      }
    }
    const name = binding.call_id + ':' + binding.attempt_id
    if (seen.has(name)) {
      fail('attempt_replay_rejected')
    }
    if (seen.size >= 4096 || running.size >= limits.inflight) {
      fail('transport_concurrency_limit')
    }
    if (!ready(current, active, binding.target.provider_id)) {
      fail('provider_not_ready')
    }
    if (trustedTime() >= binding.registration.deadline) {
      fail('deadline_exceeded')
    }
    seen.set(name, binding.registration.deadline)
    const controller = new AbortController()
    running.set(name, { controller, binding })
    try {
      const executeWire = 'executeWire' in current ? current.executeWire : undefined
      let nativeRequest: string | undefined
      if (!executeWire) {
        if (!options.nativeInput || !options.execute) {
          fail('connector_execution_required')
        }
        const original = { ...frame.payload.native_request, id: binding.native_request_id }
        const injected = options.nativeInput(structuredClone(original), structuredClone(binding))
        const { auth: _auth, ...withoutAuth } = injected
        if (boundedJson(withoutAuth) !== boundedJson(original)) {
          fail('native_input_mismatch')
        }
        nativeRequest = budget(boundedJson(injected, limits.native_bytes), limits.native_bytes)
      }
      if (trustedTime() >= binding.registration.deadline) {
        fail('deadline_exceeded')
      }
      write(envelope(active, 'accepted', { attempt: frame.payload.attempt }))
      const execution = structuredClone(binding)
      // 注入、完整编码和 accepted 发送均可能耗时；跨宿主执行边界前最后复验。
      if (
        controller.signal.aborted ||
        connection !== active ||
        session !== current ||
        stopped ||
        !ready(current, active, binding.target.provider_id)
      ) {
        fail('provider_not_ready')
      }
      if (trustedTime() >= binding.registration.deadline) {
        fail('deadline_exceeded')
      }
      assertSnapshots(active, current, true)
      // Wire hook 保留原帧、原 message_id 和无 id/auth 的 native_request，由原生 adapter 唯一注入。
      let result: WireExecutionResult | undefined
      let response: JsonObject
      if (executeWire) {
        result = await executeWire.call(current, wireRequest, controller.signal)
        if (!result) {
          fail('wire_execution_result_required')
        }
        response = result.native_response
      } else {
        response = await options.execute!(nativeRequest!, controller.signal, execution)
      }
      if (controller.signal.aborted || connection !== active || session !== current || stopped) {
        return
      }
      if (result) {
        assertBinding(result.binding, binding)
      }
      sendResponse(binding, response, active, current)
    } catch (error) {
      if (!controller.signal.aborted) {
        reconcileProviders(active, current)
        if (providerFences.has(binding.target.provider_id)) {
          return
        }
        const code = dispatchRefusal(error, binding.provider_kind)
        if (
          code &&
          active.negotiated.capabilities.includes('dispatch_refusal') &&
          connection === active &&
          session === current &&
          !stopped
        ) {
          // 迟到的确定拒绝不能倒退已到期账本；只结束本地等待，由原 deadline 收敛该 call。
          if (trustedTime() < binding.registration.deadline) {
            write(envelope(active, 'dispatch_refused', { attempt: frame.payload.attempt, code }))
          }
          return
        }
        throw error
      }
      // 此 attempt 的观察已取消；原生 adapter 可拒绝其本地等待，不能因此关闭其它活调用。
    } finally {
      running.delete(name)
      current.adapter.release(binding)
    }
  }
  /** 从受保护启动回调读取稳定身份，创建 socket 并安装只作用于该连接的事件处理器。 */
  function connect(): void {
    let credential: DeviceCredential
    try {
      credential = structuredClone(options.credential())
    } catch {
      failure = 'connection_failed'
      scheduleReconnect()
      return
    }
    const messageId = randomUUID()
    let current: Socket
    let created: Socket | undefined
    try {
      created = current = socket(url)
      // 桩只能在已建立的真实 socket 上包装，不能替换为任意非 socket 值。
      current = options.socketFactory?.(current) ?? current
    } catch {
      try {
        created?.close(LOCAL_CLOSE_CODE, '')
        created?.terminate()
      } catch {
        // 失败的构造没有活动 epoch；清理失败原文不进入诊断。
      }
      failure = 'connection_failed'
      scheduleReconnect()
      return
    }
    ws = current
    phase = 'connecting'
    // 新 epoch 已建立：任何旧 socket 的晚到事件不再能覆盖当前观测。
    settled = undefined
    opened = last = sentAt = performance.now()
    sent = sequence = messages = 0
    messageWindow = opened
    current.onopen =
      /** 在链路建立后发送绑定本次消息 ID 的 authenticate，凭据不进入 URL 或普通输出。 */
      () => {
        if (ws !== current || stopped) {
          return
        }
        try {
          const raw = encodeWireFrame(
            {
              protocol_major: offer.major,
              protocol_minor: offer.minor,
              type: 'authenticate',
              message_id: messageId,
              payload: {
                machine_id: credential.machine_id,
                recovery_generation: credential.recovery_generation,
                connector_instance_id: instance,
                device_credential: credential.credential,
                offer
              }
            },
            { phase: 'preauth', direction: 'connector_to_gateway' }
          )
          current.send(budget(raw, limits.frame_bytes))
        } catch (error) {
          failure =
            error instanceof GatewayError && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'connection_failed'
          close('connector_failure')
        }
      }
    current.onmessage =
      /** 处理 welcome 和已认证业务帧，核对方向、epoch、序号和重复消息后才进入执行路径。 */
      (event) => {
        if (ws !== current || stopped) {
          return
        }
        try {
          if (typeof event.data !== 'string') {
            fail('text_frame_required')
          }
          budget(event.data, limits.frame_bytes)
          const now = performance.now()
          if (now - messageWindow >= 1000) {
            messageWindow = now
            messages = 0
          }
          if (++messages > limits.messages_per_second) {
            fail('message_rate_limit')
          }
          if (!connection) {
            const frame = decodeWireFrame(event.data, {
              phase: 'preauth',
              direction: 'gateway_to_connector',
              offer,
              handshake_message_id: messageId
            })
            if (
              frame.type !== 'welcome' ||
              frame.payload.machine_id !== credential.machine_id ||
              frame.payload.recovery_generation !== credential.recovery_generation
            ) {
              fail('authentication_required')
            }
            const { in_reply_to: _reply, selected, ...identity } = frame.payload
            connection = { ...identity, authenticated: true, active: true, negotiated: selected }
            session = options.session(structuredClone(connection))
            if ('executeWire' in session) {
              if (
                typeof session.executeWire !== 'function' ||
                options.nativeInput !== undefined ||
                options.execute !== undefined
              ) {
                fail('connector_execution_conflict')
              }
              if (options.limits && 'native_bytes' in options.limits) {
                fail('wire_native_budget_owned_by_adapter')
              }
            } else if (typeof options.nativeInput !== 'function' || typeof options.execute !== 'function') {
              fail('connector_execution_required')
            }
            if (stopped || ws !== current || !connection || !session) {
              fail('connection_unavailable')
            }
            if (
              connection.negotiated.capabilities.includes('provider_fence') &&
              !session.fenceProvider &&
              session.readiness().providers.length
            ) {
              fail('provider_fence_backend_unavailable')
            }
            terminalReported.clear()
            publishSnapshots(connection, session)
            publishTerminalExecution(connection, session)
            if (stopped || ws !== current || !connection || !session) {
              fail('connection_unavailable')
            }
            phase = 'authenticated'
            failure = undefined
            capacity = undefined
            last = now
            return
          }
          if (!session) {
            fail('connection_unavailable')
          }
          if (received.observe(event.data, now) === 'duplicate') {
            return
          }
          reconcileProviders(connection, session)
          let frame: WireEnvelope
          try {
            frame = session.adapter.decode(event.data, 'gateway_to_connector')
          } catch (error) {
            reconcileProviders(connection, session)
            if (discardProviderFrame(event.data, connection, 'gateway_to_connector', providerFences)) {
              return
            }
            // 准入层确定性拒绝（revision 漂移）发生在任何原生写出之前；回明确拒绝帧，不杀整条连接。
            if (
              error instanceof WireError &&
              error.code === 'policy_revision_stale' &&
              connection.negotiated.capabilities.includes('dispatch_refusal') &&
              !stopped &&
              ws === current
            ) {
              const stale = decodeStaleAttempt(event.data)
              if (stale) {
                // 已进入执行或已接受的 attempt 不生成拒绝证明：重发帧不携带拒绝权，静默丢弃。
                const replayed = stale.call_id + ':' + stale.attempt_id
                if (!running.has(replayed) && !seen.has(replayed)) {
                  writeStaleRefusal(stale)
                }
                return
              }
            }
            throw error
          }
          if (!('connection_epoch' in frame)) {
            fail('authentication_required')
          }
          if (session.adapter.observeMessage(frame, 'gateway_to_connector') === 'duplicate') {
            return
          }
          if (frame.type === 'provider_fenced') {
            fenceProvider(connection, session, frame.payload.binding, false)
          } else if (frame.type === 'heartbeat') {
            if (frame.payload.sequence !== sequence++) {
              fail('heartbeat_sequence_mismatch')
            }
            last = now
          } else if (frame.type === 'cancel') {
            const binding = { ...connection, ...frame.payload.attempt }
            const active = running.get(binding.call_id + ':' + binding.attempt_id)
            if (active) {
              assertBinding(binding, active.binding)
              active.controller.abort(frame.payload.reason)
            }
          } else if (frame.type === 'request') {
            void request(frame, event.data, connection, session).catch(
              /** 仅关闭仍对应当前 socket 的失败执行，避免旧会话异常影响新连接。 */
              (error) => {
                if (ws === current) {
                  if (error instanceof ConnectorCapacityError) {
                    failure = error.code
                    capacity = error.capacity
                  }
                  try {
                    if (connection && session) {
                      reconcileProviders(connection, session)
                      if (providerFences.has(frame.payload.attempt.target.provider_id)) {
                        return
                      }
                    }
                  } catch {
                    /* 全局认证/存储等不可信时仍关闭原连接。 */
                  }
                  close()
                }
              }
            )
          } else {
            fail('transport_feature_unavailable')
          }
        } catch (error) {
          // 只保存原本固定的Wire错误码；远端正文、凭据、路径和异常文本均不进入观测。
          if (error instanceof ConnectorCapacityError) {
            failure = error.code
            capacity = error.capacity
          } else {
            failure =
              error instanceof GatewayError && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'connection_failed'
          }
          close()
        }
      }
    current.onclose =
      /** 只把对端关闭事件归一化为白名单原因与有界关闭码，再走统一清理和重连。 */
      (event) => {
        if (ws === current) {
          const observed = remoteDisconnect(event)
          close(observed.reason, observed.code)
          return
        }
        // 远端关闭晚于本机收敛且新 epoch 尚未建立：纠正最近一次观测，不重复计数。
        if (settled === current) {
          settled = undefined
          const observed = remoteDisconnect(event)
          // 本机自己发出的关闭帧回声（码 1000）不是对端事件：保留已定性的本机原因。
          if (observed.code !== LOCAL_CLOSE_CODE) {
            disconnects.refine(observed)
          }
        }
      }
    current.onerror =
      /** 隐藏底层网络错误原文，并让当前连接按统一关闭路径回收资源。 */
      () => {
        if (ws === current) {
          close('transport_unavailable')
        }
      }
  }
  const timer = setInterval(
    /** 用单个 timer 推进握手超时、心跳、观察中止和退避连接，不排队旧业务。 */
    () => {
      if (stopped) {
        return
      }
      const now = performance.now()
      if (!ws) {
        if (now >= next) {
          connect()
        }
        return
      }
      try {
        if (!connection) {
          if (now - opened >= limits.handshake_ms) {
            close('handshake_timeout')
          }
          return
        }
        if (!session || now - last >= limits.idle_ms) {
          close('transport_idle')
          return
        }
        reconcileProviders(connection, session)
        assertSnapshots(connection, session)
        publishTerminalExecution(connection, session)
        for (const { controller, binding } of running.values()) {
          if (
            !ready(session, connection, binding.target.provider_id) ||
            trustedTime() >= binding.registration.deadline
          ) {
            controller.abort()
          }
        }
        if (now - sentAt >= limits.heartbeat_ms) {
          assertSnapshots(connection, session, true)
          write(envelope(connection, 'heartbeat', { sequence: sent++ }))
          sentAt = now
        }
        if (ready(session, connection)) {
          phase = 'ready'
          if (now - opened >= limits.idle_ms) {
            retries = 0
          }
        } else {
          phase = 'authenticated'
        }
      } catch {
        close('connector_failure')
      }
    },
    Math.min(100, limits.heartbeat_ms, limits.handshake_ms, limits.reconnect_ms)
  )
  connect()
  return {
    /** 返回有界连接与 provider 健康观测，不包含凭据或原生内容。 */
    status() {
      // 无论当前相位都交付累计断开次数与有界队列，让采样侧按计数差逐条补报。
      return {
        ...(failure ? { failure } : {}),
        ...(capacity ? { capacity } : {}),
        ...disconnects.snapshot(),
        ...disconnects.changes(),
        phase,
        running: running.size,
        reconnects: retries,
        machine_id: connection?.machine_id,
        connection_epoch: connection?.connection_epoch,
        providers: connection && session ? providerHealth(connection, session.readiness()) : []
      }
    },
    /** 操作者主动断开当前连接；不宣称原生动作已回滚，也不伪造对端关闭码。 */
    disconnect: () => close('connector_disconnected'),
    /** 幂等停止 timer、socket 和观察资源；不会据此宣称原生动作已回滚。 */
    stop(): void {
      if (stopped) {
        return
      }
      stopped = true
      clearInterval(timer)
      close('connector_stopped')
    }
  }
}
