// 定义 Luvus/UHP 契约自身的资源预算，并在契约预算下复用通用 JSON 工具。
import { JsonFault, fail, parse, type JsonBounds, type JsonFailure } from '../../../json/bounds.js'

export type Limits = JsonBounds &
  Readonly<{
    bundle_bytes: number
    bundle_nodes: number
    documents: number
    document_bytes: number
    references: number
    reference_depth: number
    terminal_frame_bytes: number
  }>

export const DEFAULT_LIMITS: Limits = Object.freeze({
  object_bytes: 1_048_576,
  object_depth: 64,
  object_nodes: 100_000,
  bundle_bytes: 2_097_152,
  bundle_nodes: 150_000,
  documents: 64,
  document_bytes: 524_288,
  references: 2_048,
  reference_depth: 32,
  terminal_frame_bytes: 65_536
})

/** 契约失败与通用 JSON 失败共用同一结构，只是对外沿用既有名称。 */
export type NativeContractFailure = JsonFailure
export { JsonFault as ContractFault }

/** 只接受默认上限以内的正安全整数覆盖项，并冻结最终契约预算。 */
export function limits(overrides: Partial<Limits> = {}): Limits {
  const result: Record<string, number> = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value <= 0 || value > (result[key] as number)) {
      fail('invalid_limits', 'limits')
    }
    result[key] = value
  }
  return Object.freeze(result) as Limits
}

/** 使用受限契约预算解析原生 JSON，并将解析失败转换为 Check。 */
export function parseNativeJson(bytes: Uint8Array | string, overrides: Partial<Limits> = {}) {
  const budget = limits(overrides)
  try {
    return { ok: true as const, value: parse(bytes, budget) }
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof JsonFault
          ? error.failure
          : Object.freeze({ origin: 'contract' as const, code: 'invalid_context', stage: 'parse' })
    }
  }
}

export { attempt, equal, fail, hash, object, parse, pointer, snapshot, text } from '../../../json/bounds.js'
export type { Check, Json, JsonObject } from '../../../json/bounds.js'
