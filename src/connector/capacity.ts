/** Connector 本地容量诊断只包含固定资源类别和可回收时间，不携带请求或存储路径。 */
import { ProviderAdapterError } from './provider-error.js'

export type ConnectorCapacity = Readonly<{
  resource: 'claim_entries' | 'claim_bytes' | 'attempt_entries' | 'attempt_bytes'
  // null 表示不能根据已知到期时间保证释放空间；字节预算仍需存储检查。
  reclaim_at: number | null
}>

export class ConnectorCapacityError extends ProviderAdapterError {
  readonly capacity: ConnectorCapacity

  /** 容量只在本地观测，不扩展 Wire 拒绝证明，也不允许重派同一个 attempt。 */
  constructor(resource: ConnectorCapacity['resource'], reclaimAt: number | null) {
    super(resource.startsWith('claim_') ? 'claim_capacity' : 'connector_attempt_capacity')
    this.capacity = Object.freeze({ resource, reclaim_at: reclaimAt })
  }
}
