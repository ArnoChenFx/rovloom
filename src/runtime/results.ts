/** 已提交响应只按当前 token 的设备范围与句柄归属读取，不依赖仍在线的原连接。 */
import { GatewayError } from '../contracts.js'
import { Router, type Principal } from '../router.js'
import type { ResultPage, Store } from '../store.js'

export type ProviderResultMetadata = Readonly<Pick<ResultPage, 'result_id' | 'bytes' | 'hash' | 'expires'>>
export type ProviderResultPage = Readonly<ResultPage>
export type ProviderResultAccessOptions = Readonly<{
  store: Store
  /** 当前身份由认证宿主提供，不能由结果参数自报。 */
  principal(): Principal
}>

/** 来源、binding 与响应结构在提交时核验；分页复用 Store 的期限、字节预算和摘要。 */
export function createProviderResultAccess(options: ProviderResultAccessOptions) {
  if (!options?.store || typeof options.principal !== 'function') {
    throw new GatewayError('result_port_invalid')
  }
  const router = new Router(options.store)
  function operation<T>(action: (principal: Principal) => T): T {
    try {
      const principal = options.principal()
      if (!principal || typeof principal.id !== 'string' || !principal.id.trim()) {
        throw new GatewayError('unauthenticated')
      }
      return action(principal)
    } catch (error) {
      throw error instanceof GatewayError ? error : new GatewayError('result_unavailable')
    }
  }
  return Object.freeze({
    open(callId: string): ProviderResultMetadata {
      return operation((principal) => Object.freeze({ ...router.saveResult(principal, callId) }))
    },
    read(resultId: string, cursor = 0, maxBytes = 65_536): ProviderResultPage {
      return operation((principal) => Object.freeze(router.readResult(principal, resultId, cursor, maxBytes)))
    },
    discard(callId: string): void {
      operation((principal) => router.discardResponse(principal, callId))
    }
  })
}
