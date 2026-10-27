/** 交付现有通用角色所需 Herdr 资源；不启动 Gateway、Connector、原生进程或建立身份。 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { GatewayError } from '../../contracts.js'
import { NativeRequestPreflightError } from '../../runtime/request-preflight.js'
import { privateFile, readPrivateBytes } from '../../storage/files.js'
import {
  ConnectorAttemptBook,
  CONNECTOR_MAX_DEADLINE_MS,
  connectorAdmissionAdapter,
  createConnectorAdmissionBackend
} from '../../runtime/connector-attempts.js'
import type { GatewayProviderServices, RuntimeProviderBinding } from '../../runtime/types.js'
import type { Principal } from '../../router.js'
import type { LedgerInvalidation } from '../../storage/model.js'
import type { Connection, ConnectorWireSession, Session, SocketChannel } from '../../transport/index.js'
import { LuvusDispatchClaims } from '../luvus/claims.js'
import {
  boundedJson,
  contractRef,
  fail,
  fields,
  hash,
  id,
  object,
  parseJson,
  providerScopeAllowed,
  text,
  uint,
  validateContractSource,
  validatePolicies,
  validateTarget,
  assertBinding,
  WireError
} from '../../wire/index.js'
import type {
  ContractRecord,
  ContractSource,
  JsonObject,
  ProviderBinding,
  ProviderPolicies,
  V2Target
} from '../../wire/types.js'
import { compileHerdrSchemas } from './compiler-api.js'
import { HerdrInstallation, createHerdrHostServices } from './installation.js'
import { HerdrLocalError, inspectHerdrPath, pinHerdrConfig } from './local.js'
import type { HerdrLocalConfig } from './local.js'
import type { HerdrContractRecord, HerdrReadonlyBackend } from './readonly.js'
import { createHerdrCodec } from './readonly.js'
import { persistentHerdrBackend } from './persistence.js'
import { createHerdrRuntime } from './runtime.js'
import { createHerdrWireAdapter } from './wire.js'
import { isReviewedHerdrSource } from './review.js'
import { createHerdrGatewaySourceOwner } from './source.js'
import { describeHerdrContract } from './discovery.js'

export type HerdrLedgerRef = Readonly<{
  path: string
  mode: 'create' | 'open'
  ledger_id: string
  limits: Readonly<{ entries: number; bytes: number }>
}>
export type HerdrProviderRefConfig = Readonly<{
  version: 1
  target: V2Target & { profile: 'session' }
  binding_revision: number
  config_ref: string
  expected_source: ContractSource
  schema_path: string
  peer_policy_revision: string
  connector?: Readonly<{
    local: HerdrLocalConfig
    principal_id: string
    claims: HerdrLedgerRef
  }>
}>
export type HerdrGatewayResources = Readonly<{
  kind: 'provider'
  providers: readonly (RuntimeProviderBinding & { max_response_bytes: number })[]
  catalog: HerdrProviderCatalogProvider
  describe(): ReturnType<typeof describeHerdrContract>
  session(connection: Connection, channel: SocketChannel, services: GatewayProviderServices): Session
  release(): Promise<void>
}>
export type HerdrConnectorResources = Readonly<{
  // 只交付原受保护配置路由，供runtime组合原session，不来自请求或广告。
  providers: readonly Readonly<{ binding: ProviderBinding; target: V2Target }>[]
  kind: 'provider'
  session(connection: Connection): ConnectorWireSession
  release(): Promise<void>
  release_timeout_ms: number
  // 来源在后台被替换（实例丢失后重新附着/重建）时通知宿主结束当前连接周期，让下一次认证 epoch 取到新会话。
  session_replaced?(listener: () => void): () => void
}>
/** 结构兼容 #8 目录端口；expires_at 只是目录视图期限，不是原生 lease 或调用截止。 */
export type HerdrProviderCatalogSource = Readonly<{
  target: V2Target
  local_provider: ProviderBinding
  contract_ref: string
  contract: ContractRecord
  capability_revision: string
  expires_at: number
  methods: readonly JsonObject[]
  describe(method: string): JsonObject
}>
export type HerdrProviderCatalogProvider = Readonly<{
  kind: 'provider'
  resolve(target: V2Target, principal: Principal): HerdrProviderCatalogSource | undefined
}>

