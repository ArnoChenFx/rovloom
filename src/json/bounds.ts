// 提供与 provider 无关的有界 JSON 预算、解析、冻结快照与结构比较；不承载任何原生契约语义。
import { createHash } from 'node:crypto'

export type Json = null | boolean | number | string | readonly Json[] | JsonObject
export type JsonObject = { readonly [key: string]: Json }
export type JsonBounds = Readonly<{
  object_bytes: number
  object_depth: number
  object_nodes: number
}>

/** 通用解析与快照预算；调用方只能在自己的字段预算里收窄，不会放宽这些上限。 */
export const DEFAULT_JSON_BOUNDS: JsonBounds = Object.freeze({
  object_bytes: 1_048_576,
  object_depth: 64,
  object_nodes: 100_000
})

/** 失败来源标签：契约/结构问题，或已通过结构但仍被授权门禁拒绝。 */
export type JsonFailureOrigin = 'contract' | 'authorization'
export type JsonFailure = Readonly<{
  origin: JsonFailureOrigin
  code: string
  stage: string
  reason?: string
}>
export type Check<T> = { ok: true; value: T } | { ok: false; error: JsonFailure }

export class JsonFault extends Error {
  // 以固定失败码作为错误消息，并保留可安全返回的结构化失败信息。
  constructor(readonly failure: JsonFailure) {
    super(failure.code)
  }
}

// 抛出冻结的失败信息，供统一结果包装器捕获。
export function fail(
  code: string,
  stage = 'validation',
  reason?: string,
  origin: JsonFailureOrigin = 'contract'
): never {
  throw new JsonFault(Object.freeze({ origin, code, stage, ...(reason ? { reason } : {}) }))
}

// 同步执行并返回 Check；未知异常统一收敛为当前阶段的无效上下文。
export function attempt<T>(stage: string, fn: () => T): Check<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof JsonFault
          ? error.failure
          : Object.freeze({ origin: 'contract' as const, code: 'invalid_context', stage })
    }
  }
}

// 只接受默认上限以内的正安全整数覆盖项，并冻结最终资源预算。
export function bounds(overrides: Partial<JsonBounds> = {}): JsonBounds {
  const result = { ...DEFAULT_JSON_BOUNDS }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(result, key) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > result[key as keyof JsonBounds]
    ) {
      fail('invalid_limits', 'limits')
    }
    result[key as keyof JsonBounds] = value
  }
  return Object.freeze(result)
}

// 计算原始字节的 SHA-256 十六进制摘要。
export function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// 要求输入为非 null 且非数组的对象，否则抛出指定失败码。
export function object(value: unknown, code = 'invalid_context'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code)
  }
  return value as JsonObject
}

// 要求输入为非空字符串，否则抛出指定失败码。
export function text(value: unknown, code = 'invalid_context'): string {
  if (typeof value !== 'string' || !value.length) {
    fail(code)
  }
  return value
}

// 递归比较数组或对象的自有可枚举字段，忽略对象字段顺序。
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return false
  }
  const left = Object.keys(a).sort()
  const right = Object.keys(b).sort()
  return (
    left.length === right.length &&
    left.every(
      // 逐项核对排序后的字段名，并递归比较对应字段值。
      (key, i) => key === right[i] && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    )
  )
}

// 拒绝字符串中未配对的 UTF-16 代理项。
function unicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('invalid_json', 'parse', 'unpaired_surrogate')
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('invalid_json', 'parse', 'unpaired_surrogate')
    }
  }
}

// 在遍历时限制大小、深度与节点数，拒绝行为对象并生成冻结的 JSON 快照。
export function snapshot(value: unknown, budget: JsonBounds = DEFAULT_JSON_BOUNDS): Json {
  const active = new Set<object>()
  let nodes = 0
  let bytes = 0
  // 累计已编码字节数，一旦超出对象预算立即拒绝。
  const spend = (count: number): void => {
    bytes += count
    if (bytes > budget.object_bytes) {
      fail('object_limit', 'parse')
    }
  }

  // 校验代理项并按 JSON 转义后的 UTF-8 大小扣除字符串预算。
  const stringBytes = (value: string): void => {
    // 逐项计入 JSON 编码预算，不能先 stringify 整个对象再判断，避免超额分配。
    if (value.length + 2 > budget.object_bytes - bytes) {
      fail('object_limit', 'parse')
    }
    spend(2)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i)
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          fail('invalid_json', 'parse', 'unpaired_surrogate')
        }
        spend(4)
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail('invalid_json', 'parse', 'unpaired_surrogate')
      } else if (code === 34 || code === 92) {
        spend(2)
      } else if (code < 32) {
        spend([8, 9, 10, 12, 13].includes(code) ? 2 : 6)
      } else {
        spend(code < 128 ? 1 : code < 2048 ? 2 : 3)
      }
    }
  }

  // 递归复制当前 JSON 值，计入资源预算并拒绝循环、访问器和非普通原型。
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > budget.object_nodes || depth > budget.object_depth) {
      fail('object_limit', 'parse')
    }
    if (item === null || typeof item === 'boolean') {
      spend(item === false ? 5 : 4)
      return item
    }
    if (typeof item === 'string') {
      stringBytes(item)
      return item
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        fail('invalid_json', 'parse')
      }
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) {
        fail('json_number_precision', 'parse')
      }
      spend(JSON.stringify(item).length)
      return item
    }
    if (!item || typeof item !== 'object' || active.has(item)) {
      fail('invalid_json', 'parse')
    }
    if (
      Object.getOwnPropertySymbols(item).length ||
      Object.getPrototypeOf(item) !== (Array.isArray(item) ? Array.prototype : Object.prototype)
    ) {
      fail('invalid_json', 'parse')
    }
    if (Array.isArray(item) && item.length > budget.object_nodes) {
      fail('object_limit', 'parse')
    }
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (
      Object.values(descriptors).some(
        /* 识别访问器属性，避免复制输入时执行 getter 或 setter。 */ (d) => !('value' in d)
      )
    ) {
      fail('invalid_json', 'parse')
    }
    active.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length || Object.keys(descriptors).length !== item.length + 1) {
          fail('invalid_json', 'parse')
        }
        spend(2 + Math.max(0, item.length - 1))
        const values: Json[] = []
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(descriptors, i)) {
            fail('invalid_json', 'parse')
          }
          values.push(visit(descriptors[i]!.value, depth + 1))
        }
        return Object.freeze(values)
      }
      const result: Record<string, Json> = {}
      spend(2)
      let first = true
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) {
          fail('invalid_json', 'parse')
        }
        spend(first ? 1 : 2)
        first = false
        stringBytes(key)
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true
        })
      }
      return Object.freeze(result)
    } finally {
      active.delete(item)
    }
  }

  return visit(value, 0)
}

