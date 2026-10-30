/**
 * herdr-core 的本机附着来源：只连接已运行的 core，按内核 peer 核对 pid/uid、`/proc/<pid>/exe` 摘要、
 * `argv` 与 `HC_SESSION`，再用本次实例的 `rpc.discover` 核对审核契约。不启动、停止或接管 core。
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

/** 连接、核对并编译完成前不建立可信来源；失败只留固定码。 */
export class HerdrCoreInstallation {
  readonly #client: HerdrCoreClient
  readonly #endpoint: HerdrCoreEndpoint
  readonly #facts: HerdrCoreProcessFacts
  readonly #record: HerdrCoreContractRecord
  #closed = false

  private constructor(
    client: HerdrCoreClient,
    endpoint: HerdrCoreEndpoint,
    facts: HerdrCoreProcessFacts,
    record: HerdrCoreContractRecord,
    key: object
  ) {
    if (key !== installationKey) {
      throw new ProviderAdapterError('herdr_core_installation_receipt_required')
    }
    this.#client = client
    this.#endpoint = endpoint
    this.#facts = facts
    this.#record = record
  }

  /** 只附着已存在的端点：不创建目录、不拉起进程，也不接受调用方自报的 schema 或 pid。 */
  static async open(input: {
    config: Readonly<{ session: string; endpoint: Readonly<{ runtime_dir?: string; state_home?: string }> }>
    expected: ContractSource
    now?: () => number
  }): Promise<HerdrCoreInstallation> {
    const endpoint = herdrCorePinnedEndpoint(input.config.endpoint, input.config.session)
    inspectHerdrCoreSocket(endpoint.socket)
    const client = await openHerdrCoreClient(endpoint.socket)
    try {
      // 契约先于结果校验：没有本次实例的审核文档，就无法证明任何结果形状。
      const discovered = boundedJson(await client.request('rpc.discover', {}, 10_000), HERDR_CORE_MAX_REQUEST_BYTES * 4)
      if (hash(discovered) !== input.expected.schema_sha256) {
        throw new ProviderAdapterError('herdr_core_schema_unreviewed')
      }
      const contract = compileHerdrCoreContract(discovered)
      const status = contract.validateResult('server.status', await client.request('server.status', {}, 10_000))
      // pid 取自这条连接的内核 peer，自报值只用于互相印证；exe 摘要来自正在运行的映像。
      const facts = herdrCorePeerFacts(client.peer(), status.pid, endpoint.session)
      if (
        facts.binary_sha256 !== input.expected.binary_sha256 ||
        client.hello.version !== input.expected.binary_version
      ) {
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
        adapter_revision: input.expected.adapter_revision,
        classification_revision: input.expected.classification_revision,
        support_basis: 'schema_and_version'
      })
      if (contractRef(source) !== contractRef(input.expected)) {
        throw new ProviderAdapterError('herdr_core_installation_changed')
      }
      const record: HerdrCoreContractRecord = Object.freeze({
        wire: Object.freeze({ source, support_status: 'validated' as const }),
        contract
      })
      return new HerdrCoreInstallation(client, endpoint, facts, record, installationKey)
    } catch (error) {
      client.close()
      throw error
    }
  }

  /** 每次写入前重读内核 peer 与 `/proc/<pid>` 事实；不缓存自报值，也不跟随端点变化。 */
  assert(peer?: NativePeer): void {
    if (this.#closed) {
      throw new ProviderAdapterError('herdr_core_installation_closed')
    }
    inspectHerdrCoreSocket(this.#endpoint.socket)
    const current = peer ?? this.#client.peer()
    if (current.uid !== process.getuid?.()) {
      throw new ProviderAdapterError('herdr_core_peer_uid_mismatch')
    }
    if (current.pid !== this.#facts.pid) {
      throw new ProviderAdapterError('herdr_core_peer_pid_mismatch')
    }
    const again = herdrCorePeerFacts(current, this.#facts.pid, this.#endpoint.session)
    if (
      again.exe !== this.#facts.exe ||
      again.binary_sha256 !== this.#facts.binary_sha256 ||
      again.argv.length !== this.#facts.argv.length ||
      again.argv.some(
        /** 固定 argv 逐项一致，不允许重新解释。 */ (value, index) => value !== this.#facts.argv[index]
      ) ||
      again.session !== this.#facts.session
    ) {
      throw new ProviderAdapterError('herdr_core_installation_changed')
    }
  }

  /** 只返回本次实际连接与审核文档；调用方不能替换客户端或 schema。 */
  client(): HerdrCoreClient {
    if (this.#closed) {
      throw new ProviderAdapterError('herdr_core_installation_closed')
    }
    return this.#client
  }

  endpoint(): HerdrCoreEndpoint {
    return this.#endpoint
  }

  record(): HerdrCoreContractRecord {
    this.assert()
    return this.#record
  }

  contract(): HerdrCoreContract {
    return this.#record.contract
  }

  /** 固定目标、修订和契约摘要必须同时匹配，才承认这是同一来源。 */
  source(binding: AttemptBinding): boolean {
    this.assert()
    return (
      binding.provider_kind === 'herdr-core' &&
      binding.target.profile === 'session' &&
      binding.target.session === this.#endpoint.session &&
      binding.contract_ref === contractRef(this.#record.wire.source)
    )
  }

  /** 关闭本机来源能力，不停止外部 core，也不删除用户数据。 */
  close(): void {
    this.#closed = true
    this.#client.close()
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