/** 配置路径必须显式规范绝对值，读取配置不从 cwd、环境变量或设备广告推断路径。 */
function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.includes('\0')) {
    fail('herdr_provider_path_invalid')
  }
  return value
}

/** 持久账本沿用现有 create/open 和预算接口；不新建 book 数据库或静默重建缺失墓碑。 */
function ledgerRef(input: unknown, maximum: number): HerdrLedgerRef {
  const value = object(input)
  fields(value, ['path', 'mode', 'ledger_id', 'limits'])
  id(value.ledger_id)
  if (value.mode !== 'create' && value.mode !== 'open') {
    fail('herdr_provider_config_invalid')
  }
  const limits = object(value.limits)
  fields(limits, ['entries', 'bytes'])
  uint(limits.entries, true)
  uint(limits.bytes, true)
  if (limits.entries > maximum || limits.bytes < 262_144 || limits.bytes > 16_777_216) {
    fail('herdr_provider_config_invalid')
  }
  return Object.freeze({
    path: path(value.path),
    mode: value.mode,
    ledger_id: value.ledger_id,
    limits: Object.freeze({ entries: limits.entries, bytes: limits.bytes })
  })
}

/** 公开 JSON 配置解析器只校验声明；实际文件、安装和当前认证来源由资源工厂另外验证。 */
export function parseHerdrProviderRefConfig(input: unknown): HerdrProviderRefConfig {
  const value = object(parseJson(boundedJson(input, 65_536)))
  fields(
    value,
    ['version', 'target', 'binding_revision', 'config_ref', 'expected_source', 'schema_path', 'peer_policy_revision'],
    ['connector']
  )
  if (value.version !== 1) {
    fail('herdr_provider_config_invalid')
  }
  validateTarget(value.target)
  if (value.target.profile !== 'session') {
    fail('unsupported_profile')
  }
  uint(value.binding_revision, true)
  text(value.config_ref, 256)
  id(value.peer_policy_revision)
  validateContractSource(value.expected_source)
  if (!isReviewedHerdrSource(value.expected_source)) {
    fail('herdr_contract_unreviewed')
  }
  const target = Object.freeze({ ...value.target })
  const shared = {
    version: 1 as const,
    target,
    binding_revision: value.binding_revision,
    config_ref: value.config_ref,
    expected_source: Object.freeze({ ...value.expected_source }),
    schema_path: path(value.schema_path),
    peer_policy_revision: value.peer_policy_revision
  }
  if (value.connector === undefined) {
    return Object.freeze(shared)
  }
  const connector = object(value.connector)
  fields(connector, ['local', 'principal_id', 'claims'])
  id(connector.principal_id)
  const local = object(connector.local)
  fields(
    local,
    [
      'target',
      'binding_revision',
      'config_ref',
      'binary',
      'home',
      'config_home',
      'state_home',
      'cache_home',
      'temporary_home',
      'cwd'
    ],
    ['allow_terminal_execution', 'agent_bin_dirs', 'attach']
  )
  if (
    boundedJson(local.target) !== boundedJson(target) ||
    local.binding_revision !== shared.binding_revision ||
    local.config_ref !== shared.config_ref
  ) {
    fail('provider_binding_mismatch')
  }
  const pinned = pinHerdrConfig({
    target,
    binding_revision: shared.binding_revision,
    config_ref: shared.config_ref,
    binary: path(local.binary),
    home: path(local.home),
    config_home: path(local.config_home),
    state_home: path(local.state_home),
    cache_home: path(local.cache_home),
    temporary_home: path(local.temporary_home),
    cwd: path(local.cwd),
    ...(Object.hasOwn(local, 'allow_terminal_execution')
      ? { allow_terminal_execution: local.allow_terminal_execution as boolean }
      : {}),
    ...(Object.hasOwn(local, 'agent_bin_dirs') ? { agent_bin_dirs: local.agent_bin_dirs as string[] } : {}),
    ...(Object.hasOwn(local, 'attach') ? { attach: local.attach as true } : {})
  })
  const claims = ledgerRef(connector.claims, 4096)
  return Object.freeze({
    ...shared,
    connector: Object.freeze({ local: pinned, principal_id: connector.principal_id, claims })
  })
}

