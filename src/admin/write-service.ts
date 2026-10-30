// 为共享管理服务提供设备写入闭环；身份、生产会话、秘密交付及当前资源事实均复用受信宿主。
import { canonical, digest, GatewayError } from '../contracts.js'
import type { Store } from '../store.js'
import type { ManagementActor, ManagementAuthority } from '../storage/management.js'
import type {
  AdminContext,
  Administrator,
  ConfirmationDraft,
  GatewayIdentitySource,
  GatewayManagementService,
  ManagementArguments,
  ManagementGrant,
  ManagementIntent,
  ManagementOperation,
  ManagementReply,
  ManagementWrite,
  ResourceTarget
} from '../mcp/management.js'
import { PROVIDER_KINDS } from '../wire/types.js'
import type { ProviderKind } from '../wire/types.js'

export type ManagementWriteOptions = {
  store: Store
  identities: GatewayIdentitySource
  /** 组合原管理六读服务；缺省不假造读取或生产管理员。 */
  reads?: GatewayManagementService
  /** 复用同一个实际 Gateway.refresh，逐连接复验后只关闭失效 epoch。 */
  transport?: { refresh(): void }
  /** 当前受保护策略引用验证；仅记录申请，不授予 caller/设备/provider 权限。 */
  pairingPolicy?(policyRef: string, admin: Administrator, machine?: string): boolean
  /** 真实双端配置、重发现与重新授权证明；缺失时 provider enable 拒绝。 */
  providerEnable?(target: { machine_id: string; provider_id: string; kind: ProviderKind }, revision: number): boolean
}
const writes = new Set([
  'history_open',
  'write_state_get',
  'pairings_get',
  'operations_get',
  'confirmations_create',
  'confirmations_confirm',
  'pairings_create',
  'pairings_cancel',
  'pairings_claim_approve',
  'devices_rename',
  'devices_disconnect',
  'devices_revoke',
  'providers_disable',
  'providers_enable'
])
const reasons = new Set(['administrator_request', 'maintenance', 'device_lost', 'pairing_cancelled'])
const writeFields = [
  'request_id',
  'history_epoch',
  'confirmation_id',
  'recovery_generation',
  'expected_revision',
  'reason'
]
const readNames = new Set([
  'status',
  'devices_list',
  'devices_get',
  'providers_list',
  'providers_get',
  'permissions_get',
  'calls_list'
])

/** 仅输出固定公共码，底层 SQL、路径、身份后端异常与用户内容均不离开服务。 */
export class ManagementServiceError extends Error {
  /** 固定码由本服务的白名单提供，不把任意宿主异常的 code 当公共数据。 */
  constructor(readonly code: string) {
    super(code)
  }
}
// 仅桥接本服务已知的身份、权限、配置证明拒绝；未知异常仍交给 Store 的故障降级路径。
const transactionRefusals = new Set(['unauthenticated', 'forbidden', 'backend_unavailable', 'invalid_arguments'])
/** 受信管理判定进入 writer 时使用 Store 认识的业务错误，避免健康库被权限拒绝误降级。 */
function storageRefusal<T>(check: () => T): T {
  try {
    return check()
  } catch (error) {
    if (error instanceof ManagementServiceError && transactionRefusals.has(error.code)) {
      throw new GatewayError(error.code)
    }
    throw error
  }
}
const publicCodes = new Set([
  'unauthenticated',
  'forbidden',
  'backend_unavailable',
  'invalid_arguments',
  'storage_degraded',
  'management_history_unavailable',
  'idempotency_conflict',
  'revision_conflict',
  'connection_epoch_conflict',
  'provider_binding_mismatch',
  'confirmation_required',
  'confirmation_mismatch',
  'confirmation_expired',
  'operation_unconfirmed',
  'pairing_conflict',
  'pairing_not_found',
  'invalid_pairing_claim',
  'invalid_pairing_issuance',
  'pairing_claim_not_found',
  'pairing_claim_code_mismatch',
  'pairing_claim_conflict',
  'machine_not_found',
  'invalid_machine_state',
  'invalid_name',
  'constraint_conflict',
  'clock_untrusted'
])

