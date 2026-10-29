// 将 SQLite 账本事实接入原生适配器，并在同一事务内提交可信响应证据。
import type { Store } from '../store.js'
import type { AuthenticatedEnvelope } from './types.js'
import type { Adapter } from '../transport/common.js'

// 由 Store 在 BEGIN IMMEDIATE 写事务内重新取得锚点并调用真实适配器，统一固定接收时钟。
// 提交成功后才返回结果；可信冲突先提交审计再抛错误，写入失败不得对外发布 responded。
export function commitNativeResponse(
  store: Store,
  adapter: Pick<Adapter, 'planEvidence'>,
  frame: Extract<AuthenticatedEnvelope, { type: 'response' }>
) {
  const binding = {
    machine_id: frame.machine_id,
    recovery_generation: frame.recovery_generation,
    connection_epoch: frame.connection_epoch,
    ...frame.payload.attempt
  }
  return store.commitEvidence(
    binding,
    /* 在 Store 固定的事务时钟下调用真实适配器，禁止接受序列化计划作为证据。 */ () => adapter.planEvidence(frame)
  )
}
