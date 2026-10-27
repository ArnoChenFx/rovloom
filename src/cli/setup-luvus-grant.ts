// 仅升级旧版单码配对生成的完整 raw 授权；显式自定义主体、方法子集或其它谱系保持原有范围。
import { boundedJson, validatePolicies } from '../wire/index.js'
import type { ProviderPolicies } from '../wire/types.js'
import { checkedRemoteLuvusConfig } from '../runtime/remote-luvus.js'
import type { LuvusProductionRemoteConfig } from '../runtime/remote-luvus.js'
import type { ProductionProviderReference } from './production.js'
import {
  isSetupLuvusMethods,
  SIMPLE_SETUP_ACTOR,
  setupReference,
  simpleSetupAuthorization,
  upgradeSetupLuvusMethods,
  upgradeSetupLuvusPolicy
} from './setup-policy.js'

/** 在受保护的 Gateway 配置装配时迁移内存副本；不重配设备、不改 token，不写回旧文件。 */
export function migrateSetupLuvusGrant(entry: ProductionProviderReference): ProductionProviderReference {
  const value = entry.value
  const prefix = setupReference('', 'luvus')
  if (
    !entry.reference.startsWith(prefix) ||
    entry.reference.length === prefix.length ||
    !value ||
    typeof value !== 'object' ||
    !('kind' in value) ||
    value.kind !== 'luvus' ||
    !('authentication' in value) ||
    value.authentication !== 'remote_connector'
  ) {
    return entry
  }
  let remote: LuvusProductionRemoteConfig
  try {
    remote = checkedRemoteLuvusConfig(entry.reference, value)
  } catch {
    // 不迁移不合法的引用；仍由原生产 loader 校验并返回原有的受控错误。
    return entry
  }
  const target = remote.target
  if (
    target.profile !== 'session' ||
    !['default', 'rovloom'].includes(target.session) ||
    remote.binding.binding_revision !== 1 ||
    !remote.binding.enabled
  ) {
    return entry
  }
  const expected = simpleSetupAuthorization(target.machine_id, ['luvus'], {
    luvus: target.session as 'default' | 'rovloom'
  })
  const grant = expected.policies.caller.grants[0]!
  const raw = remote.raw_grant
  if (
    boundedJson(target) !== boundedJson(grant.target) ||
    remote.peer_policy_revision !== expected.policies.local.revision ||
    !raw ||
    !isSetupLuvusMethods(raw.methods) ||
    ![
      { principal_id: SIMPLE_SETUP_ACTOR, methods: raw.methods },
      { caller_policy_revision: expected.policies.caller.revision, methods: raw.methods }
    ].some((candidate) => boundedJson(raw) === boundedJson(candidate))
  ) {
    return entry
  }
  const upgraded = {
    caller_policy_revision: expected.policies.caller.revision,
    methods: [...upgradeSetupLuvusMethods(raw.methods)]
  }
  if (boundedJson(raw) === boundedJson(upgraded)) {
    return entry
  }
  return {
    reference: entry.reference,
    value: {
      ...remote,
      raw_grant: upgraded
    }
  }
}

/** 原准备记录已核对后才升级 Connector 的受保护策略副本；不重写配对 journal 或安装根。 */
export function migrateSetupLuvusConnector(entry: ProductionProviderReference): ProductionProviderReference {
  const value = entry.value as Record<string, unknown> | null
  if (
    !entry.reference.startsWith('luvus_') ||
    entry.reference.length === 'luvus_'.length ||
    !value ||
    typeof value !== 'object' ||
    value.kind !== 'luvus' ||
    value.authentication !== 'local_owner' ||
    value.principal_id !== SIMPLE_SETUP_ACTOR ||
    value.peer_policy_revision !== 'setup_local_simple'
  ) {
    return entry
  }
  try {
    const policies = value.policies as ProviderPolicies
    validatePolicies(policies)
    const caller = upgradeSetupLuvusPolicy(policies.caller)
    const local = upgradeSetupLuvusPolicy(policies.local)
    if (caller === policies.caller && local === policies.local) {
      return entry
    }
    return { ...entry, value: { ...value, policies: { caller, local } } }
  } catch {
    // 畸形配置仍交给原生产解析器拒绝，不能靠迁移修复或绕过来源验证。
    return entry
  }
}
