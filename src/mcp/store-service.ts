// 将门面查询、调用元数据和独立清理接到实际 Store/Router；缺执行、管理审计或通道后端时拒绝写入。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { canonical, digest, GatewayError } from '../contracts.js'
import type { CallState } from '../contracts.js'
import { Router, type LocalPolicies, type Principal } from '../router.js'
import type { Store } from '../store.js'
import { LIMITS, providerScopeAllowed, validatePolicies } from '../wire/index.js'
import type { AttemptBinding, ProviderBinding, ProviderPolicy, V2Target } from '../wire/types.js'
import { isToolName, parseToolArguments } from './schema.js'
import { publicCallView } from './call-view.js'
import {
  createManagementTransportProjection,
  sampleManagementTransport,
  type ManagementTransportProjection
} from './transport-observations.js'
import type { GatewayTransportObservationSource, MachineObservationRequest } from '../transport/observation.js'
import { authorizedLuvusCatalog, type GatewayCatalog } from './native-catalog.js'
import { authorizedProviderCatalog } from './provider-catalog.js'
import {
  FacadeServiceError,
  type CallView,
  type GatewayService,
  type MachineView,
  type MachineDetailsView,
  type Page,
  type ProviderView,
  type McpProviderView,
  type ProviderMetadata,
  type ReplyData,
  type ServiceContext,
  type ServiceErrorCode,
  type ServiceReply,
  type ToolArguments,
  type ToolName
} from './types.js'
import type {
  AdminContext,
  Administrator,
  CallAggregate,
  CallSummary,
  DeviceSnapshot,
  GatewayIdentitySource,
  GatewayManagementService,
  ManagementArguments,
  ManagementOperation,
  ManagementReply,
  ManagementGrant,
  ManagementPermission,
  ManagementStatus,
  PermissionDecision,
  PermissionSnapshot,
  ProviderSnapshot
} from './management.js'

type ToolRequest = { [K in ToolName]: { name: K; args: ToolArguments[K] } }[ToolName]
export type StoreGatewayOptions = {
  store: Store
  identities: GatewayIdentitySource
  localPolicies: LocalPolicies
  router?: Router
  catalog?: GatewayCatalog
  /** 仅观察当前连接报告的本地开关；缺失为未知，不授予调用或读取权。 */
  terminalExecutionState?(binding: ProviderBinding): boolean | undefined
  /** 实际 Gateway 传输的只读观测来源；缺失时连接、认证和 provider 就绪保持未核实。 */
  transportObservations?: GatewayTransportObservationSource
  // 仅由实际组合器报告已装配的管理写能力；只读提示不得调用确认、签发或provider启用证明。
  managementCapabilities?(target: { machine_id: string; provider_id?: string }): readonly ManagementPermission[]
}
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/
const persistedStates = new Set(['pending', 'offline', 'online', 'revoked'])
/** 调用状态是账本枚举，管理筛选不接受未知或现场推导状态。 */
const callStates = new Set<CallState>([
  'created',
  'dispatching',
  'connector_accepted',
  'responded',
  'not_dispatched',
  'outcome_unknown'
])
/** 管理调用视图固定回看窗口与单次采样上限；更早的记录仍需按原保留期清理，页面不宣称全量。 */
const CALL_WINDOW_MS = 86_400_000
const CALL_WINDOW_LIMIT = 2_000
const gatewayErrors: Record<string, ServiceErrorCode> = {
  machine_not_found: 'not_found',
  call_not_found: 'not_found',
  result_not_found: 'not_found',
  forbidden: 'forbidden',
  discard_forbidden: 'forbidden',
  clock_untrusted: 'storage_degraded',
  provider_disabled: 'unavailable',
  connection_unavailable: 'unavailable',
  provider_binding_mismatch: 'binding_revision_conflict'
}

// 将已知存储拒绝转换为公共代码；任何未知异常只暴露固定内部错误。
function serviceError(error: unknown): FacadeServiceError {
  if (error instanceof FacadeServiceError) {
    return error
  }
  if (error instanceof GatewayError) {
    if (error.code === 'storage_degraded' || error.code === 'storage_exhausted') {
      return new FacadeServiceError(error.code)
    }
    const code = Object.hasOwn(gatewayErrors, error.code) ? gatewayErrors[error.code] : undefined
    if (code) {
      return new FacadeServiceError(code)
    }
  }
  return new FacadeServiceError('internal_error')
}

// 从游标绑定中去掉游标本身，保留完整查询范围和分页大小，避免产生不可编码的 undefined。
function queryArguments(args: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(/* 游标只引用既有分页关联，不参与该关联的查询摘要。 */ ([key]) => key !== 'cursor')
  )
}

// 从同一身份来源复制当前Principal；仅受信宿主上下文可调用，工具JSON不能提供此来源。
export function resolveGatewayPrincipal(
  identities: GatewayIdentitySource,
  caller: ServiceContext['caller']
): Principal {
  const principal = identities.principal(caller)
  if (
    !principal ||
    typeof principal.id !== 'string' ||
    principal.id !== caller.principal_id ||
    !idPattern.test(principal.id)
  ) {
    throw new FacadeServiceError('unauthenticated')
  }
  const snapshot = JSON.parse(canonical(principal)) as Principal
  validatePolicies({ caller: snapshot.policy, local: snapshot.policy })
  // 身份来源交付的范围必须形状正确；缺失即不收窄，任何变形均拒绝。
  if (
    snapshot.device_scope !== undefined &&
    (snapshot.device_scope.mode !== 'selected' ||
      !Array.isArray(snapshot.device_scope.machine_ids) ||
      snapshot.device_scope.machine_ids.length > LIMITS.scope_machines ||
      snapshot.device_scope.machine_ids.some(
        /* 只接受稳定 machine_id 形状。 */ (item) => typeof item !== 'string' || !idPattern.test(item)
      ) ||
      new Set(snapshot.device_scope.machine_ids).size !== snapshot.device_scope.machine_ids.length)
  ) {
    throw new FacadeServiceError('unauthenticated')
  }
  return snapshot
}

