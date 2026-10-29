// 将 Store 的设备凭据校验与连接 fence 组合为 Gateway 的认证宿主与 socket 门禁。
import type { Store } from '../store.js'
import { fail, hash } from '../wire/index.js'
import type { ConnectionIdentity } from '../wire/types.js'
import type { IdentityHost } from './identity.js'
import type { ChannelHost } from './channel-host.js'

/** 建立认证与重配接线：凭据校验、fresh epoch 与审计在 Store 的同一事务内完成，不存在跨库步骤。 */
export function createDeviceLifecycle(store: Store) {
  /** 校验凭据格式后由 Store 事务核对摘要并分配 fresh epoch；返回该凭据的 hash 租期。 */
  function authenticate(machine: string, generation: string, credential: string) {
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(credential)) {
      fail('invalid_device_credential')
    }
    if (generation !== store.generation()) {
      fail('invalid_device_credential')
    }
    const epoch = store.connect(machine, credential)
    return {
      identity: { machine_id: machine, recovery_generation: generation, connection_epoch: epoch },
      lease: hash(credential)
    }
  }
  /** 从具体 socket 读取身份，独立已提交身份库和当前 Store fence 都通过后才交给 backend。 */
  function connection(channels: ChannelHost) {
    const current = channels.connection()
    if (current.authenticated !== true || current.active !== true) {
      fail('authentication_required')
    }
    store.assertConnection(current)
    return current
  }
  const identityHost: IdentityHost = {
    /** 只读取主 Store 的当前代次。 */
    generation: () => store.generation(),
    authenticate,
    /** 复验原 socket 的 hash 租期与真实 Store fence，重配、撤销和旧 epoch 均不能混用。 */
    assert(current, lease) {
      store.assertConnection(current, lease)
    },
    /** 普通断连只断开匹配 epoch。 */
    disconnect(current: ConnectionIdentity) {
      store.disconnect(current.machine_id, current.connection_epoch)
    }
  }
  return {
    store,
    identityHost,
    authenticate,
    connection,
    /** 管理确认后重置同 ID 设备为 pending，再关闭其全部旧 socket；旧 epoch 已在提交中清除。 */
    reset(channels: ChannelHost, machine: string, generation: string, expectedEpoch: string | null): void {
      store.resetDeviceEnrollment(machine, generation, expectedEpoch)
      channels.blockAndClose(machine)
    }
  }
}

export type DeviceLifecycleWiring = ReturnType<typeof createDeviceLifecycle>
