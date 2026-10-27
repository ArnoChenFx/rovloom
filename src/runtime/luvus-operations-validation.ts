/** 复用固定 Luvus 普通方法的契约审核、参数检查和逐次授权；原生来源与 raw 决定仍由受信宿主交付。 */
import { isDeepStrictEqual } from 'node:util'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import type { NativeContractRecord, NativeWireBackend } from '../integration/luvus-wire.js'
import type { TrustedNativeContext } from '../native-contract/index.js'
import { object } from '../wire/index.js'
import type { AttemptBinding } from '../wire/types.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from './native-source.js'
import { luvusOperationDescriptor, luvusOperationValidation, validateLuvusOperationParams } from './luvus-operations.js'

/** 只核对本轮实际安装契约与普通方法来源；完整响应 schema、能力绑定和实际来源由外层原校验器复核。 */
export function assertLuvusOperationsContract(contract: NativeContractRecord): void {
  const source = contract.wire.source
  const capabilities = object(object(contract.capabilities).result)
  if (
    contract.wire.support_status !== 'validated' ||
    source.provider_kind !== 'luvus' ||
    source.protocol_family !== 'uhp' ||
    source.schema_origin !== 'installed_cli' ||
    source.schema_command !== 'luvus uhp schema' ||
    !/^1\.\d+$/u.test(source.native_protocol_version ?? '') ||
    source.support_basis !== 'live_catalog' ||
    source.adapter_revision !== MANAGED_LUVUS_REVISION ||
    source.classification_revision !== MANAGED_LUVUS_CLASSIFICATION ||
    typeof source.runtime_generation !== 'string' ||
    !source.runtime_generation.length ||
    source.runtime_generation !== capabilities.server_generation ||
    contract.compiled.identity.binary_sha256 !== source.binary_sha256 ||
    contract.compiled.identity.schema_sha256 !== source.schema_sha256 ||
    contract.compiled.identity.revision !== source.adapter_revision ||
    !Array.isArray(capabilities.method_contracts)
  ) {
    throw new LuvusAdapterError('luvus_operations_source_mismatch')
  }
}

/** 固定分类不能授予来源或 raw 权限；每次先取宿主当前来源，再按显式回调决定是否交付原 gate 所需 grant。 */
export function createLuvusOperationsValidation(
  contract: NativeContractRecord,
  current: (binding: AttemptBinding) => TrustedNativeContext
): NonNullable<NativeWireBackend['validateAttempt']> {
  assertLuvusOperationsContract(contract)
  const methods = object(object(contract.capabilities).result).method_contracts as Record<string, unknown>[]
  return /** 每个候选重验当前来源、精确方法与参数，不从快照导入 Owner、permit 或新的期限。 */ (attempt, native) => {
    const proven = current(attempt.binding)
    const descriptor = luvusOperationDescriptor(attempt.method)
    if (
      proven.authenticated !== true ||
      proven.source_verified !== true ||
      !descriptor ||
      attempt.native_request.method !== attempt.method ||
      attempt.mode !== luvusOperationValidation(attempt.method) ||
      !isDeepStrictEqual(proven.binding, native)
    ) {
      throw new LuvusAdapterError('luvus_operation_unreviewed')
    }
    const live = methods.filter(
      /** 仅审核本次依赖的方法，缺少或变化不使其它健康方法失效。 */ (row) => row.method === attempt.method
    )
    if (
      live.length !== 1 ||
      !isDeepStrictEqual(
        {
          method: live[0]!.method,
          access: live[0]!.access,
          scope: live[0]!.scope,
          idempotent: live[0]!.idempotent
        },
        descriptor.native
      )
    ) {
      throw new LuvusAdapterError('luvus_operations_contract_mismatch')
    }
    validateLuvusOperationParams(attempt.method, attempt.native_request.params)
  }
}
