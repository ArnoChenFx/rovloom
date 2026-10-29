/** 复用受控实例的完整来源绑定和同 socket peer；不签发 token 或建立有限授权策略。 */
import { isDeepStrictEqual } from 'node:util'
import type { Socket } from 'node:net'
import { readLuvusPeer, LuvusAdapterError } from '../index.js'
import type { EndpointIdentity, LuvusLocalConfig, NativeTransportEvidence, PeerIdentity } from '../index.js'
import { recheckEndpoint } from '../local.js'
import type { NativeBinding, TrustedNativeContext } from '../contract/index.js'
import type { NativeContractRecord } from '../backend.js'
import { assertBinding, boundedJson, contractRef } from '../../../wire/index.js'
import type { AttemptBinding } from '../../../wire/types.js'
import type { Connection } from '../../../transport/index.js'
import { id } from '../../../wire/index.js'
import { ownedPathStamp } from './native-process.js'
import type { ReadonlyNativeProcess } from './native-process.js'

/** Owner 与既有 custody 共用实际受控进程和 endpoint 检查，不把 auth 模式当作来源证明。 */
export abstract class NativeInstanceContext {
  readonly #process: ReadonlyNativeProcess
  readonly #endpoint: EndpointIdentity
  readonly #ownership: () => void
  readonly #endpointStamp: string
  readonly #evidence = new WeakMap<EndpointIdentity, { socket: Socket; binding: string; peer: PeerIdentity }>()
  /** 接收同一真实 child 和启动配置，不认领外部 PID 或读取用户会话。 */
  constructor(
    readonly config: LuvusLocalConfig & { readonly transport: 'ipc' },
    child: ReadonlyNativeProcess,
    endpoint: EndpointIdentity,
    ownership: () => void,
    readonly contract: NativeContractRecord
  ) {
    this.#process = child
    this.#endpoint = endpoint
    this.#ownership = ownership
    this.#endpointStamp = ownedPathStamp(endpoint.address, 'socket')
  }
  /** 子类仅补当前自身生命周期，实际进程与 socket 的检查由公用基础执行。 */
  protected abstract assertAccess(): void
  /** 子类失效时回收其自身内存状态，不推断原生动作已回滚。 */
  protected abstract invalidateAccess(): void
  /** 来源在每次调用时重新核对，失败不能复用先前成功。 */
  protected assertInstance(): void {
    try {
      this.assertAccess()
      this.#process.assertLive()
      if (ownedPathStamp(this.#endpoint.address, 'socket') !== this.#endpointStamp) {
        throw new LuvusAdapterError('owned_endpoint_mismatch')
      }
      this.#ownership()
    } catch (error) {
      this.invalidateAccess()
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('owned_instance_unavailable')
    }
  }
  /** 每次先复核 child/路径/custody，再把该受保护事实绑定到完整登记 attempt。 */
  source(binding: AttemptBinding): TrustedNativeContext {
    this.assertInstance()
    assertBinding(binding, binding)
    if (
      !isDeepStrictEqual(binding.target, this.config.target) ||
      binding.machine_id !== this.config.target.machine_id ||
      binding.provider_kind !== 'luvus' ||
      binding.binding_revision !== this.config.binding_revision ||
      binding.contract_ref !== contractRef(this.contract.wire.source)
    ) {
      throw new LuvusAdapterError('owned_binding_mismatch')
    }
    return this.#nativeBinding(binding)
  }

  /** 目录使用宿主当前认证连接，复用相同实际实例核验；不编造调用 ID 或原请求。 */
  catalogSource(connection: Connection): TrustedNativeContext {
    this.assertInstance()
    if (
      connection.authenticated !== true ||
      connection.active !== true ||
      connection.machine_id !== this.config.target.machine_id
    ) {
      throw new LuvusAdapterError('owned_binding_mismatch')
    }
    return this.#nativeBinding(connection)
  }

  /** 从已核验的 attempt 或当前连接复制共同来源字段，不伪造另一种认证或请求对象。 */
  #nativeBinding(connection: Pick<Connection, 'connection_epoch' | 'recovery_generation'>): TrustedNativeContext {
    for (const value of [connection.connection_epoch, connection.recovery_generation]) {
      id(value)
    }
    const source = this.contract.wire.source
    const native: NativeBinding = Object.freeze({
      kind: 'luvus',
      provider_id: this.config.target.provider_id,
      binding_revision: this.config.binding_revision,
      contract_source_ref: contractRef(source),
      target: Object.freeze({
        machine_id: this.config.target.machine_id,
        profile: 'session',
        session: this.config.target.session
      }),
      server_generation: source.runtime_generation,
      connection_epoch: connection.connection_epoch,
      recovery_generation: connection.recovery_generation,
      capability_revision: this.contract.capability_revision,
      classification_revision: source.classification_revision!,
      contract: this.contract.compiled.identity
    })
    return Object.freeze({ binding: native, authenticated: true, source_verified: true })
  }

  /** 对 adapter 实际同一 socket 读取 SO_PEERCRED，并与直接 child 的启动身份核对。 */
  async verifyPeer(socket: Socket, endpoint: EndpointIdentity, binding: AttemptBinding): Promise<PeerIdentity> {
    this.source(binding)
    if (
      endpoint.address !== this.#endpoint.address ||
      endpoint.stamp !== this.#endpoint.stamp ||
      endpoint.uid !== this.#endpoint.uid
    ) {
      throw new LuvusAdapterError('owned_endpoint_mismatch')
    }
    await recheckEndpoint(this.config, endpoint)
    this.source(binding)
    const peer = readLuvusPeer(socket, endpoint)
    if (!isDeepStrictEqual(peer, this.#process.identity())) {
      throw new LuvusAdapterError('owned_peer_mismatch')
    }
    this.#evidence.set(endpoint, { socket, binding: boundedJson(binding), peer })
    return peer
  }

  /** 只接受同一 endpoint 引用下仍活着的实测 socket，拒绝 JSON 复述或跨 attempt 借用。 */
  assertEvidence(binding: AttemptBinding, evidence: NativeTransportEvidence): void {
    this.source(binding)
    const proof = this.#evidence.get(evidence.endpoint)
    if (
      evidence.transport !== 'ipc' ||
      evidence.proxy_pid !== undefined ||
      !proof ||
      proof.binding !== boundedJson(binding) ||
      !isDeepStrictEqual(evidence.peer, proof.peer) ||
      !isDeepStrictEqual(readLuvusPeer(proof.socket, evidence.endpoint), proof.peer) ||
      !isDeepStrictEqual(proof.peer, this.#process.identity())
    ) {
      throw new LuvusAdapterError('owned_evidence_untrusted')
    }
  }
}
