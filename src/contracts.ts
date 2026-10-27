// 定义基础调用目标、策略和错误，并提供有界 JSON 规范化与摘要，供路由和存储共享。
import { createHash } from 'node:crypto'

export class GatewayError extends Error {
  // 保留可判定的网关错误码，并设置独立错误类型供上层识别。
  constructor(public readonly code: string) {
    super(code)
    this.name = 'GatewayError'
  }
}

export type Target =
  | { machine_id: string; profile: 'session'; session: string }
  | { machine_id: string; profile: 'host'; session?: never }

export type NativeRequest = { method: string; params?: unknown; [key: string]: unknown }

export type CallState =
  | 'created'
  | 'dispatching'
  | 'connector_accepted'
  | 'responded'
  | 'not_dispatched'
  | 'outcome_unknown'

export type Policy = { machines: string[]; sessions: string[]; methods: string[]; host: boolean }

// 要求显式机器与 session/host profile；缺失会话或混用 profile 字段时拒绝。
export function validateTarget(value: Target): void {
  if (!value || typeof value.machine_id !== 'string' || !value.machine_id.trim()) {
    throw new GatewayError('invalid_target')
  }
  if (value.profile === 'session') {
    if (typeof value.session !== 'string' || !value.session.trim()) {
      throw new GatewayError('session_required')
    }
  } else if (value.profile !== 'host' || value.session !== undefined) {
    throw new GatewayError('invalid_profile')
  }
}

// 校验原生方法与保留字段，再通过规范化拒绝无法安全快照的请求。
export function validateRequest(request: NativeRequest): void {
  if (!request || typeof request.method !== 'string' || !request.method.trim()) {
    throw new GatewayError('invalid_request')
  }
  if ('auth' in request || 'id' in request) {
    throw new GatewayError('reserved_request_field')
  }
  canonical(request)
}

// 按键排序输出确定性 JSON；拒绝循环、访问器和非 JSON 值，并限制深度、节点数及字节数。
export function canonical(value: unknown): string {
  // 只跟踪当前递归链：共享子对象可重复编码，真正的循环引用必须拒绝。
  const ancestors = new Set<object>()
  let nodes = 0
  let bytes = 0
  // 累计输出字节预算，超限时中止规范化；否则返回原片段。
  const emit = (text: string): string => {
    bytes += Buffer.byteLength(text)
    if (bytes > 1_048_576) {
      throw new GatewayError('json_limit')
    }
    return text
  }
  // 递归编码当前值并维护祖先链；共享引用可重用，循环引用和不安全对象会失败。
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 64) {
      throw new GatewayError('json_limit')
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return emit(JSON.stringify(item))
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return emit(JSON.stringify(item))
    }
    if (typeof item !== 'object' || item === null || ancestors.has(item)) {
      throw new GatewayError('invalid_json')
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) {
      throw new GatewayError('invalid_json')
    }
    if (Object.getOwnPropertySymbols(item).length) {
      throw new GatewayError('invalid_json')
    }
    ancestors.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      // 先检查数据描述符，再读取内容，避免规范化触发 getter。
      if (
        Object.values(descriptors).some(/* 检出访问器描述符，避免读取对象时执行用户 getter。 */ (d) => !('value' in d))
      ) {
        throw new GatewayError('invalid_json')
      }
      if (Array.isArray(item)) {
        if (item.length > 100_000 || Object.keys(item).length !== item.length) {
          throw new GatewayError('invalid_json')
        }
        const values: string[] = []
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) {
            throw new GatewayError('invalid_json')
          }
          values.push(visit(item[i], depth + 1))
        }
        emit('[' + ','.repeat(Math.max(0, values.length - 1)) + ']')
        return '[' + values.join(',') + ']'
      }
      const entries = Object.keys(item)
        .sort()
        .map(
          /* 将已排序的键与其数据属性编码成确定性的成员片段。 */ (key) =>
            emit(JSON.stringify(key) + ':') + visit(descriptors[key]!.value, depth + 1)
        )
      emit('{' + ','.repeat(Math.max(0, entries.length - 1)) + '}')
      return '{' + entries.join(',') + '}'
    } finally {
      ancestors.delete(item)
    }
  }
  return visit(value, 0)
}

// 返回输入文本的 SHA-256 十六进制摘要，供凭据散列和请求去重使用。
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
