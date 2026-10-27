// 配对设备原生配置与 MCP 调用方的发布/合并：首台设备全新发布，后续设备原样追加，绝不改写已批准权限。
import { boundedJson, fields, object } from '../wire/index.js'
import { CliError } from './config.js'
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

export type SetupCallerEntry = {
  principal: { id: string }
  token_sha256: string
  issued_at: number
  expires_at: number
}

// 首次配对只发布身份凭据；设备及方法不需要写入 token 的授权快照。
export function publishSetupCaller(path: string, resource: string, caller: SetupCallerEntry): void {
  const previous = readSetupJson(path, REGISTRY_MAX_BYTES)
  const registry: CallerRegistry =
    previous === undefined
      ? { schema_version: 2, kind: 'mcp-caller-source', resource, callers: [] }
      : parseRegistry(previous, resource)
  const found = registry.callers.find((entry) => entry.principal.id === caller.principal.id)
  if (
    found &&
    (found.token_sha256 !== caller.token_sha256 ||
      found.issued_at !== caller.issued_at ||
      found.expires_at !== caller.expires_at)
  ) {
    throw new CliError('configuration_required')
  }
  const next = { ...registry, callers: found ? registry.callers : [...registry.callers, caller] }
  parseRegistry(next, resource)
  writeSetupFile(
    path,
    boundedJson(next, REGISTRY_MAX_BYTES),
    previous !== undefined,
    previous === undefined ? undefined : setupFileStamp(path)
  )
}

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
