/** 为实际受控本机 Owner 装配普通 Luvus 窗口与 Agent 操作，复用原 Wire、当前政策、来源与固定派发期限。 */
import { LuvusAdapterError } from './types.js'
import { object } from '../../wire/index.js'
import { assertLocalOwnerLuvus } from './host/native-source.js'
import type { LocalOwnerLuvusInstance } from './host/native-source.js'
import { assertLuvusOperationsContract, createLuvusOperationsValidation } from './operations-validation.js'
import { LUVUS_OPERATION_METHODS } from './operations.js'
import type { RuntimeProvider } from '../../runtime/types.js'

/** 只有原受控进程交付的真实 Owner 句柄可装配；普通 JSON、缺 token 或 ready 自报不能成为来源。 */
export function createLuvusOperationsProvider(owner: LocalOwnerLuvusInstance): RuntimeProvider {
  assertLocalOwnerLuvus(owner)
  const config = owner.config
  const contract = owner.contract
  const source = contract.wire.source
  const capabilities = object(object(contract.capabilities).result)
  assertLuvusOperationsContract(contract)
  if (source.runtime_generation !== capabilities.server_generation || capabilities.session !== config.target.session) {
    throw new LuvusAdapterError('luvus_operations_source_mismatch')
  }
  const validateAttempt = createLuvusOperationsValidation(
    contract,
    /** 本机 authority 仍逐次要求真实 Owner，并由同一实例核对完整 attempt。 */ (binding) => {
      assertLocalOwnerLuvus(owner)
      return owner.source(binding)
    }
  )
  return Object.freeze({
    catalog_methods: LUVUS_OPERATION_METHODS,
    binding: Object.freeze({
      machine_id: config.target.machine_id,
      provider_id: config.target.provider_id,
      kind: 'luvus' as const,
      binding_revision: config.binding_revision,
      config_ref: config.config_ref,
      enabled: true
    }),
    target: config.target,
    contract,
    /** 每个调用都复核原真实 child/root/session/generation，不能复用另一实例的许可。 */
    source(binding) {
      assertLocalOwnerLuvus(owner)
      return owner.source(binding)
    },
    /** 目录只使用当前实际认证连接及当前 caller/local 政策，不创建虚构请求。 */
    catalogSource(connection) {
      assertLocalOwnerLuvus(owner)
      return owner.catalogSource(connection)
    },
    validateAttempt,
    /** 就绪只取真实受控来源，失效后不把旧 Owner 句柄自报为永久可用。 */
    ready() {
      try {
        assertLocalOwnerLuvus(owner)
        return owner.ready()
      } catch {
        return false
      }
    }
  })
}