/** 文件底层异常只保留已有固定码，缺失路径或操作系统诊断不进入公共错误。 */
function fileOperation<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof GatewayError || error instanceof HerdrLocalError) {
      throw error
    }
    fail('herdr_provider_file_unavailable')
  }
}
/** 从同一不跟随链接的私有 fd 有界读取并固定身份，原文和路径不进入公共错误。 */
function protectedFile(file: string, maximum: number) {
  return fileOperation(
    /** 读取前后的完整身份必须属于同一文件。 */ () => {
      inspectHerdrPath(dirname(file), 'directory')
      privateFile(file)
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = fstatSync(fd, { bigint: true })
        if (before.size < 1n || before.size > BigInt(maximum)) {
          fail('herdr_provider_file_invalid')
        }
        const buffer = Buffer.alloc(Number(before.size) + 1)
        let total = 0
        for (;;) {
          const size = readSync(fd, buffer, total, buffer.length - total, null)
          if (!size) {
            break
          }
          total += size
          if (total > Number(before.size)) {
            fail('herdr_provider_file_changed')
          }
        }
        const bytes = buffer.subarray(0, total)
        const stamp = /** 文件 inode/权限与内容身份都必须保持一致。 */ (entry: typeof before) =>
          [entry.dev, entry.ino, entry.uid, entry.mode, entry.nlink, entry.ctimeNs, entry.size].join(':')
        const identity = stamp(before)
        if (
          stamp(fstatSync(fd, { bigint: true })) !== identity ||
          stamp(lstatSync(file, { bigint: true })) !== identity ||
          bytes.length !== Number(before.size)
        ) {
          fail('herdr_provider_file_changed')
        }
        return {
          bytes,
          assertCurrent: /** 逐次复核原配置文件身份；不从新文件补建旧来源。 */ () => {
            fileOperation(
              /** 已关闭或被替换的配置不能恢复旧来源。 */ () => {
                inspectHerdrPath(dirname(file), 'directory')
                privateFile(file)
                if (stamp(lstatSync(file, { bigint: true })) !== identity) {
                  fail('herdr_provider_file_changed')
                }
              }
            )
          }
        }
      } finally {
        closeSync(fd)
      }
    }
  )
}
/** #8 的显式 ref loader 可直接调用；不解释 executable module 或在导入配置时启动服务。 */
export function readHerdrProviderRefConfig(file: string): HerdrProviderRefConfig {
  const opened = protectedFile(path(file), 65_536)
  const result = parseHerdrProviderRefConfig(parseJson(opened.bytes, 65_536))
  opened.assertCurrent()
  return result
}

/** 只生成共享 canonical provider 配置；不注册、启用或修改唯一 Gateway Store 中的 binding。 */
function provider(config: HerdrProviderRefConfig): ProviderBinding {
  return Object.freeze({
    machine_id: config.target.machine_id,
    provider_id: config.target.provider_id,
    kind: 'herdr',
    config_ref: config.config_ref,
    binding_revision: config.binding_revision,
    enabled: true
  })
}

