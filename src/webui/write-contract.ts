// 浏览器管理操作的严格边界；共享参数/DTO沿用management.ts，不携带身份或秘密。
import type { ProviderKind } from '../wire/types.js'
import type {
  ConfirmationView,
  ManagementArguments,
  ManagementIntent,
  ManagementReply,
  OperationReceipt
} from '../mcp/management.js'

export type DeviceManagementIntent =
  | { action: 'device_rename'; machine_id: string; name: string }
  | { action: 'device_disconnect' | 'device_revoke'; machine_id: string }
  | {
      action: 'provider_disable'
      machine_id: string
      provider_id: string
      kind: ProviderKind
      expected_binding_revision: number
    }
/** 浏览器可达的确认摘要 = 设备摘要 + 配对创建/认领批准；provider_enable 与 pairing_cancel 仍不进浏览器。 */
type BrowserSummary = Exclude<ConfirmationView['summary'], { action: 'provider_enable' | 'pairing_cancel' }>
export type BrowserReceipt = OperationReceipt
export type DeviceWriteOperation = 'devices_rename' | 'devices_disconnect' | 'devices_revoke' | 'providers_disable'
export type ManagementClientOperation =
  | 'history_open'
  | 'write_state_get'
  | 'pairings_get'
  | 'operations_get'
  | 'confirmations_create'
  | 'confirmations_confirm'
  | DeviceWriteOperation
  | PairingWriteOperation
export type PairingWriteOperation = 'pairings_create' | 'pairings_claim_approve'
/** 浏览器配对意图保持扁平形状，流程层再组装为共享 ManagementIntent。 */
export type PairingManagementIntent =
  | { action: 'pairing_create'; name: string; policy_ref: string; labels: readonly string[] }
  | { action: 'pairing_create'; machine_id: string; policy_ref: string }
  | {
      action: 'pairing_claim_approve'
      machine_id: string
      pairing_id: string
      claim_id: string
      user_code: string
    }
export type ManagementClientProblem =
  | 'invalid_request'
  | 'invalid_response'
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'busy'
  | 'unavailable'
  | 'outcome_unconfirmed'
  | 'aborted'
export interface ManagementWriteTransport {
  /** 每次只提交一次指定请求，取消停止等待，不重发或声明业务回滚。 */
  execute<K extends ManagementClientOperation>(
    name: K,
    args: ManagementArguments[K],
    signal: AbortSignal
  ): Promise<ManagementReply[K]>
}
/** 固定问题类型不会包含原响应、URL、身份或底层异常正文。 */
export class ManagementClientError extends Error {
  /** request_started仅用于保守保留原操作关联，不代表已提交或未提交。 */
  constructor(
    readonly problem: ManagementClientProblem,
    readonly request_started = false
  ) {
    super(problem)
  }
}
export const MANAGEMENT_WRITE_REQUEST_BYTES = 16_384
export const MANAGEMENT_WRITE_REPLY_BYTES = 32_768
const id = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const digest = /^[a-f0-9]{64}$/
const reasons = ['administrator_request', 'maintenance', 'device_lost']
const actions = [
  'device_rename',
  'device_disconnect',
  'device_revoke',
  'provider_disable',
  'pairing_create',
  'pairing_claim_approve'
]
const fields = ['request_id', 'history_epoch', 'confirmation_id', 'recovery_generation', 'expected_revision', 'reason']

