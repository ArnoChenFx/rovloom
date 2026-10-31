/**
 * herdr-core 的生产端口：Descriptor / Catalog / ProviderSession / LocalIdentityVerifier / NativeOwner。
 * 契约只来自本次实例 `rpc.discover` 的内容寻址快照，由宿主（附着或启动 core 的角色）发布；
 * 本模块不启动进程、不连接套接字，也不把配置里的期望值当作本地身份事实。
 */
import { isAbsolute, normalize } from 'node:path'
import { GatewayError } from '../../contracts.js'
import type { GatewayProviderServices, GatewayProviderPort } from '../../runtime/types.js'
import {
  createProviderPortRegistry,
  type LocalIdentityFacts,
  type LocalIdentityVerifier,
  type NativeOwner,
  type ProviderDescriptor,
  type ProviderPortRegistry,
  type ProviderSessionPort
} from '../../runtime/provider-port.js'
import { createProviderWireAdapter } from '../../runtime/provider-wire.js'
import { responseRetention } from '../../runtime/response-retention.js'
import type { Principal } from '../../router.js'
import type { Store } from '../../store.js'
import type { Connection, Session, SocketChannel } from '../../transport/index.js'
import { readSchema } from '../schema-store.js'
import {
  boundedJson,
  contractRef,
  fail,
  fields,
  id,
  object,
  parseJson,
  text,
  uint,
  validateContractSource,
  validateProvider,
  validateTarget
} from '../../wire/index.js'
import type {
  AuthenticatedContext,
  ContractRecord,
  ContractSource,
  Direction,
  JsonObject,
  ProviderBinding,
  V2Target
} from '../../wire/types.js'
import { HERDR_CORE_PROVIDER_DESCRIPTOR } from './descriptor.js'
import { herdrCoreSessionName } from './identity.js'
import {
  HERDR_CORE_BLOCKED_PARAMS,
  HERDR_CORE_EVENTS_PARAMS_SCHEMA,
  HERDR_CORE_EXPOSED_METHODS,
  HERDR_CORE_GUIDE,
  HERDR_CORE_SYNTHETIC_METHODS,
  HERDR_CORE_METHOD_USAGE,
  HERDR_CORE_CLASSIFICATION_REVISIONS,
  HERDR_CORE_UNAVAILABLE,
  herdrCoreTier
} from './methods.js'
import { requiresTerminalExecution } from '../terminal-execution.js'
import { describeHerdrCoreParams } from './overlay.js'
import { preflightHerdrCoreRequest } from './preflight.js'
import { compileHerdrCoreContract } from './schema.js'
import type { HerdrCoreContract } from './schema.js'
import { createHerdrCoreAdapter } from './readonly.js'
import type { HerdrCoreBackend, HerdrCoreContractRecord } from './readonly.js'

/** 只有附着本机已有实例时才有本地身份事实；Gateway 不伪造，缺证据就拒绝。 */
export type HerdrCoreIdentityFacts = () => LocalIdentityFacts

export type HerdrCoreClaimLedgerRef = Readonly<{
  path: string
  mode: 'create' | 'open'
  ledger_id: string
  limits: Readonly<{ entries: number; bytes: number }>
}>

/** Connector 侧的附着事实：会话名、端点位置、路由主体与发送墓碑；不启动或接管 core。 */
export type HerdrCoreConnectorConfig = Readonly<{
  session: string
  /** 配对时固定的端点位置；运行时不再读环境变量或 cwd 推断。 */
  endpoint: Readonly<{ runtime_dir?: string; state_home?: string }>
  principal_id: string
  claims: HerdrCoreClaimLedgerRef
}>

export type HerdrCoreProviderRefConfig = Readonly<{
  version: 1
  target: V2Target & { profile: 'session' }
  binding_revision: number
  config_ref: string
  expected_source: ContractSource
  /** `rpc.discover` 原文的内容寻址快照；摘要必须等于 expected_source.schema_sha256。 */
  schema_ref: string
  /** 只有 Connector 本地配置携带；Gateway 侧配置没有原生执行事实。 */
  connector?: HerdrCoreConnectorConfig
}>

