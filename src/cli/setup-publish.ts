// 配对设备原生配置与 MCP 调用方的发布/合并：首台设备全新发布，后续设备原样追加，绝不改写已批准权限。
import { boundedJson, fields, object } from '../wire/index.js'
import type { ProviderGrant, ProviderPolicy } from '../wire/types.js'
import { CliError } from './config.js'
import { isAdminPlaceholder } from './admin-registry.js'
import type { CallerRegistry } from './token-registry.js'
import { REGISTRY_MAX_BYTES, parseRegistry } from './token-registry.js'
import { readSetupJson, setupFileStamp, writeSetupFile, writeSetupJson } from './setup-files.js'
import { readRuntimeJson } from './runtime-files.js'

// 相同计划的重入只接纳完全相同的程序数据；未知条目、部分内容或外部改动不被覆盖。
export function publish(path: string, value: unknown, maximum = 16_384): void {
  const current = readSetupJson(path, maximum)
  if (current === undefined) {
    writeSetupJson(path, value, false, maximum)
  } else if (boundedJson(current, maximum) !== boundedJson(value, maximum)) {
    throw new CliError('configuration_required')
  }
}

// 把新设备的授权并入已有策略：同一目标已有授权时必须完全相同（重入），不同则拒绝，绝不静默改写已批准的权限。
export function unionGrants(existing: readonly ProviderGrant[], added: readonly ProviderGrant[]): ProviderGrant[] {
  const merged = [...existing]
  for (const grant of added) {
    const found = merged.find(/* 同一精确目标。 */ (entry) => boundedJson(entry.target) === boundedJson(grant.target))
    if (!found) {
      merged.push(grant)
    } else if (boundedJson(found) !== boundedJson(grant)) {
      throw new CliError('configuration_required')
    }
  }
  return merged
}

export type SetupCallerEntry = {
  principal: { id: string; policy: ProviderPolicy }
  token_sha256: string
  issued_at: number
  expires_at: number
}

// 首台设备的调用方发布：注册表缺失时全新发布；已有注册表时只保留管理员占位主体（首次配对前
// rovloom admin create 建立）或与本次完全相同的原条目（中断后的重入），本机策略整体替换，
// 绝不覆盖或扩大任何真实 MCP 主体。
export function publishFirstCallers(
  path: string,
  resource: string,
  authorization: { principal_id: string; policies: { caller: ProviderPolicy; local: ProviderPolicy } },
  caller: SetupCallerEntry
): void {
  const previous = readSetupJson(path, REGISTRY_MAX_BYTES)
  const created: CallerRegistry = {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource,
    local_policy: authorization.policies.local,
    gateway_policy: authorization.policies.caller,
    callers: [caller]
  }
  if (previous === undefined) {
    parseRegistry(JSON.parse(boundedJson(created, REGISTRY_MAX_BYTES)))
    writeSetupFile(path, boundedJson(created, REGISTRY_MAX_BYTES), false)
    return
  }
  const registry = parseRegistry(previous, resource)
  const kept = registry.callers.filter(
    /* 管理员占位保留；非占位条目必须是同一请求的原样重入，其余状态一律拒绝。 */ (entry) =>
      isAdminPlaceholder(entry) ||
      entry.scope === 'gateway' ||
      boundedJson(entry, REGISTRY_MAX_BYTES) === boundedJson(caller, REGISTRY_MAX_BYTES)
  )
  if (kept.length !== registry.callers.length) {
    throw new CliError('configuration_required')
  }
  // 原样重入的条目已存在时不重复追加；管理员占位保留在设备主体之前。
  const callers = [...kept]
  if (!callers.some((entry) => boundedJson(entry, REGISTRY_MAX_BYTES) === boundedJson(caller, REGISTRY_MAX_BYTES))) {
    callers.push(caller)
  }
  const merged: CallerRegistry = { ...created, callers }
  parseRegistry(JSON.parse(boundedJson(merged, REGISTRY_MAX_BYTES)), resource)
  const stamp = setupFileStamp(path)
  writeSetupFile(path, boundedJson(merged, REGISTRY_MAX_BYTES), true, stamp)
}

// 加入新设备：本机策略与安装时建立的 MCP 主体策略并入新设备的授权；修订标签沿用首台设备，已批准的授权不改写。
// 之后用 rovloom token create --like 克隆出的其它主体是创建时的快照，需要重新克隆才包含新设备。
export function mergeSetupCallers(
  path: string,
  resource: string,
  authorization: { principal_id: string; policies: { caller: ProviderPolicy; local: ProviderPolicy } }
): void {
  const stamp = setupFileStamp(path)
  // parseRegistry 返回冻结对象；在深拷贝上并入授权。
  const registry = structuredClone(parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES), resource)) as ReturnType<
    typeof parseRegistry
  >
  if (registry.local_policy.revision !== authorization.policies.local.revision) {
    throw new CliError('configuration_required')
  }
  if (registry.gateway_policy && registry.gateway_policy.revision !== authorization.policies.caller.revision) {
    throw new CliError('configuration_required')
  }
  registry.gateway_policy = {
    revision: authorization.policies.caller.revision,
    grants: unionGrants(registry.gateway_policy?.grants ?? [], authorization.policies.caller.grants)
  }
  registry.local_policy.grants = unionGrants(registry.local_policy.grants, authorization.policies.local.grants)
  for (const entry of registry.callers) {
    if (entry.principal.id === authorization.principal_id) {
      if (entry.principal.policy.revision !== authorization.policies.caller.revision) {
        throw new CliError('configuration_required')
      }
      entry.principal.policy.grants = unionGrants(entry.principal.policy.grants, authorization.policies.caller.grants)
    }
  }
  parseRegistry(JSON.parse(boundedJson(registry, REGISTRY_MAX_BYTES)), resource)
  writeSetupFile(path, boundedJson(registry, REGISTRY_MAX_BYTES), true, stamp)
}

// 加入新设备：已有设备的 provider 条目原样保留，只追加本次已核验的条目（同引用必须完全相同）。
export function mergeSetupProviders(path: string, entries: readonly { reference: string; value: unknown }[]): void {
  const stamp = setupFileStamp(path)
  const document = object(readRuntimeJson(path, 1_048_576))
  fields(document, ['schema_version', 'role', 'providers'])
  if (document.schema_version !== 1 || document.role !== 'gateway' || !Array.isArray(document.providers)) {
    throw new CliError('configuration_required')
  }
  const merged = [...(document.providers as { reference: string; value: unknown }[])]
  for (const entry of entries) {
    const found = merged.find(/* 同一引用。 */ (value) => value.reference === entry.reference)
    if (!found) {
      merged.push(entry)
    } else if (boundedJson(found.value, 1_048_576) !== boundedJson(entry.value, 1_048_576)) {
      throw new CliError('configuration_required')
    }
  }
  if (merged.length > 32) {
    throw new CliError('configuration_required')
  }
  writeSetupFile(path, boundedJson({ ...document, providers: merged }, 1_048_576), true, stamp)
}
