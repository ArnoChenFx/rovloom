// 两种 provider 共享的原请求与账本事实。
import type { LedgerInvalidation } from '../storage/model.js'
import type { ResponseAnchor } from './evidence.js'
import type { AttemptBinding, JsonObject } from './types.js'

export type TrustedAttempt = {
  binding: AttemptBinding
  principal_id: string
  method: string
  mode: 'strict' | 'raw-contract'
  native_request: JsonObject
}

/** 两种 provider 都使用的可信 attempt/结果账本查询；不包含原生契约或来源类型。 */
export interface AttemptBackend {
  attempt(callId: string, attemptId: string): TrustedAttempt | undefined
  currentPrincipal(): string | undefined
  now(): number
  contentStatus(binding: AttemptBinding): 'available' | 'expired' | 'discarded' | 'unavailable'
  responseAnchor?(binding: AttemptBinding): ResponseAnchor | undefined
  subscribeInvalidation?(listener: (event: LedgerInvalidation) => void): () => void
}
