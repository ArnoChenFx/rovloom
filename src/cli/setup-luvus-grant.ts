// 仅升级旧版单码配对生成的完整 raw 授权；显式自定义主体、方法子集或其它谱系保持原有范围。
import { boundedJson } from '../wire/index.js'
import { checkedRemoteLuvusConfig } from '../runtime/remote-luvus.js'
import type { LuvusProductionRemoteConfig } from '../runtime/remote-luvus.js'
import type { ProductionProviderReference } from './production.js'
import { SIMPLE_SETUP_ACTOR, setupReference, simpleSetupAuthorization } from './setup-policy.js'

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
  if (
    boundedJson(target) !== boundedJson(grant.target) ||
    remote.peer_policy_revision !== expected.policies.local.revision ||
    boundedJson(remote.raw_grant ?? null) !== boundedJson({ principal_id: SIMPLE_SETUP_ACTOR, methods: grant.methods })
  ) {
    return entry
  }
  return {
    reference: entry.reference,
    value: {
      ...remote,
      raw_grant: { caller_policy_revision: expected.policies.caller.revision, methods: grant.methods }
    }
  }
}
