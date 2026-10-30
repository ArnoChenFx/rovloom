import { ConnectorCapacityError } from '../capacity.js'
/** 执行经过 Wire 与原生契约许可的单次本地 RPC，协调身份核验、完整帧预算及取消结果语义。 */
import { compileBundle, createNativeValidator, DEFAULT_LIMITS, parseNativeJson } from './contract/index.js'
import type { CompiledContract, Json } from './contract/index.js'
import { createLuvusWireAdapter } from './wire.js'
import { createHash } from 'node:crypto'
import { assertBinding, boundedJson, WireError } from '../../wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope, JsonObject } from '../../wire/types.js'
import { aborted, deadline, interruptible, runFixedProcess, runSocket } from './io.js'
import type { PreparedFrame } from './io.js'
import {
  LUVUS_ENDPOINT_TRANSPORT,
  inspectEndpoint,
  localLimits,
  pinConfig,
  recheckEndpoint,
  recheckInstallation,
  verifyInstallation
} from './local.js'
import { LuvusAdapterError } from './types.js'
import { assertTerminalExecutionAllowed, currentTerminalExecution } from '../terminal-execution.js'
import type {
  EndpointIdentity,
  LuvusLocalConfig,
  LuvusRpcHost,
  NativeTransportEvidence,
  LuvusNativeAuth
} from './types.js'

/** 按原生 JSON 规则解析有界字节，失败时仅暴露安全错误码。 */
function parse(bytes: Buffer, maxBytes: number): Json {
  const result = parseNativeJson(bytes, { object_bytes: maxBytes })
  if (!result.ok) {
    throw new LuvusAdapterError(result.error.code)
  }
  return result.value
}
/** 要求解析值为普通 JSON 对象，拒绝数组、空值和标量。 */
function object(value: Json): { readonly [key: string]: Json } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LuvusAdapterError('native_json_object_required')
  }
  return value as { readonly [key: string]: Json }
}
/** 解析唯一的 JSON 加 LF 响应帧；截断、多帧或非法 JSON 均报告结果未知。 */
export function parseRpcFrame(bytes: Buffer, maxBytes: number): JsonObject {
  // 采集证据是一个 JSON + LF，之后 EOF；不接受 CRLF、多帧或无 LF 的截断结果。
  if (bytes.length > maxBytes || bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10) || bytes.includes(13)) {
    throw new LuvusAdapterError('native_framing_invalid', 'outcome_unknown')
  }
  try {
    return object(parse(bytes.subarray(0, -1), maxBytes)) as JsonObject
  } catch (error) {
    throw new LuvusAdapterError(
      error instanceof LuvusAdapterError ? error.code : 'native_json_invalid',
      'outcome_unknown'
    )
  }
}
/** 由宿主注入原生 id 和受限认证串，并将 UTF-8、转义及末尾 LF 纳入完整帧预算。 */
export function requestFrame(request: JsonObject, nativeId: string, auth: LuvusNativeAuth, budget: number): Buffer {
  const owner =
    auth !== null && typeof auth === 'object' && auth.kind === 'local_owner' && Object.keys(auth).length === 1
  if (!owner && (typeof auth !== 'string' || !/^[!-~]{1,256}$/.test(auth))) {
    throw new LuvusAdapterError('native_auth_required')
  }
  if (Object.hasOwn(request, 'id') || Object.hasOwn(request, 'auth')) {
    throw new LuvusAdapterError('caller_native_identity_forbidden')
  }
  // Wire 已校验请求；此处将 Connector 专有字段加入后，重新计算完整 UTF-8 帧预算。
  let bytes: Buffer
  try {
    bytes = Buffer.from(boundedJson({ ...request, id: nativeId, ...(owner ? {} : { auth }) }, budget) + '\n')
  } catch {
    throw new LuvusAdapterError('native_request_limit')
  }
  if (bytes.length > budget) {
    throw new LuvusAdapterError('native_request_limit')
  }
  return bytes
}
type RpcRequest = Extract<AuthenticatedEnvelope, { type: 'request' }>
/** 只从已经通过 Wire 校验的认证帧提取绑定，供本机私有状态终结清理。 */
function frameBinding(frame: AuthenticatedEnvelope): AttemptBinding | undefined {
  if (!('attempt' in frame.payload)) {
    return undefined
  }
  return {
    machine_id: frame.machine_id,
    recovery_generation: frame.recovery_generation,
    connection_epoch: frame.connection_epoch,
    ...frame.payload.attempt
  }
}
export type RpcResult = Readonly<{
  binding: AttemptBinding
  native_response: JsonObject
  transport: 'ipc' | 'cli'
  exit_code: number | null
  stderr_bytes: number
}>

