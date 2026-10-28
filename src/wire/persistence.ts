// 将 SQLite 账本事实接入原生适配器，并在同一事务内提交可信响应证据。
import type { Store } from '../store.js'
import type { AuthenticatedEnvelope } from '../wire/types.js'
import type { NativeWireBackend } from './backend.js'
import { createLuvusWireAdapter } from './native.js'

type Services = Omit<
  NativeWireBackend,
  'attempt' | 'provider' | 'responseAnchor' | 'contentStatus' | 'now' | 'subscribeInvalidation'
>
// 只填持久化事实；认证、双端本机配置、原生来源、契约与真实权限必须独立注入。
export function persistentBackend(store: Store, services: Services): NativeWireBackend {
  return {
    ...services,
    // 转接 Store 的提交后失效和关闭通知，返回取消订阅入口。
    subscribeInvalidation: (listener) => store.subscribeInvalidation(listener),
    // 使用 Store 的可信时钟，保证适配器和持久化事务采用同一期限基准。
    now: () => store.clock(),
    // 先取得独立宿主连接，再由 Store 核对当前在线 epoch 和恢复 generation。
    connection() {
      const connection = services.connection()
      store.assertConnection(connection)
      return connection
    },
    // 从 Store 查询精确调用与尝试的原请求记录，内容清理后不再可取。
    attempt: (call, attempt) => store.attempt(call, attempt),
    // 按目标设备与 provider 双重作用域查询持久化绑定。
    provider: (target) => store.provider(target.machine_id, target.provider_id),
    // 从账本读取原派发锚点和固定期限，不取回请求正文。
    responseAnchor: (binding) => store.responseAnchor(binding),
    // 读取原锚点的当前内容状态，让过期或删除即时约束读取门禁。
    contentStatus: (binding) => store.responseAnchor(binding).content_status
  }
}
// 由 Store 在 BEGIN IMMEDIATE 写事务内重新取得锚点并调用真实适配器，统一固定接收时钟。
// 提交成功后才返回结果；可信冲突先提交审计再抛错误，写入失败不得对外发布 responded。
export function commitNativeResponse(
  store: Store,
  adapter: Pick<ReturnType<typeof createLuvusWireAdapter>, 'planEvidence'>,
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

export { commitNativeResponse as commitLuvusResponse }