// 验证独立管理只读参数的精确字段；尚未实现的写入不会解析或执行调用方意图。
function adminArguments(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(canonical(value))
  } catch {
    throw new FacadeServiceError('invalid_arguments')
  }
  if (
    !args ||
    Array.isArray(args) ||
    typeof args !== 'object' ||
    Object.keys(args).some(/* 拒绝额外身份、秘密或命令字段。 */ (key) => ![...required, ...optional].includes(key)) ||
    required.some(/* 所有必要目标都必须显式存在，不能依靠隐式 current 选择。 */ (key) => !(key in args))
  ) {
    throw new FacadeServiceError('invalid_arguments')
  }
  for (const [key, item] of Object.entries(args)) {
    if (key === 'limit') {
      if (!Number.isSafeInteger(item) || Number(item) < 1 || Number(item) > 200) {
        throw new FacadeServiceError('invalid_arguments')
      }
    } else if (key === 'states') {
      if (
        !Array.isArray(item) ||
        item.length < 1 ||
        item.length > 4 ||
        new Set(item).size !== item.length ||
        item.some(
          /* 只接受持久状态枚举，不能把未知现场状态或任意文本用于筛选。 */ (state) =>
            typeof state !== 'string' || !persistedStates.has(state)
        )
      ) {
        throw new FacadeServiceError('invalid_arguments')
      }
    } else if (key === 'cursor') {
      if (typeof item !== 'string' || item.length < 1 || item.length > 1024) {
        throw new FacadeServiceError('invalid_arguments')
      }
    } else if (typeof item !== 'string' || !idPattern.test(item)) {
      throw new FacadeServiceError('invalid_arguments')
    }
  }
  return args
}

// 管理调用窗口只接受显式分页、可选设备与调用状态；请求正文、来源或命令都不能作为查询注入。
function callArguments(value: unknown): ManagementArguments['calls_list'] {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(canonical(value))
  } catch {
    throw new FacadeServiceError('invalid_arguments')
  }
  if (
    !args ||
    Array.isArray(args) ||
    typeof args !== 'object' ||
    Object.keys(args).some(
      /* 只允许分页、设备范围和状态筛选，不接受身份或正文条件。 */ (key) =>
        !['cursor', 'limit', 'machine_id', 'states'].includes(key)
    )
  ) {
    throw new FacadeServiceError('invalid_arguments')
  }
  if (
    args.limit !== undefined &&
    (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 200)
  ) {
    throw new FacadeServiceError('invalid_arguments')
  }
  if (
    args.cursor !== undefined &&
    (typeof args.cursor !== 'string' || args.cursor.length < 1 || args.cursor.length > 1024)
  ) {
    throw new FacadeServiceError('invalid_arguments')
  }
  if (args.machine_id !== undefined && (typeof args.machine_id !== 'string' || !idPattern.test(args.machine_id))) {
    throw new FacadeServiceError('invalid_arguments')
  }
  if (
    args.states !== undefined &&
    (!Array.isArray(args.states) ||
      args.states.length < 1 ||
      args.states.length > 6 ||
      new Set(args.states).size !== args.states.length ||
      args.states.some(
        /* 只接受账本状态枚举，不从数据库状态推断连接。 */ (state) => !callStates.has(state as CallState)
      ))
  ) {
    throw new FacadeServiceError('invalid_arguments')
  }
  return args as ManagementArguments['calls_list']
}

/** 只保留目标 profile 与调用方声明的 session 名；原生句柄、凭据和其它字段不进入管理投影。 */
function callTarget(value: string): CallSummary['target'] {
  try {
    const target = JSON.parse(value) as { profile?: unknown; session?: unknown }
    if (target?.profile === 'host') {
      return { profile: 'host', session: null }
    }
    if (target?.profile === 'session' && typeof target.session === 'string' && target.session.length <= 1024) {
      return { profile: 'session', session: target.session }
    }
  } catch {
    /* 无法解析的账本行按未记录目标处理，不猜测。 */
  }
  return { profile: 'host', session: null }
}

/** 按固定顺序汇总计数，切片不改变统计范围；空窗口返回空数组而不是零值行。 */
function tally<T extends string>(values: readonly T[], order: readonly T[]): { key: T; count: number }[] {
  const counts = new Map<T, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return order
    .filter(/* 只输出已知枚举，避免未知账本值成为展示分类。 */ (key) => counts.has(key))
    .map((key) => ({ key, count: counts.get(key)! }))
}

/** 计数按降序、同值按码元序排列，限制展示长度以免单页返回过多分类。 */
function ranked<T>(rows: readonly { key: T; count: number }[], limit: number): { key: T; count: number }[] {
  return [...rows]
    .sort(
      /* 计数优先；同值用码元比较，避免不同 locale 给出不同分类顺序。 */ (a, b) =>
        b.count === a.count
          ? String(a.key) < String(b.key)
            ? -1
            : String(a.key) > String(b.key)
              ? 1
              : 0
          : b.count - a.count
    )
    .slice(0, limit)
}

export class StoreGatewayService implements GatewayService {
  private readonly router: Router
  private readonly cursorKey = randomBytes(32)
  private closed = false
  readonly management: GatewayManagementService

