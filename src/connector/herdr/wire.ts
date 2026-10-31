/** 将已评审 Herdr 普通 RPC 接入现有 Wire 接口；不提供原生流、对象传输或取消保证。 */
import { createProviderWireAdapter } from '../../runtime/provider-wire.js'
import { createHerdrReadonlyAdapter } from './readonly.js'
import type { HerdrReadonlyBackend } from './readonly.js'

/** Herdr 的原生 core 只负责自己的校验与许可；桥接行为由中性模块交付。 */
export function createHerdrWireAdapter(backend: HerdrReadonlyBackend, core = createHerdrReadonlyAdapter(backend)) {
  return createProviderWireAdapter(
    core,
    'herdr_transport_unsupported',
    /** 与原生宿主共用同一 Store 时钟。 */ () => backend.now()
  )
}
