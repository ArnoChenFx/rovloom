/**
 * herdr-core 的本机附着来源：只连接已运行的 core，按内核 peer 核对 pid/uid、`/proc/<pid>/exe` 摘要、
 * `argv` 与 `HC_SESSION`，再用本次实例的 `rpc.discover` 核对审核契约。不启动、停止或接管 core。
 *
 * core 退出或被 holder 重建后连接会关闭。这里保留同一个附着对象，用有退避、有上限的单飞轮
 * 重新走一遍**完整**身份核对（内核 peer、exe 摘要、argv、HC_SESSION、目录权限、契约摘要、版本），
 * 不热循环、不缓存旧许可；在途调用不重放，断线后的写类调用仍是 `outcome_unknown`。
 */
import { readSchema } from '../schema-store.js'
import type { NativePeer } from '../local/linux-peer.js'
import { ProviderAdapterError } from '../provider-error.js'
import { boundedJson, contractRef, hash } from '../../wire/index.js'
import type { AttemptBinding, ContractSource } from '../../wire/types.js'
import { openHerdrCoreClient } from './client.js'
import type { HerdrCoreClient } from './client.js'
import {
  herdrCorePeerFacts,
  herdrCorePinnedEndpoint,
  herdrCoreSessionLimit,
  inspectHerdrCoreSocket,
  type HerdrCoreEndpoint,
  type HerdrCoreProcessFacts
} from './identity.js'
import { HERDR_CORE_MAX_REQUEST_BYTES } from './methods.js'
import { compileHerdrCoreContract } from './schema.js'
import type { HerdrCoreContract } from './schema.js'
import type { HerdrCoreContractRecord } from './readonly.js'

/** 来源令牌只覆盖一次实际连接与本机事实；关闭后不能迁移到新进程或新端点。 */
const installationKey = Object.freeze({})

/** 重新附着的退避序列：合计约 5.25 秒，覆盖 holder 默认 3 秒宽限加新 core 启动。 */
export const HERDR_CORE_REATTACH_DELAYS_MS: readonly number[] = Object.freeze([0, 250, 500, 1000, 1500, 2000])
/** 一轮失败后的冷却：期间再调用直接失败，不逐请求重试。 */
export const HERDR_CORE_REATTACH_COOLDOWN_MS = 1000
/** 单轮重新附着的总预算上限；调用方还要按自己的剩余期限再收紧。 */
export const HERDR_CORE_REATTACH_WINDOW_MS = 6000
/** 单次连接、单次 `rpc.discover`/`server.status` 的上限，避免重启窗口里挂住调用。 */
export const HERDR_CORE_ATTACH_STEP_MS = 5000

export type HerdrCoreAttachmentStatus = Readonly<{
  state: 'attached' | 'detached' | 'closed'
  core_id: string | null
  attempts: number
  last_error: string | null
}>

/** 执行端只消费这组已验证事实；测试可以交付真实连接上的同形实现，生产只由 open 建立。 */
export type HerdrCoreAttachment = Readonly<{
  record(): HerdrCoreContractRecord
  client(): HerdrCoreClient
  /** 断线后重新附着；有退避与上限，失败只给固定码，不悬挂调用。 */
  ensure(budgetMs: number): Promise<void>
  /** 只标记当前连接不可用；下一次 ensure 会重新走完整核对。 */
  invalidate(): void
  assert(peer?: NativePeer): void
  source(binding: AttemptBinding): boolean
  endpoint(): HerdrCoreEndpoint
  status(): HerdrCoreAttachmentStatus
  close(): void
}>

/** 一次成功附着的不可变事实；重新附着时整体替换，旧连接不再被引用。 */
type HerdrCoreAttached = Readonly<{
  client: HerdrCoreClient
  facts: HerdrCoreProcessFacts
  record: HerdrCoreContractRecord
}>

/**
 * 单飞轮重新附着：同一时刻只有一轮，失败后冷却一段时间，不逐请求重试。
 * `budgetMs` 是调用方愿意等待的上限；轮内每一步都不超过剩余预算。
 */
export type HerdrCoreAttachmentSupervisor<T> = Readonly<{
  current(): T | undefined
  ensure(budgetMs: number): Promise<T>
  invalidate(): void
  stats(): Readonly<{ attempts: number; last_error: string | undefined }>
}>