  // 只组合现有 Store、Router 和同一身份政策来源；资源关闭及真实 transport/native 仍由宿主持有。
  constructor(private readonly options: StoreGatewayOptions) {
    this.router = options.router ?? new Router(options.store, options.localPolicies)
    this.management = {
      execute: /* 共享同一 Store 与身份服务；独立管理会话每次重新验证。 */ (name, args, context) =>
        this.adminExecute(name, args, context)
    }
  }

  // 关闭门面并销毁本实例游标签名密钥；Store、Router 和目录资源仍由宿主释放。
  close(): void {
    this.closed = true
    this.cursorKey.fill(0)
  }

  // 复制当前 Principal 并核对受信 caller；不从工具参数创建身份或扩展 Router 权限。
  private principal(context: ServiceContext | AdminContext): Principal {
    if (this.closed || context.wait_signal.aborted) {
      throw new FacadeServiceError('unavailable')
    }
    return resolveGatewayPrincipal(this.options.identities, context.caller)
  }

  // 在每次读取前执行实际时钟与恢复门禁；降级下仍只允许 Store 支持的授权读取和清理。
  private now(): number {
    return this.options.store.clock()
  }

  // 使用 Wire 的完整 tuple 求交，不把不同 grant 的 machine/provider/session/method 拼成新授权。
  private visibleTargets(principal: Principal): { target: V2Target; local_revision: string }[] {
    const targets = new Map<string, { target: V2Target; local_revision: string }>()
    // 令牌的设备范围是独立过滤器：在 grants 推导出的集合上再收窄，永不扩大授权。
    const scope = principal.device_scope?.machine_ids
    if (principal.policy.grants.length > 256) {
      throw new FacadeServiceError('busy')
    }
    let evaluations = 0
    for (const grant of principal.policy.grants) {
      if (
        !grant.actions.includes('read') ||
        (scope !== undefined && !scope.includes(grant.target.machine_id)) ||
        !this.options.store.provider(grant.target.machine_id, grant.target.provider_id)
      ) {
        continue
      }
      const local = JSON.parse(canonical(this.options.localPolicies(grant.target))) as ProviderPolicy
      if (local.grants.length > 256) {
        throw new FacadeServiceError('busy')
      }
      if (
        grant.methods.some(
          /* 仅有双方同一完整目标和精确方法的 read 授权时，才能展示该 route 的设备/provider 元数据。 */ (method) => {
            if (++evaluations > 256) {
              throw new FacadeServiceError('busy')
            }
            return providerScopeAllowed({ target: grant.target } as AttemptBinding, method, 'read', {
              caller: principal.policy,
              local
            })
          }
        )
      ) {
        targets.set(canonical(grant.target), { target: grant.target, local_revision: local.revision })
      }
    }
    return [...targets.values()]
  }

  // 投影持久设备状态；没有 live transport 证据时不将旧 online 行宣称为当前连接或认证成功。
  private machine(
    machineId: string,
    targets: readonly V2Target[],
    observed: ManagementTransportProjection,
    detail: true
  ): MachineDetailsView
  private machine(
    machineId: string,
    targets: readonly V2Target[],
    observed: ManagementTransportProjection,
    detail?: false
  ): MachineView
  private machine(
    machineId: string,
    targets: readonly V2Target[],
    observed: ManagementTransportProjection,
    detail = false
  ): MachineView | MachineDetailsView {
    const machine = this.options.store.machine(machineId)
    if (!persistedStates.has(machine.status)) {
      throw new FacadeServiceError('unavailable')
    }
    const details = observed.machineDetails(machine.machine_id)
    const platform = this.options.store.devicePlatform(machine.machine_id)
    const summary = details.host
      ? `${details.host.os.family}/${details.host.arch}`
      : (details.platform ?? (platform ? `${platform.os}/${platform.arch === 'x64' ? 'x86_64' : 'aarch64'}` : null))
    const providerIds = new Set(targets.map((target) => target.provider_id))
    return {
      machine_id: machine.machine_id,
      name: machine.name,
      platform: summary,
      ...(detail ? { last_seen_at: details.last_seen_at, link_since: details.link_since } : {}),
      ...(detail && details.host
        ? {
            host: {
              ...details.host,
              providers: details.host.providers.filter((provider) => providerIds.has(provider.provider_id))
            }
          }
        : {}),
      status: machine.status === 'pending' ? 'pending' : machine.status === 'revoked' ? 'revoked' : 'active',
      // pending/revoked 是持久事实；active 设备的连接只取自真实传输观测，无证据时为 unverified。
      link:
        machine.status === 'pending' || machine.status === 'revoked' ? 'offline' : observed.link(machine.machine_id),
      // 只列出调用方当前获授权的完整 tuple，runtime_* 可直接原样回传。
      targets: targets.map(/* 输出独立副本，调用方修改返回值不影响授权快照。 */ (target) => structuredClone(target))
    }
  }

  // 只输出当前数据库 binding 的公开字段；readiness 来自真实传输观测，没有证据时保持未核实。
  private provider(machine: string, provider: string, observed: ManagementTransportProjection): ProviderView {
    const binding = this.options.store.provider(machine, provider)
    if (!binding) {
      throw new FacadeServiceError('not_found')
    }
    const enabled = binding.enabled && this.options.store.machine(machine).status !== 'revoked'
    return {
      machine_id: binding.machine_id,
      provider_id: binding.provider_id,
      kind: binding.kind,
      binding_revision: binding.binding_revision,
      enabled: binding.enabled,
      // 禁用或无观测时不报告 ready；观测必须匹配当前 binding revision。
      readiness: !enabled ? 'unavailable' : observed.providerReady(machine, provider, binding.binding_revision)
    }
  }