export class LuvusRpcAdapter {
  readonly #config: LuvusLocalConfig
  readonly #limits
  readonly #host: LuvusRpcHost
  readonly #wire
  readonly #seen = new Map<string, number>()
  readonly #active = new Map<string, { binding: AttemptBinding; abort: AbortController }>()
  #closed = false
  #lastNow = -1

  /** 冻结本地安装配置并绑定现有 Wire 后端；不建立原生连接或获取认证。 */
  constructor(config: LuvusLocalConfig, host: LuvusRpcHost) {
    this.#config = pinConfig(config)
    this.#limits = localLimits(config.limits)
    this.#host = host
    this.#wire = createLuvusWireAdapter(host.backend)
  }

  /** 核对完整 target、配置修订和二进制来源，阻止许可跨安装或跨 provider 使用。 */
  #match(binding: AttemptBinding): void {
    const origin = this.#host.backend.nativeSource(binding.call_id, binding.attempt_id)
    if (
      binding.provider_kind !== 'luvus' ||
      binding.machine_id !== this.#config.target.machine_id ||
      binding.binding_revision !== this.#config.binding_revision ||
      boundedJson(binding.target) !== boundedJson(this.#config.target) ||
      this.#host.backend.localProvider(binding.target)?.config_ref !== this.#config.config_ref ||
      !origin ||
      origin.binding.contract.binary_sha256 !== this.#config.binary_sha256
    ) {
      throw new LuvusAdapterError('local_binding_mismatch')
    }
  }
  /** 读取非负且不回退的宿主时钟；无可信时间时拒绝继续。 */
  #now(): number {
    const now = this.#host.backend.now()
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastNow) {
      throw new LuvusAdapterError('clock_untrusted')
    }
    this.#lastNow = now
    return now
  }
  /** 绑定可信能力并限定原生单请求 RPC，再计算本地与在线通用、终端帧预算的交集。 */
  #nativeBoundary(binding: AttemptBinding, method: string) {
    const record = this.#host.backend.contract(binding.contract_ref)
    const source = this.#host.backend.nativeSource(binding.call_id, binding.attempt_id)
    if (!record || !source) {
      throw new LuvusAdapterError('native_source_untrusted')
    }
    const capabilities = object(
      parse(Buffer.from(boundedJson(record.capabilities, DEFAULT_LIMITS.object_bytes)), DEFAULT_LIMITS.object_bytes)
    )
    const validator = createNativeValidator(record.compiled)
    const bound = validator.bindCapabilities(capabilities, source)
    if (!bound.ok) {
      throw new LuvusAdapterError(bound.error.code)
    }
    const descriptor = validator.describe(bound.value, method)
    if (!descriptor.ok) {
      throw new LuvusAdapterError(descriptor.error.code)
    }
    // backend 可以同时服务流模块；其支持集合不能扩大本 adapter 的单请求传输边界。
    if (descriptor.value.transport !== 'single_request_rpc') {
      throw new LuvusAdapterError('ordinary_rpc_required')
    }
    const online = object(capabilities.result ?? null)
    const general = object(online.limits ?? null).frame_bytes as number
    const terminal = object(object(online.terminal ?? null).limits ?? null)
    const isTerminal = method.startsWith('terminal.backend.')
    // 在线数值已经过原生 validator 检查。原始帧上限还须在 transport 层执行，
    // 不能让 JSON 重序列化删除空白后，才检查原生 response 的字节预算。
    return {
      request_bytes: Math.min(
        this.#limits.request_bytes,
        general,
        isTerminal ? (terminal.request_bytes as number) : general
      ),
      response_bytes: Math.min(
        this.#limits.response_bytes,
        general,
        isTerminal ? (terminal.response_bytes as number) : general
      ),
      /** 复核注入 id 和 auth 后的完整原生请求；保留 Wire 原先签发的派发许可。 */
      validateRequest(bytes: Buffer, mode: 'strict' | 'raw-contract') {
        const value = object(parse(bytes.subarray(0, -1), DEFAULT_LIMITS.object_bytes))
        const checked =
          mode === 'raw-contract'
            ? validator.checkRawRequest(bound.value, value)
            : validator.checkRequest(bound.value, value)
        if (!checked.ok) {
          throw new LuvusAdapterError(checked.error.code)
        }
        // 这里只复核注入后的完整原生帧；不签发新 DispatchPermit，不替换 Wire 的原许可。
      }
    }
  }
  /** 运行固定会话发现命令，仅返回唯一运行中会话的受保护本地 Unix socket。 */
  async #discover(signal: AbortSignal): Promise<EndpointIdentity> {
    const result = await runFixedProcess(this.#config, this.#limits, 'sessions', signal)
    if (result.exit_code !== 0) {
      throw new LuvusAdapterError('native_discovery_exit')
    }
    const listing = object(parse(result.stdout, Math.min(this.#limits.discovery_bytes, 1_048_576)))
    if (!Array.isArray(listing.sessions) || listing.sessions.length > 256) {
      throw new LuvusAdapterError('native_discovery_invalid')
    }
    const matches = listing.sessions.filter(
      /* 只保留名称与固定目标会话完全一致的发现条目。 */ (row) => object(row).name === this.#config.target.session
    )
    if (matches.length !== 1) {
      throw new LuvusAdapterError('native_session_unavailable')
    }
    const row = object(matches[0]!)
    if (row.running !== true) {
      throw new LuvusAdapterError('native_session_unavailable')
    }
    const endpoint = object(row.endpoint ?? null)
    if (endpoint.transport !== LUVUS_ENDPOINT_TRANSPORT || typeof endpoint.address !== 'string') {
      throw new LuvusAdapterError('native_endpoint_unsupported')
    }
    return interruptible(inspectEndpoint(this.#config, endpoint.address), signal)
  }

  /** 在本地等待期限内发现 endpoint；入口已关闭或等待被取消时返回安全的派发前错误。 */
  async discoverEndpoint(signal?: AbortSignal): Promise<EndpointIdentity> {
    const scope = deadline(signal, this.#limits.timeout_ms)
    try {
      if (this.#closed) {
        throw new LuvusAdapterError('adapter_closed')
      }
      return await this.#discover(scope.signal)
    } catch (error) {
      throw this.#safe(error)
    } finally {
      scope.close()
    }
  }

  /** 从固定安装读取 schema 原始字节并以二进制、内容哈希和指定修订编译契约。 */
  async installedSchema(
    revision: string,
    signal?: AbortSignal
  ): Promise<
    Readonly<{
      bytes: Buffer
      compiled: CompiledContract
    }>
  > {
    const scope = deadline(signal, this.#limits.timeout_ms)
    try {
      if (this.#closed) {
        throw new LuvusAdapterError('adapter_closed')
      }
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(revision)) {
        throw new LuvusAdapterError('contract_revision_invalid')
      }
      const output = await runFixedProcess(this.#config, this.#limits, 'schema', scope.signal)
      if (output.exit_code !== 0) {
        throw new LuvusAdapterError('native_schema_exit')
      }
      const compiled = await compileBundle(
        output.stdout,
        {
          identity: {
            binary_sha256: this.#config.binary_sha256,
            schema_sha256: createHash('sha256').update(output.stdout).digest('hex'),
            revision
          }
        },
        scope.signal
      )
      if (!compiled.ok) {
        throw new LuvusAdapterError(compiled.error.code)
      }
      aborted(scope.signal)
      if (this.#closed) {
        throw new LuvusAdapterError('adapter_closed')
      }
      await verifyInstallation(this.#config)
      aborted(scope.signal)
      if (this.#closed) {
        throw new LuvusAdapterError('adapter_closed')
      }
      return Object.freeze({ bytes: output.stdout, compiled: compiled.value })
    } catch (error) {
      throw this.#safe(error)
    } finally {
      scope.close()
    }
  }

  /** 验证 Wire 许可后执行一次受限 RPC；发送前复核权限，发送后的失败保留结果未知且不重放。 */
  async dispatch(input: string | Uint8Array, signal?: AbortSignal): Promise<RpcResult> {
    let dispatched = false
    let scope: ReturnType<typeof deadline> | undefined
    let linked: /* 将外部取消传播到本次派发的无参数处理器类型。 */ (() => void) | undefined
    let key: string | undefined
    let activeAbort: AbortController | undefined
    let decodedBinding: AttemptBinding | undefined
    try {
      if (this.#closed) {
        throw new LuvusAdapterError('adapter_closed')
      }
      // 始终先验证真实 Wire/NativeValidator 许可，不提供绕过 gate 的原始 execute API。
      const frame = this.#wire.decode(input, 'gateway_to_connector')
      if ('connection_epoch' in frame) {
        decodedBinding = frameBinding(frame)
      }
      if (frame.type !== 'request' || !('connection_epoch' in frame)) {
        throw new LuvusAdapterError('ordinary_rpc_required')
      }
      const request = frame as RpcRequest
      /** 只从本机配置取得开关；完整原生请求始终仍走既有 Wire、分类及权限门禁。 */
      const terminalBoundary = () =>
        assertTerminalExecutionAllowed(
          'luvus',
          request.payload.native_request,
          currentTerminalExecution(
            this.#host.terminalExecution?.bind(this.#host),
            this.#config.allow_terminal_execution
          )
        )
      terminalBoundary()
      const binding: AttemptBinding = {
        machine_id: request.machine_id,
        recovery_generation: request.recovery_generation,
        connection_epoch: request.connection_epoch,
        ...request.payload.attempt
      }
      this.#match(binding)
      const observed = this.#now()
      const remaining = binding.registration.deadline - observed
      if (remaining <= 0) {
        throw new LuvusAdapterError('native_timeout')
      }
      // 缺失证明接口时不启动 discovery/proxy，也不连接 native endpoint。
      if (this.#config.transport === 'ipc' ? !this.#host.verifyPeer : !this.#host.verifyProxy) {
        throw new LuvusAdapterError('native_identity_verifier_required')
      }
      if (typeof this.#host.nativeAuth !== 'function' || typeof this.#host.claimDispatch !== 'function') {
        throw new LuvusAdapterError('native_host_binding_required')
      }
      key = boundedJson([binding.machine_id, binding.target.provider_id, binding.call_id, binding.attempt_id])
      // 原意图到期后由完整 Wire 与最后写入门禁拒绝；回收索引不终止仍在收敛的 IO。
      for (const [previous, expires] of this.#seen) {
        if (expires <= observed) {
          this.#seen.delete(previous)
        }
      }
      if (this.#seen.has(key)) {
        throw new LuvusAdapterError('attempt_already_observed')
      }
      if (this.#seen.size >= this.#limits.attempts) {
        throw new LuvusAdapterError('local_attempt_limit')
      }
      if (this.#wire.observeMessage(request, 'gateway_to_connector') !== 'new') {
        throw new LuvusAdapterError('duplicate_message')
      }
      this.#seen.set(key, binding.registration.deadline)
      const abort = new AbortController()
      activeAbort = abort
      linked = /* 把调用方取消传播到本次派发的本地等待范围。 */ () => abort.abort('cancelled')
      signal?.addEventListener('abort', linked, { once: true })
      if (signal?.aborted) {
        linked()
      }
      this.#active.set(key, { binding, abort })
      scope = deadline(abort.signal, Math.min(remaining, this.#limits.rpc_timeout_ms))
      const activeSignal = scope.signal
      const native = this.#nativeBoundary(binding, request.payload.native_request.method as string)
      const endpoint = await this.discoverEndpoint(activeSignal)
      // 完整摘要验证在打开原生连接之前做完；连接建立后原生对空闲有期限，期间只复核身份戳。
      const installed = await interruptible(verifyInstallation(this.#config), activeSignal)
      const raw = boundedJson(request)
      const prepare = /* 在已验证传输上获取认证、检查完整帧并申请唯一 claim，返回写入前的同步复核钩子。 */ async (
        evidence: NativeTransportEvidence,
        ioSignal: AbortSignal
      ): Promise<PreparedFrame> => {
        aborted(ioSignal)
        const auth = await interruptible(this.#host.nativeAuth(binding, evidence), ioSignal)
        const bytes = requestFrame(
          request.payload.native_request,
          binding.native_request_id,
          auth,
          native.request_bytes
        )
        const current = /* 同步复核当前许可、来源、最终请求和登记期限；任一变化都禁止写入。 */ () => {
          aborted(ioSignal)
          this.#wire.decode(raw, 'gateway_to_connector')
          this.#match(binding)
          native.validateRequest(bytes, request.payload.validation)
          if (this.#now() >= binding.registration.deadline) {
            throw new LuvusAdapterError('native_timeout')
          }
          terminalBoundary()
        }
        await interruptible(recheckEndpoint(this.#config, endpoint), ioSignal)
        await interruptible(recheckInstallation(this.#config, installed), ioSignal)
        current()
        // 完整帧预算通过后才占用 durable dispatch claim；claim 必须拒绝已登记 attempt。
        await interruptible(this.#host.claimDispatch(binding, evidence), ioSignal)
        // claim 期间可能改变安装来源；写入前同时重验 binary 和 endpoint。
        await interruptible(recheckInstallation(this.#config, installed), ioSignal)
        await interruptible(recheckEndpoint(this.#config, endpoint), ioSignal)
        aborted(ioSignal)
        return {
          bytes,
          /** 紧贴实际 IO 写入复核派发条件，并标记后续失败应按结果未知处理。 */
          beforeWrite() {
            current()
            dispatched = true
          }
        }
      }
      let output: Buffer
      let exitCode: number | null = null
      let stderrBytes = 0
      if (this.#config.transport === 'ipc') {
        output = await runSocket(
          endpoint.address,
          native.response_bytes,
          activeSignal,
          /* 独立验证同一 socket 的 peer 身份，再为该连接准备受限请求帧。 */ async (socket, ioSignal) => {
            await interruptible(recheckEndpoint(this.#config, endpoint), ioSignal)
            const peer = await interruptible(this.#host.verifyPeer!(socket, endpoint, binding), ioSignal)
            if (
              peer.uid !== endpoint.uid ||
              !Number.isSafeInteger(peer.pid) ||
              peer.pid <= 0 ||
              !Number.isSafeInteger(peer.gid) ||
              peer.gid < 0
            ) {
              throw new LuvusAdapterError('native_peer_mismatch')
            }
            return prepare(Object.freeze({ endpoint, transport: 'ipc', peer: Object.freeze({ ...peer }) }), ioSignal)
          }
        )
      } else {
        const result = await runFixedProcess(
          this.#config,
          { ...this.#limits, response_bytes: native.response_bytes },
          'proxy',
          activeSignal,
          /** 要求宿主证明固定代理子进程的原生连接来源，再准备请求帧。 */
          async (child, ioSignal) => {
            await interruptible(this.#host.verifyProxy!(child, endpoint, binding), ioSignal)
            return prepare(Object.freeze({ endpoint, transport: 'cli', proxy_pid: child.pid }), ioSignal)
          }
        )
        output = result.stdout
        exitCode = result.exit_code
        stderrBytes = result.stderr_bytes
      }
      const response = parseRpcFrame(output, native.response_bytes)
      // 原生 error 即使 exit=1 也按原样保留，不能改写成网关 error。
      if (exitCode !== null && exitCode !== 0 && !(exitCode === 1 && Object.hasOwn(response, 'error'))) {
        throw new LuvusAdapterError('native_process_exit', 'outcome_unknown')
      }
      await interruptible(recheckEndpoint(this.#config, endpoint), activeSignal)
      aborted(activeSignal)
      this.#wire.checkResult(binding, response)
      this.#match(binding)
      return Object.freeze({
        binding,
        native_response: response,
        transport: this.#config.transport,
        exit_code: exitCode,
        stderr_bytes: stderrBytes
      })
    } catch (error) {
      throw this.#safe(error, dispatched)
    } finally {
      scope?.close()
      if (linked) {
        signal?.removeEventListener('abort', linked)
      }
      if (key && this.#active.get(key)?.abort === activeAbort) {
        this.#active.delete(key)
      }
      if (decodedBinding) {
        this.#releaseIdle(decodedBinding)
      }
    }
  }

  /** 校验并去重 Wire 取消帧，仅中止完全匹配的活动等待；不撤销原生操作。 */
  cancel(input: string | Uint8Array): boolean {
    let binding: AttemptBinding | undefined
    try {
      const frame = this.#wire.decode(input, 'gateway_to_connector')
      if ('connection_epoch' in frame) {
        binding = frameBinding(frame)
      }
      if (frame.type !== 'cancel' || !('connection_epoch' in frame)) {
        throw new LuvusAdapterError('cancel_frame_required')
      }
      if (this.#wire.observeMessage(frame, 'gateway_to_connector') !== 'new') {
        return false
      }
      binding = frameBinding(frame)!
      this.#match(binding)
      const key = boundedJson([binding.machine_id, binding.target.provider_id, binding.call_id, binding.attempt_id])
      const active = this.#active.get(key)
      if (!active) {
        return false
      }
      assertBinding(binding, active.binding)
      active.abort.abort(frame.payload.reason === 'deadline_exceeded' ? 'deadline' : 'cancelled')
      return true
    } finally {
      if (binding) {
        this.#releaseIdle(binding)
      }
    }
  }
  /** 仅释放无人执行的本机 Wire 原文；重复请求/取消不能释放仍在途的所属许可，seen 防重放记录保留至原 deadline。 */
  #releaseIdle(binding: AttemptBinding): void {
    const key = boundedJson([binding.machine_id, binding.target.provider_id, binding.call_id, binding.attempt_id])
    if (this.#active.has(key)) {
      return
    }
    try {
      this.#wire.release(binding)
    } catch {
      // 已关闭或无法安全清理时终结整个本机 adapter，不以旧私有状态继续服务，也不改写原派发结果。
      this.close()
    }
  }
  /** 拒绝新派发、取消已登记派发的活动等待，并释放私有 Wire 上下文、维护计时器和账本订阅。 */
  close(): void {
    this.#closed = true
    for (const active of this.#active.values()) {
      active.abort.abort('cancelled')
    }
    this.#wire.close()
    // seen 不提前清空，不能把关闭或取消解释成新意图并自动重放。
  }
  /** 将内部异常收敛为无敏感内容的错误，并按是否可能发送保守标记结果。 */
  #safe(error: unknown, dispatched = false): LuvusAdapterError {
    if (!dispatched && error instanceof ConnectorCapacityError) {
      return error
    }
    const code =
      error instanceof LuvusAdapterError || error instanceof WireError ? error.code : 'native_adapter_unavailable'
    const unknown = dispatched || (error instanceof LuvusAdapterError && error.outcome === 'outcome_unknown')
    return new LuvusAdapterError(code, unknown ? 'outcome_unknown' : 'not_dispatched')
  }
}
