// 提供隔离 loopback 通道与真实账本/validator 的 mock 宿主，所有身份和原生权限均无生产效力。
import { CredentialLifecycle } from './memory-identity.js'
import { PairingAdmin } from './memory-pairing.js'
import { randomUUID } from 'node:crypto'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { Router } from '../../src/router.js'
import { persistentBackend } from '../../src/integration/persistence.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { createConnector, createGateway } from '../../src/transport/index.js'
import type { Connection, DeviceCredential, Session, SocketChannel } from '../../src/transport/index.js'
import type { NativeConnectorOptions } from '../../src/transport/connector.js'
import type { GatewayOptions } from '../../src/transport/gateway.js'
import type { NativeBinding } from '../../src/native-contract/index.js'
import type { CompiledContract } from '../../src/native-contract/index.js'
import {
  ConnectorAttemptBook,
  CONNECTOR_MAX_DEADLINE_MS,
  connectorAdmissionAdapter,
  createConnectorAdmissionBackend
} from '../../src/runtime/connector-attempts.js'
import type { ContractSource, ProviderBinding, V2Target, VersionOffer } from '../../src/wire/types.js'
import { contractRef } from '../../src/wire/index.js'
import { compiled, G, identity, json } from '../native-contract/helpers.js'
import { source } from '../wire/helpers.js'
import { management } from '../storage/helpers.js'

type FixtureHost = {
  contract?: {
    source: ContractSource
    compiled: CompiledContract
    identity: NativeBinding['contract']
    capabilities?: unknown
    capability_revision?: string
  }
  /** 把同一测试账本放入新建私有目录，以验证真实磁盘 Store 生命周期。 */
  store?(now: () => number, options: StoreOptions): Store
  /** 为实际 Gateway socket 组合受信生命周期 backend；Connector 仍独立创建其本机 adapter。 */
  adapter?(
    connection: Connection,
    channel: SocketChannel,
    services: Parameters<typeof persistentBackend>[1]
  ): Session['adapter']
  /** Connector 侧改用生产同款准入后端（本机 attempt 锚点 + 当前 provider 配置）；默认直连 Store。 */
  connectorAdmission?: boolean
}