  /** 只读取同一授权目录的已核验契约，不触发 native RPC，也不从安装常量或 readiness 猜版本。 */
  private providerMetadata(
    binding: ProviderBinding,
    targets: readonly V2Target[],
    principal: Principal,
    context: ServiceContext
  ): ProviderMetadata {
    if (binding.enabled && this.options.catalog) {
      for (const target of targets) {
        try {
          const provider =
            this.options.catalog.kind === 'mixed' ? this.options.catalog.select(target) : this.options.catalog
          if (!provider) {
            continue
          }
          const options = {
            store: this.options.store,
            principal,
            currentPrincipal: () => this.principal(context),
            localPolicies: this.options.localPolicies,
            terminalExecutionState: this.options.terminalExecutionState,
            target,
            expected_binding_revision: binding.binding_revision
          }
          const catalog =
            provider.kind === 'provider'
              ? authorizedProviderCatalog({ ...options, provider })
              : authorizedLuvusCatalog({ ...options, provider })
          return catalog.metadata
        } catch {
          // 缺失、过期或失效目录不妨碍查看 binding；返回前仍重新核对当前 read 授权。
        }
      }
    }
    return { native_version: null, schema_status: 'unavailable', schema_sha256: null }
  }

  // 签名只绑定分页范围和位置，不授予读取权；密钥只存在于当前门面实例，重启后旧游标失效。
  private cursorTag(scope: string, offset: number, expires: number): string {
    return createHmac('sha256', this.cursorKey)
      .update(JSON.stringify([scope, offset, expires]))
      .digest('base64url')
  }

