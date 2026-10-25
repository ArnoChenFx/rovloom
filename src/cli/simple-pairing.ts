// 单码直连配对面：设备 listener 的 POST /pairing/context 查询谱系，POST /pairing 完成配对。
// 一机一码兑换 → 签发设备凭据 → 自动批准原生清单（编译核验、发布 schema/provider/调用方）→ 同一响应返回凭据与 MCP Bearer。
// 子部署取舍：没有人工批准、核对码或两阶段交付；失败用新码重试，崩溃窗口的幂等由本进程内存缓存兜底。
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ManagementRequest } from '../storage/model.js'
import type { openGatewayState } from '../runtime/state.js'
import { parseNativeJson } from '../native-contract/json.js'
import { boundedJson, fields, id, object } from '../wire/index.js'
import { GatewayError } from '../contracts.js'
import type { GatewayConfig } from './config.js'
import { canonicalLoopbackHost } from '../mcp/listen.js'
import { PairingCodes } from './pairing-codes.js'
import { publishSetupSchemas, reviewSetupManifest } from './setup-manifest.js'
import { mergeSetupCallers, mergeSetupProviders, publish, publishFirstCallers } from './setup-publish.js'
import { SIMPLE_SETUP_ACTOR } from './setup-policy.js'
import { gatewayPairingContext, type PairingContext } from './pairing-context.js'
import { readSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'
import { readRuntimeConfig } from './runtime-config.js'

type State = ReturnType<typeof openGatewayState>

// 只交付固定公共码与无秘密元数据；配对secret响应同样强制no-store。
export function setupReply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

// 按实际流累计有界字节，不因缺Content-Length或分块传输而无限读取。
export async function requestJson(
  request: Request,
  maximum: number,
  stopped: AbortSignal
): Promise<Record<string, unknown>> {
  const signal = AbortSignal.any([request.signal, stopped, AbortSignal.timeout(300_000)])
  const reader = request.body?.getReader()
  if (!reader) {
    throw new Error('setup_request_invalid')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      let abort!: () => void
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('setup_request_closed'))
        signal.addEventListener('abort', abort, { once: true })
      })
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        if (signal.aborted) {
          throw new Error('setup_request_closed')
        }
        result = await Promise.race([reader.read(), cancelled])
      } finally {
        signal.removeEventListener('abort', abort)
      }
      if (result.done) {
        break
      }
      bytes += result.value.length
      if (bytes > maximum || signal.aborted) {
        throw new Error('setup_request_invalid')
      }
      chunks.push(result.value)
    }
    const parsed = parseNativeJson(Buffer.concat(chunks, bytes), { object_bytes: maximum })
    if (!parsed.ok) {
      throw new Error('setup_request_invalid')
    }
    return object(parsed.value)
  } finally {
    void reader.cancel().catch(/* 只回收请求流，不透传网络错误。 */ () => {})
    reader.releaseLock()
  }
}

export type PairingApplication = Readonly<{
  machine_id: string
  recovery_generation: string
  credential: string
  mcp?: Readonly<{ url: string; token: string }>
}>

// 缓存属于 CLI 运行时而非某一轮 listener；重载可重放，真正重启仍需新码。
// 只保留短期、有界的凭据交付结果，按状态目录、恢复代次和码摘要隔离。
export class PairingReplayCache {
  readonly #entries = new Map<string, { application: PairingApplication; expires: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  private key(directory: string, generation: string, code: string): string {
    return boundedJson([directory, generation, createHash('sha256').update(code).digest('hex')])
  }

  private prune(): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expires <= this.now()) {
        this.#entries.delete(key)
      }
    }
  }

  get(directory: string, generation: string, code: string): PairingApplication | undefined {
    this.prune()
    return this.#entries.get(this.key(directory, generation, code))?.application
  }

  set(directory: string, generation: string, code: string, application: PairingApplication): void {
    this.prune()
    const key = this.key(directory, generation, code)
    this.#entries.delete(key)
    while (this.#entries.size >= 128) {
      this.#entries.delete(this.#entries.keys().next().value!)
    }
    this.#entries.set(key, { application, expires: this.now() + 600_000 })
  }
}

/** Gateway 侧单端点配对：账本兑换 + 自动批准 + 凭据交付；与 PairingCodes 共享同一 Store。 */
export class SimplePairingHttp {
  readonly #codes: PairingCodes
  readonly #requests = new Set<Promise<Response>>()
  readonly #applying = new Set<string>()
  // defineProvider 的一次性许可：发布前登记，Store 事务内消费，杜绝第二来源复用。
  readonly #permits = new Map<string, { confirmation: string; expires: number; generation: string }>()
  readonly #stop = new AbortController()
  #closed = false