export function createAttachmentSupervisor<T>(options: {
  attach(budgetMs: number): Promise<T>
  stale(value: T): boolean
  now(): number
  sleep?(ms: number): Promise<void>
  delays?: readonly number[]
  cooldownMs?: number
  seed?: T
}): HerdrCoreAttachmentSupervisor<T> {
  const delays = options.delays ?? HERDR_CORE_REATTACH_DELAYS_MS
  const cooldown = options.cooldownMs ?? HERDR_CORE_REATTACH_COOLDOWN_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let attached: T | undefined = options.seed
  let round: Promise<T> | undefined
  let nextRoundAt = 0
  let attempts = 0
  let lastError: string | undefined

  /** 只按固定码记录失败；底层文本、路径与请求正文都不进入状态。 */
  function failure(error: unknown): ProviderAdapterError {
    return error instanceof ProviderAdapterError ? error : new ProviderAdapterError('herdr_core_connection_closed')
  }

  /** 当前值只在仍新鲜时可用；已关闭的连接不能继续代表原生来源。 */
  function live(): T | undefined {
    return attached !== undefined && !options.stale(attached) ? attached : undefined
  }

  async function run(budgetMs: number): Promise<T> {
    const started = options.now()
    let error: ProviderAdapterError | undefined
    for (const delay of delays) {
      const remaining = budgetMs - (options.now() - started)
      if (remaining < 1) {
        break
      }
      if (delay > 0) {
        await sleep(Math.min(delay, remaining))
      }
      const left = budgetMs - (options.now() - started)
      if (left < 1) {
        break
      }
      attempts += 1
      try {
        const value = await options.attach(left)
        attached = value
        nextRoundAt = 0
        lastError = undefined
        return value
      } catch (cause) {
        error = failure(cause)
        lastError = error.code
      }
    }
    // 本轮失败：冷却期内不再重试，调用方拿到最后一个固定码。
    nextRoundAt = options.now() + cooldown
    throw error ?? new ProviderAdapterError('herdr_core_connection_closed')
  }

  return Object.freeze({
    current: live,
    ensure: (budgetMs: number) => {
      const value = live()
      if (value) {
        return Promise.resolve(value)
      }
      if (round) {
        return round
      }
      if (options.now() < nextRoundAt) {
        return Promise.reject(new ProviderAdapterError(lastError ?? 'herdr_core_connection_closed'))
      }
      const started = run(Math.max(1, Math.min(budgetMs, HERDR_CORE_REATTACH_WINDOW_MS)))
      const shared = started.finally(
        /** 轮结束即清空单飞标记；失败已由原 Promise 交给调用方。 */ () => {
          round = undefined
        }
      )
      round = shared
      return shared
    },
    invalidate: /** 只丢弃当前值；连接本身由调用方关闭，下一轮重新核对全部事实。 */ () => {
      attached = undefined
    },
    stats: () => Object.freeze({ attempts, last_error: lastError })
  })
}

/**
 * 连接并核对一次。`published` 为已发布的契约记录：重新附着必须得到同一份内容寻址文档，
 * 否则按契约不符拒绝；首次附着时由这里编译并建立记录。
 */