/** 目录视图与 herdr 的 provider 目录同形；expires_at 只是视图期限，不是原生 lease。 */
export type HerdrCoreCatalogSource = Readonly<{
  target: V2Target
  local_provider: ProviderBinding
  contract_ref: string
  contract: ContractRecord
  capability_revision: string
  expires_at: number
  methods: readonly JsonObject[]
  describe(method: string): JsonObject
}>

/** 结构兼容 #8 目录端口；expires_at 只是目录视图期限，不是原生 lease 或调用截止。 */
export type HerdrCoreCatalogProvider = Readonly<{
  kind: 'provider'
  resolve(target: V2Target, principal: Principal): HerdrCoreCatalogSource | undefined
}>

export type HerdrCoreGatewayResources = Readonly<{
  kind: 'provider'
  providers: readonly GatewayProviderPort[]
  catalog: HerdrCoreCatalogProvider
  /** 端口层登记结果；Gateway 运行时按 kind 从这里取会话，不再接受组内自带 session。 */
  ports: ProviderPortRegistry
  describe(): ReturnType<typeof describeHerdrCoreContract>
  /**
   * 绑定当前连接上报的本机开关观察值（transport.terminalExecutionState）。
   * 绑定前一律当作关闭：控制档在 Gateway 登记前就被拒绝，不把未知当打开。
   */
  bindTerminalExecution(read: () => boolean | undefined): void
  release(): Promise<void>
}>

/** 配置路径必须显式规范绝对值；不从 cwd、环境变量或设备广告推断路径。 */
function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.includes('\0')) {
    fail('herdr_core_provider_config_invalid')
  }
  return value
}

/** 只生成共享 canonical provider 配置；不注册、启用或修改唯一 Gateway Store 中的 binding。 */
function provider(config: HerdrCoreProviderRefConfig): ProviderBinding {
  return Object.freeze({
    machine_id: config.target.machine_id,
    provider_id: config.target.provider_id,
    kind: 'herdr-core',
    config_ref: config.config_ref,
    binding_revision: config.binding_revision,
    enabled: true
  })
}

/** 账本只沿用既有 create/open 与预算字段；路径必须是规范绝对值。 */
function claims(value: unknown): HerdrCoreClaimLedgerRef {
  const row = object(value)
  fields(row, ['path', 'mode', 'ledger_id', 'limits'])
  id(row.ledger_id)
  if (row.mode !== 'create' && row.mode !== 'open') {
    fail('herdr_core_provider_config_invalid')
  }
  const limits = object(row.limits)
  fields(limits, ['entries', 'bytes'])
  uint(limits.entries, true)
  uint(limits.bytes, true)
  return Object.freeze({
    path: path(row.path),
    mode: row.mode,
    ledger_id: row.ledger_id,
    limits: Object.freeze({ entries: limits.entries, bytes: limits.bytes })
  })
}

/** 端点位置只接受一个固定来源，且必须是规范绝对路径。 */
function endpoint(value: unknown): HerdrCoreConnectorConfig['endpoint'] {
  const row = object(value)
  fields(row, [], ['runtime_dir', 'state_home'])
  const keys = ['runtime_dir', 'state_home'].filter((key) => row[key] !== undefined)
  if (keys.length !== 1) {
    fail('herdr_core_provider_config_invalid')
  }
  return Object.freeze(
    keys[0] === 'runtime_dir' ? { runtime_dir: path(row.runtime_dir) } : { state_home: path(row.state_home) }
  )
}

/** Connector 本地事实只在本地配置出现；会话必须与 Target 的 session 一致。 */
function connector(value: unknown, target: V2Target & { profile: 'session' }): HerdrCoreConnectorConfig {
  const row = object(value)
  fields(row, ['session', 'endpoint', 'principal_id', 'claims'])
  const session = herdrCoreSessionName(row.session)
  if (session !== target.session) {
    fail('herdr_core_provider_config_invalid')
  }
  id(row.principal_id)
  return Object.freeze({
    session,
    endpoint: endpoint(row.endpoint),
    principal_id: row.principal_id,
    claims: claims(row.claims)
  })
}