  constructor(
    readonly state: State,
    readonly config: GatewayConfig,
    // 原生配置发布完成后唤醒宿主重开（新 provider 与 caller 来源下次启动加载）。
    private readonly reload: () => void = () => {},
    private readonly replays = new PairingReplayCache()
  ) {
    this.#codes = new PairingCodes(state.store, config.state_dir)
  }

  /** 面板与 --issue-code 共用的码账本。 */
  get codes(): PairingCodes {
    return this.#codes
  }

  /** Store 受保护写端口的授权回调：只放行本类登记过的 provider 首次定义。 */
  authorizeManagement(request: ManagementRequest): { actor: string; confirmation_id: string } {
    if (request.action !== 'providers_manage' || request.fence !== 'new' || this.#closed) {
      throw new GatewayError('management_authorization_required')
    }
    const permit = this.#permits.get(request.target)
    if (!permit || Date.now() >= permit.expires || permit.generation !== this.state.store.generation()) {
      throw new GatewayError('management_authorization_required')
    }
    this.#permits.delete(request.target)
    return { actor: SIMPLE_SETUP_ACTOR, confirmation_id: permit.confirmation }
  }

  // 明确拒绝浏览器Origin、URL凭据和非JSON请求。
  handle(request: Request): Promise<Response> | undefined {
    const url = new URL(request.url)
    if (url.pathname !== '/pairing' && url.pathname !== '/pairing/context') {
      return undefined
    }
    if (
      this.#closed ||
      request.method !== 'POST' ||
      request.headers.has('origin') ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    ) {
      return Promise.resolve(setupReply({ error: 'setup_request_refused' }, 403))
    }
    if (this.#requests.size >= 16) {
      return Promise.resolve(setupReply({ error: 'setup_busy' }, 503))
    }
    const task = this.respond(request, url.pathname === '/pairing/context')
    this.#requests.add(task)
    void task.then(
      /* 同一请求实际收尾后才释放额度。 */ () => this.#requests.delete(task),
      /* 异常收尾也只回收自己的额度。 */ () => this.#requests.delete(task)
    )
    return task
  }

  // 失败只回固定错误码；崩溃窗口的重试用同一码命中内存缓存，Gateway 重启后需生成新码。
  private async respond(request: Request, contextOnly: boolean): Promise<Response> {
    let reserved: string | undefined
    try {
      const input = await requestJson(request, 1_048_576, this.#stop.signal)
      fields(input, contextOnly ? ['code'] : ['code', 'installation'])
      const parts = String(input.code).split('.')
      if (parts.length !== 3) {
        throw new Error('pairing_code_invalid')
      }
      const [machine, attempt, secret] = parts
      id(machine)
      id(attempt)
      if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
        throw new Error('pairing_code_invalid')
      }
      const full = String(input.code)
      const generation = this.state.store.generation()
      const cached = this.replays.get(this.config.state_dir, generation, full)
      if (cached) {
        if (
          this.state.store.credentialDigest(machine) !== createHash('sha256').update(cached.credential).digest('hex')
        ) {
          throw new Error('pairing_code_invalid')
        }
        return contextOnly
          ? setupReply({ state: 'pairing_context', ...gatewayPairingContext(this.config) })
          : setupReply({ state: 'paired', ...cached, replayed: true })
      }
      this.#codes.verify(machine, attempt, secret)
      const context = gatewayPairingContext(this.config)
      if (contextOnly) {
        return setupReply({ state: 'pairing_context', ...context })
      }
      if (this.#applying.has(attempt)) {
        return setupReply({ error: 'setup_busy' }, 503)
      }
      this.#applying.add(attempt)
      reserved = attempt
      const applied = await this.apply(machine, attempt, input.installation, request, context)
      this.replays.set(this.config.state_dir, generation, full, applied)
      this.#codes.settle(attempt, true)
      // 下一事件轮才关闭旧listener，先让原响应调用完成其finally。
      setImmediate(() => this.reload())
      return setupReply({ state: 'paired', ...applied })
    } catch (error) {
      if (reserved) {
        this.#codes.settle(reserved, false)
      }
      const code = error instanceof GatewayError ? error.code : 'pairing_failed'
      return setupReply({ error: code }, 409)
    } finally {
      if (reserved) {
        this.#applying.delete(reserved)
      }
    }
  }