/** 严格字段集合与有界规范 JSON 先于任何身份或数据库写入，拒绝额外权限/secret 字段。 */
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Buffer.byteLength(canonical(value)) > 16_384
  ) {
    throw new ManagementServiceError('invalid_arguments')
  }
  const row = value as Record<string, unknown>
  for (const field of required) {
    if (!Object.hasOwn(row, field)) {
      throw new ManagementServiceError('invalid_arguments')
    }
  }
  for (const field of Object.keys(row)) {
    if (!required.includes(field) && !optional.includes(field)) {
      throw new ManagementServiceError('invalid_arguments')
    }
  }
  return row
}
/** 标识只允许有界 opaque 引用，不接收路径、URL、原文令牌或控制码。 */
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new ManagementServiceError('invalid_arguments')
  }
}
/** 资源 revision 必须是安全非负整数，新设备注册使用零，其它资源另核对当前值。 */
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ManagementServiceError('invalid_arguments')
  }
}
/** 名称按 Store 同一规范输入，避免确认展示与实际生效名称不一致。 */
function deviceName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value)) {
    throw new ManagementServiceError('invalid_arguments')
  }
}
/** 意图枚举及目标使用精确字段，不允许通过普通 JSON 注入命令、配置或确认状态。 */
function intent(value: unknown): ManagementIntent {
  const input = value as ManagementIntent
  if (!input || typeof input !== 'object') {
    throw new ManagementServiceError('invalid_arguments')
  }
  if (!input.target || typeof input.target !== 'object' || Array.isArray(input.target)) {
    throw new ManagementServiceError('invalid_arguments')
  }
  const action = input.action
  const extra =
    action === 'device_disconnect'
      ? ['expected_connection_epoch']
      : action === 'device_rename'
        ? ['name']
        : action === 'provider_disable' || action === 'provider_enable'
          ? ['expected_binding_revision']
          : []
  object(input, ['action', 'target', ...extra])
  if (action === 'pairing_create') {
    if ('name' in input.target) {
      object(input.target, ['name', 'policy_ref', 'labels'])
      deviceName(input.target.name)
      if (
        !Array.isArray(input.target.labels) ||
        input.target.labels.length > 16 ||
        new Set(input.target.labels).size !== input.target.labels.length
      ) {
        throw new ManagementServiceError('invalid_arguments')
      }
      for (const label of input.target.labels) {
        identifier(label)
      }
    } else {
      object(input.target, ['machine_id', 'policy_ref'])
      identifier(input.target.machine_id)
    }
    identifier(input.target.policy_ref)
  } else if (action === 'pairing_cancel') {
    object(input.target, ['machine_id', 'pairing_id'])
    identifier(input.target.machine_id)
    identifier(input.target.pairing_id)
  } else if (action === 'pairing_claim_approve') {
    object(input.target, ['machine_id', 'pairing_id', 'claim_id', 'user_code'])
    identifier(input.target.machine_id)
    identifier(input.target.pairing_id)
    identifier(input.target.claim_id)
    if (!/^[A-Z0-9]{4,16}$/.test(input.target.user_code)) {
      throw new ManagementServiceError('invalid_arguments')
    }
  } else if (action === 'device_disconnect' || action === 'device_revoke' || action === 'device_rename') {
    object(input.target, ['machine_id'])
    identifier(input.target.machine_id)
    if (action === 'device_disconnect') {
      identifier(input.expected_connection_epoch)
    }
    if (action === 'device_rename') {
      deviceName(input.name)
    }
  } else if (action === 'provider_disable' || action === 'provider_enable') {
    object(input.target, ['machine_id', 'provider_id', 'kind'])
    identifier(input.target.machine_id)
    identifier(input.target.provider_id)
    if (!PROVIDER_KINDS.includes(input.target.kind as ProviderKind)) {
      throw new ManagementServiceError('invalid_arguments')
    }
    revision(input.expected_binding_revision)
    if (!input.expected_binding_revision) {
      throw new ManagementServiceError('invalid_arguments')
    }
  } else {
    throw new ManagementServiceError('invalid_arguments')
  }
  return input
}
/** 写范围引用逐项核对，原因使用固定枚举而不记录自由文本或秘密。 */
function fence(value: Record<string, unknown>, confirmation = true): void {
  for (const field of [
    'request_id',
    'history_epoch',
    'recovery_generation',
    ...(confirmation ? ['confirmation_id'] : [])
  ]) {
    identifier(value[field])
  }
  revision(value.expected_revision)
  if (!reasons.has(value.reason as string)) {
    throw new ManagementServiceError('invalid_arguments')
  }
}
/** 管理授权逐条精确匹配，provider 权限不会被设备权限或其它实例继承。 */
function allowed(
  admin: Administrator,
  action: ManagementGrant['action'],
  machine?: string,
  provider?: string
): boolean {
  return admin.grants.some(
    /* 同一条 grant 必须完整匹配动作和目标。 */ (grant) =>
      grant.action === action &&
      ('machine_id' in grant ? grant.machine_id === machine : machine === undefined) &&
      ('provider_id' in grant ? grant.provider_id === provider : provider === undefined)
  )
}
/** 一个可注入现有 StoreGatewayService.management 的写侧服务，缺失生产会话保持拒绝。 */
export class StoreManagementWriteService implements GatewayManagementService {
  /** 绑定同一 Store 和当前身份来源，不从配置文件或浏览器生成管理员。 */
  constructor(private readonly options: ManagementWriteOptions) {}

