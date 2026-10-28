/** 用持久受保护 Luvus root 显式启动正式受控 child，并交付本机 Owner 句柄。 */
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import type { AttemptBinding, ContractSource } from '../../../wire/types.js'
import { boundedJson } from '../../../wire/index.js'
import { parseNativeJson } from '../contract/index.js'
import type { TrustedNativeContext } from '../contract/index.js'
import type { NativeContractRecord } from '../backend.js'
import { deadline } from '../io.js'
import { localLimits } from '../local.js'
import { LuvusAdapterError } from '../types.js'
import type { EndpointIdentity, LuvusLocalConfig, NativeTransportEvidence, PeerIdentity } from '../types.js'
import type { Connection } from '../../../transport/index.js'
import type { CompiledContract } from '../contract/index.js'
import { NativeInstanceContext } from './native-instance-context.js'
import { assertManagedRoot, claimManagedRoot } from './native-root.js'
import type { ManagedLuvusRoot } from './native-root.js'
import { assertControlledLuvus, controlledLuvusRpc, startControlledLuvus } from './native-control.js'
import type { ControlledLuvusSession } from './native-control.js'
import { OwnedProcessShutdownError } from './native-process.js'

export const MANAGED_LUVUS_REVISION = 'managed-owned-luvus-0.14.3-1'
export const MANAGED_LUVUS_CLASSIFICATION = 'managed-owned-rpc-1'
const processBrand = Symbol('managed-luvus-process')
const localOwners = new WeakMap<LocalOwnerLuvusInstance, () => boolean>()
export interface LocalOwnerLuvusInstance {
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  source(binding: AttemptBinding): TrustedNativeContext
  catalogSource(connection: Connection): TrustedNativeContext
  verifyPeer(socket: Socket, endpoint: EndpointIdentity, binding: AttemptBinding): Promise<PeerIdentity>
  assertEvidence(binding: AttemptBinding, evidence: NativeTransportEvidence): void
  nativeAuth(binding: AttemptBinding, evidence: NativeTransportEvidence): Readonly<{ kind: 'local_owner' }>
  ready(): boolean
}
/** 内部真实 managed/attach 工厂在实际 peer 检查完成后登记闭包，不向产品入口开放 JSON 注册。 */
export function registerLocalOwnerLuvus(owner: LocalOwnerLuvusInstance, live: () => boolean): void {
  if (localOwners.has(owner) || !live()) {
    throw new LuvusAdapterError('local_owner_unavailable')
  }
  localOwners.set(owner, live)
}
/** 仅接受本次受控进程明确交付的 Owner；没有 token 不是自动选择此模式的理由。 */
export function assertLocalOwnerLuvus(owner: LocalOwnerLuvusInstance): void {
  const live = localOwners.get(owner)
  if (!live || !live()) {
    throw new LuvusAdapterError('local_owner_unavailable')
  }
}
export interface ControlledLuvusProcess {
  readonly [processBrand]: true
  readonly root_id: string
  readonly root_revision: number
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  // 宿主显式选择本机 Owner 操作，不签发 token、添加批准或创建持续访问。
  localOwner(): LocalOwnerLuvusInstance
  ready(): boolean
  close(): Promise<void>
}

/** 从同一真实能力响应建立完整 envelope 契约，generation 只认当前受控 child 的原生值。 */
function observedContract(
  control: ControlledLuvusSession,
  observed: Readonly<{ frame: Record<string, unknown>; result: Record<string, unknown> }>
): NativeContractRecord {
  assertControlledLuvus(control)
  return observedLuvusContract(control.config, control.compiled, observed, control.binaryVersion)
}

/** 共享真实能力快照到安装契约的纯映射；调用者必须先建立自身实际 socket/process 来源。 */
export function observedLuvusContract(
  config: LuvusLocalConfig,
  compiled: CompiledContract,
  observed: Readonly<{ frame: Record<string, unknown>; result: Record<string, unknown> }>,
  binaryVersion = 'unavailable'
): NativeContractRecord {
  const value = observed.result
  const protocol = value.protocol as Record<string, unknown> | undefined
  if (
    typeof value.server_generation !== 'string' ||
    !value.server_generation.length ||
    value.server_generation.length > 512 ||
    value.session !== config.target.session ||
    protocol?.name !== 'luvus-uhp' ||
    protocol.major !== 1 ||
    !Number.isSafeInteger(protocol.minor) ||
    (protocol.minor as number) < 0
  ) {
    throw new LuvusAdapterError('native_source_capabilities_invalid')
  }
  const maximum = Math.min(localLimits(config.limits).discovery_bytes, 1_048_576)
  const snapshot = parseNativeJson(boundedJson(observed.frame, maximum), { object_bytes: maximum })
  if (!snapshot.ok) {
    throw new LuvusAdapterError('native_source_capabilities_invalid')
  }
  const source: ContractSource = Object.freeze({
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: binaryVersion,
    binary_sha256: config.binary_sha256,
    schema_sha256: compiled.identity.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version:
      typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 128
        ? value.version
        : null,
    native_protocol_version: `${protocol.major}.${protocol.minor}`,
    runtime_generation: value.server_generation,
    adapter_revision: MANAGED_LUVUS_REVISION,
    classification_revision: MANAGED_LUVUS_CLASSIFICATION,
    support_basis: 'live_catalog'
  })
  return Object.freeze({
    wire: Object.freeze({ source, support_status: 'validated' as const }),
    compiled,
    capabilities: snapshot.value,
    capability_revision: createHash('sha256').update(boundedJson(value, maximum)).digest('hex')
  })
}

