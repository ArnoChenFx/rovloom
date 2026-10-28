// 用受保护静态 pin 和实际认证 epoch 的快照建立 Gateway 来源；不读取远端路径或重建本机 Owner。
import { compileBundle, createNativeValidator, parseNativeJson } from '../contract/index.js'
import type { NativeBinding, TrustedNativeContext } from '../contract/index.js'
import type { NativeContractRecord } from '../../../wire/backend.js'
import type { Connection } from '../../../transport/index.js'
import {
  assertBinding,
  boundedJson,
  contractRef,
  fields,
  hash,
  object,
  sha,
  validateContractSource,
  validateProvider,
  validateTarget
} from '../../../wire/index.js'
import type { AttemptBinding, ProviderBinding, ProviderSnapshot, V2Target } from '../../../wire/types.js'
import { readSchema } from '../../schema-store.js'
import { LuvusAdapterError } from '../types.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from './native-source.js'
import { assertLuvusOperationsContract, createLuvusOperationsValidation } from '../operations-validation.js'
import { LUVUS_OPERATION_METHODS } from '../operations.js'
import type { RemoteLuvusRuntimeProvider, RuntimeProvider } from '../../../runtime/types.js'
import { createLuvusRequestPreflight } from '../preflight.js'

export type LuvusProductionRemoteConfig = Readonly<{
  kind: 'luvus'
  authentication: 'remote_connector'
  binding: ProviderBinding
  target: V2Target
  contract: Readonly<{
    binary_version: string
    binary_sha256: string
    schema_sha256: string
    adapter_revision: string
    classification_revision: string
    /**
     * 原始安装 schema 的来源：新记录使用内容寻址的 `schema_ref`，旧记录仍内嵌 `schema_bundle` 文本。
     * 两条路径都保留配对时取得的原始字节，不解析后重新序列化。
     */
    schema_ref?: string
    schema_bundle?: string
  }>
  peer_policy_revision?: string
  // 兼容旧配置的只读字段，不再充当授权来源；原 Wire 仍逐次复验动作、来源和截止。
  raw_grant?: unknown
}>

/** 所有静态配置先有界复制和完整核验；调用方仍负责受保护配置文件的来源及读取。 */
export function checkedRemoteLuvusConfig(reference: string, input: unknown): LuvusProductionRemoteConfig {
  const config = object(JSON.parse(boundedJson(input)))
  fields(config, ['kind', 'authentication', 'binding', 'target', 'contract'], ['raw_grant', 'peer_policy_revision'])
  validateProvider(config.binding)
  validateTarget(config.target)
  const pin = object(config.contract)
  fields(
    pin,
    ['binary_version', 'binary_sha256', 'schema_sha256', 'adapter_revision', 'classification_revision'],
    ['schema_ref', 'schema_bundle']
  )
  sha(pin.binary_sha256)
  sha(pin.schema_sha256)
  if (
    config.kind !== 'luvus' ||
    config.authentication !== 'remote_connector' ||
    config.binding.kind !== 'luvus' ||
    config.target.profile !== 'session' ||
    config.binding.machine_id !== config.target.machine_id ||
    config.binding.provider_id !== config.target.provider_id ||
    config.binding.config_ref !== reference ||
    typeof pin.binary_version !== 'string' ||
    !pin.binary_version.length ||
    pin.binary_version.length > 128 ||
    pin.adapter_revision !== MANAGED_LUVUS_REVISION ||
    pin.classification_revision !== MANAGED_LUVUS_CLASSIFICATION ||
    // 两种来源都必须恰好出现一种，并在取字节时按声明摘要核验。
    (pin.schema_ref === undefined) === (pin.schema_bundle === undefined) ||
    (pin.schema_ref !== undefined && typeof pin.schema_ref !== 'string') ||
    (typeof pin.schema_bundle === 'string' && hash(pin.schema_bundle) !== pin.schema_sha256) ||
    (pin.schema_bundle !== undefined && typeof pin.schema_bundle !== 'string')
  ) {
    throw new LuvusAdapterError('remote_luvus_pin_invalid')
  }

  delete config.raw_grant
  delete config.peer_policy_revision
  for (const value of [config.binding, config.target, config.contract]) {
    Object.freeze(value)
  }
  return Object.freeze(config) as LuvusProductionRemoteConfig
}

type Epoch = {
  connection: Connection
  assertCurrent(): void
  record?: NativeContractRecord
  provider?: RuntimeProvider
  fingerprint?: string
  closed: boolean
}