  // 对当前授权后的行无状态分页；固定期限与完整scope签名避免页数、重读或其它列表挤占容量。
  private page<T>(
    items: T[],
    args: { cursor?: string; limit?: number },
    scope: unknown,
    now: number,
    expiresAt?: number,
    includePrevious = false
  ): Page<T> & { previous_cursor?: string | null } {
    const fingerprint = digest(canonical(scope))
    let offset = 0
    let expires = Math.min(now + 30_000, expiresAt ?? Infinity)
    if (args.cursor !== undefined) {
      const parts = /^page_v1\.([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(args.cursor)
      if (!parts) {
        throw new FacadeServiceError('invalid_cursor')
      }
      offset = Number(parts[1])
      const priorExpires = Number(parts[2])
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(priorExpires) ||
        now >= priorExpires ||
        !timingSafeEqual(Buffer.from(parts[3]!), Buffer.from(this.cursorTag(fingerprint, offset, priorExpires)))
      ) {
        throw new FacadeServiceError('invalid_cursor')
      }
      // 后续页只沿用原游标与当前目录的较早期限，不能借fresh resolve滑动续期。
      expires = Math.min(expires, priorExpires)
    }
    const limit = args.limit ?? 50
    const next = offset + limit
    const previous =
      includePrevious && offset > 0
        ? {
            previous_cursor:
              offset <= limit
                ? null
                : `page_v1.${offset - limit}.${expires}.${this.cursorTag(fingerprint, offset - limit, expires)}`
          }
        : {}
    if (next >= items.length) {
      return { ...previous, items: items.slice(offset, next) }
    }
    const token = `page_v1.${next}.${expires}.${this.cursorTag(fingerprint, next, expires)}`
    return { ...previous, items: items.slice(offset, next), next_cursor: token }
  }

  // 有界短等只轮询原调用，每轮重读当前身份/双方政策；终止等待不调用取消、派发或原生操作。
  private async callGet(args: ToolArguments['runtime_call_get'], context: ServiceContext): Promise<CallView> {
    const until = performance.now() + (args.wait_ms ?? 0)
    while (true) {
      // Router.get 经 Store.call 取得本轮最新持久时钟，并核验归属、恢复与当前 ACL。
      const call = this.router.get(this.principal(context), args.call_id)
      if (!['created', 'dispatching', 'connector_accepted'].includes(call.state) || performance.now() >= until) {
        return publicCallView(call)
      }
      await new Promise<void>(
        /* 将 AbortSignal 接到当前短等 timer，释放监听器后统一回到门禁，不形成任何执行重试。 */ (resolve) => {
          // 只唤醒本地轮询，既不变更账本也不取消 native 工作。
          const wake = /* 在超时或取消时释放两种资源，避免等待结束后遗留监听器。 */ () => {
            clearTimeout(timer)
            context.wait_signal.removeEventListener('abort', wake)
            resolve()
          }
          const timer = setTimeout(wake, Math.min(50, Math.max(1, until - performance.now())))
          context.wait_signal.addEventListener('abort', wake, { once: true })
          if (context.wait_signal.aborted) {
            wake()
          }
        }
      )
    }
  }

  // 统一验证服务入口；参数、身份和存储拒绝均保持固定公共错误，原始 SQLite 异常不会外泄。
  async execute<K extends ToolName>(
    name: K,
    args: ToolArguments[K],
    context: ServiceContext
  ): Promise<ServiceReply<K>> {
    try {
      if (!isToolName(name)) {
        throw new FacadeServiceError('unsupported')
      }
      let request: ToolRequest
      try {
        request = { name, args: parseToolArguments(name, args) } as ToolRequest
      } catch {
        throw new FacadeServiceError('invalid_arguments')
      }
      const principal = this.principal(context)
      const data =
        request.name === 'runtime_call_get'
          ? await this.callGet(request.args, context)
          : await this.run(request, principal, context, this.now())
      if (this.closed || context.wait_signal.aborted) {
        throw new FacadeServiceError('unavailable')
      }
      return { data: data as ReplyData[K] }
    } catch (error) {
      throw serviceError(error)
    }
  }

  // 用实际 Store/Router 完成已具备门禁的路径；未接线动作在产生账本、凭据或副作用前明确拒绝。
  private async run(
    request: ToolRequest,
    principal: Principal,
    context: ServiceContext,
    now: number
  ): Promise<ReplyData[ToolName]> {
    if (request.name === 'runtime_response_discard') {
      this.router.discardResponse(principal, request.args.call_id)
      return { call_id: request.args.call_id, content_status: 'discarded' }
    }
    if (request.name === 'runtime_discover' || request.name === 'runtime_describe') {
      const visible = this.visibleTargets(principal)
      if (
        !visible.some(
          /* 目录只接纳已通过同一完整Target read交集的资源。 */ (row) =>
            canonical(row.target) === canonical(request.args.target)
        )
      ) {
        throw new FacadeServiceError('not_found')
      }
      if (!this.options.catalog) {
        throw new FacadeServiceError('backend_unavailable')
      }
      const options = {
        store: this.options.store,
        principal,
        currentPrincipal: /* 扫描和描述期间仍从同一受信身份来源复验，不借用旧principal。 */ () =>
          this.principal(context),
        localPolicies: this.options.localPolicies,
        terminalExecutionState: this.options.terminalExecutionState,
        target: request.args.target,
        expected_binding_revision: request.args.expected_binding_revision
      }
      const provider =
        this.options.catalog.kind === 'mixed' ? this.options.catalog.select(request.args.target) : this.options.catalog
      if (!provider) {
        throw new FacadeServiceError('backend_unavailable')
      }
      const catalog =
        provider.kind === 'provider'
          ? authorizedProviderCatalog({ ...options, provider })
          : authorizedLuvusCatalog({ ...options, provider })
      if (request.name === 'runtime_describe') {
        return catalog.describe(request.args.method)
      }
      return this.page(
        catalog.methods,
        request.args,
        {
          principal: principal.id,
          policy: principal.policy,
          target: request.args.target,
          name: request.name,
          catalog: catalog.scope,
          args: queryArguments(request.args)
        },
        now,
        'expires_at' in catalog ? catalog.expires_at : catalog.scope.expires_at
      )
    }
    if (!['machines_list', 'machines_get', 'providers_list', 'providers_get'].includes(request.name)) {
      throw new FacadeServiceError('backend_unavailable')
    }
    const visible = this.visibleTargets(principal)
    const machines = [
      ...new Set(visible.map(/* 提取授权目标中的稳定设备 ID，不建立第二份注册表。 */ (row) => row.target.machine_id))
    ].sort()
    // 连接与 provider 就绪来自同一实际传输的只读观测；没有来源时各层保持未核实。
    const detailMachine =
      request.name === 'machines_get'
        ? (request.args.machine_id ??
          machines.find((machine) => this.options.store.machine(machine).name === request.args.name))
        : undefined
    const metadata =
      request.name === 'machines_get'
        ? { machine_ids: detailMachine && machines.includes(detailMachine) ? [detailMachine] : [], include_host: true }
        : request.name === 'machines_list'
          ? { machine_ids: machines, include_host: false }
          : undefined
    const { projection: observed } = this.observe(metadata)
    if (
      canonical(this.principal(context)) !== canonical(principal) ||
      canonical(this.visibleTargets(this.principal(context))) !== canonical(visible)
    ) {
      throw new FacadeServiceError('forbidden')
    }
    const scope = {
      principal: principal.id,
      policy: principal.policy,
      // 范围进入游标绑定：改范围后旧游标不再可重放。
      ...(principal.device_scope === undefined ? {} : { device_scope: principal.device_scope }),
      visible,
      generation: this.options.store.generation(),
      name: request.name,
      args: queryArguments(request.args)
    }
    if (request.name === 'machines_get') {
      const machineId =
        request.args.machine_id ??
        machines.find(
          /* 精确名称查询只扫描当前授权候选，不向未授权设备名称提供探测入口。 */ (machine) =>
            this.options.store.machine(machine).name === request.args.name
        )
      if (!machineId || !machines.includes(machineId)) {
        throw new FacadeServiceError('not_found')
      }
      return this.machine(
        machineId,
        /* 只回传该设备下当前获授权的完整 tuple。 */ visible
          .filter((row) => row.target.machine_id === machineId)
          .map((row) => row.target),
        observed,
        true
      )
    }
    if (request.name === 'machines_list') {
      return this.page(
        machines.map(
          /* 从真实 Store 读取每个当前授权设备的公开投影。 */ (machine) =>
            this.machine(
              machine,
              visible.filter((row) => row.target.machine_id === machine).map((row) => row.target),
              observed
            )
        ),
        request.args,
        scope,
        now
      )
    }
    if (request.name === 'providers_list' || request.name === 'providers_get') {
      const project = (provider: string): McpProviderView => {
        const basic = this.provider(request.args.machine_id, provider, observed)
        const binding = this.options.store.provider(request.args.machine_id, provider)!
        const metadata = this.providerMetadata(
          binding,
          visible
            .filter((row) => row.target.machine_id === binding.machine_id && row.target.provider_id === provider)
            .map((row) => row.target),
          principal,
          context
        )
        if (
          canonical(this.principal(context)) !== canonical(principal) ||
          canonical(this.visibleTargets(this.principal(context))) !== canonical(visible) ||
          canonical(this.options.store.provider(binding.machine_id, provider)) !== canonical(binding)
        ) {
          throw new FacadeServiceError('forbidden')
        }
        return { ...basic, ...metadata }
      }
      const ids = [
        ...new Set(
          visible
            .filter(
              /* 仅保留请求显式设备下获授权的 provider。 */ (row) => row.target.machine_id === request.args.machine_id
            )
            .map(/* 提取同一 tuple 中的 provider，不复用其它实例授权。 */ (row) => row.target.provider_id)
        )
      ].sort()
      if (!machines.includes(request.args.machine_id)) {
        throw new FacadeServiceError('not_found')
      }
      if (request.name === 'providers_get') {
        if (!ids.includes(request.args.provider_id)) {
          throw new FacadeServiceError('not_found')
        }
        return project(request.args.provider_id)
      }
      return this.page(
        ids.map(/* 读取每个当前授权 binding，剔除其内部配置引用。 */ (provider) => project(provider)),
        request.args,
        scope,
        now
      )
    }
    throw new FacadeServiceError('backend_unavailable')
  }

  // 重新核验独立管理会话和同一 Principal；MCP/设备身份及过期会话不能获得管理读模型。
  private administrator(context: AdminContext): { principal: Principal; admin: Administrator } {
    const principal = this.principal(context)
    if (typeof context.management_session_ref !== 'string' || !idPattern.test(context.management_session_ref)) {
      throw new FacadeServiceError('unauthenticated')
    }
    const admin = this.options.identities.administrator(context.caller, context.management_session_ref)
    if (
      !admin ||
      admin.principal_id !== principal.id ||
      admin.session_ref !== context.management_session_ref ||
      admin.assurance !== 'administrator' ||
      typeof admin.policy_revision !== 'string' ||
      !idPattern.test(admin.policy_revision) ||
      !Array.isArray(admin.grants) ||
      admin.grants.length > 4096
    ) {
      throw new FacadeServiceError('unauthenticated')
    }
    return { principal, admin: JSON.parse(canonical(admin)) as Administrator }
  }

  // 管理 grant 逐项匹配完整资源范围，不把设备管理权扩展到 provider 管理权。
  private allowed(
    admin: Administrator,
    action: ManagementGrant['action'],
    machine?: string,
    provider?: string
  ): boolean {
    return admin.grants.some(
      /* 同一条当前 grant 必须同时包含该操作和确切资源。 */ (grant) =>
        grant.action === action &&
        ('machine_id' in grant ? grant.machine_id === machine : machine === undefined) &&
        ('provider_id' in grant ? grant.provider_id === provider : provider === undefined)
    )
  }

  // 构建真实持久设备状态与明确未核实的现场状态，避免从数据库状态推断心跳、认证或设备 revision。
  private observe(metadata?: MachineObservationRequest) {
    // 先取样再读取 Store 时钟：取样中的观测不能因为晚于请求入口一毫秒而被误判为未来。
    const sample = sampleManagementTransport(this.options.transportObservations, metadata)
    const health = this.options.store.health()
    const now = this.options.store.clock()
    const projection = createManagementTransportProjection(sample, {
      mode: health.mode as ManagementStatus['mode'],
      server_time: now,
      recovery_generation: health.generation,
      stale_after_ms: 15000
    })
    return { projection, now, health }
  }

  private deviceSnapshot(machine: string, now: number, observed: ManagementTransportProjection): DeviceSnapshot {
    const row = this.options.store.machine(machine)
    if (!persistedStates.has(row.status)) {
      throw new FacadeServiceError('unavailable')
    }
    return observed.device({
      machine_id: row.machine_id,
      name: row.name,
      labels: null,
      persisted_state: row.status as DeviceSnapshot['persisted_state'],
      resource_revision: null,
      observed_at: now,
      // 平台是设备属性：从未上报就是 null，不从 os 猜测。
      platform: this.options.store.devicePlatform(row.machine_id),
      connection: { verification: 'unverified', reason_code: 'backend_unavailable' },
      authentication:
        row.status === 'revoked' || row.status === 'pending'
          ? {
              verification: 'verified',
              observed_at: now,
              source: 'store',
              value: { state: row.status, last_failure: null }
            }
          : { verification: 'unverified', reason_code: 'backend_unavailable' }
    })
  }

  // 管理面只输出词法安全的非秘密配置引用，绝不展开路径、环境或未核实的 native 信息。
  private providerSnapshot(
    machine: string,
    provider: string,
    now: number,
    observed: ManagementTransportProjection
  ): ProviderSnapshot {
    const binding = this.options.store.provider(machine, provider)!
    return {
      ...this.provider(machine, provider, observed),
      config_ref: idPattern.test(binding.config_ref) ? binding.config_ref : null,
      observed_at: now,
      runtime: { verification: 'unverified', reason_code: 'backend_unavailable' }
    }
  }

  // 返回短期 UI 提示，已获权限但缺少真实写后端的动作保持不可用；该快照不作为执行许可。
  private permissions(
    principal: Principal,
    admin: Administrator,
    target: { machine_id: string; provider_id?: string },
    now: number,
    context: AdminContext
  ): PermissionSnapshot {
    const actions: ManagementGrant['action'][] = target.provider_id
      ? ['providers_read', 'providers_manage']
      : ['devices_read', 'devices_rename', 'devices_disconnect', 'devices_revoke', 'permissions_read', 'calls_read']
    const mode = this.options.store.health().mode
    const capabilities = new Set(this.options.managementCapabilities?.(target) ?? [])
    const current = this.administrator(context)
    if (canonical(current.principal) !== canonical(principal) || canonical(current.admin) !== canonical(admin)) {
      throw new FacadeServiceError('forbidden')
    }
    const decisions: PermissionDecision[] = actions.map(
      /* 先判断当前权限，再说明真实后端或全局模式的阻断；不得把按钮状态用于后端授权。 */ (action) => {
        const allowed = this.allowed(
          admin,
          action,
          target.machine_id,
          action.startsWith('providers_') ? target.provider_id : undefined
        )
        const reason = !allowed
          ? 'forbidden'
          : !['devices_read', 'providers_read', 'permissions_read', 'calls_read'].includes(action)
            ? mode === 'storage_degraded'
              ? 'storage_degraded'
              : capabilities.has(action)
                ? 'allowed'
                : 'backend_unavailable'
            : 'allowed'
        return { action, allowed: reason === 'allowed', reason_code: reason }
      }
    )
    return {
      target,
      principal_id: principal.id,
      policy_revision: admin.policy_revision,
      caller_policy_revision: principal.policy.revision,
      local_policy_revision: null,
      recovery_generation: this.options.store.generation(),
      observed_at: now,
      expires_at: now + 5000,
      decisions
    }
  }

  // 管理调用窗口只读当前授权设备的账本元数据；分页与统计来自同一次采样，正文与凭据不进入回复。
  private callList(
    principal: Principal,
    admin: Administrator,
    args: ManagementArguments['calls_list'],
    now: number,
    mode: ManagementStatus['mode']
  ): ManagementReply['calls_list'] {
    const granted = [
      ...new Set(
        admin.grants
          .filter(/* 只有明确的 calls_read 授权设备可进入调用视图。 */ (grant) => grant.action === 'calls_read')
          .map(/* 提取同一条 grant 中的设备范围。 */ (grant) => (grant as { machine_id: string }).machine_id)
      )
    ].sort()
    if (!granted.length) {
      throw new FacadeServiceError('forbidden')
    }
    // 授权设备数受管理员记录上限约束；超出视为异常授权，不构造超长查询。
    if (granted.length > 900) {
      throw new FacadeServiceError('busy')
    }
    if (args.machine_id !== undefined && !granted.includes(args.machine_id)) {
      throw new FacadeServiceError('not_found')
    }
    const machines = args.machine_id === undefined ? granted : [args.machine_id]
    const since = Math.max(0, now - CALL_WINDOW_MS)
    // 多取一条用于判定窗口是否被采样上限截断；列表仍按签名游标分页。
    const rows = this.options.store.callsWindow(machines, since, CALL_WINDOW_LIMIT + 1)
    const truncated = rows.length > CALL_WINDOW_LIMIT
    const windowRows = truncated ? rows.slice(0, CALL_WINDOW_LIMIT) : rows
    const projected: CallSummary[] = windowRows.map(
      /* 逐行投影账本元数据；降级时未定结论保持 outcome_unknown，不宣称已执行。 */ (row) => {
        const state =
          mode === 'storage_degraded' && ['dispatching', 'connector_accepted'].includes(row.state)
            ? ('outcome_unknown' as const)
            : row.state
        const content =
          row.content_status === 'available' && now < row.content_expires
            ? ('available' as const)
            : row.content_status === 'available'
              ? ('expired' as const)
              : (row.content_status as CallSummary['content_status'])
        return {
          call_id: row.call_id,
          principal: row.principal,
          machine_id: row.machine_id,
          provider_id: row.provider_id,
          provider_kind: row.provider_kind,
          method: row.method,
          state,
          dispatched: row.epoch !== null,
          target: callTarget(row.target_json),
          outcome:
            row.response_category === 'result' || row.response_category === 'error' ? row.response_category : null,
          created_at: row.created,
          deadline: row.deadline,
          content_status: content
        }
      }
    )
    const items = args.states ? projected.filter((row) => args.states!.includes(row.state)) : projected
    const scope = {
      principal: principal.id,
      admin,
      generation: this.options.store.generation(),
      name: 'calls_list',
      args: queryArguments(args)
    }
    const page = this.page(items, args, scope, now, undefined, true)
    return {
      ...page,
      observed_at: now,
      aggregate: this.callAggregate(items),
      window: {
        since,
        first_at: items.length ? items[items.length - 1]!.created_at : null,
        last_at: items.length ? items[0]!.created_at : null,
        // 采样数与统计同一范围（含状态筛选），避免页面出现两个互相矛盾的总数。
        sampled: items.length,
        truncated
      }
    }
  }

  // 分布只覆盖本次采样并受分页过滤影响；分类长度有界，避免单次回复膨胀。
  private callAggregate(items: readonly CallSummary[]): CallAggregate {
    const states: CallState[] = [
      'created',
      'dispatching',
      'connector_accepted',
      'responded',
      'not_dispatched',
      'outcome_unknown'
    ]
    // provider_id 只在所属机器内唯一；历史记录也可能包含同一实例的不同 kind。
    const providerCounts = new Map<string, CallAggregate['by_provider'][number]>()
    for (const item of items) {
      const key = canonical([item.machine_id, item.provider_id, item.provider_kind])
      const previous = providerCounts.get(key)
      providerCounts.set(key, {
        machine_id: item.machine_id,
        provider_id: item.provider_id,
        kind: item.provider_kind,
        count: (previous?.count ?? 0) + 1
      })
    }
    return {
      total: items.length,
      by_state: tally(
        items.map(/* 状态分布用于页面环形图，值域固定。 */ (item) => item.state),
        states
      ).map(({ key, count }) => ({ state: key, count })),
      by_provider: ranked(
        [...providerCounts].map(([key, value]) => ({ key, count: value.count })),
        8
      ).map(({ key }) => providerCounts.get(key)!),
      by_principal: ranked(
        tally(
          items.map(/* 来源分布按 principal 计数，是审计可见的调用方标识。 */ (item) => item.principal),
          [...new Set(items.map((item) => item.principal))]
        ),
        8
      ).map(({ key, count }) => ({ principal: key, count })),
      by_method: ranked(
        tally(
          items.map(/* 命令分布按已提交方法名计数，不展开参数。 */ (item) => item.method),
          [...new Set(items.map((item) => item.method))]
        ),
        8
      ).map(({ key, count }) => ({ method: key, count }))
    }
  }

  // 实现独立管理只读查询，完整写契约在缺持久回执/确认和资源关闭后端时统一拒绝。
  private async adminExecute<K extends ManagementOperation>(
    name: K,
    value: ManagementArguments[K],
    context: AdminContext
  ): Promise<ManagementReply[K]> {
    try {
      const { principal, admin } = this.administrator(context)
      if (name === 'devices_get') {
        const args = adminArguments(value, ['machine_id'])
        const machine = args.machine_id as string
        if (!this.allowed(admin, 'devices_read', machine)) {
          throw new FacadeServiceError('not_found')
        }
        const { projection: observed, now } = this.observe({ machine_ids: [machine], include_host: true })
        const current = this.administrator(context)
        if (canonical(current.principal) !== canonical(principal) || canonical(current.admin) !== canonical(admin)) {
          throw new FacadeServiceError('forbidden')
        }
        const details = observed.machineDetails(machine)
        return {
          ...this.deviceSnapshot(machine, now, observed),
          last_seen_at: details.last_seen_at,
          link_since: details.link_since,
          ...(details.host
            ? {
                host: {
                  ...details.host,
                  providers: details.host.providers.filter((provider) =>
                    this.allowed(admin, 'providers_read', machine, provider.provider_id)
                  )
                }
              }
            : {})
        } as ManagementReply[K]
      }
      // 每次管理读取取一次传输观测，同一回复里的设备、provider 与状态汇总来自同一取样。
      const { projection: observed, now, health } = this.observe()
      if (name === 'status') {
        adminArguments(value, [])
        if (!this.allowed(admin, 'gateway_read')) {
          throw new FacadeServiceError('forbidden')
        }
        return {
          server_time: now,
          observed_at: now,
          mode: health.mode,
          recovery_generation: health.generation,
          policy_revision: admin.policy_revision,
          refresh_after_ms: 5000,
          stale_after_ms: 15000,
          history: null,
          components: {
            store: health.mode === 'active' ? 'available' : 'degraded',
            transport: observed.transport,
            // 传输层的派发就绪不是原生运行观测：没有原生观测来源时如实报告 unverified。
            native: 'unverified'
          }
        } as ManagementReply[K]
      }
      this.now()
      if (name === 'calls_list') {
        return this.callList(
          principal,
          admin,
          callArguments(value),
          now,
          health.mode as ManagementStatus['mode']
        ) as ManagementReply[K]
      }
      if (!['devices_list', 'devices_get', 'providers_list', 'providers_get', 'permissions_get'].includes(name)) {
        throw new FacadeServiceError('backend_unavailable')
      }
      const required =
        name === 'devices_list' ? [] : name === 'providers_get' ? ['machine_id', 'provider_id'] : ['machine_id']
      const optional =
        name === 'devices_list'
          ? ['cursor', 'limit', 'states']
          : name === 'providers_list'
            ? ['cursor', 'limit']
            : name === 'permissions_get'
              ? ['provider_id']
              : []
      const args = adminArguments(value, required, optional)
      const machine = args.machine_id as string | undefined
      const provider = args.provider_id as string | undefined
      const scope = {
        principal: principal.id,
        admin,
        generation: health.generation,
        name,
        args: queryArguments(args)
      }
      let result: unknown
      if (name === 'devices_list') {
        const ids = [
          ...new Set(
            admin.grants
              .filter(
                /* 枚举当前明确授予devices_read的设备ID，不创建全局注册表。 */ (grant) =>
                  grant.action === 'devices_read'
              )
              .map(/* 提取同一管理grant中的设备范围。 */ (grant) => (grant as { machine_id: string }).machine_id)
          )
        ].sort()
        result = this.page(
          ids
            .map(/* 从实际Store读取授权设备，不在页面层构造状态。 */ (id) => this.deviceSnapshot(id, now, observed))
            .filter(
              /* 先完成授权和真实状态校验，再按持久状态筛选，不推测现场连接状态。 */ (device) =>
                !args.states || (args.states as string[]).includes(device.persisted_state)
            ),
          args as { cursor?: string; limit?: number },
          scope,
          now
        )
      } else if (name === 'providers_list') {
        if (!this.allowed(admin, 'devices_read', machine)) {
          throw new FacadeServiceError('not_found')
        }
        this.options.store.machine(machine!)
        const ids = [
          ...new Set(
            admin.grants
              .filter(
                /* 限定同设备下显式providers_read的实例，设备查看权不扩大为provider查看权。 */ (grant) =>
                  grant.action === 'providers_read' && 'machine_id' in grant && grant.machine_id === machine
              )
              .map(/* 从单条完整范围中取provider ID。 */ (grant) => (grant as { provider_id: string }).provider_id)
          )
        ].sort()
        result = this.page(
          ids.map(
            /* 读取当前binding和安全引用，现场运行状态保持未核实。 */ (id) =>
              this.providerSnapshot(machine!, id, now, observed)
          ),
          args as { cursor?: string; limit?: number },
          scope,
          now
        )
      } else if (name === 'providers_get') {
        if (!this.allowed(admin, 'providers_read', machine, provider)) {
          throw new FacadeServiceError('not_found')
        }
        result = this.providerSnapshot(machine!, provider!, now, observed)
      } else {
        if (
          !this.allowed(admin, 'permissions_read', machine) ||
          !this.allowed(admin, provider ? 'providers_read' : 'devices_read', machine, provider)
        ) {
          throw new FacadeServiceError('not_found')
        }
        if (provider) {
          this.provider(machine!, provider, observed)
        } else {
          this.options.store.machine(machine!)
        }
        result = this.permissions(
          principal,
          admin,
          { machine_id: machine!, ...(provider ? { provider_id: provider } : {}) },
          now,
          context
        )
      }
      return result as ManagementReply[K]
    } catch (error) {
      throw serviceError(error)
    }
  }
}
