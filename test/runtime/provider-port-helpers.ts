/** 在真实 provider 准入端口的登记回调中检查完整原生请求，成功后停止，不伪造调用或执行结果。 */
import assert from 'node:assert/strict'
import type { GatewayProviderPort } from '../../src/runtime/types.js'
import type { JsonObject } from '../../src/wire/types.js'

export function checkProviderRequest(
  provider: Pick<GatewayProviderPort, 'admit'>,
  request: JsonObject & { method: string },
  reference: string
): void {
  const stop = Symbol('checked_before_registration')
  let checked = false
  try {
    provider.admit(
      request,
      { binding_revision: 1, contract_ref: reference, deadline: Date.now() + 30_000 },
      (_options, check) => {
        check(request)
        checked = true
        throw stop
      }
    )
  } catch (error) {
    if (error !== stop) {
      throw error
    }
  }
  assert.equal(checked, true)
}