  /** 每次请求与 writer 事务内都重新验证 principal、会话、assurance 和当前政策。 */
  private administrator(context: AdminContext): Administrator {
    const principal = this.options.identities.principal(context.caller)
    const admin = this.options.identities.administrator(context.caller, context.management_session_ref)
    if (
      !principal ||
      !admin ||
      principal.id !== context.caller.principal_id ||
      admin.principal_id !== principal.id ||
      admin.session_ref !== context.management_session_ref ||
      admin.assurance !== 'administrator' ||
      !Array.isArray(admin.grants) ||
      admin.grants.length > 4096
    ) {
      throw new ManagementServiceError('unauthenticated')
    }
    identifier(admin.policy_revision)
    identifier(admin.session_ref)
    return JSON.parse(canonical(admin)) as Administrator
  }

  /** 从当前管理员会话核对具体管理能力；缺少真实宿主能力时在确认前拒绝。 */
  private authorize(admin: Administrator, operation: ManagementIntent, capabilities = true): void {
    const target = operation.target as ResourceTarget
    let permitted = false
    switch (operation.action) {
      case 'pairing_create':
        permitted =
          allowed(admin, 'devices_register') &&
          (!('machine_id' in operation.target) || allowed(admin, 'devices_revoke', operation.target.machine_id))
        if (
          capabilities &&
          permitted &&
          this.options.pairingPolicy?.(operation.target.policy_ref, admin, target.machine_id) !== true
        ) {
          throw new ManagementServiceError('backend_unavailable')
        }
        break
      case 'pairing_cancel':
        permitted = allowed(admin, 'devices_register') && allowed(admin, 'devices_revoke', target.machine_id)
        break
      case 'pairing_claim_approve':
        permitted = allowed(admin, 'devices_register') && allowed(admin, 'devices_revoke', target.machine_id)
        break
      case 'device_rename':
        permitted = allowed(admin, 'devices_rename', target.machine_id)
        break
      case 'device_disconnect':
        permitted = allowed(admin, 'devices_disconnect', target.machine_id)
        break
      case 'device_revoke':
        permitted = allowed(admin, 'devices_revoke', target.machine_id)
        break
      case 'provider_disable':
      case 'provider_enable':
        permitted = allowed(admin, 'providers_manage', target.machine_id, target.provider_id)
        break
    }
    if (!permitted) {
      throw new ManagementServiceError('forbidden')
    }
    if (!capabilities) {
      return
    }
    if (
      ['device_disconnect', 'device_revoke', 'provider_disable', 'provider_enable'].includes(operation.action) &&
      !this.options.transport
    ) {
      throw new ManagementServiceError('backend_unavailable')
    }
    if (
      operation.action === 'provider_enable' &&
      this.options.providerEnable?.(operation.target, operation.expected_binding_revision) !== true
    ) {
      throw new ManagementServiceError('backend_unavailable')
    }
  }

