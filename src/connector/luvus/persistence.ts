import { createLuvusWireAdapter } from './wire.js'
import { fail } from '../../wire/index.js'
import type { DeviceLifecycleWiring } from '../../transport/lifecycle.js'
import type { ChannelHost } from '../../transport/channel-host.js'
import type { Store } from '../../store.js'
import type { NativeWireBackend } from './backend.js'
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

/** 对原生来源解析前后各复验同一 socket，并校验来源 target/代次/epoch，不从 Wire 输入制造来源。 */
export function guardLuvusSource(
  lifecycle: DeviceLifecycleWiring,
  channels: ChannelHost,
  resolve: NativeWireBackend['nativeSource']
): NativeWireBackend['nativeSource'] {
  /** 保持解析函数闭包只引用所属 socket 的连接门禁，不使用最近上线的设备身份。 */
  const guarded: NativeWireBackend['nativeSource'] = (call, attempt) => {
    lifecycle.connection(channels)
    const source = resolve(call, attempt)
    const current = lifecycle.connection(channels)
    if (
      source &&
      (source.binding.target.machine_id !== current.machine_id ||
        source.binding.recovery_generation !== current.recovery_generation ||
        source.binding.connection_epoch !== current.connection_epoch)
    ) {
      fail('native_identity_mismatch')
    }
    return source
  }
  return guarded
}
/** 为具体 socket 组合 persistentBackend 与真实 adapter，当前连接和原生来源均经过失效门禁。 */
export function createDeviceLifecycleAdapter(
  lifecycle: DeviceLifecycleWiring,
  channels: ChannelHost,
  services: Omit<Parameters<typeof persistentBackend>[1], 'connection'>
) {
  /** 生命周期已同步核对双库和当前 Store fence；直接复用本次结果，避免紧邻的重复持久时钟写入。 */
  const connection = () => lifecycle.connection(channels)
  const backend = {
    ...persistentBackend(lifecycle.store, {
      ...services,
      /** 每次 backend 使用均从当前 socket 及双库重新取可信连接。 */
      connection,
      nativeSource: guardLuvusSource(lifecycle, channels, services.nativeSource)
    }),
    connection
  }
  return { backend, adapter: createLuvusWireAdapter(backend) }
}