// 在字节及结构预算内解析 JSON，保留重复键、精度和 Unicode 拒绝边界。
export function parse(bytes: Uint8Array | string, budget: JsonBounds): Json {
  let input: string
  if (typeof bytes === 'string') {
    if (bytes.length > budget.object_bytes) {
      fail('object_limit', 'parse')
    }
    unicode(bytes)
    input = bytes
  } else if (bytes instanceof Uint8Array) {
    if (bytes.byteLength > budget.object_bytes) {
      fail('object_limit', 'parse')
    }
    try {
      // 保留 BOM 交给 JSON 语法拒绝，不能让字节入口静默接受字符串入口拒绝的内容。
      input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      fail('invalid_utf8', 'parse')
    }
  } else {
    fail('invalid_json', 'parse')
  }
  if (Buffer.byteLength(input) > budget.object_bytes) {
    fail('object_limit', 'parse')
  }
  let position = 0
  let nodes = 0
  // 推进游标以跳过 JSON 允许的空白字符。
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(input[position] ?? '\u0000')) {
      position++
    }
  }

  // 读取一个字符串字面量，使用原生解码并复核代理项合法性。
  const string = (): string => {
    const start = position++
    while (position < input.length) {
      const c = input[position++]
      if (c === '\\') {
        position++
        continue
      }
      if (c === '"') {
        try {
          const value: string = JSON.parse(input.slice(start, position))
          unicode(value)
          return value
        } catch (error) {
          if (error instanceof JsonFault) {
            throw error
          }
          fail('invalid_json', 'parse')
        }
      }
    }
    fail('invalid_json', 'parse')
  }

  // 从当前游标解析一个 JSON 值，限制递归资源并冻结容器。
  const value = (depth: number): Json => {
    if (++nodes > budget.object_nodes || depth > budget.object_depth) {
      fail('object_limit', 'parse')
    }
    whitespace()
    const c = input[position]
    if (c === '"') {
      return string()
    }
    if (c === '{') {
      position++
      whitespace()
      const result: Record<string, Json> = {}
      const keys = new Set<string>()
      if (input[position] === '}') {
        position++
        return Object.freeze(result)
      }
      while (true) {
        whitespace()
        if (input[position] !== '"') {
          fail('invalid_json', 'parse')
        }
        const key = string()
        // 必须在写入对象前拒绝重复键；JSON.parse 会覆盖旧值，无法保留这一边界。
        if (keys.has(key)) {
          fail('duplicate_json_key', 'parse')
        }
        keys.add(key)
        whitespace()
        if (input[position++] !== ':') {
          fail('invalid_json', 'parse')
        }
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true })
        whitespace()
        const end = input[position++]
        if (end === '}') {
          return Object.freeze(result)
        }
        if (end !== ',') {
          fail('invalid_json', 'parse')
        }
      }
    }
    if (c === '[') {
      position++
      whitespace()
      const result: Json[] = []
      if (input[position] === ']') {
        position++
        return Object.freeze(result)
      }
      while (true) {
        result.push(value(depth + 1))
        whitespace()
        const end = input[position++]
        if (end === ']') {
          return Object.freeze(result)
        }
        if (end !== ',') {
          fail('invalid_json', 'parse')
        }
      }
    }
    for (const [literal, decoded] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const) {
      if (input.startsWith(literal, position)) {
        position += literal.length
        return decoded
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(position))
    if (!match) {
      fail('invalid_json', 'parse')
    }
    position += match[0].length
    const decoded = Number(match[0])
    if (!Number.isFinite(decoded)) {
      fail('invalid_json', 'parse')
    }
    if (Number.isInteger(decoded) && !Number.isSafeInteger(decoded)) {
      fail('json_number_precision', 'parse')
    }
    return decoded
  }

  const result = value(0)
  whitespace()
  if (position !== input.length) {
    fail('invalid_json', 'parse')
  }
  return result
}

// 使用受限预算解析 JSON，并将解析失败转换为 Check。
export function parseJson(bytes: Uint8Array | string, overrides: Partial<JsonBounds> = {}): Check<Json> {
  return attempt('parse', /* 合并有效预算后解析输入，交由外层包装解析失败。 */ () => parse(bytes, bounds(overrides)))
}

// 按 JSON Pointer 逐级读取自有字段；非法路径或缺失片段均拒绝。
export function pointer(value: unknown, path: string): unknown {
  if (path === '') {
    return value
  }
  if (!path.startsWith('/') || /~(?![01])/.test(path)) {
    fail('schema_unavailable', 'compile', 'missing_fragment')
  }
  for (const token of path.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      fail('schema_unavailable', 'compile', 'missing_fragment')
    }
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
