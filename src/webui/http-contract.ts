/** 固定管理只读 HTTP 路由及传输预算；复用共享操作/参数，不定义身份或查询实现。 */
import type { ManagementArguments } from '../mcp/management.js'
import type { ManagementReadOperation } from './read.js'
import { ReadError } from './reader.js'

export const MANAGEMENT_REPLY_BYTES = 524_288
export const MANAGEMENT_URL_BYTES = 32_768
export type ManagementReadRequest = {
  [K in ManagementReadOperation]: { operation: K; args: ManagementArguments[K] }
}[ManagementReadOperation]

/** 把非法传输参数归为固定失败，不回显输入。 */
function invalid(): never {
  throw new ReadError('invalid_response')
}

/** 路径引用与游标只能是有界非空文本，不把未提供目标默认为当前机器。 */
function reference(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 1024 ||
    [...value].some(
      /** 拒绝控制码，保持引用是可打印的不透明文本。 */
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) {
    invalid()
  }
}

/** 解码单个不透明引用，拒绝畸形百分号编码；编码斜杠仍作为引用内容。 */
function decode(value: string): string {
  let result: string
  try {
    result = decodeURIComponent(value)
  } catch {
    invalid()
  }
  reference(result)
  if (result === '.' || result === '..') {
    invalid()
  }
  return result
}

/** 查询参数只允许声明字段且每项出现一次，避免身份或操作字段被静默忽略。 */
function query(parameters: URLSearchParams, allowed: readonly string[]): void {
  for (const key of parameters.keys()) {
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1) {
      invalid()
    }
  }
}

/** 解析共享分页参数；HTTP 只做形状与预算检查，实际授权分页仍由服务执行。 */
function pagination(parameters: URLSearchParams): { limit?: number; cursor?: string } {
  const result: { limit?: number; cursor?: string } = {}
  if (parameters.has('limit')) {
    const value = parameters.get('limit')!
    if (!/^[1-9][0-9]{0,2}$/u.test(value) || Number(value) > 200) {
      invalid()
    }
    result.limit = Number(value)
  }
  if (parameters.has('cursor')) {
    const cursor = parameters.get('cursor')!
    reference(cursor)
    result.cursor = cursor
  }
  return result
}

/** 只识别六项 GET 资源；未知路径返回 null，已知路径的多余参数直接失败。 */
export function parseManagementReadPath(path: string): ManagementReadRequest | null {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    new TextEncoder().encode(path).byteLength > MANAGEMENT_URL_BYTES ||
    path.includes('#')
  ) {
    invalid()
  }
  const url = new URL(path, 'http://127.0.0.1')
  const parameters = url.searchParams
  if (url.pathname === '/admin/v1/status') {
    query(parameters, [])
    return { operation: 'status', args: {} }
  }
  if (url.pathname === '/admin/v1/devices') {
    query(parameters, ['cursor', 'limit', 'states'])
    const args: ManagementArguments['devices_list'] = pagination(parameters)
    if (parameters.has('states')) {
      const states = parameters.get('states')!.split(',')
      if (
        !states.length ||
        new Set(states).size !== states.length ||
        states.some(
          /** 过滤枚举仅按共享持久状态接收，不推导连接或认证。 */
          (state) => !['pending', 'offline', 'online', 'revoked'].includes(state)
        )
      ) {
        invalid()
      }
      args.states = states as NonNullable<typeof args.states>
    }
    return { operation: 'devices_list', args }
  }
  if (url.pathname === '/admin/v1/calls') {
    query(parameters, ['cursor', 'limit', 'machine_id', 'states'])
    const args: ManagementArguments['calls_list'] = pagination(parameters)
    if (parameters.has('machine_id')) {
      reference(parameters.get('machine_id')!)
      args.machine_id = parameters.get('machine_id')!
    }
    if (parameters.has('states')) {
      const states = parameters.get('states')!.split(',')
      if (
        !states.length ||
        new Set(states).size !== states.length ||
        states.some(
          /** 调用状态是账本枚举；未知值不成为筛选条件。 */
          (state) =>
            ![
              'created',
              'dispatching',
              'connector_accepted',
              'responded',
              'not_dispatched',
              'outcome_unknown'
            ].includes(state)
        )
      ) {
        invalid()
      }
      args.states = states as NonNullable<typeof args.states>
    }
    return { operation: 'calls_list', args }
  }
  const parts = /^\/admin\/v1\/devices\/([^/]+)(?:\/(providers|permissions)(?:\/([^/]+))?)?$/u.exec(url.pathname)
  if (!parts) {
    return null
  }
  const machine_id = decode(parts[1]!)
  if (!parts[2]) {
    query(parameters, [])
    return { operation: 'devices_get', args: { machine_id } }
  }
  if (parts[2] === 'permissions') {
    if (parts[3]) {
      return null
    }
    query(parameters, ['provider_id'])
    const args: ManagementArguments['permissions_get'] = { machine_id }
    if (parameters.has('provider_id')) {
      const provider_id = parameters.get('provider_id')!
      reference(provider_id)
      args.provider_id = provider_id
    }
    return { operation: 'permissions_get', args }
  }
  if (parts[3]) {
    query(parameters, [])
    return { operation: 'providers_get', args: { machine_id, provider_id: decode(parts[3]) } }
  }
  query(parameters, ['cursor', 'limit'])
  return { operation: 'providers_list', args: { machine_id, ...pagination(parameters) } }
}