/** 建立纯 mock 身份和原生来源的隔离 Gateway fixture，复用真实 Store/Router/validator。 */
export function fixture(
  extra: Partial<GatewayOptions> = {},
  storeOptions: Partial<StoreOptions> = {},
  host: FixtureHost = {}
) {
  let now = 1000
  const settings: StoreOptions = { management, ...storeOptions }
  /** 向临时 Store 提供测试控制的时间，避免依赖墙钟推进。 */
  const clock = () => now
  const store = host.store
    ? host.store(clock, settings)
    : new Store(
        ':memory:',
        /** 向临时 Store 提供测试控制的时间，避免依赖墙钟推进。 */
        clock,
        settings
      )
  const canonical = new Map<string, string>()
  const credentials = new CredentialLifecycle(
    {
      /** 从 fixture Store 取得恢复代次，保持模拟设备与账本关联。 */
      generation: () => store.generation(),
      /** 只用 fixture 进程内 custody 的原始凭据调用旧 Store 连接，生产代码不导入此代理。 */
      connect: (machine) => store.connect(machine, canonical.get(machine) ?? ''),
      /** 用真实 Store 校验模拟连接的 epoch，测试并未伪造连接有效性。 */
      assert: (connection) => store.assertConnection(connection),
      /** 只断开 fixture 中匹配的设备 epoch，驱动真实账本 unknown 收敛。 */
      disconnect: (connection) => store.disconnect(connection.machine_id, connection.connection_epoch)
    },
    /** 向内存租期 fixture 提供同一可控时间。 */
    () => now
  )
  let allowed = true
  const admin = new PairingAdmin(store, credentials, {
    /** 按测试开关模拟管理员允许或拒绝，不代表真实管理员身份服务。 */
    authorize() {
      if (!allowed) {
        throw new Error('fixture_admin_denied')
      }
    },
    /** 仅在 fixture 进程内保管首次兑换的原始凭据，不持久化到生产代码。 */
    installCanonical(machine, credential) {
      canonical.set(machine, credential)
    }
  })
  const principal: import('../../src/router.js').Principal = { id: 'synthetic' }
  const router = new Router(store)
  const origin = host.contract?.source ?? { ...source, runtime_generation: G, classification_revision: 'review1' }
  const installedIdentity = host.contract?.identity ?? identity
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = G
  const installedCapabilities = host.contract?.capabilities ?? capabilities
  const capabilityRevision = host.contract?.capability_revision ?? 'caps1'
  const localBindings = new Map<string, ProviderBinding>()
  const configs = new Map<string, { native: boolean; sourceVerified: boolean }>()
  let openedSessions = 0
  let closedSessions = 0
  const encoded: string[] = []
  /** 为本次实际连接组合真实持久 backend 的服务，供独立 Wire 与原生 RPC adapter 分别持有状态。 */
  const backendServices = (connection: Connection): Parameters<typeof persistentBackend>[1] => ({
    /** 将当前已认证的 fixture 连接传入持久 backend，保持 epoch 独立。 */
    connection: () => connection,
    /** 按完整 machine/provider 键解析本机 mock binding，避免跨实例混用。 */
    localProvider: (target) => localBindings.get(target.machine_id + '/' + target.provider_id),
    /** 只为固定 contract_ref 返回离线 fixture bundle 及其合成来源。 */
    contract: (ref) =>
      ref === contractRef(origin)
        ? {
            wire: { source: origin, support_status: 'validated' },
            compiled: host.contract?.compiled ?? compiled,
            capabilities: installedCapabilities,
            capability_revision: capabilityRevision
          }
        : undefined,
    /** 从真实 Store attempt 构造该实例的 mock NativeBinding，并受来源开关控制。 */
    nativeSource: (call, attempt) => {
      const row = store.attempt(call, attempt)
      if (!row) {
        return undefined
      }
      const b = row.binding
      const native: NativeBinding = {
        kind: 'luvus',
        provider_id: b.target.provider_id,
        binding_revision: b.binding_revision,
        contract_source_ref: b.contract_ref,
        target: { machine_id: b.machine_id, profile: 'session', session: 'synthetic' },
        server_generation: G,
        connection_epoch: b.connection_epoch,
        recovery_generation: b.recovery_generation,
        capability_revision: capabilityRevision,
        classification_revision: origin.classification_revision ?? 'review1',
        contract: installedIdentity
      }
      return {
        authenticated: true,
        source_verified: configs.get(b.machine_id)!.sourceVerified,
        binding: native
      }
    },
    /** 离线 fixture 不做 provider 参数预检；生产装配另行注入真实 validateAttempt。 */
    validateAttempt: () => {},
    /** 取得测试当前 reader ID，验证读取与派发身份分别受控。 */
    currentPrincipal: () => principal.id
  })
  /** 为每条模拟连接创建真实 Wire/native adapter，并统计打开与关闭的宿主资源。 */
  const session = (connection: Connection, channel?: SocketChannel): Session => {
    openedSessions++
    /** gateway 侧会话（带 channel）用实时注册表；connector 侧会话用固定的准入快照，模拟双侧漂移。 */
    const services = channel
      ? {
          ...backendServices(connection)
        }
      : backendServices(connection)
    const backend = persistentBackend(store, services)
    let original: Session['adapter']
    if (!channel && host.connectorAdmission) {
      // 生产同款：Connector 侧 attempt 锚点在本机准入后端，不在 Gateway Store；revision 核对用快照。
      const book = new ConnectorAttemptBook({ maximum_deadline_ms: CONNECTOR_MAX_DEADLINE_MS, now: () => now })
      const admission = createConnectorAdmissionBackend({
        connection,
        routes: [...localBindings.values()]
          .filter(/** 只为已配对的 provider 建立受保护路由。 */ (p) => p.machine_id === connection.machine_id)
          .map(
            /** 路由固定 fixture principal，与生产单路由同构。 */ (p) => ({
              target: {
                machine_id: p.machine_id,
                provider_id: p.provider_id,
                profile: 'session' as const,
                session: 'synthetic'
              },
              principal_id: principal.id
            })
          ),
        book,
        source: {
          now: () => now
        }
      })
      const inner = createLuvusWireAdapter({
        ...backend,
        attempt: (call, attempt) => admission.attempt(call, attempt),
        contentStatus: (binding) => admission.contentStatus(binding),
        currentPrincipal: () => principal.id
      })
      original = connectorAdmissionAdapter(admission, inner)
    } else {
      original = channel && host.adapter ? host.adapter(connection, channel, services) : createLuvusWireAdapter(backend)
    }
    const adapter = {
      ...original,
      /** 先调用真实 adapter 编码，再记录不含认证 secret 的业务帧供扫描。 */
      encode(frame: Parameters<typeof original.encode>[0], direction: Parameters<typeof original.encode>[1]) {
        const raw = original.encode(frame, direction)
        encoded.push(raw)
        return raw
      }
    }
    let closed = false
    return {
      adapter,
      /** 组合双端 fixture binding 与本机健康，提供逐 provider 的可信 readiness 输入。 */
      readiness: () => ({
        providers: [...localBindings.values()]
          .filter(
            /** 只选属于当前模拟设备的本地 binding。 */
            (p) => p.machine_id === connection.machine_id
          )
          .map(
            /** 将对应的 Store binding、本地配置及可控原生健康组成单实例观测。 */
            (binding) => ({
              expected: store.provider(binding.machine_id, binding.provider_id)!,
              local: binding,
              native_ready: configs.get(binding.machine_id)!.native
            })
          )
      }),
      /** 幂等增加会话关闭计数，用于验证资源回收次数。 */
      close() {
        if (!closed) {
          closed = true
          closedSessions++
        }
      }
    }
  }
  const gateway = createGateway({
    hostname: '127.0.0.1',
    port: 0,
    developmentLoopback: true,
    identity: credentials,
    store,
    router,
    /** 从 fixture 的独立 caller 对象取 principal，不接受帧中的身份字段。 */
    principal: () => principal,
    session,
    limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 150 },
    ...extra
  })
  const clients: ReturnType<typeof createConnector>[] = []
  let executions = 0
  /** 用真实注册和一次性兑换建立 mock 设备、provider 与精确目标 grant。 */
  function pair(name: string) {
    const machine = admin.register(name)
    const enrollment = admin.issue(machine.machine_id)
    const credential = admin.redeem(enrollment)
    const binding = store.defineProvider({
      machine_id: machine.machine_id,
      provider_id: 'provider',
      kind: 'luvus',
      config_ref: 'mock_config',
      binding_revision: 1,
      enabled: true
    })
    localBindings.set(machine.machine_id + '/provider', binding)
    configs.set(machine.machine_id, {
      native: true,
      sourceVerified: true
    })
    const target: V2Target = {
      machine_id: machine.machine_id,
      provider_id: 'provider',
      profile: 'session',
      session: 'synthetic'
    }
    return { machine_id: machine.machine_id, credential, enrollment, target }
  }
  /** 连接到隔离 Gateway 并注入可控 native 宿主；所有授权与 token 都是无生产效力 fixture。 */
  function connector(credential: () => DeviceCredential, overrides: Partial<NativeConnectorOptions> = {}) {
    const client = createConnector({
      url: gateway.url,
      developmentLoopback: true,
      credential,
      session,
      /** 只向 mock 原生 JSON 注入无生产效力 delegated token，以测试完整帧计量。 */
      nativeInput: (input) => ({
        ...input,
        auth: { delegated_token: 'MOCK_ONLY_NO_PRODUCTION_EFFECT' }
      }),
      /** 记录模拟执行次数并按原请求 ID 返回合成响应，不启动真实原生实例。 */
      execute: async (raw) => {
        executions++
        const input = JSON.parse(raw)
        return { id: input.id, result: { id: 'mock_task' } }
      },
      limits: {
        heartbeat_ms: 30,
        idle_ms: 1500,
        handshake_ms: 150,
        reconnect_ms: 20,
        reconnect_max_ms: 200
      },
      /** 固定退避随机值，让连接拒绝和重连测试可重复。 */
      random: () => 1,
      ...overrides,
      /** 向 Connector 提供与 fixture Store 相同的可信时间。 */
      now: () => now
    })
    clients.push(client)
    return client
  }
  /** 经真实 Router 登记固定目标和契约的新调用，派发仍须另经 Store 锚点。 */
  function call(target: V2Target, client_request_key?: string) {
    return router.create(
      principal,
      target,
      { method: 'task.add', params: { title: 'synthetic' } },
      {
        binding_revision: store.provider(target.machine_id, target.provider_id)!.binding_revision,
        contract_ref: contractRef(origin),
        timeoutMs: 10_000,
        ...(client_request_key ? { client_request_key } : {})
      }
    )
  }
  return {
    store,
    router,
    principal,
    admin,
    credentials,
    gateway,
    session,
    backendServices,
    configs,
    localBindings,
    encoded,
    pair,
    connector,
    call,
    /** 返回 mock 原生实际执行次数，供不重放和限额断言。 */
    get executions() {
      return executions
    },
    /** 返回宿主会话打开/关闭计数，检查测试资源是否成对回收。 */
    get sessions() {
      return { opened: openedSessions, closed: closedSessions }
    },
    /** 读取测试当前时间，不推进任何真实凭据期限。 */
    get now() {
      return now
    },
    /** 推进 fixture 时间，便于确定性验证边界到期与时钟回退。 */
    set now(value: number) {
      now = value
    },
    /** 关闭 fixture 管理授权开关，供受保护操作拒绝测试。 */
    denyAdmin() {
      allowed = false
    },
    /** 依次停止所有 Connector、Gateway 和临时 Store，释放 timer 与 loopback 资源。 */
    stop() {
      for (const client of clients) {
        client.stop()
      }
      gateway.stop()
      store.close()
    }
  }
}
/** 轮询有界条件并用单调时间限制等待；不会改变已登记调用的 deadline。 */
export async function until(check: () => boolean, timeout = 4000): Promise<void> {
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start > timeout) {
      throw new Error('fixture_wait_timeout')
    }
    await new Promise(
      /** 短暂让出事件循环，供 socket 或异步执行状态推进。 */
      (resolve) => setTimeout(resolve, 5)
    )
  }
}
/** 建立可手工注入帧的 mock 客户端，保存收到的帧与本次 welcome epoch。 */
export function rawConnect(
  url: string,
  credential: DeviceCredential,
  offer: VersionOffer = { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] }
) {
  const ws = new WebSocket(url)
  let epoch = ''
  const frames: unknown[] = []
  ws.onopen =
    /** 链路建立后发送只含 mock 凭据的 authenticate，供违规帧测试控制后续输入。 */
    () =>
      ws.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'authenticate',
          message_id: randomUUID(),
          payload: {
            machine_id: credential.machine_id,
            recovery_generation: credential.recovery_generation,
            device_credential: credential.credential,
            connector_instance_id: 'mock_instance',
            offer
          }
        })
      )
  ws.onmessage =
    /** 记录返回帧并仅从 welcome 提取本次 epoch，测试自身不伪造认证状态。 */
    (event) => {
      const frame = JSON.parse(String(event.data))
      frames.push(frame)
      if (frame.type === 'welcome') {
        epoch = frame.payload.connection_epoch
      }
    }
  return {
    ws,
    frames,
    /** 暴露客户端实际观察到的 welcome epoch，供旧 epoch 与重复连接断言。 */
    get epoch() {
      return epoch
    }
  }
}
