// 提供 Wire 错误、字段校验和有大小、深度、节点限制的 JSON 边界。
import { createHash } from 'node:crypto'
import { GatewayError } from '../contracts.js'
import { ContractFault, DEFAULT_LIMITS as JSON_LIMITS, parse as parseNativeJson } from '../native-contract/json.js'
import type { JsonObject } from './types.js'

export const LIMITS = Object.freeze({
  frame_bytes: 1_048_576,
  depth: 64,
  nodes: 100_000,
  object_bytes: 8_388_608,
  buffered_bytes: 20_971_520,
  dedup_entries: 4096,
  // 令牌设备范围（device_scope.machine_ids）的数组上限：形状/规模边界，注册表与 MCP 两面共用。
  scope_machines: 256
})

export class WireError extends GatewayError {
  readonly source: 'gateway' | 'transport'
  // 构造带固定名称、错误码和来源的 Wire 边界错误。
  constructor(code: string, source: 'gateway' | 'transport' = 'gateway') {
    super(code)
    this.name = 'WireError'
    this.source = source
  }
}

// 抛出结构化 Wire 错误，终止当前校验流程。
export function fail(code: string, source?: 'gateway' | 'transport'): never {
  throw new WireError(code, source)
}

// 仅接受普通 JSON 对象，拒绝数组、空值和自定义原型。
export function object(v: unknown): JsonObject {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) {
    fail('invalid_frame')
  }
  return v as JsonObject
}

// 要求必填字段齐全，并拒绝不在允许集合中的额外字段。
export function fields(v: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  if (
    required.some(/* 检测对象是否缺少任一必填字段。 */ (k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some(/* 检测对象是否包含未声明的字段。 */ (k) => !required.includes(k) && !optional.includes(k))
  ) {
    fail('invalid_frame_fields')
  }
}

// 校验长度受限且仅含安全 ASCII 字符的帧标识。
export function id(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v)) {
    fail('invalid_frame_id')
  }
}

// 校验安全整数；按参数要求非负或严格为正。
export function uint(v: unknown, positive = false): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < (positive ? 1 : 0)) {
    fail('invalid_integer')
  }
}

// 校验小写十六进制的 SHA-256 摘要格式。
export function sha(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) {
    fail('invalid_digest')
  }
}

// 校验非空文本、UTF-8 字节上限及 ASCII 控制字符边界。
export function text(v: unknown, max = 4096): asserts v is string {
  // Wire 文本标识在边界拒绝 ASCII 控制字符，不能让它们混入日志或路由上下文。
  // oxlint-disable no-control-regex
  if (typeof v !== 'string' || v.length === 0 || Buffer.byteLength(v) > max || /[\u0000-\u001f]/.test(v)) {
    fail('invalid_text')
  }
  // oxlint-enable no-control-regex
}

// 要求值属于指定字符串枚举，否则抛出协议错误。
export function oneOf<T extends string>(v: unknown, values: readonly T[]): asserts v is T {
  if (!values.includes(v as T)) {
    fail('invalid_enum')
  }
}

// 判断字符串是否不含未配对的 UTF-16 代理码元。
function wellFormed(v: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)
}

// 规范化不调用 getter/toJSON，计量完整 JSON；对象/大 bundle 独立于 frame 上限。
export function boundedJson(value: unknown, maxBytes: number = LIMITS.frame_bytes): string {
  let nodes = 0
  let bytes = 0
  const seen = new Set<object>()
  // 累计输出的 UTF-8 字节数，超限时拒绝序列化。
  const emit = (s: string) => {
    bytes += Buffer.byteLength(s)
    if (bytes > maxBytes) {
      fail('json_size_limit', 'transport')
    }
    return s
  }

  // 递归生成规范 JSON，同时限制节点、深度并拒绝循环和非数据属性。
  const visit = (v: unknown, depth: number): string => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) {
      fail('json_depth_limit', 'transport')
    }
    if (v === null || typeof v === 'boolean') {
      return emit(JSON.stringify(v))
    }
    if (typeof v === 'string') {
      if (!wellFormed(v)) {
        fail('invalid_unicode', 'transport')
      }
      return emit(JSON.stringify(v))
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      return emit(JSON.stringify(v))
    }
    if (v === null || typeof v !== 'object' || seen.has(v)) {
      fail('invalid_json', 'transport')
    }
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) {
      fail('invalid_json', 'transport')
    }
    const ds = Object.getOwnPropertyDescriptors(v)
    if (
      Object.getOwnPropertySymbols(v).length ||
      Object.values(ds).some(/* 检测属性描述符是否包含 getter 或 setter。 */ (d) => !('value' in d))
    ) {
      fail('invalid_json', 'transport')
    }
    seen.add(v)
    try {
      if (Array.isArray(v)) {
        if (v.length > LIMITS.nodes || Object.keys(v).length !== v.length) {
          fail('invalid_json', 'transport')
        }
        const entries: string[] = []
        for (let i = 0; i < v.length; i++) {
          if (!Object.hasOwn(v, i)) {
            fail('invalid_json', 'transport')
          }
          entries.push(visit(ds[String(i)]!.value, depth + 1))
        }
        emit('[' + ','.repeat(Math.max(0, entries.length - 1)) + ']')
        return '[' + entries.join(',') + ']'
      }
      const entries = Object.keys(v)
        .sort()
        .map(
          /* 按已排序的键序列化属性名和值，并校验属性名的 Unicode 完整性。 */ (k) => {
            if (!wellFormed(k)) {
              fail('invalid_unicode', 'transport')
            }
            return emit(JSON.stringify(k) + ':') + visit(ds[k]!.value, depth + 1)
          }
        )
      emit('{' + ','.repeat(Math.max(0, entries.length - 1)) + '}')
      return '{' + entries.join(',') + '}'
    } finally {
      seen.delete(v)
    }
  }
  return visit(value, 0)
}

// 在字节、深度和节点限制内解析 JSON，将原生解析错误映射为 Wire 错误。
export function parseJson(input: string | Uint8Array, maxBytes: number = LIMITS.frame_bytes): unknown {
  if (!(typeof input === 'string' || input instanceof Uint8Array)) {
    fail('invalid_frame', 'transport')
  }
  if ((typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength) > maxBytes) {
    fail('frame_limit', 'transport')
  }
  let raw: string
  try {
    raw = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
  } catch {
    fail('invalid_utf8', 'transport')
  }
  if (!wellFormed(raw)) {
    fail('invalid_unicode', 'transport')
  }
  let value: unknown
  try {
    value = parseNativeJson(raw, {
      ...JSON_LIMITS,
      object_bytes: maxBytes,
      object_depth: LIMITS.depth,
      object_nodes: LIMITS.nodes
    })
  } catch (error) {
    if (error instanceof ContractFault) {
      const { code, reason } = error.failure
      if (code === 'object_limit') {
        fail('json_depth_limit', 'transport')
      }
      if (reason === 'unpaired_surrogate') {
        fail('invalid_unicode', 'transport')
      }
      if (code === 'duplicate_json_key') {
        fail(code, 'transport')
      }
      // 在解析阶段提前拒绝精度损失，保留已有 Wire 整数错误接口。
      if (code === 'json_number_precision') {
        fail('invalid_integer', 'transport')
      }
    }
    fail('invalid_frame_json', 'transport')
  }
  boundedJson(value, maxBytes)
  return value
}

// 对文本或字节计算小写十六进制 SHA-256 摘要。
export function hash(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex')
}