/** 在 Gateway 本地编译固定原字节；设备只交付数据快照，不能导入编译句柄、Owner、view 或 permit。 */
export async function createPinnedRemoteLuvus(config: LuvusProductionRemoteConfig) {
  const pin = config.contract
  // 与 Herdr 共用同一内容寻址读取；旧内嵌文本仍直接使用原始字节。
  const bytes =
    pin.schema_bundle !== undefined
      ? Buffer.from(pin.schema_bundle, 'utf8')
      : readSchema(pin.schema_ref!, pin.schema_sha256, 'remote_luvus_pin_invalid')
  const compiled = await compileBundle(bytes, {
    identity: { binary_sha256: pin.binary_sha256, schema_sha256: pin.schema_sha256, revision: pin.adapter_revision }
  })
  if (!compiled.ok) {
    throw new LuvusAdapterError(compiled.error.code)
  }
  const contractHandle = compiled.value
  const target = config.target
  if (target.profile !== 'session') {
    throw new LuvusAdapterError('remote_luvus_pin_invalid')
  }
  const validator = createNativeValidator(contractHandle)
  let closed = false
  let active: Epoch | undefined

  /** 同一真实 socket 的闭包及 Store fence 每次重验；回调中的同步关闭也不能漏过。 */
  function assertEpoch(epoch: Epoch): void {
    if (closed || epoch.closed || active !== epoch) {
      throw new LuvusAdapterError('remote_luvus_epoch_unavailable')
    }
    const checked = epoch.assertCurrent()
    if (checked !== undefined) {
      // 同步 fence 不等待 Promise；消费已开始异步回调的晚拒绝，但不将它当作认证成功。
      void Promise.resolve(checked).catch(/** 晚拒绝只被观察，不复活已拒绝的来源。 */ () => {})
      throw new LuvusAdapterError('synchronous_remote_source_required')
    }
    if (closed || epoch.closed || active !== epoch) {
      throw new LuvusAdapterError('remote_luvus_epoch_unavailable')
    }
  }
  /** 关闭只丢弃本 epoch 来源；不迁移快照、重发请求或推断原生工作停止。 */
  function closeEpoch(epoch: Epoch): void {
    epoch.closed = true
    epoch.record = undefined
    epoch.provider = undefined
    if (active === epoch) {
      active = undefined
    }
  }
  /** 当前连接、完整静态 binding 与已接纳快照共同建立来源，不能凭一个认证布尔值放行。 */
  function nativeBinding(epoch: Epoch): TrustedNativeContext {
    assertEpoch(epoch)
    const record = epoch.record
    if (!record) {
      throw new LuvusAdapterError('remote_luvus_snapshot_required')
    }
    const target = config.target
    if (target.profile !== 'session') {
      throw new LuvusAdapterError('remote_luvus_pin_invalid')
    }
    const binding: NativeBinding = Object.freeze({
      kind: 'luvus',
      provider_id: target.provider_id,
      binding_revision: config.binding.binding_revision,
      contract_source_ref: contractRef(record.wire.source),
      target: Object.freeze({ machine_id: target.machine_id, profile: 'session', session: target.session }),
      server_generation: record.wire.source.runtime_generation,
      connection_epoch: epoch.connection.connection_epoch,
      recovery_generation: epoch.connection.recovery_generation,
      capability_revision: record.capability_revision,
      classification_revision: pin.classification_revision,
      contract: contractHandle.identity
    })
    assertEpoch(epoch)
    return Object.freeze({ binding, authenticated: true, source_verified: true })
  }
  /** 静态入口只有真实快照完成后才可能就绪；失效来源永远不由设备广告复活。 */
  function ready(): boolean {
    try {
      if (!active?.record) {
        return false
      }
      assertEpoch(active)
      return true
    } catch {
      return false
    }
  }
  const provider: RemoteLuvusRuntimeProvider = Object.freeze({
    remote_luvus: true,
    binding: config.binding,
    target: config.target,
    preflightRequest: createLuvusRequestPreflight(contractHandle),
    ready,
    /** 只由 Gateway 的实际认证 session 调用；静态 pin 不预先构造任何 live 来源。 */
    open(connection, assertCurrent) {
      if (
        closed ||
        active ||
        !connection.authenticated ||
        !connection.active ||
        connection.machine_id !== config.target.machine_id ||
        !connection.negotiated.capabilities.includes('provider_snapshot')
      ) {
        throw new LuvusAdapterError('remote_luvus_epoch_unavailable')
      }
      const epoch: Epoch = { connection: structuredClone(connection), assertCurrent, closed: false }
      active = epoch
      try {
        assertEpoch(epoch)
      } catch (error) {
        closeEpoch(epoch)
        throw error
      }
      return Object.freeze({
        /** 原 transport 已认证并验同 epoch；此处再交叉核对固定 pin、完整能力与原 schema。 */
        accept(input: ProviderSnapshot): RuntimeProvider {
          assertEpoch(epoch)
          const copied = parseNativeJson(boundedJson(input))
          if (!copied.ok) {
            throw new LuvusAdapterError(copied.error.code)
          }
          const snapshot = copied.value as ProviderSnapshot
          fields(object(snapshot), ['binding', 'target', 'source', 'capabilities', 'capability_revision'])
          validateProvider(snapshot.binding)
          validateTarget(snapshot.target)
          validateContractSource(snapshot.source)
          sha(snapshot.capability_revision)
          if (
            boundedJson(snapshot.binding) !== boundedJson(config.binding) ||
            boundedJson(snapshot.target) !== boundedJson(config.target)
          ) {
            throw new LuvusAdapterError('remote_luvus_binding_mismatch')
          }
          const source = snapshot.source
          if (
            source.binary_sha256 !== pin.binary_sha256 ||
            source.schema_sha256 !== pin.schema_sha256 ||
            source.adapter_revision !== pin.adapter_revision ||
            source.classification_revision !== pin.classification_revision ||
            typeof source.runtime_generation !== 'string' ||
            !source.runtime_generation.length
          ) {
            throw new LuvusAdapterError('remote_luvus_contract_mismatch')
          }
          const capabilities = object(snapshot.capabilities)
          const value = object(capabilities.result)
          if (hash(boundedJson(value)) !== snapshot.capability_revision) {
            throw new LuvusAdapterError('remote_luvus_capability_mismatch')
          }
          const shape = validator.checkCapabilitiesShape(capabilities, {
            target: { machine_id: target.machine_id, profile: 'session', session: target.session },
            server_generation: source.runtime_generation
          })
          if (!shape.ok) {
            throw new LuvusAdapterError(shape.error.code)
          }
          const record: NativeContractRecord = Object.freeze({
            wire: Object.freeze({ source: Object.freeze(source), support_status: 'validated' }),
            compiled: contractHandle,
            capabilities,
            capability_revision: snapshot.capability_revision
          })
          assertLuvusOperationsContract(record)
          const fingerprint = hash(boundedJson(snapshot))
          if (epoch.fingerprint !== undefined) {
            if (epoch.fingerprint !== fingerprint) {
              throw new LuvusAdapterError('remote_luvus_snapshot_changed')
            }
            assertEpoch(epoch)
            return epoch.provider!
          }
          /** 原调用必须属于本次实际 epoch、完整目标和固定契约，旧 attempt 不能借新连接读取。 */
          function sourceFor(binding: AttemptBinding): TrustedNativeContext {
            assertEpoch(epoch)
            assertBinding(binding, binding)
            if (
              binding.machine_id !== epoch.connection.machine_id ||
              binding.recovery_generation !== epoch.connection.recovery_generation ||
              binding.connection_epoch !== epoch.connection.connection_epoch ||
              binding.provider_kind !== 'luvus' ||
              binding.binding_revision !== config.binding.binding_revision ||
              boundedJson(binding.target) !== boundedJson(config.target) ||
              binding.contract_ref !== contractRef(record.wire.source)
            ) {
              throw new LuvusAdapterError('remote_luvus_binding_mismatch')
            }
            return nativeBinding(epoch)
          }
          const live: RuntimeProvider = Object.freeze({
            catalog_methods: LUVUS_OPERATION_METHODS,
            binding: config.binding,
            target: config.target,
            contract: record,
            source: sourceFor,
            /** 目录无需虚构 attempt，直接使用同一真实连接和本次实际 caller/local 修订。 */
            catalogSource(current) {
              if (boundedJson(current) !== boundedJson(epoch.connection)) {
                throw new LuvusAdapterError('remote_luvus_epoch_unavailable')
              }
              return nativeBinding(epoch)
            },
            validateAttempt: createLuvusOperationsValidation(record, sourceFor),
            /** 旧 live 对象即使仍被原句柄引用，也只能检查其原 epoch。 */
            ready() {
              try {
                assertEpoch(epoch)
                return !!epoch.record
              } catch {
                return false
              }
            }
          })
          assertEpoch(epoch)
          epoch.record = record
          epoch.fingerprint = fingerprint
          epoch.provider = live
          return live
        },
        /** 断连、撤权或关闭只使此 epoch 失效，不影响后续新认证连接的独立来源。 */
        close() {
          closeEpoch(epoch)
        }
      })
    }
  })
  return Object.freeze({
    provider,
    /** 工厂释放也封锁尚未收到快照的连接，原 compiled 句柄不再作为 live 来源使用。 */
    close() {
      closed = true
      if (active) {
        closeEpoch(active)
      }
    }
  })
}