/** Gateway校验实际schema字节并保留编译快照；远端binary/endpoint仍由Connector安装所有者交付。 */
export async function createHerdrGatewayResources(
  input: Readonly<{ config: unknown; signal?: AbortSignal; now?: () => number }>
): Promise<HerdrGatewayResources> {
  const config = parseHerdrProviderRefConfig(input.config)
  // Gateway加载普通文件的有界字节快照；运行中的编译契约不依赖文件所有者、权限或inode。
  const bytes = fileOperation(
    /** 路径已由角色配置解析器核对。 */ () => readPrivateBytes(config.schema_path, 16_777_216)
  )
  if (!bytes.length) {
    fail('herdr_provider_file_invalid')
  }
  if (hash(bytes) !== config.expected_source.schema_sha256) {
    fail('herdr_schema_unreviewed')
  }
  const schemas = await compileHerdrSchemas(bytes, input.signal)
  const codec = createHerdrCodec(config.expected_source, schemas)
  const schemaDocument = object(JSON.parse(bytes.toString('utf8')))
  const record: HerdrContractRecord = Object.freeze({
    wire: Object.freeze({ source: config.expected_source, support_status: 'validated' }),
    schemas
  })
  const reference = contractRef(config.expected_source)
  const binding = provider(config)
  const sessions = new Set<Session>()
  let closed = false
  let catalogClock = -1
  const now = input.now ?? Date.now
  /** Gateway 本机只确认契约和配置仍当前有效，不把此判断命名为远端本机测量。 */
  function assertCurrent(): void {
    if (closed) {
      fail('herdr_provider_closed')
    }
  }
  /** 同一来源的公开描述每次重验；没有 caller 的此端口本身不发行目录或执行权限。 */
  function describeCurrent(): ReturnType<typeof describeHerdrContract> {
    assertCurrent()
    return describeHerdrContract({
      target: config.target,
      binding_revision: config.binding_revision,
      source: config.expected_source,
      document: schemaDocument,
      source_basis: 'configured_connector_contract'
    })
  }
  /** 目录时钟只约束五秒元数据视图；从不写入或续期任何 call、receipt、claim 或原生 lease。 */
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
  const catalog: HerdrProviderCatalogProvider = Object.freeze({
    kind: 'provider',
    /** 当前 principal 是既有认证宿主的输入，目录不创建身份，也不替代实际双端派发/读取授权。 */
    resolve(target: V2Target, principal: Principal) {
      assertCurrent()
      validateTarget(target)
      id(principal.id)
      if (boundedJson(target) !== boundedJson(config.target)) {
        return undefined
      }
      const descriptor = describeCurrent()
      const principalId = principal.id
      /** 同一策略在两侧仅作 caller 单侧投影；这不是对 Gateway 本地策略已授权的声明。 */
      function callerActions(method: string): ('dispatch' | 'read')[] {
        return (['dispatch', 'read'] as const).filter(
          /** 复用完整 Target/方法/动作匹配，不拼接跨 provider 或会话的 grant。 */ (action) =>
            providerScopeAllowed({ target: config.target }, method, action, {
              caller: principal.policy,
              local: principal.policy
            })
        )
      }
      const visible = descriptor.methods.flatMap(
        /** 目录可见性允许 dispatch 或 read 任一动作；cancel/stream_input 不足以探测方法。 */ (method) => {
          const actions = callerActions(method.method)
          if (!actions.length) {
            return []
          }
          const summary: JsonObject = { ...method, caller_actions: actions }
          delete summary.params_schema
          return [summary]
        }
      )
      if (!visible.length) {
        return undefined
      }
      const visibleMethods = new Set(
        visible.map(/** 固定原视图方法，不受返回摘要对象的修改影响。 */ (entry) => entry.method)
      )
      const expires = catalogNow() + 5000
      return Object.freeze({
        target: structuredClone(config.target),
        local_provider: { ...binding },
        contract_ref: reference,
        contract: structuredClone(record.wire),
        capability_revision: config.expected_source.classification_revision ?? config.expected_source.schema_sha256,
        expires_at: expires,
        methods: Object.freeze(visible),
        /** 未知、失去 caller 可见性或已过期的视图不能泄露方法参数；需要新的 resolve。 */
        describe(method: string): JsonObject {
          if (catalogNow() >= expires) {
            fail('catalog_view_expired')
          }
          text(method, 256)
          if (principal.id !== principalId) {
            fail('unauthenticated')
          }
          const actions = callerActions(method)
          if (!actions.length || !visibleMethods.has(method)) {
            fail('runtime_method_unavailable')
          }
          const selected = describeCurrent().methods.find(
            /** 只取当前固定来源中的精确方法描述。 */ (entry) => entry.method === method
          )
          if (!selected) {
            fail('runtime_method_unavailable')
          }
          return { ...selected, caller_actions: actions }
        }
      })
    }
  })
  return Object.freeze({
    kind: 'provider',
    catalog,
    describe: describeCurrent,
    providers: Object.freeze([
      {
        binding,
        target: config.target,
        peer_policy_revision: config.peer_policy_revision,
        max_response_bytes: 65_536,
        contract_ref: reference,
        preflightRequest: /** 使用同一已编译完整根预检真实登记请求；不生成原生 permit 或发送字节。 */ (
          request: JsonObject
        ) => {
          assertCurrent()
          try {
            codec.encode(request)
          } catch (error) {
            // 预检拒绝发生在登记前，是确定未派发的客户端参数错误；与 Luvus 预检同一投影，
            // 不把原生 schema 细节进 MCP 诊断（不含参数、路径或字段指针）。
            if (error instanceof WireError && error.code === 'herdr_native_request_invalid') {
              throw new NativeRequestPreflightError()
            }
            throw error
          }
          assertCurrent()
        },
        ready: /** 仅本地契约先决条件；认证 peer 的 readiness 仍由原 transport 计算。 */ () => {
          assertCurrent()
          return true
        }
      }
    ]),
    /** 原中性 Gateway 在认证提交后交付真实通道，资源只组装对应 epoch 的普通 Wire。 */
    session(connection, channel, services) {
      assertCurrent()
      if (connection.machine_id !== config.target.machine_id) {
        fail('connection_binding_mismatch')
      }
      const source = createHerdrGatewaySourceOwner({
        channel,
        connection,
        target: config.target,
        binding_revision: config.binding_revision,
        contract_ref: reference,
        assertCurrent: /** 当前受保护本地配置必须与这一个完整 provider 同值。 */ () => {
          assertCurrent()
          if (boundedJson(services.localProvider(config.target)) !== boundedJson(binding)) {
            fail('provider_binding_mismatch')
          }
          assertCurrent()
        }
      })
      let adapter: ReturnType<typeof createHerdrWireAdapter> | undefined
      let session: Session | undefined
      try {
        const backend = persistentHerdrBackend(services.store, {
          currentPrincipal: services.currentPrincipal,
          localProvider: services.localProvider,
          contract: /** 返回 pin 来源和完整 Worker 根；不是远端安装测量记录。 */ (ref) => {
            source.assertCurrent()
            return ref === reference ? record : undefined
          },
          nativeSource: source.source,
          context: /** 每个操作重查原认证 socket、原调用者和当前双端政策。 */ (principal, direction) => {
            source.assertCurrent()
            return {
              phase: 'authenticated',
              direction,
              connection: channel.connection(),
              policies: principal ? services.policies(principal) : undefined,
              resolveContract: /** 固定契约必须仍可从本资源读取。 */ (ref) =>
                ref === reference ? record.wire : undefined
            }
          }
        })
        adapter = createHerdrWireAdapter(backend)
        const current = adapter
        session = {
          adapter: current,
          readiness: /** 此处只报告配置/契约先决条件，不虚构远端进程或模型状态。 */ () => {
            source.assertCurrent()
            const local = services.localProvider(config.target)
            return {
              policy_revision: services.localPolicies(config.target).revision,
              peer_policy_revision: config.peer_policy_revision,
              providers: [{ expected: binding, local: local ?? { ...binding, enabled: false }, native_ready: true }]
            }
          },
          close: /** 会话关闭即时撤销来源品牌和全部私有 Wire permit。 */ () => {
            source.close()
            current.close()
            if (session) {
              sessions.delete(session)
            }
          }
        }
        source.assertCurrent()
        sessions.add(session)
        return session
      } catch (error) {
        source.close()
        adapter?.close()
        throw error
      }
    },
    release: /** 资源只释放自己的契约/Wire；不关闭外部唯一 Store 或远端 Herdr。 */ async () => {
      closed = true
      let failed = false
      for (const session of sessions) {
        try {
          session.close()
        } catch {
          failed = true
        }
      }
      sessions.clear()
      if (failed) {
        throw new GatewayError('herdr_gateway_release_failed')
      }
    }
  })
}