  /** 生成只保留会话摘要的事务授权回调；政策撤权在事务内立即生效。 */
  private authority(context: AdminContext, operation?: ManagementIntent): ManagementAuthority {
    return /* 不缓存管理员或按钮许可，每次重新解析受信身份后端。 */ (): ManagementActor =>
      storageRefusal(
        /* 已知管理拒绝必须回滚且保留健康writer。 */ () => {
          const admin = this.administrator(context)
          if (operation) {
            this.authorize(admin, operation, false)
          }
          const principal = this.options.identities.principal(context.caller)
          if (!principal || principal.id !== admin.principal_id) {
            throw new ManagementServiceError('unauthenticated')
          }
          return {
            actor: admin.principal_id,
            session_hash: digest(admin.session_ref),
            policy_digest: digest(
              canonical({
                revision: admin.policy_revision,
                grants: admin.grants
              })
            )
          }
        }
      )
  }

  /** 只接受已公布的固定操作，写响应不含 enrollment、设备凭据或 native 内容。 */
  async execute<K extends ManagementOperation>(
    name: K,
    args: ManagementArguments[K],
    context: AdminContext
  ): Promise<ManagementReply[K]> {
    if (!writes.has(name)) {
      if (readNames.has(name) && this.options.reads) {
        return this.options.reads.execute(name, args, context)
      }
      throw new ManagementServiceError('backend_unavailable')
    }
    let attempted: { operation: ManagementIntent; write: ManagementWrite } | undefined
    try {
      const admin = this.administrator(context)
      if (context.wait_signal.aborted) {
        throw new ManagementServiceError('backend_unavailable')
      }
      const ledger = this.options.store.administration
      // 在解析配对/目标元数据之前拒绝隔离与降级写入。
      const mode = this.options.store.health().mode
      if (mode !== 'active') {
        throw new ManagementServiceError(mode)
      }
      let result: unknown
      if (name === 'history_open') {
        object(args, [])
        if (
          !admin.grants.some(
            /* 纯只读管理员不能创建管理写范围。 */ (grant) =>
              [
                'devices_register',
                'devices_rename',
                'devices_disconnect',
                'devices_revoke',
                'providers_manage'
              ].includes(grant.action)
          )
        ) {
          throw new ManagementServiceError('forbidden')
        }
        result = ledger.open(this.authority(context))
      } else if (name === 'write_state_get') {
        const value = object(args, ['machine_id'], ['provider_id'])
        identifier(value.machine_id)
        if (value.provider_id !== undefined) {
          identifier(value.provider_id)
        }
        const target = value as ResourceTarget
        if (
          target.provider_id
            ? !allowed(admin, 'providers_manage', target.machine_id, target.provider_id)
            : !['devices_rename', 'devices_disconnect', 'devices_revoke'].some(
                /* 只有同设备独立写授权可读取原始管理 fence。 */ (action) =>
                  allowed(admin, action as ManagementGrant['action'], target.machine_id)
              )
        ) {
          throw new ManagementServiceError('forbidden')
        }
        result = ledger.state(target, this.authority(context))
      } else if (name === 'pairings_get') {
        const value = object(args, ['machine_id', 'pairing_id'])
        identifier(value.machine_id)
        identifier(value.pairing_id)
        if (!allowed(admin, 'devices_read', value.machine_id)) {
          throw new ManagementServiceError('forbidden')
        }
        result = ledger.pairing(value.machine_id, value.pairing_id, this.authority(context))
      } else if (name === 'operations_get') {
        const value = object(args, ['request_id', 'history_epoch', 'recovery_generation'])
        for (const item of Object.values(value)) {
          identifier(item)
        }
        const write = value as ManagementArguments['operations_get']
        const original = ledger.intent(write, this.authority(context))
        this.authorize(admin, original, false)
        result = ledger.receipt(write, this.authority(context, original))
      } else if (name === 'confirmations_create') {
        const value = object(
          args,
          ['action', 'target', 'request_id', 'history_epoch', 'recovery_generation', 'expected_revision', 'reason'],
          ['name', 'expected_connection_epoch', 'expected_binding_revision']
        )
        fence(value, false)
        const {
          request_id: _request,
          history_epoch: _history,
          recovery_generation: _generation,
          expected_revision: _revision,
          reason: _reason,
          ...operation
        } = value
        const parsed = intent(operation)
        this.authorize(admin, parsed)
        result = ledger.create(value as ConfirmationDraft, this.authority(context, parsed))
      } else if (name === 'confirmations_confirm') {
        const value = object(args, [...writeFields, 'operation_digest'])
        fence(value)
        identifier(value.operation_digest)
        const write = value as ManagementArguments['confirmations_confirm']
        const original = ledger.intent(write, this.authority(context))
        this.authorize(admin, original, false)
        result = ledger.confirm(write, this.authority(context, original))
      } else {
        const fields =
          name === 'pairings_create'
            ? []
            : name === 'pairings_cancel'
              ? ['machine_id', 'pairing_id']
              : name === 'pairings_claim_approve'
                ? ['machine_id', 'pairing_id', 'claim_id', 'user_code']
                : name === 'devices_rename'
                  ? ['machine_id', 'name']
                  : name === 'devices_disconnect'
                    ? ['machine_id', 'expected_connection_epoch']
                    : name === 'devices_revoke'
                      ? ['machine_id']
                      : ['machine_id', 'provider_id', 'kind', 'expected_binding_revision']
        const value = object(
          args,
          [...writeFields, ...fields],
          name === 'pairings_create' ? ['name', 'labels', 'policy_ref', 'machine_id'] : []
        )
        fence(value)
        const {
          request_id,
          history_epoch,
          confirmation_id,
          recovery_generation,
          expected_revision,
          reason,
          ...target
        } = value
        const write = {
          request_id,
          history_epoch,
          confirmation_id,
          recovery_generation,
          expected_revision,
          reason
        } as ManagementWrite
        const action =
          name === 'pairings_create'
            ? 'pairing_create'
            : name === 'pairings_cancel'
              ? 'pairing_cancel'
              : name === 'pairings_claim_approve'
                ? 'pairing_claim_approve'
                : name === 'devices_rename'
                  ? 'device_rename'
                  : name === 'devices_disconnect'
                    ? 'device_disconnect'
                    : name === 'devices_revoke'
                      ? 'device_revoke'
                      : name === 'providers_disable'
                        ? 'provider_disable'
                        : 'provider_enable'
        const { name: renamed, expected_connection_epoch, expected_binding_revision, ...resource } = target
        const operation = intent(
          action === 'pairing_create'
            ? { action, target }
            : action === 'device_rename'
              ? { action, target: resource, name: renamed }
              : action === 'device_disconnect'
                ? { action, target: resource, expected_connection_epoch }
                : action === 'provider_disable' || action === 'provider_enable'
                  ? { action, target: resource, expected_binding_revision }
                  : { action, target: resource }
        )
        attempted = { operation, write }
        this.authorize(admin, operation, false)
        result = ledger.commit(
          operation,
          write,
          this.authority(context, operation),
          /* 新意图才要求当前真实宿主证明，原回执读取不重新执行。 */ () =>
            storageRefusal(
              /* 证明撤销是明确业务拒绝，真实SQLite或未知宿主异常仍不转换。 */ () =>
                this.authorize(this.administrator(context), operation)
            )
        )
        // COMMIT 后复验所有当前通道；宿主失败不撤销已提交结果，通道效果继续标未确认。
        try {
          this.options.transport?.refresh()
        } catch {
          /* 只返回已持久化证据，不把 native 工作误报回滚。 */
        }
      }
      return result as ManagementReply[K]
    } catch (error) {
      const code =
        error instanceof ManagementServiceError || error instanceof GatewayError ? error.code : 'backend_unavailable'
      if (
        attempted &&
        [
          'forbidden',
          'idempotency_conflict',
          'revision_conflict',
          'connection_epoch_conflict',
          'provider_binding_mismatch',
          'confirmation_required',
          'confirmation_mismatch',
          'confirmation_expired',
          'invalid_machine_state',
          'pairing_conflict',
          'invalid_pairing_claim',
          'pairing_claim_code_mismatch',
          'constraint_conflict'
        ].includes(code) &&
        this.options.store.health().mode === 'active'
      ) {
        try {
          this.options.store.administration.denied(attempted.operation, attempted.write, code, this.authority(context))
        } catch {
          // 无法证明当前会话或审计提交时不伪造已记录；存储降级保持明确拒绝。
          if (this.options.store.health().mode === 'storage_degraded') {
            throw new ManagementServiceError('storage_degraded')
          }
        }
      }
      if (error instanceof ManagementServiceError) {
        throw error
      }
      if (error instanceof GatewayError && publicCodes.has(error.code)) {
        throw new ManagementServiceError(error.code)
      }
      throw new ManagementServiceError('backend_unavailable')
    }
  }
}