/** 公开 JSON 配置解析器只校验声明；实际 schema 文件、摘要与编译结果由资源工厂另外验证。 */
export function parseHerdrCoreProviderRefConfig(input: unknown): HerdrCoreProviderRefConfig {
  const value = object(parseJson(boundedJson(input, 65_536)))
  fields(value, ['version', 'target', 'binding_revision', 'config_ref', 'expected_source', 'schema_ref'], ['connector'])
  if (value.version !== 1) {
    fail('herdr_core_provider_config_invalid')
  }
  validateTarget(value.target)
  if (value.target.profile !== 'session') {
    fail('unsupported_profile')
  }
  uint(value.binding_revision, true)
  text(value.config_ref, 256)
  validateContractSource(value.expected_source)
  if (
    value.expected_source.provider_kind !== 'herdr-core' ||
    value.expected_source.protocol_family !== 'herdr-core-jsonrpc' ||
    value.expected_source.schema_command !== 'rpc.discover' ||
    value.expected_source.schema_origin !== 'live_instance'
  ) {
    fail('herdr_core_contract_unreviewed')
  }
  // 分类修订标识本仓库的档位表，是配置事实：不属于它的配置在读取任何文件之前就拒绝。core 的版本与协议代次不设限。
  if (!HERDR_CORE_CLASSIFICATION_REVISIONS.includes(value.expected_source.classification_revision ?? '')) {
    fail('herdr_core_contract_unreviewed')
  }
  const parsedTarget = Object.freeze({ ...value.target }) as V2Target & { profile: 'session' }
  return Object.freeze({
    version: 1,
    target: parsedTarget,
    binding_revision: value.binding_revision,
    config_ref: value.config_ref,
    expected_source: Object.freeze({ ...value.expected_source }),
    schema_ref: path(value.schema_ref),
    ...(value.connector === undefined ? {} : { connector: connector(value.connector, parsedTarget) })
  })
}

/**
 * 公开描述只含方法与档位、core 自己的说明与 rovloom 的使用说明；
 * 不输出契约字节、原生请求或终端内容。
 */
export function describeHerdrCoreContract(input: {
  target: V2Target
  binding_revision: number
  source: ContractSource
  contract: HerdrCoreContract
}) {
  return Object.freeze({
    target: structuredClone(input.target),
    binding_revision: input.binding_revision,
    source: structuredClone(input.source),
    source_basis: 'live_instance_contract' as const,
    contract_identity: input.contract.identity,
    /** 全局使用说明（rovloom 撰写、经审核），随每次 describe 一起交付。 */
    guide: HERDR_CORE_GUIDE,
    /** core 有、rovloom 不开放的方法与原因（固定码），让控制端能发现边界而不是以为能力缺失。 */
    blocked_methods: HERDR_CORE_UNAVAILABLE,
    methods: Object.freeze(
      HERDR_CORE_EXPOSED_METHODS.map(
        /** 只描述本期开放的方法；参数 schema 与说明来自本次实例的审核结果。 */ (method) =>
          Object.freeze({
            method,
            // rovloom 自有方法不在 core 的 32 个方法表里，档位固定为观察。
            tier: HERDR_CORE_SYNTHETIC_METHODS.includes(method) ? ('observe' as const) : herdrCoreTier(method),
            description: HERDR_CORE_SYNTHETIC_METHODS.includes(method)
              ? 'rovloom long poll: current snapshot plus events after a watermark (not a core method).'
              : input.contract.methodDescription(method),
            params_schema: HERDR_CORE_SYNTHETIC_METHODS.includes(method)
              ? structuredClone(HERDR_CORE_EVENTS_PARAMS_SCHEMA)
              : describeHerdrCoreParams(input.contract, method),
            /** 审核表里一律拒绝的参数；它们不出现在 params_schema 里。 */
            blocked_params: HERDR_CORE_BLOCKED_PARAMS,
            ...(HERDR_CORE_METHOD_USAGE[method] ? { usage: HERDR_CORE_METHOD_USAGE[method] } : {})
          })
      )
    )
  })
}

/** 宿主交付的持久事实；本模块不打开 Gateway Store、不建立设备身份或原生连接。 */
export type HerdrCoreHostServices = Readonly<{
  currentPrincipal(): string | undefined
  localProvider(target: V2Target): ProviderBinding | undefined
  context(principal: string, direction: Direction): AuthenticatedContext
}>

