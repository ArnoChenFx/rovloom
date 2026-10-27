// MCP 设备会话不采用配对时的逐方法限制；旧配置仅保留目标及策略修订。
import { validatePolicies } from '../wire/index.js'
import type { ProviderPolicies } from '../wire/types.js'
import type { ProductionProviderReference } from './production.js'
import { allExposedMethods } from './setup-policy.js'

export function allExposedConnectorMethods(entry: ProductionProviderReference): ProductionProviderReference {
  const value = entry.value as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || !('policies' in value)) {
    return entry
  }
  const policies = value.policies as ProviderPolicies
  validatePolicies(policies)
  return {
    ...entry,
    value: {
      ...value,
      policies: {
        caller: allExposedMethods(policies.caller),
        local: allExposedMethods(policies.local)
      }
    }
  }
}
