// 定义账本行、独立设备身份校验接口及提交后回收通知，并投影不含内部请求与证据字段的公开调用。
import type { CallState } from '../contracts.js'
import type { ResponseAnchor } from '../wire/evidence.js'
import type { ValidationMode } from '../wire/types.js'
import type { Retention } from './config.js'

export type Machine = { machine_id: string; name: string; status: string }
export type Metadata = { generation: string; mode: string; clock: number }
export type ManagementRequest = { action: string; target: string; fence: string }
// 内容通知允许宿主压缩执行上下文，身份 fence 和关闭通知则销毁对应能力；通知本身不序列化原生句柄。
export type LedgerInvalidation =
  | { kind: 'content' | 'fence'; machine_id: string; call_id: string }
  | { kind: 'device_fence'; machine_id: string }
  | { kind: 'closed' }
export type StoreOptions = {
  retention?: Partial<Retention>
  backupDirectory?: string
  maintenanceIntervalMs?: number
  // 只由受保护宿主注入，须核实独立权限、真实确认及准确 fence；普通工具参数不能传入。
  management?: (request: ManagementRequest) => { actor: string; confirmation_id: string }
  // 只由产品装配注入：认领批准产生的凭据在提交前暂存进在线 custody，交付前必须复验账本状态；普通工具参数不能传入。
  pairingClaimCustody?: (event: { machine_id: string; claim_id: string; credential: string }) => void
  // 仅供隔离故障测试在固定写入阶段中断事务；生产宿主不从外部参数注入。
  fault?: (point: 'before_commit' | 'after_anchor' | 'evidence_commit') => void
}
export type CallOptions = {
  binding_revision: number
  contract_ref: string
  caller_policy_revision: string
  local_policy_revision: string
  validation?: ValidationMode
  timeoutMs?: number
  client_request_key?: string
}
// 绝对截止时间与相对 timeout 互斥；调用方重送必须保持首次意图的精确 deadline。
export type CallAdmissionOptions = Omit<CallOptions, 'timeoutMs'> & { deadline: number; timeoutMs?: never }
// created 仅表示本事务首次登记成功，不代表已派发或取得原生执行许可；重复意图不得再次发送。
export type CallAdmission = { call: Call; created: boolean }
export type Call = {
  call_id: string
  principal: string
  machine_id: string
  provider_id: string
  binding_revision: number
  provider_kind: 'luvus' | 'herdr'
  state: CallState
  epoch: string | null
  attempt_id: string | null
  response: string | null
  target_json: string
  method: string
  deadline: number
  content_expires: number
  metadata_expires: number
  dedup_expires: number
  content_status: ResponseAnchor['content_status']
}
// 单次结果页携带原句柄的绝对毫秒截止时间；它不延长句柄，也不保证后续删除或撤权后仍可读取。
export type ResultPage = {
  result_id: string
  encoding: 'base64'
  data: string
  next_cursor: number
  eof: boolean
  bytes: number
  hash: string
  expires: number
}
// 内部行追加原文、绑定和摘要等账本字段；适配器密封的仅响应能力不进入持久化行。
export type Row = Call & {
  identity_json: string
  binding_json: string | null
  request_json: string | null
  request_hash: string
  key_digest: string | null
  created: number
  response_hash: string | null
  response_bytes: number | null
  response_category: string | null
  reserved: number
  mode: ValidationMode
}
// 管理只读窗口行只取账本元数据与调用方已提交的命令名；原文、绑定与证据摘要不进入此投影。
export type CallWindowRow = {
  call_id: string
  principal: string
  machine_id: string
  provider_id: string
  provider_kind: 'luvus' | 'herdr'
  method: string
  state: CallState
  target_json: string
  created: number
  deadline: number
  content_expires: number
  content_status: string
  response_category: string | null
  epoch: string | null
}
// 构造公开调用的新对象，仅在内容仍可用且未到期时返回响应，隐藏内部请求、绑定和证据摘要。
// 到期状态仅反映在返回投影，不清理数据库或刷新既有期限，也不赋予原生执行或响应校验能力。
export const publicCall = (r: Row, now: number): Call => {
  const {
    call_id,
    principal,
    machine_id,
    provider_id,
    binding_revision,
    provider_kind,
    state,
    epoch,
    attempt_id,
    response,
    target_json,
    method,
    deadline,
    content_expires,
    metadata_expires,
    dedup_expires,
    content_status
  } = r
  return {
    call_id,
    principal,
    machine_id,
    provider_id,
    binding_revision,
    provider_kind,
    state,
    epoch,
    attempt_id,
    response: content_status === 'available' && now < content_expires ? response : null,
    target_json,
    method,
    deadline,
    content_expires,
    metadata_expires,
    dedup_expires,
    content_status: content_status === 'available' && now >= content_expires ? 'expired' : content_status
  }
}