/** Store 只填持久化事实，并将当前连接及每个完整 Target 与本机 provider 配置核对。 */
export function persistentHerdrCoreBackend(
  store: Store,
  services: HerdrCoreHostServices,
  contract: (ref: string) => HerdrCoreContractRecord | undefined
): HerdrCoreBackend {
  return {
    ...services,
    contract,
    attempt: /** 内容过期后 Store 不再返回请求，adapter 只能使用既有最小响应上下文。 */ (call, attempt) =>
      store.attempt(call, attempt),
    now: /** 事务内外共用 Store 固定的可信时钟。 */ () => store.clock(),
    responseAnchor: /** 从原账本查询绑定、状态和不可延长的期限。 */ (binding) => store.responseAnchor(binding),
    contentStatus: /** 内容状态独立于响应合法性，不因迟到结果而复活。 */ (binding) =>
      store.responseAnchor(binding).content_status,
    subscribeInvalidation: /** 只转接已提交回收与 fence 通知，退订由 adapter 负责。 */ (listener) =>
      store.subscribeInvalidation(listener),
    /** 每次取得当前认证并向 Store 核对 epoch，再封装 provider 的双端配置检查。 */
    context(principal, direction) {
      const context = services.context(principal, direction)
      store.assertConnection(context.connection)
      return {
        ...context,
        direction,
        resolveProvider: /** 同一 Target 必须在 Store 和受保护本地配置完全一致。 */ (target) => {
          const registered = store.provider(target.machine_id, target.provider_id)
          const local = services.localProvider(target)
          if (!registered || !local || boundedJson(registered) !== boundedJson(local)) {
            fail('provider_binding_mismatch')
          }
          return registered
        }
      }
    }
  }
}

/** 只接受本次实例的已审核契约；分类修订已由配置解析核对，这里核对方法集合。 */
function reviewedContract(source: ContractSource, contract: HerdrCoreContract): void {
  validateContractSource(source)
  if (source.provider_kind !== 'herdr-core') {
    fail('herdr_core_contract_unreviewed')
  }
  // 契约里的方法集合必须覆盖本期开放集合，缺项说明文档与审核表不一致。
  // rovloom 自己提供的方法（长轮询）不在 core 契约里，参数与结果由本仓库审核。
  for (const method of HERDR_CORE_EXPOSED_METHODS) {
    if (HERDR_CORE_SYNTHETIC_METHODS.includes(method)) {
      continue
    }
    if (!contract.methods.includes(method)) {
      fail('herdr_core_contract_unreviewed')
    }
  }
}