async function attachHerdrCore(options: {
  endpoint: HerdrCoreEndpoint
  expected: ContractSource
  published?: HerdrCoreContractRecord
  budgetMs: number
}): Promise<HerdrCoreAttached> {
  const { endpoint, expected } = options
  const budget = Math.max(1, Math.min(options.budgetMs, HERDR_CORE_ATTACH_STEP_MS))
  // 目录权限与套接字属主每次重连都重查；core 重建后目录可能被替换。
  inspectHerdrCoreSocket(endpoint.socket)
  const client = await openHerdrCoreClient(endpoint.socket, { timeout_ms: budget })
  try {
    // 契约先于结果校验：没有本次实例的审核文档，就无法证明任何结果形状。
    const discovered = boundedJson(await client.request('rpc.discover', {}, budget), HERDR_CORE_MAX_REQUEST_BYTES * 4)
    if (hash(discovered) !== expected.schema_sha256) {
      throw new ProviderAdapterError('herdr_core_schema_unreviewed')
    }
    const contract = compileHerdrCoreContract(discovered)
    if (options.published && contract.identity !== options.published.contract.identity) {
      throw new ProviderAdapterError('herdr_core_schema_unreviewed')
    }
    const status = contract.validateResult('server.status', await client.request('server.status', {}, budget))
    // pid 取自这条连接的内核 peer，自报值只用于互相印证；exe 摘要来自正在运行的映像。
    const facts = herdrCorePeerFacts(client.peer(), status.pid, endpoint.session)
    if (facts.binary_sha256 !== expected.binary_sha256 || client.hello.version !== expected.binary_version) {
      throw new ProviderAdapterError('herdr_core_installation_changed')
    }
    const source: ContractSource = Object.freeze({
      provider_kind: 'herdr-core',
      protocol_family: 'herdr-core-jsonrpc',
      binary_version: client.hello.version,
      binary_sha256: facts.binary_sha256,
      schema_sha256: hash(discovered),
      schema_origin: 'live_instance',
      schema_command: 'rpc.discover',
      server_version: typeof status.version === 'string' ? status.version : null,
      native_protocol_version: String(client.hello.generation),
      runtime_generation: null,
      adapter_revision: expected.adapter_revision,
      classification_revision: expected.classification_revision,
      support_basis: 'schema_and_version'
    })
    if (contractRef(source) !== contractRef(expected)) {
      throw new ProviderAdapterError('herdr_core_installation_changed')
    }
    const record: HerdrCoreContractRecord =
      options.published ??
      Object.freeze({
        wire: Object.freeze({ source, support_status: 'validated' as const }),
        contract
      })
    return Object.freeze({ client, facts, record })
  } catch (error) {
    client.close()
    throw error
  }
}

/** 连接、核对并编译完成前不建立可信来源；失败只留固定码。 */
export class HerdrCoreInstallation implements HerdrCoreAttachment {
  readonly #endpoint: HerdrCoreEndpoint
  readonly #record: HerdrCoreContractRecord
  readonly #supervisor: HerdrCoreAttachmentSupervisor<HerdrCoreAttached>
  #closed = false

  private constructor(
    endpoint: HerdrCoreEndpoint,
    record: HerdrCoreContractRecord,
    supervisor: HerdrCoreAttachmentSupervisor<HerdrCoreAttached>,
    key: object
  ) {
    if (key !== installationKey) {
      throw new ProviderAdapterError('herdr_core_installation_receipt_required')
    }
    this.#endpoint = endpoint
    this.#record = record
    this.#supervisor = supervisor
  }

  /** 只附着已存在的端点：不创建目录、不拉起进程，也不接受调用方自报的 schema 或 pid。 */
  static async open(input: {
    config: Readonly<{ session: string; endpoint: Readonly<{ runtime_dir?: string; state_home?: string }> }>
    expected: ContractSource
    now?: () => number
  }): Promise<HerdrCoreInstallation> {
    const endpoint = herdrCorePinnedEndpoint(input.config.endpoint, input.config.session)
    // 首次附着失败直接抛出，不建立任何可信来源。
    const first = await attachHerdrCore({
      endpoint,
      expected: input.expected,
      budgetMs: HERDR_CORE_REATTACH_WINDOW_MS
    })
    const supervisor = createAttachmentSupervisor<HerdrCoreAttached>({
      // 重新附着复用同一份已发布契约：文档摘要与编译身份都必须与首次一致。
      attach: (budget) =>
        attachHerdrCore({ endpoint, expected: input.expected, published: first.record, budgetMs: budget }),
      stale: /** 连接已关闭就是需要重新附着的唯一信号；进程事实每次写入前另核对。 */ (value) => value.client.closed(),
      now: Date.now,
      seed: first
    })
    return new HerdrCoreInstallation(endpoint, first.record, supervisor, installationKey)
  }