/** 把共享参数编码到固定同源 GET 路径；未知字段或操作不得成为隐式身份/管理变更。 */
export function managementReadPath<K extends ManagementReadOperation>(
  operation: K,
  args: ManagementArguments[K]
): string {
  const allowed: Record<ManagementReadOperation, readonly string[]> = {
    status: [],
    devices_list: ['cursor', 'limit', 'states'],
    devices_get: ['machine_id'],
    providers_list: ['machine_id', 'cursor', 'limit'],
    providers_get: ['machine_id', 'provider_id'],
    permissions_get: ['machine_id', 'provider_id'],
    calls_list: ['cursor', 'limit', 'machine_id', 'states']
  }
  if (
    !Object.hasOwn(allowed, operation) ||
    !args ||
    typeof args !== 'object' ||
    Object.getPrototypeOf(args) !== Object.prototype
  ) {
    invalid()
  }
  if (Object.getOwnPropertySymbols(args).length) {
    invalid()
  }
  for (const key of Object.getOwnPropertyNames(args)) {
    const descriptor = Object.getOwnPropertyDescriptor(args, key)
    if (!allowed[operation].includes(key) || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      invalid()
    }
  }
  const values = args as Record<string, unknown>
  const parameters = new URLSearchParams()
  let path = '/admin/v1/status'
  if (operation === 'devices_list') {
    path = '/admin/v1/devices'
    if (values.states !== undefined) {
      if (
        !Array.isArray(values.states) ||
        Object.getPrototypeOf(values.states) !== Array.prototype ||
        !values.states.length ||
        values.states.length > 4 ||
        values.states.some(
          /** 状态只接受固定字符串，不能通过对象转换注入查询。 */
          (state) => typeof state !== 'string'
        )
      ) {
        invalid()
      }
      parameters.set('states', values.states.join(','))
    }
  } else if (operation === 'calls_list') {
    path = '/admin/v1/calls'
    if (values.machine_id !== undefined) {
      reference(values.machine_id)
      if (values.machine_id === '.' || values.machine_id === '..') {
        invalid()
      }
      parameters.set('machine_id', values.machine_id)
    }
    if (values.states !== undefined) {
      if (
        !Array.isArray(values.states) ||
        Object.getPrototypeOf(values.states) !== Array.prototype ||
        !values.states.length ||
        values.states.length > 6 ||
        values.states.some(
          /** 调用状态只接受固定枚举，不能通过对象转换注入查询。 */
          (state) => typeof state !== 'string'
        )
      ) {
        invalid()
      }
      parameters.set('states', values.states.join(','))
    }
  } else if (operation !== 'status') {
    reference(values.machine_id)
    if (values.machine_id === '.' || values.machine_id === '..') {
      invalid()
    }
    path = `/admin/v1/devices/${encodeURIComponent(values.machine_id)}`
    if (operation.startsWith('providers_')) {
      path += '/providers'
      if (operation === 'providers_get') {
        reference(values.provider_id)
        path += `/${encodeURIComponent(values.provider_id)}`
      }
    } else if (operation === 'permissions_get') {
      path += '/permissions'
      if (values.provider_id !== undefined) {
        reference(values.provider_id)
        parameters.set('provider_id', values.provider_id)
      }
    }
  }
  for (const field of ['cursor', 'limit']) {
    if (values[field] !== undefined) {
      if (
        (field === 'cursor' && typeof values[field] !== 'string') ||
        (field === 'limit' && typeof values[field] !== 'number')
      ) {
        invalid()
      }
      parameters.set(field, String(values[field]))
    }
  }
  const result = path + (parameters.size ? `?${parameters}` : '')
  if (parseManagementReadPath(result)?.operation !== operation) {
    invalid()
  }
  return result
}