/** Gateway 校验实际 schema 字节并保留编译快照；本机身份事实仍由附着宿主交付。 */
export async function createHerdrCoreGatewayResources(
  input: Readonly<{
    config: unknown
    now?: () => number
    facts?: HerdrCoreIdentityFacts
    /** 可选：当前连接上报的本机开关；生产由 started 钩子晚绑定，缺省即关闭。 */
    terminalExecution?: () => boolean | undefined
  }>
): Promise<HerdrCoreGatewayResources> {
  const config = parseHerdrCoreProviderRefConfig(input.config)
  // 字节先按内容寻址摘要核对，再编译；分类修订与开放集合在编译后逐项核对。
  const bytes = readSchema(
    config.schema_ref,
    config.expected_source.schema_sha256,
    'herdr_core_schema_unreviewed',
    'herdr_core_provider_file_invalid'
  )
  const contract = compileHerdrCoreContract(bytes)
  reviewedContract(config.expected_source, contract)
  const record: HerdrCoreContractRecord = Object.freeze({
    wire: Object.freeze({ source: config.expected_source, support_status: 'validated' }),
    contract
  })
  const reference = contractRef(config.expected_source)
  const binding = provider(config)
  const descriptor: ProviderDescriptor = HERDR_CORE_PROVIDER_DESCRIPTOR
  const sessions = new Set<Session>()
  const now = input.now ?? Date.now
  let closed = false
  let catalogClock = -1
  // 晚绑定：Gateway 运行时与传输先于本次绑定建立，绑定前一律当作关闭。
  let terminalExecution = input.terminalExecution

  /** 只读取当前连接的上报值；未知（未上报/断线/被 fence）一律当作关闭。 */
  function terminalEnabled(): boolean {
    try {
      return terminalExecution?.() === true
    } catch {
      return false
    }
  }

  /** Gateway 本机只确认配置与契约仍当前有效，不把此判断命名为远端本机测量。 */
  function assertCurrent(): void {
    if (closed) {
      fail('herdr_core_provider_closed')
    }
  }

  /** 目录时钟只约束五秒元数据视图；从不写入或续期任何 call、receipt 或原生 lease。 */
  function catalogNow(): number {
    assertCurrent()
    const at = now()
    assertCurrent()
    uint(at)
    if (at < catalogClock || !Number.isSafeInteger(at + 5000)) {
      fail('clock_untrusted')
    }
    catalogClock = at
    return at
  }

  const catalog: HerdrCoreCatalogProvider = Object.freeze({
    kind: 'provider',
    /** 当前 principal 是既有认证宿主的输入，目录不创建身份，也不替代实际双端派发/读取授权。 */
    resolve(target: V2Target, principal: Principal) {
      assertCurrent()
      validateTarget(target)
      id(principal.id)
      if (boundedJson(target) !== boundedJson(config.target)) {
        return undefined
      }
      const described = describeHerdrCoreContract({
        target: config.target,
        binding_revision: config.binding_revision,
        source: config.expected_source,
        contract
      })
      const visible = described.methods.map(
        /** 目录只公开方法摘要，不携带参数 schema。 */ (entry) => {
          const summary: JsonObject = { method: entry.method, tier: entry.tier }
          return summary
        }
      )
      const expires = catalogNow() + 5000
      return Object.freeze({
        target: structuredClone(config.target),
        local_provider: { ...binding },
        contract_ref: reference,
        contract: structuredClone(record.wire),
        capability_revision: contract.identity,
        expires_at: expires,
        methods: Object.freeze(visible),
        describe(method: string): JsonObject {
          if (catalogNow() >= expires) {
            fail('catalog_view_expired')
          }
          if (!HERDR_CORE_EXPOSED_METHODS.includes(method)) {
            fail('runtime_method_unavailable')
          }
          const found = described.methods.find(
            /** 只取当前固定来源中的精确方法描述。 */ (entry) => entry.method === method
          )
          if (!found) {
            fail('runtime_method_unavailable')
          }
          return {
            method: found.method,
            tier: found.tier,
            description: found.description,
            params_schema: structuredClone(found.params_schema),
            blocked_params: found.blocked_params,
            ...(found.usage ? { usage: found.usage } : {}),
            /** 使用说明是全局的，逐条 describe 也带上，控制端不必先读整份目录。 */
            guide: described.guide,
            /** core 有、rovloom 不开放的方法与原因。 */
            blocked_methods: described.blocked_methods
          }
        }
      })
    }
  })

  const session: ProviderSessionPort = Object.freeze({
    /** 原中性 Gateway 在认证提交后交付真实通道；资源只组装对应 epoch 的普通 Wire。 */
    session(connection: Connection, channel: SocketChannel, services: GatewayProviderServices): Session {
      assertCurrent()
      if (connection.machine_id !== config.target.machine_id) {
        fail('connection_binding_mismatch')
      }
      const backend = persistentHerdrCoreBackend(
        services.store,
        {
          currentPrincipal: services.currentPrincipal,
          /** 当前受保护本地配置必须与这一个完整 provider 同值。 */
          localProvider: (target) => {
            const local = services.localProvider(target)
            if (!local || boundedJson(local) !== boundedJson(binding)) {
              fail('provider_binding_mismatch')
            }
            return local
          },
          context: (principal, direction) => ({
            phase: 'authenticated',
            direction,
            connection: channel.connection(),
            resolveContract: /** 固定契约必须仍可从本资源读取。 */ (ref) =>
              ref === reference ? record.wire : undefined
          })
        },
        /** 只交付本次实例的审核契约；其它引用不可解析。 */ (ref) => (ref === reference ? record : undefined)
      )
      const core = createHerdrCoreAdapter(backend)
      const adapter = createProviderWireAdapter(core, 'herdr_core_transport_unsupported', () => backend.now())
      const result: Session = {
        adapter,
        readiness: /** 此处只报告配置/契约先决条件，不虚构原生进程或终端状态。 */ () => {
          assertCurrent()
          const local = services.localProvider(config.target)
          return {
            providers: [{ expected: binding, local: local ?? { ...binding, enabled: false }, native_ready: true }]
          }
        },
        close: /** 会话关闭即时撤销本 epoch 的全部私有 Wire permit。 */ () => {
          try {
            core.close()
          } finally {
            sessions.delete(result)
          }
        }
      }
      assertCurrent()
      sessions.add(result)
      return result
    }
  })

  const identity: LocalIdentityVerifier = Object.freeze({
    /** 只复核调用方已登记的完整 binding；没有本机事实时明确拒绝，不用配置冒充证据。 */
    verify(value: ProviderBinding): LocalIdentityFacts {
      validateProvider(value)
      if (boundedJson(value) !== boundedJson(binding)) {
        fail('provider_binding_mismatch')
      }
      if (!input.facts) {
        fail('herdr_core_identity_unavailable')
      }
      const facts = input.facts()
      if (facts.kind !== 'herdr-core' || facts.provider_id !== binding.provider_id) {
        fail('provider_binding_mismatch')
      }
      return Object.freeze({ ...facts })
    }
  })

  const owner: NativeOwner = Object.freeze({
    /** 释放本资源自己的会话与契约；不停止外部 core，也不删除用户数据。 */
    release: async () => {
      closed = true
      let failed = false
      for (const entry of sessions) {
        try {
          entry.close()
        } catch {
          failed = true
        }
      }
      sessions.clear()
      if (failed) {
        throw new GatewayError('herdr_core_gateway_release_failed')
      }
    }
  })

  // 端口层登记会拒绝重复 kind、缺失端口、表外档位和自由文本保证；装配只按 kind 取会话。
  const ports = createProviderPortRegistry([{ descriptor, catalog, session, identity, owner }])

  return Object.freeze({
    kind: 'provider',
    providers: Object.freeze<GatewayProviderPort[]>([
      {
        binding,
        target: config.target,
        retainEvidence: responseRetention(65_536),
        /**
         * herdr-core 的方法参数都是对象：省略 `params` 与显式 `{}` 是同一个请求。
         * 在登记前规范化，存档的请求、去重键与 Wire 帧因此完全一致；其它形状原样交给预检。
         */
        normalizeRequest(request) {
          return request.params === undefined ? Object.freeze({ ...request, params: {} }) : request
        },
        admit(request, admission, register) {
          return register(admission, (candidate) => {
            if (admission.contract_ref !== reference) {
              fail('contract_unavailable')
            }
            assertCurrent()
            // 预检拒绝发生在登记前：只核对方法与审核参数，不发送原生请求。
            const method = object(candidate).method
            if (typeof method !== 'string' || !HERDR_CORE_EXPOSED_METHODS.includes(method)) {
              fail('herdr_core_method_unavailable')
            }
            // 直接输入与控制档在本机开关关闭时连登记都不发生；目录隐藏与 Connector 最终写入另有同样门禁。
            if (requiresTerminalExecution('herdr-core', method, object(candidate.params ?? {})) && !terminalEnabled()) {
              fail('terminal_execution_disabled')
            }
            // 与 Wire 编码完全相同的参数审核放在登记前：被拒的调用不产生记录，控制端直接拿到固定路径与规则。
            // 编码阶段仍是最后一道防线（例如网关与连接器版本不一致时），那里的码由调用视图的 reason 交付。
            preflightHerdrCoreRequest({ contract, method, params: candidate.params })
          })
        },
        ready: /** 仅本地契约先决条件；认证 peer 的 readiness 仍由原 transport 计算。 */ () => {
          assertCurrent()
          return true
        }
      }
    ]),
    catalog,
    ports,
    describe: () =>
      describeHerdrCoreContract({
        target: config.target,
        binding_revision: config.binding_revision,
        source: config.expected_source,
        contract
      }),
    /** 只接受宿主晚绑定的同步观察口；晚绑定之前控制档一律关闭。 */
    bindTerminalExecution(read: () => boolean | undefined): void {
      if (typeof read !== 'function') {
        fail('terminal_execution_state_invalid')
      }
      terminalExecution = read
    },
    release: owner.release
  })
}