/** 持有真实 child 与永久 owner 锁；启动与关闭分别有独立的可验证边界。 */
class ManagedProcess extends NativeInstanceContext implements ControlledLuvusProcess {
  readonly [processBrand] = true as const
  readonly root_id: string
  readonly root_revision: number
  readonly #root: ManagedLuvusRoot
  readonly #control: ControlledLuvusSession
  readonly #lock: ReturnType<typeof claimManagedRoot>
  #stopping = false
  #closing: Promise<void> | undefined

  /** 仅本工厂可交付同一 root 锁、真实 process handle 和同 socket 能力观察。 */
  constructor(
    root: ManagedLuvusRoot,
    control: ControlledLuvusSession,
    lock: ReturnType<typeof claimManagedRoot>,
    contract: NativeContractRecord
  ) {
    super(
      control.config,
      control.process,
      control.endpoint,
      /* 同一受控 root、直接 child 与真实 endpoint 继续由既有基础核对。 */ () => assertControlledLuvus(control),
      contract
    )
    this.#root = root
    this.#control = control
    this.#lock = lock
    this.root_id = root.root_id
    this.root_revision = root.root_revision
  }

  /** Owner 使用同一真实受控实例寿命。 */
  protected assertAccess(): void {
    this.#live()
  }
  /** Owner 不持有 token；来源失效始终由原进程状态继续拒绝。 */
  protected invalidateAccess(): void {}
  /** 显式本机 Owner 句柄只用于受控实例的普通操作，不签发 token。 */
  localOwner(): LocalOwnerLuvusInstance {
    this.#live()
    const owner: LocalOwnerLuvusInstance = Object.freeze({
      config: this.config,
      contract: this.contract,
      source: /* 每个原调用继续绑定同一实际 native 来源。 */ (binding: AttemptBinding) => this.source(binding),
      catalogSource: /* 目录只绑定当前实际认证连接及本次当前政策，不创建虚构 attempt。 */ (connection: Connection) =>
        this.catalogSource(connection),
      verifyPeer: /* 原 adapter 的同一 IPC socket 继续进行实际 peer 检查。 */ (
        socket: Socket,
        endpoint: EndpointIdentity,
        binding: AttemptBinding
      ) => this.verifyPeer(socket, endpoint, binding),
      assertEvidence: /* 写入前核对原 socket 与完整调用匹配。 */ (
        binding: AttemptBinding,
        evidence: NativeTransportEvidence
      ) => this.assertEvidence(binding, evidence),
      nativeAuth: /* 显式省略 native auth 字段才表示官方本机 Owner；peer 事实另行核验。 */ (
        binding: AttemptBinding,
        evidence: NativeTransportEvidence
      ) => {
        this.assertEvidence(binding, evidence)
        return Object.freeze({ kind: 'local_owner' as const })
      },
      ready: /* 当前受控进程失效时不沿用旧就绪状态。 */ () => this.ready()
    })
    registerLocalOwnerLuvus(owner, /* 只调用原实现的当前真实进程核验，不采信交付对象自报。 */ () => this.ready())
    return owner
  }
  /** 进程是否仍在受控状态；就绪不授予 token 或派发能力。 */
  ready(): boolean {
    try {
      this.#live()
      return true
    } catch {
      return false
    }
  }

  /** 显式关闭先阻止新用途，确认真实 child 退出后才释放 owner 锁；失败可显式重试。 */
  close(): Promise<void> {
    this.#stopping = true
    if (this.#closing) {
      return this.#closing
    }
    const attempt = this.#stop()
    this.#closing = attempt
    void attempt.then(
      /* 成功后重复 close 仍核验真实已退出状态。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      },
      /* 失败只清本次等待，保留 owner 锁及 pidfd，不恢复来源。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      }
    )
    return attempt
  }

  /** 当前关闭 fence、真实 root 和实际 child 归属都必须独立有效。 */
  #live(): void {
    if (this.#stopping) {
      throw new LuvusAdapterError('native_source_unavailable')
    }
    assertManagedRoot(this.#root)
    this.#lock.assert()
    assertControlledLuvus(this.#control)
  }

  /** 不把逻辑等待截止当作物理退出，只有受控 owner 返回确认后才可清理锁。 */
  async #stop(): Promise<void> {
    await this.#control.process.close()
    this.#lock.release(this.#control.process)
  }
}

/** 显式启动记录指定的持久 root；不认领已有 PID、不读业务列表、不发行 token。 */
export async function startManagedLuvus(root: ManagedLuvusRoot): Promise<ControlledLuvusProcess> {
  assertManagedRoot(root)
  const lock = claimManagedRoot(root)
  const scope = deadline(undefined, localLimits(root.config.limits).timeout_ms)
  let control: ControlledLuvusSession | undefined
  try {
    control = await startControlledLuvus(root.config, {
      revision: MANAGED_LUVUS_REVISION,
      signal: scope.signal,
      /* 启动与每次控制 RPC 都依赖真实保护记录及本轮独占锁。 */ assertOwnership: () => lock.assert()
    })
    const observed = await controlledLuvusRpc(control, 'uhp.capabilities', {}, undefined, scope.signal)
    const contract = observedContract(control, observed)
    return new ManagedProcess(root, control, lock, contract)
  } catch (error) {
    if (control) {
      await control.process.close()
      lock.release(control.process)
    } else if (!(error instanceof OwnedProcessShutdownError && !error.exit_confirmed)) {
      // 内部启动器确认没留下 child 后才能释放锁；cleanup_pending 错误保留所有权证据。
      lock.release()
    }
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_source_start_failed')
  } finally {
    scope.close()
  }
}