/** 只抛固定边界错误，绝不附上收到的正文。 */
function invalid(problem: 'invalid_request' | 'invalid_response'): never {
  throw new ManagementClientError(problem)
}
/** 精确普通数据属性，拒绝未知字段、getter、符号与隐形属性。 */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  problem: 'invalid_request' | 'invalid_response'
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  ) {
    invalid(problem)
  }
  for (const field of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (
      (!required.includes(field) && !optional.includes(field)) ||
      !descriptor?.enumerable ||
      !('value' in descriptor)
    ) {
      invalid(problem)
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      invalid(problem)
    }
  }
}
/** 标识及摘要都必须是有界非秘密引用，不能用路径或URL选择资源。 */
function identifier(value: unknown, problem: 'invalid_request' | 'invalid_response', hash = false): void {
  if (typeof value !== 'string' || !(hash ? digest : id).test(value)) {
    invalid(problem)
  }
}
/** 设备revision不接受分数、负数、零或丢失精度的数值。 */
function revision(value: unknown, problem: 'invalid_request' | 'invalid_response', nullable = false): void {
  if (!(nullable && value === null) && (!Number.isSafeInteger(value) || Number(value) < 1)) {
    invalid(problem)
  }
}
/** 时间只用于展示原服务时点，不作为浏览器自行建立的授权期限。 */
function time(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    invalid('invalid_response')
  }
}
/** 只接收允许的枚举，未知状态不得自动变成成功。 */
function choice(
  value: unknown,
  allowed: readonly unknown[],
  problem: 'invalid_request' | 'invalid_response' = 'invalid_response'
): void {
  if (!allowed.includes(value)) {
    invalid(problem)
  }
}
/** 设备名与Store当前规范一致，不在确认之后暗中改名或规范化。 */
function name(value: unknown, problem: 'invalid_request' | 'invalid_response'): void {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value)) {
    invalid(problem)
  }
}
/** 数组有界且无稀疏槽、附加属性或getter。 */
function array(value: unknown, limit: number): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(value).length !== value.length
  ) {
    invalid('invalid_response')
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      invalid('invalid_response')
    }
  }
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    invalid('invalid_response')
  }
}
/** 验证浏览器明确意图；启用证明与offline/revoked重置不在此入口扩展。 */
export function checkDeviceIntent(value: unknown): DeviceManagementIntent {
  record(
    value,
    ['action'],
    ['machine_id', 'name', 'provider_id', 'kind', 'expected_binding_revision'],
    'invalid_request'
  )
  const action = value.action
  const targetKeys =
    action === 'provider_disable'
      ? ['machine_id', 'provider_id', 'kind', 'expected_binding_revision']
      : action === 'device_rename'
        ? ['machine_id', 'name']
        : ['machine_id']
  record(value, ['action', ...targetKeys], [], 'invalid_request')
  const { action: _action, name: renamed, expected_binding_revision, ...target } = value
  const operation =
    action === 'device_rename'
      ? { action, target, name: renamed }
      : action === 'device_disconnect'
        ? { action, target, expected_connection_epoch: 'validation' }
        : action === 'provider_disable'
          ? { action, target, expected_binding_revision }
          : { action, target }
  summary(
    { ...operation, recovery_generation: 'validation', expected_revision: 0, reason: 'administrator_request' },
    'invalid_request'
  )
  return JSON.parse(JSON.stringify(value)) as DeviceManagementIntent
}
/** 验证浏览器配对意图；认领秘密、管理员身份与批准标记永远不属于意图。 */
export function checkPairingIntent(value: unknown): PairingManagementIntent {
  record(
    value,
    ['action'],
    ['machine_id', 'name', 'policy_ref', 'labels', 'pairing_id', 'claim_id', 'user_code'],
    'invalid_request'
  )
  const action = (value as { action: unknown }).action
  if (action === 'pairing_create') {
    const hasName = Object.hasOwn(value as object, 'name')
    const keys = hasName ? ['action', 'name', 'policy_ref', 'labels'] : ['action', 'machine_id', 'policy_ref']
    record(value, keys, [], 'invalid_request')
    const intent = value as unknown as PairingManagementIntent
    const operation: ManagementIntent =
      intent.action === 'pairing_create' && 'name' in intent
        ? {
            action: 'pairing_create',
            target: { name: intent.name, policy_ref: intent.policy_ref, labels: intent.labels }
          }
        : {
            action: 'pairing_create',
            target: {
              machine_id: (intent as { machine_id: string }).machine_id,
              policy_ref: (intent as { policy_ref: string }).policy_ref
            }
          }
    summary(
      { ...operation, recovery_generation: 'validation', expected_revision: 0, reason: 'administrator_request' },
      'invalid_request'
    )
    return JSON.parse(JSON.stringify(value)) as PairingManagementIntent
  }
  if (action === 'pairing_claim_approve') {
    record(value, ['action', 'machine_id', 'pairing_id', 'claim_id', 'user_code'], [], 'invalid_request')
    const intent = value as unknown as PairingManagementIntent
    if (intent.action !== 'pairing_claim_approve') {
      invalid('invalid_request')
    }
    summary(
      {
        action: 'pairing_claim_approve',
        target: {
          machine_id: intent.machine_id,
          pairing_id: intent.pairing_id,
          claim_id: intent.claim_id,
          user_code: intent.user_code
        },
        recovery_generation: 'validation',
        expected_revision: 0,
        reason: 'administrator_request'
      },
      'invalid_request'
    )
    return JSON.parse(JSON.stringify(value)) as PairingManagementIntent
  }
  invalid('invalid_request')
}
/** 配对摘要只接受申请与认领批准两种目标形状；政策引用与标签都不是秘密，但必须与 Store 规范一致。 */
function pairingSummary(
  v: Record<string, unknown> & { target: unknown },
  problem: 'invalid_request' | 'invalid_response'
) {
  const target = v.target
  if (v.action === 'pairing_create') {
    if (target && typeof target === 'object' && 'name' in target) {
      record(target, ['name', 'policy_ref', 'labels'], [], problem)
      const t = target as { name: unknown; policy_ref: unknown; labels: unknown }
      name(t.name, problem)
      identifier(t.policy_ref, problem)
      if (!Array.isArray(t.labels) || t.labels.length > 16 || new Set(t.labels).size !== t.labels.length) {
        invalid(problem)
      }
      for (const label of t.labels) {
        identifier(label, problem)
      }
    } else {
      record(target, ['machine_id', 'policy_ref'], [], problem)
      const t = target as { machine_id: unknown; policy_ref: unknown }
      identifier(t.machine_id, problem)
      identifier(t.policy_ref, problem)
    }
  } else {
    record(target, ['machine_id', 'pairing_id', 'claim_id', 'user_code'], [], problem)
    const t = target as { machine_id: unknown; pairing_id: unknown; claim_id: unknown; user_code: unknown }
    identifier(t.machine_id, problem)
    identifier(t.pairing_id, problem)
    identifier(t.claim_id, problem)
    if (typeof t.user_code !== 'string' || !/^[A-Z0-9]{4,16}$/.test(t.user_code)) {
      invalid(problem)
    }
  }
  return v
}
/** 当前确认摘要使用原共享类型，明确绑定目标、动作、恢复代次与适用epoch。 */
function summary(value: unknown, problem: 'invalid_request' | 'invalid_response') {
  const v = value as BrowserSummary
  record(
    v,
    ['action', 'target', 'recovery_generation', 'expected_revision', 'reason'],
    ['name', 'expected_connection_epoch', 'expected_binding_revision'],
    problem
  )
  const extra =
    v?.action === 'device_rename'
      ? ['name']
      : v?.action === 'device_disconnect'
        ? ['expected_connection_epoch']
        : v?.action === 'provider_disable'
          ? ['expected_binding_revision']
          : []
  record(v, ['action', 'target', 'recovery_generation', 'expected_revision', 'reason', ...extra], [], problem)
  choice(v.action, actions, problem)
  identifier(v.recovery_generation, problem)
  if (!Number.isSafeInteger(v.expected_revision) || v.expected_revision < 0) {
    invalid(problem)
  }
  choice(v.reason, reasons, problem)
  if (v.action === 'pairing_create' || v.action === 'pairing_claim_approve') {
    return pairingSummary(v as unknown as Record<string, unknown> & { target: unknown }, problem)
  }
  const target = v.target
  record(target, ['machine_id', ...(v.action === 'provider_disable' ? ['provider_id', 'kind'] : [])], [], problem)
  identifier(v.target.machine_id, problem)
  if (v.action === 'provider_disable') {
    identifier(v.target.provider_id, problem)
    choice(v.target.kind, ['luvus', 'herdr'], problem)
    revision(v.expected_binding_revision, problem)
  }
  if (v.action === 'device_rename') {
    name(v.name, problem)
  }
  if (v.action === 'device_disconnect') {
    identifier(v.expected_connection_epoch, problem)
  }
  return v
}
/** 固定位置的值组成摘要比较键，不依赖对象键序或客户端哈希生成。 */
export function managementSummaryKey(value: ConfirmationView['summary']): string {
  const validated = summary(value, 'invalid_response')
  return JSON.stringify([
    validated.action,
    Object.entries(validated.target as Record<string, unknown>).sort(
      /** 固定目标字段次序，不依赖JSON键顺序。 */ ([a], [b]) => a.localeCompare(b)
    ),
    validated.recovery_generation,
    validated.expected_revision,
    validated.reason,
    validated.action === 'device_rename' ? validated.name : null,
    validated.action === 'device_disconnect' ? validated.expected_connection_epoch : null,
    validated.action === 'provider_disable' ? validated.expected_binding_revision : null
  ])
}
/** 输入先于fetch做精确字段检查；身份、approved、secret和额外目标均拒绝。 */
export function managementWriteBody<K extends ManagementClientOperation>(
  operation: K,
  value: ManagementArguments[K]
): string {
  if (
    ![
      'history_open',
      'write_state_get',
      'pairings_get',
      'operations_get',
      'confirmations_create',
      'confirmations_confirm',
      'devices_rename',
      'devices_disconnect',
      'devices_revoke',
      'providers_disable',
      'pairings_create',
      'pairings_claim_approve'
    ].includes(operation)
  ) {
    invalid('invalid_request')
  }
  const args = value as unknown as Record<string, unknown>
  if (operation === 'history_open') {
    record(args, [], [], 'invalid_request')
  } else if (operation === 'write_state_get') {
    record(args, ['machine_id'], ['provider_id'], 'invalid_request')
    identifier(args.machine_id, 'invalid_request')
    if (args.provider_id !== undefined) {
      identifier(args.provider_id, 'invalid_request')
    }
  } else if (operation === 'operations_get') {
    record(args, ['request_id', 'history_epoch', 'recovery_generation'], [], 'invalid_request')
    for (const item of Object.values(args)) {
      identifier(item, 'invalid_request')
    }
  } else if (operation === 'pairings_get') {
    record(args, ['machine_id', 'pairing_id'], [], 'invalid_request')
    identifier(args.machine_id, 'invalid_request')
    identifier(args.pairing_id, 'invalid_request')
  } else if (operation === 'confirmations_create') {
    record(
      args,
      ['request_id', 'history_epoch', 'action', 'target', 'recovery_generation', 'expected_revision', 'reason'],
      ['name', 'expected_connection_epoch', 'expected_binding_revision'],
      'invalid_request'
    )
    const { request_id, history_epoch, ...intent } = args
    identifier(request_id, 'invalid_request')
    identifier(history_epoch, 'invalid_request')
    summary(intent, 'invalid_request')
  } else {
    record(
      args,
      fields,
      [
        'operation_digest',
        'machine_id',
        'name',
        'provider_id',
        'kind',
        'expected_binding_revision',
        'expected_connection_epoch',
        'policy_ref',
        'labels',
        'pairing_id',
        'claim_id',
        'user_code'
      ],
      'invalid_request'
    )
    for (const field of ['request_id', 'history_epoch', 'confirmation_id', 'recovery_generation']) {
      identifier(args[field], 'invalid_request')
    }
    if (!Number.isSafeInteger(args.expected_revision) || Number(args.expected_revision) < 0) {
      invalid('invalid_request')
    }
    choice(args.reason, reasons, 'invalid_request')
    if (operation === 'confirmations_confirm') {
      record(args, [...fields, 'operation_digest'], [], 'invalid_request')
      identifier(args.operation_digest, 'invalid_request', true)
    } else {
      const target = Object.fromEntries(
        Object.entries(args).filter(/** 只剥离已验证的写范围字段。 */ ([key]) => !fields.includes(key))
      )
      const action =
        operation === 'devices_rename'
          ? 'device_rename'
          : operation === 'devices_disconnect'
            ? 'device_disconnect'
            : operation === 'devices_revoke'
              ? 'device_revoke'
              : operation === 'pairings_create'
                ? 'pairing_create'
                : operation === 'pairings_claim_approve'
                  ? 'pairing_claim_approve'
                  : 'provider_disable'
      const { name: renamed, expected_connection_epoch, expected_binding_revision, ...resource } = target
      const intent =
        action === 'pairing_create' || action === 'pairing_claim_approve'
          ? { action, target }
          : action === 'device_rename'
            ? { action, target: resource, name: renamed }
            : action === 'device_disconnect'
              ? { action, target: resource, expected_connection_epoch }
              : action === 'provider_disable'
                ? { action, target: resource, expected_binding_revision }
                : { action, target: resource }
      summary(
        {
          ...intent,
          recovery_generation: args.recovery_generation,
          expected_revision: args.expected_revision,
          reason: args.reason
        },
        'invalid_request'
      )
    }
  }

  const body = JSON.stringify(args)
  if (new TextEncoder().encode(body).byteLength > MANAGEMENT_WRITE_REQUEST_BYTES) {
    invalid('invalid_request')
  }
  return body
}
/** 严格确认视图可进入有限状态机；其中不允许凭据或任意原生正文。 */
function confirmation(value: unknown): ConfirmationView {
  const v = value as ConfirmationView
  record(
    v,
    ['confirmation_id', 'state', 'operation_digest', 'summary', 'expires_at'],
    ['affected_providers'],
    'invalid_response'
  )
  identifier(v.confirmation_id, 'invalid_response')
  identifier(v.operation_digest, 'invalid_response', true)
  time(v.expires_at)
  choice(v.state, ['pending', 'confirmed', 'consumed', 'expired'])
  summary(v.summary, 'invalid_response')
  if (v.affected_providers !== undefined) {
    array(v.affected_providers, 200)
    for (const provider of v.affected_providers) {
      record(provider, ['provider_id', 'kind', 'binding_revision', 'enabled'], [], 'invalid_response')
      identifier(provider.provider_id, 'invalid_response')
      choice(provider.kind, ['luvus', 'herdr'])
      revision(provider.binding_revision, 'invalid_response')
      if (typeof provider.enabled !== 'boolean') {
        invalid('invalid_response')
      }
    }
  }
  return v
}
/** 真实确认仍须对应用户已看到的影响集合与原截止，不接受确认中扩展目标或续期。 */
export function managementConfirmationKey(value: ConfirmationView): string {
  const validated = confirmation(value)
  const providers = (validated.affected_providers ?? []).map(
    /** 固定字段次序，与响应对象键序无关；集合排序不改变确认内容。 */ (provider) =>
      JSON.stringify([provider.provider_id, provider.kind, provider.binding_revision, provider.enabled])
  )
  return JSON.stringify([
    validated.confirmation_id,
    validated.operation_digest,
    managementSummaryKey(validated.summary),
    validated.expires_at,
    providers.sort()
  ])
}
/** 只投影已接线管理动作的回执，精确区分持久提交、未知和备份历史。 */
function receipt(value: unknown): BrowserReceipt {
  const v = value as BrowserReceipt & {
    machine_id?: unknown
    pairing_id?: unknown
    claim_id?: unknown
    status?: unknown
    expires_at?: unknown
    requires_local_issuance?: unknown
  }
  const pairingExtras =
    v.action === 'pairing_create'
      ? ['machine_id', 'pairing_id', 'status', 'expires_at', 'requires_local_issuance']
      : v.action === 'pairing_claim_approve'
        ? ['machine_id', 'pairing_id', 'claim_id', 'status']
        : []
  record(
    v,
    [
      'request_id',
      'history_epoch',
      'recovery_generation',
      'operation_digest',
      'action',
      'target',
      'operation_state',
      'new_revision',
      'new_binding_revision',
      'observed_at',
      'audit_event_ids',
      'evidence',
      'effects'
    ],
    pairingExtras,
    'invalid_response'
  )
  if (pairingExtras.length) {
    for (const field of pairingExtras) {
      if (!Object.hasOwn(v, field)) {
        invalid('invalid_response')
      }
    }
    identifier(v.machine_id, 'invalid_response')
    identifier(v.pairing_id, 'invalid_response')
    if (v.machine_id !== (v.target as { machine_id: string }).machine_id) {
      invalid('invalid_response')
    }
    if (v.action === 'pairing_create') {
      choice(v.status, ['pending'])
      time(v.expires_at as number)
      if (typeof v.requires_local_issuance !== 'boolean') {
        invalid('invalid_response')
      }
    } else {
      identifier(v.claim_id, 'invalid_response')
      choice(v.status, ['approved'])
    }
  }
  for (const field of ['request_id', 'history_epoch', 'recovery_generation'] as const) {
    identifier(v[field], 'invalid_response')
  }
  identifier(v.operation_digest, 'invalid_response', true)
  choice(v.action, actions)
  record(v.target, ['machine_id'], v.action === 'provider_disable' ? ['provider_id'] : [], 'invalid_response')
  identifier((v.target as { machine_id: string }).machine_id, 'invalid_response')
  if (v.action === 'provider_disable') {
    identifier((v.target as { provider_id: string }).provider_id, 'invalid_response')
  }
  choice(v.operation_state, ['committed', 'not_committed', 'outcome_unknown'])
  revision(v.new_revision, 'invalid_response', true)
  revision(v.new_binding_revision, 'invalid_response', true)
  if (v.action !== 'provider_disable' && v.new_binding_revision !== null) {
    invalid('invalid_response')
  }
  time(v.observed_at)
  array(v.audit_event_ids, 16)
  for (const event of v.audit_event_ids) {
    identifier(event, 'invalid_response')
  }
  choice(v.evidence, ['current_durable', 'backup_history'])
  record(v.effects, ['persistent_authorization', 'channel', 'provider', 'native_work'], [], 'invalid_response')
  choice(v.effects.persistent_authorization, ['unchanged', 'revoked', 'unconfirmed'])
  choice(v.effects.channel, ['unchanged', 'disconnected', 'unconfirmed'])
  choice(v.effects.provider, ['unchanged', 'disabled', 'unconfirmed'])
  choice(v.effects.native_work, ['may_continue'])
  if (
    v.operation_state === 'committed' &&
    (v.new_revision === null ||
      (v.action === 'provider_disable'
        ? v.effects.provider !== 'disabled' || v.new_binding_revision === null
        : v.effects.provider !== 'unchanged') ||
      v.audit_event_ids.length === 0 ||
      v.effects.persistent_authorization !== (v.action === 'device_revoke' ? 'revoked' : 'unchanged'))
  ) {
    invalid('invalid_response')
  }
  return v
}
/** 输出必须符合操作和原请求关联；深拷贝后不把可变服务对象留给页面。 */
export function checkManagementWriteReply<K extends ManagementClientOperation>(
  operation: K,
  value: unknown,
  args: ManagementArguments[K]
): ManagementReply[K] {
  const input = args as unknown as Record<string, unknown>
  if (operation === 'history_open') {
    record(value, ['history_epoch', 'recovery_generation', 'accept_new_until'], [], 'invalid_response')
    identifier(value.history_epoch, 'invalid_response')
    identifier(value.recovery_generation, 'invalid_response')
    time(value.accept_new_until)
  } else if (operation === 'write_state_get') {
    record(
      value,
      ['target', 'resource_revision', 'recovery_generation', 'connection_epoch', 'binding_revision'],
      [],
      'invalid_response'
    )
    record(value.target, ['machine_id'], input.provider_id !== undefined ? ['provider_id'] : [], 'invalid_response')
    if (value.target.machine_id !== input.machine_id || value.target.provider_id !== input.provider_id) {
      invalid('invalid_response')
    }
    revision(value.resource_revision, 'invalid_response')
    revision(value.binding_revision, 'invalid_response', true)
    if ((input.provider_id === undefined) !== (value.binding_revision === null)) {
      invalid('invalid_response')
    }
    identifier(value.recovery_generation, 'invalid_response')
    if (value.connection_epoch !== null) {
      identifier(value.connection_epoch, 'invalid_response')
    }
  } else if (operation === 'confirmations_create' || operation === 'confirmations_confirm') {
    const v = confirmation(value)
    if (
      v.summary.recovery_generation !== input.recovery_generation ||
      v.summary.expected_revision !== input.expected_revision ||
      v.summary.reason !== input.reason
    ) {
      invalid('invalid_response')
    }
    if (operation === 'confirmations_create') {
      const { request_id: _request, history_epoch: _history, ...expected } = input
      if (managementSummaryKey(v.summary) !== managementSummaryKey(expected as ConfirmationView['summary'])) {
        invalid('invalid_response')
      }
    } else if (v.confirmation_id !== input.confirmation_id || v.operation_digest !== input.operation_digest) {
      invalid('invalid_response')
    }
  } else if (operation === 'pairings_get') {
    const v = value as ManagementReply['pairings_get']
    record(
      v,
      ['machine_id', 'pairing_id', 'status', 'expires_at', 'issuance', 'requires_local_issuance'],
      ['claim'],
      'invalid_response'
    )
    if (v.machine_id !== input.machine_id || v.pairing_id !== input.pairing_id) {
      invalid('invalid_response')
    }
    choice(v.status, ['pending', 'paired', 'cancelled', 'expired', 'failed'])
    choice(v.issuance, ['issued', 'unissued'])
    if (v.requires_local_issuance !== false) {
      invalid('invalid_response')
    }
    time(v.expires_at)
    if (v.claim !== undefined) {
      record(v.claim, ['claim_id', 'user_code', 'status', 'expires_at'], ['activation'], 'invalid_response')
      identifier(v.claim.claim_id, 'invalid_response')
      if (!/^[A-Z0-9]{4,16}$/.test(v.claim.user_code)) {
        invalid('invalid_response')
      }
      choice(v.claim.status, ['pending', 'approved', 'delivered', 'activated', 'failed', 'cancelled'])
      if (v.claim.activation !== undefined && (v.claim.activation !== 'configured' || v.claim.status !== 'activated')) {
        invalid('invalid_response')
      }
      time(v.claim.expires_at)
    }
  } else {
    const v = receipt(value)
    if (
      v.request_id !== input.request_id ||
      v.history_epoch !== input.history_epoch ||
      v.recovery_generation !== input.recovery_generation
    ) {
      invalid('invalid_response')
    }
    if (operation !== 'operations_get') {
      const expected =
        operation === 'devices_rename'
          ? 'device_rename'
          : operation === 'devices_disconnect'
            ? 'device_disconnect'
            : operation === 'devices_revoke'
              ? 'device_revoke'
              : operation === 'pairings_create'
                ? 'pairing_create'
                : operation === 'pairings_claim_approve'
                  ? 'pairing_claim_approve'
                  : 'provider_disable'
      if (
        v.action !== expected ||
        ('machine_id' in input && (v.target as { machine_id: string }).machine_id !== input.machine_id) ||
        (v.target as { provider_id?: string }).provider_id !== input.provider_id ||
        (operation === 'pairings_claim_approve' &&
          ((v as { pairing_id?: string }).pairing_id !== input.pairing_id ||
            (v as { claim_id?: string }).claim_id !== input.claim_id))
      ) {
        invalid('invalid_response')
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MANAGEMENT_WRITE_REPLY_BYTES) {
    invalid('invalid_response')
  }
  return JSON.parse(JSON.stringify(value)) as ManagementReply[K]
}