  // 兑换 + 自动批准 + 发布；除账本与 Store 事务外没有人工环节。
  private async apply(
    machine: string,
    attempt: string,
    installation: unknown,
    request: Request,
    context: PairingContext
  ): Promise<PairingApplication> {
    const signal = AbortSignal.any([request.signal, this.#stop.signal])
    const reviewed = await reviewSetupManifest(
      installation,
      { attempt_id: attempt, ...context },
      machine,
      this.config.state_dir,
      signal
    )
    // 兑换即签发设备凭据：机器必须仍为 pending，秘密只进入本次响应。
    const enrollment = this.state.store.issueEnrollment(machine, 600_000)
    const redeemed = this.state.store.redeem(enrollment)
    if (redeemed.machine_id !== machine) {
      throw new GatewayError('pairing_target_mismatch')
    }
    await publishSetupSchemas(reviewed.reviewed, signal)
    const authorization = reviewed.authorization
    const providersPath = runtimeReference(this.config.state_dir, 'providers')
    const additional = readSetupJson(providersPath, 1_048_576) !== undefined
    // 已有不同registry或caller不能被首次引导扩大权限或覆盖；每个来源都必须属于同一批准清单。
    const providers = readRuntimeConfig(this.config).providers
    if (
      providers.some(
        /* 恢复时只允许原attempt完全相同的条目；加入新设备时其它设备的条目不属于本次，但同引用必须一致。 */ (entry) => {
          const expected = reviewed.reviewed.find(/* 同一原条目。 */ (value) => value.reference === entry.reference)
          return expected ? boundedJson(entry.value, 1_048_576) !== boundedJson(expected.value, 1_048_576) : !additional
        }
      )
    ) {
      throw new GatewayError('pairing_conflict')
    }
    // 本机客户端凭据记录的资源地址用规范回环地址，不写通配绑定地址。
    const hostname = canonicalLoopbackHost(this.config.mcp_hostname)
    const resource = new URL('http://' + hostname + ':' + this.config.mcp_port + '/mcp').href
    const clientPath = runtimeReference(this.config.state_dir, 'mcp-client')
    const original = readSetupJson(clientPath)
    if (additional && original === undefined) {
      // 第 2 台及以后设备复用首台设备建立的 MCP 凭据；没有它说明发布状态不完整。
      throw new GatewayError('pairing_conflict')
    }
    let minted: { url: string; token: string } | undefined
    const client =
      original === undefined
        ? (() => {
            const token = randomBytes(32).toString('base64url')
            minted = { url: this.config.mcp_public_url ?? resource, token }
            return {
              schema_version: 1,
              kind: 'mcp-client-credential',
              attempt_id: attempt,
              resource,
              principal_id: authorization.principal_id,
              token,
              issued_at: Date.now(),
              expires_at: Date.now() + 365 * 86400_000
            }
          })()
        : object(original)
    fields(client, [
      'schema_version',
      'kind',
      'attempt_id',
      'resource',
      'principal_id',
      'token',
      'issued_at',
      'expires_at'
    ])
    if (
      client.schema_version !== 1 ||
      client.kind !== 'mcp-client-credential' ||
      client.resource !== resource ||
      client.principal_id !== authorization.principal_id ||
      typeof client.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(client.token) ||
      !Number.isSafeInteger(client.issued_at) ||
      !Number.isSafeInteger(client.expires_at) ||
      Number(client.expires_at) <= Date.now()
    ) {
      throw new GatewayError('pairing_conflict')
    }
    publish(clientPath, client)
    const callersPath = runtimeReference(this.config.state_dir, 'mcp-callers')
    const reviewedEntries = reviewed.reviewed.map(
      /* 只保存已核验清单的程序配置；Gateway文件路径始终由本机程序选择。 */ (entry) => ({
        reference: entry.reference,
        value: entry.value
      })
    )
    if (!additional) {
      publishFirstCallers(callersPath, resource, authorization, {
        principal: { id: authorization.principal_id, policy: authorization.policies.caller },
        token_sha256: createHash('sha256')
          .update(client.token as string)
          .digest('hex'),
        issued_at: client.issued_at as number,
        expires_at: client.expires_at as number
      })
      publish(providersPath, { schema_version: 1, role: 'gateway', providers: reviewedEntries }, 1_048_576)
    } else {
      mergeSetupCallers(callersPath, resource, authorization)
      mergeSetupProviders(providersPath, reviewedEntries)
    }
    for (const entry of reviewed.reviewed) {
      const target = entry.target.machine_id + '/' + entry.target.provider_id
      this.#permits.set(target, {
        confirmation: randomUUID(),
        expires: Date.now() + 60_000,
        generation: this.state.store.generation()
      })
      try {
        const binding = this.state.store.provider(entry.target.machine_id, entry.target.provider_id)
        if (!binding) {
          this.state.store.defineProvider(entry.binding)
        } else if (boundedJson(binding) !== boundedJson(entry.binding)) {
          throw new GatewayError('pairing_conflict')
        }
      } finally {
        this.#permits.delete(target)
      }
    }
    return {
      machine_id: machine,
      recovery_generation: this.state.store.generation(),
      credential: redeemed.credential,
      ...(minted ? { mcp: minted } : {})
    }
  }

  // 关闭时拒绝新配对并等待在途请求收尾，交回宿主释放 Store。
  async close(): Promise<void> {
    this.#closed = true
    this.#stop.abort()
    await Promise.allSettled(this.#requests)
  }
}