  /** 每次写入前重读内核 peer 与 `/proc/<pid>` 事实；不缓存自报值，也不跟随端点变化。 */
  assert(peer?: NativePeer): void {
    if (this.#closed) {
      throw new ProviderAdapterError('herdr_core_installation_closed')
    }
    const attached = this.#supervisor.current()
    if (!attached) {
      throw new ProviderAdapterError('herdr_core_connection_closed')
    }
    inspectHerdrCoreSocket(this.#endpoint.socket)
    const current = peer ?? attached.client.peer()
    if (current.uid !== process.getuid?.()) {
      throw new ProviderAdapterError('herdr_core_peer_uid_mismatch')
    }
    if (current.pid !== attached.facts.pid) {
      throw new ProviderAdapterError('herdr_core_peer_pid_mismatch')
    }
    const again = herdrCorePeerFacts(current, attached.facts.pid, this.#endpoint.session)
    if (
      again.exe !== attached.facts.exe ||
      again.binary_sha256 !== attached.facts.binary_sha256 ||
      again.argv.length !== attached.facts.argv.length ||
      again.argv.some(
        /** 固定 argv 逐项一致，不允许重新解释。 */ (value, index) => value !== attached.facts.argv[index]
      ) ||
      again.session !== attached.facts.session
    ) {
      throw new ProviderAdapterError('herdr_core_installation_changed')
    }
  }

  /** 只返回当前实际连接；断线后必须先 ensure，不返回已关闭的连接。 */
  client(): HerdrCoreClient {
    if (this.#closed) {
      throw new ProviderAdapterError('herdr_core_installation_closed')
    }
    const attached = this.#supervisor.current()
    if (!attached) {
      throw new ProviderAdapterError('herdr_core_connection_closed')
    }
    return attached.client
  }

  endpoint(): HerdrCoreEndpoint {
    return this.#endpoint
  }

  /** 契约是内容寻址的、与进程无关：断线期间仍可读，进程事实由 assert() 每次重读。 */
  record(): HerdrCoreContractRecord {
    if (this.#closed) {
      throw new ProviderAdapterError('herdr_core_installation_closed')
    }
    return this.#record
  }

  contract(): HerdrCoreContract {
    return this.record().contract
  }

  /** 固定目标、修订和契约摘要必须同时匹配，才承认这是同一来源。 */
  source(binding: AttemptBinding): boolean {
    if (this.#closed) {
      throw new ProviderAdapterError('herdr_core_installation_closed')
    }
    return (
      binding.provider_kind === 'herdr-core' &&
      binding.target.profile === 'session' &&
      binding.target.session === this.#endpoint.session &&
      binding.contract_ref === contractRef(this.#record.wire.source)
    )
  }

  status(): HerdrCoreAttachmentStatus {
    const stats = this.#supervisor.stats()
    const attached = this.#closed ? undefined : this.#supervisor.current()
    return Object.freeze({
      state: this.#closed ? 'closed' : attached ? 'attached' : 'detached',
      core_id: attached ? attached.client.hello.core.id : null,
      attempts: stats.attempts,
      last_error: stats.last_error ?? null
    })
  }

  /** 断线后重新走完整身份核对；失败只给固定码，调用方按未派发处理。 */
  async ensure(budgetMs: number): Promise<void> {
    if (this.#closed) {
      throw new ProviderAdapterError('herdr_core_installation_closed')
    }
    await this.#supervisor.ensure(budgetMs)
  }

  /** 只丢弃当前连接值；已关闭的连接由下一次附着替换。 */
  invalidate(): void {
    this.#supervisor.invalidate()
  }

  /** 关闭本机来源能力，不停止外部 core，也不删除用户数据。 */
  close(): void {
    this.#closed = true
    const attached = this.#supervisor.current()
    this.#supervisor.invalidate()
    try {
      attached?.client.close()
    } catch {
      /* 关闭只释放本机连接，失败不改变已关闭的事实。 */
    }
  }
}

/** 端点长度在配置阶段就按 core 的公式检查，不留给 core 报 usage。 */
export function assertHerdrCoreSessionFits(
  session: string,
  pin: Readonly<{ runtime_dir?: string; state_home?: string }>
): void {
  const endpoint = herdrCorePinnedEndpoint(pin, session)
  const limit = herdrCoreSessionLimit(
    pin.runtime_dir !== undefined ? { XDG_RUNTIME_DIR: pin.runtime_dir } : { XDG_STATE_HOME: pin.state_home }
  )
  if (session.length > limit.limit) {
    throw new ProviderAdapterError('herdr_core_session_too_long')
  }
  if (endpoint.session !== session) {
    throw new ProviderAdapterError('herdr_core_endpoint_unavailable')
  }
}

/** 确认 Gateway 发布的 schema 字节与本次连接编译出的契约一致；不用于执行许可。 */
export function assertPublishedSchema(path: string, source: ContractSource): void {
  readSchema(path, source.schema_sha256, 'herdr_core_schema_unreviewed', 'herdr_core_provider_file_invalid')
}