/** installation 与进程释放所有者由既有 launch/open 路径交付；工厂绝不暗中启动或连接其它 session。 */
export async function createHerdrConnectorResources(
  input: Readonly<{
    config: unknown
    installation: HerdrInstallation
    now(): number
    policies(principal: string): ProviderPolicies
    releaseOwner(): Promise<void>
    release_timeout_ms?: number
    /** 与最终写入共用的本机开关读取器；省略时使用原安装配置。 */
    terminalExecution?(): boolean
  }>
): Promise<HerdrConnectorResources> {
  const config = parseHerdrProviderRefConfig(input.config)
  const connector = config.connector
  if (
    !connector ||
    !(input.installation instanceof HerdrInstallation) ||
    typeof input.now !== 'function' ||
    typeof input.policies !== 'function' ||
    typeof input.releaseOwner !== 'function'
  ) {
    fail('herdr_connector_owner_required')
  }
  const releaseTimeout = input.release_timeout_ms ?? 5000
  uint(releaseTimeout, true)
  if (releaseTimeout > 5000) {
    fail('herdr_provider_config_invalid')
  }
  const installed = input.installation
  installed.assert(undefined, true)
  if (
    boundedJson(installed.config) !== boundedJson(connector.local) ||
    boundedJson(installed.record().wire.source) !== boundedJson(config.expected_source)
  ) {
    fail('provider_binding_mismatch')
  }
  const document = protectedFile(config.schema_path, 16_777_216)
  if (hash(document.bytes) !== config.expected_source.schema_sha256) {
    fail('herdr_schema_unreviewed')
  }
  const reference = contractRef(config.expected_source)
  const binding = provider(config)
  const routes = [{ target: config.target, principal_id: connector.principal_id }]
  const sessions = new Set<ConnectorWireSession>()
  let claims: LuvusDispatchClaims | undefined
  let closed = false
  let releasing: Promise<void> | undefined
  /** policies 每次来自受保护宿主当前值，配置中的 principal 只是路由归属，不发行身份。 */
  function policies(principal: string): ProviderPolicies {
    if (closed || principal !== connector!.principal_id) {
      fail('admission_principal_mismatch')
    }
    const value = JSON.parse(boundedJson(input.policies(principal))) as ProviderPolicies
    validatePolicies(value)
    if (closed) {
      fail('herdr_provider_closed')
    }
    return value
  }
  /** 先停止全部 epoch，再释放两个已有 writer 和原所有者；失败仍逐项清理且只执行一次。 */
  function release(): Promise<void> {
    if (!releasing) {
      closed = true
      let completed!: () => void
      let rejected!: (reason: unknown) => void
      releasing = new Promise<void>(
        /** 先发布共享结果，再调用任何可同步重入的资源或 owner。 */ (resolve, reject) => {
          completed = resolve
          rejected = reject
        }
      )
      void (
        /** 原所有者释放只执行一次，不把逻辑关闭解释为物理进程已退出。 */ (async () => {
          let failed = false
          for (const action of [
            ...[...sessions].map(
              /** 不等待单个 epoch，先同步阻止所有新执行。 */ (session) =>
                /** 执行原会话幂等关闭，不创建新的清理目标。 */
                () =>
                  session.close()
            ),
            /** 保留原发送墓碑，只关闭 writer。 */ () => claims?.close(),
            /** 安装关闭撤销来源；停止本机进程由原 owner 单独负责。 */ () => installed.close()
          ]) {
            try {
              action()
            } catch {
              failed = true
            }
          }
          sessions.clear()
          try {
            await input.releaseOwner()
          } catch {
            failed = true
          }
          if (failed) {
            throw new GatewayError('herdr_connector_release_failed')
          }
        })().then(completed, rejected)
      )
      void releasing.catch(/** 原角色会观察释放结果，内部也消费无人 await 的晚到拒绝。 */ () => {})
    }
    return releasing
  }
  try {
    const book = new ConnectorAttemptBook({ maximum_deadline_ms: CONNECTOR_MAX_DEADLINE_MS, now: input.now })
    claims = new LuvusDispatchClaims({ ...connector.claims, now: input.now })
    const sendClaims = claims
    return Object.freeze({
      kind: 'provider',
      release,
      release_timeout_ms: releaseTimeout,
      providers: Object.freeze([Object.freeze({ binding, target: config.target })]),
      /** 每个实际认证 epoch 独立准入正文，长期 book/claim 仍由同一资源所有者持有。 */
      session(connection) {
        if (closed) {
          fail('herdr_provider_closed')
        }
        installed.assert()
        document.assertCurrent()
        const admission = createConnectorAdmissionBackend({
          connection,
          routes,
          book,
          source: { policies, now: input.now }
        })
        const listeners = new Set<(event: LedgerInvalidation) => void>()
        let runtime: ReturnType<typeof createHerdrRuntime> | undefined
        let session: ConnectorWireSession | undefined
        try {
          const services = createHerdrHostServices(installed, {
            currentPrincipal: admission.currentPrincipal,
            localProvider: /** Connector 固定受保护配置，不读取 Gateway Store 或 caller 参数中的 binding。 */ (
              target
            ) => (boundedJson(target) === boundedJson(config.target) ? binding : undefined),
            context: /** 每次使用准入后端当前 epoch 和宿主当前政策，关闭后不复用旧连接。 */ (principal, direction) => ({
              phase: 'authenticated',
              direction,
              connection: admission.connection(),
              policies: policies(principal || connector.principal_id),
              resolveProvider: /** 只解析这一个完整固定目标。 */ (target) =>
                boundedJson(target) === boundedJson(config.target) ? binding : undefined,
              resolveContract: /** 原生契约只能来自实际 installation。 */ (ref) =>
                ref === reference ? installed.record().wire : undefined
            })
          })
          const backend: HerdrReadonlyBackend = {
            ...services,
            ...admission,
            /** Connector 没有 Gateway 锚点：以已解码的本机 attempt 合成，内容与句柄期限都取请求 deadline（准入提交前也稳定）。 */
            responseAnchor(binding) {
              const stored = admission.attempt(binding.call_id, binding.attempt_id)
              if (!stored) {
                return undefined
              }
              assertBinding(binding, stored.binding)
              return {
                binding: structuredClone(stored.binding),
                method: stored.method,
                mode: stored.mode,
                state: 'connector_accepted',
                content_status: input.now() < binding.registration.deadline ? 'available' : 'expired',
                content_expires_at: binding.registration.deadline,
                dedup_expires_at: binding.registration.deadline
              }
            },
            subscribeInvalidation(listener) {
              listeners.add(listener)
              return () => {
                listeners.delete(listener)
              }
            }
          }
          runtime = createHerdrRuntime(installed, backend, sendClaims, input.terminalExecution)
          const current = runtime
          session = {
            adapter: connectorAdmissionAdapter(admission, current.adapter),
            nativeVersions: () => {
              installed.assert()
              return [
                { provider_id: binding.provider_id, native_version: installed.record().wire.source.binary_version }
              ]
            },
            executeWire: current.executeWire,
            terminalExecutionState: /** 目录使用同一个本机配置源；最终写入仍由原runtime再检查。 */ () => [
              {
                binding,
                enabled: input.terminalExecution
                  ? input.terminalExecution()
                  : installed.config.allow_terminal_execution === true
              }
            ],
            readiness: /** 只有真实本机安装与当前双端配置均有效才报告该 provider 可用。 */ () => {
              if (closed) {
                fail('herdr_provider_closed')
              }
              installed.assert()
              document.assertCurrent()
              return {
                policy_revision: policies(connector.principal_id).local.revision,
                peer_policy_revision: config.peer_policy_revision,
                providers: [{ expected: binding, local: binding, native_ready: true }]
              }
            },
            close: /** 关闭本 epoch 观察与正文，长期 book/claim 墓碑保持原期限。 */ () => {
              try {
                current.close()
              } finally {
                admission.close()
                for (const listener of listeners) {
                  listener({ kind: 'closed' })
                }
                if (session) {
                  sessions.delete(session)
                }
              }
            }
          }
          if (closed) {
            fail('herdr_provider_closed')
          }
          sessions.add(session)
          return session
        } catch (error) {
          try {
            runtime?.close()
          } finally {
            admission.close()
          }
          throw error
        }
      }
    })
  } catch (error) {
    await release()
    throw error
  }
}
