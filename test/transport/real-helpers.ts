// 在私有临时目录组合真实 Store 设备凭据、实际 socket 与真实 Wire/native adapter。
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { ChannelRegistry, createDeviceLifecycle } from '../../src/transport/index.js'
import { createDeviceLifecycleAdapter } from '../../src/connector/luvus/persistence.js'
import type { Connection, IdentityHost, SocketChannel } from '../../src/transport/index.js'
import type { NativeConnectorOptions } from '../../src/transport/connector.js'
import { boundedJson, fail } from '../../src/wire/index.js'
import { fixture, until } from './helpers.js'
import { management } from '../storage/helpers.js'

/** 初始化真实 Store 与双端 loopback，管理确认及 native 来源均仅为本次 mock fixture。 */
export function realFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-real-bridge-mock-'))
  const storePath = join(root, 'store.sqlite')
  const channels = new ChannelRegistry()
  let approval: { machine: string; fence: string; id: string } | undefined
  let failStore = false
  let beforeStoreCommit: (() => void) | undefined
  const records: {
    connection: Connection
    channel: SocketChannel
    native: ReturnType<typeof createDeviceLifecycleAdapter>
  }[] = []
  const events: Parameters<Parameters<Store['subscribeInvalidation']>[0]>[0][] = []
  const identityProxy: IdentityHost = {
    /** 仅在创建完真实接线后读取主 Store 代次。 */
    generation: () => lifecycle.identityHost.generation(),
    /** 真实 Store 事务核对凭据摘要并分配 fresh epoch。 */
    authenticate: (machine, generation, credential) =>
      lifecycle.identityHost.authenticate(machine, generation, credential),
    /** 每次复验该原 socket 的凭据摘要与真实 Store epoch。 */
    assert: (current, lease) => lifecycle.identityHost.assert(current, lease),
    /** 普通断连使用真实 Store 精确 epoch 操作。 */
    disconnect: (current) => lifecycle.identityHost.disconnect(current)
  }
  const f = fixture(
    {
      identity: identityProxy,
      channels,
      limits: { heartbeat_ms: 200, idle_ms: 10_000, handshake_ms: 5000 }
    },
    {
      maintenanceIntervalMs: 60_000,
      /** reset 只消费精确设备、代次与 epoch 的独立确认，其它合成管理操作仍用 fixture 管理员。 */
      management(request) {
        if (request.action !== 'device_enrollment_reset') {
          return management!(request)
        }
        if (!approval || approval.machine !== request.target || approval.fence !== request.fence) {
          return { actor: '', confirmation_id: '' }
        }
        return { actor: 'mock_admin', confirmation_id: approval.id }
      },
      /** 在真实业务 COMMIT 前制造失败，整个事务回滚。 */
      fault(point) {
        if (point === 'before_commit' && beforeStoreCommit) {
          const callback = beforeStoreCommit
          beforeStoreCommit = undefined
          callback()
        }
        if (failStore && point === 'before_commit') {
          throw new Error('mock_primary_commit_failure')
        }
      }
    },
    {
      /** 真实业务账本仅写本测试新建的 0700 根目录。 */
      store: (now, settings) => new Store(storePath, now, settings),
      /** Gateway 每个实际 socket 均使用生命周期 backend 和提交后回收订阅，记录仅供资源断言。 */
      adapter(connection, channel, services) {
        const native = createDeviceLifecycleAdapter(lifecycle, channel, services)
        records.push({ connection, channel, native })
        return native.adapter
      }
    }
  )
  const lifecycle = createDeviceLifecycle(f.store)
  const unsubscribe = f.store.subscribeInvalidation(
    /** 收集真实 COMMIT 后的最小设备作用域回收事件，不收集请求或凭据。 */
    (event) => {
      events.push(event)
    }
  )
  return {
    f,
    lifecycle,
    channels,
    records,
    events,
    root,
    storePath,
    /** 使用 fixture 的注册与配对流程，但把凭据换成真实 Store 兑换得到的原始值。 */
    pair(name: string) {
      const original = f.store.redeem.bind(f.store)
      let real: { machine_id: string; credential: string } | undefined
      f.store.redeem = /** 捕获真实兑换结果，仅用于本测试把凭据交给 Connector。 */ (token) => {
        real = original(token)
        return real
      }
      let device: ReturnType<typeof f.pair>
      try {
        device = f.pair(name)
      } finally {
        f.store.redeem = original
      }
      device.credential = {
        machine_id: real!.machine_id,
        recovery_generation: f.store.generation(),
        credential: real!.credential
      }
      return device
    },
    /** 使用当前设备启动配置创建真实 loopback Connector，不运行任何真实原生进程。 */
    connector(device: ReturnType<typeof f.pair>, options: Partial<NativeConnectorOptions> = {}) {
      return f.connector(
        /** 凭据来自本 fixture 受保护启动闭包，不取自业务输入或设备名称。 */
        () => device.credential,
        {
          limits: { heartbeat_ms: 200, idle_ms: 10_000, handshake_ms: 5000, reconnect_ms: 20, reconnect_max_ms: 200 },
          ...options
        }
      )
    },
    /** 同时等待双方真实 ready，避免 Gateway 就绪早于 Connector 完成 welcome 的竞态。 */
    async ready(...clients: ReturnType<typeof f.connector>[]) {
      await until(
        /** 每个指定 Connector 都必须收到 welcome 并完成本机 readiness 检查。 */
        () =>
          clients.every(
            /** 当前连接必须实际 ready，不能只检查 TCP 或 socket open。 */
            (client) => client.status().phase === 'ready'
          ),
        8000
      )
    },
    /** 为一次主 Store 重配签发精确 fence 管理确认。 */
    approve(machine: string, epoch: string | null) {
      approval = {
        machine,
        fence: boundedJson({ recovery_generation: f.store.generation(), connection_epoch: epoch }),
        id: randomUUID()
      }
    },
    /** 按当前记录的精确 epoch 调用真实重配协调：Store 事务提交后关闭该设备全部旧 socket。 */
    reset(machine: string, epoch: string | null) {
      const record = records.findLast(
        /** 只取此设备实际认证 socket 的作用域，绝不从 Wire 帧构造 connection。 */
        (item) => item.connection.machine_id === machine
      )
      if (!record) {
        fail('mock_channel_unavailable')
      }
      lifecycle.reset(record.channel, machine, f.store.generation(), epoch)
    },
    /** 开关真实主 Store 提交故障，不改变任何生产配置。 */
    set failStore(value: boolean) {
      failStore = value
    },
    /** 在下次真实 Store 提交前同步重入一次管理操作。 */
    set beforeStoreCommit(callback: (() => void) | undefined) {
      beforeStoreCommit = callback
    },
    /** 幂等停止本 fixture 的网络、adapter 和 Store，然后清除新建目录。 */
    close() {
      unsubscribe()
      f.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
