/** 组合实际 Herdr 安装、生产 runtime、Store/Router/Wire 与 loopback 通道；设备身份仅具 fixture 效力。 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../../../src/store.js'
import type { NativeRequest } from '../../../src/contracts.js'
import { createConnector } from '../../../src/transport/index.js'
import type { Adapter, Connection, ConnectorWireSession } from '../../../src/transport/index.js'
import { assertBinding, boundedJson, contractRef, fail } from '../../../src/wire/index.js'
import type { AttemptBinding, Direction, JsonObject, ProviderBinding } from '../../../src/wire/types.js'
import { LuvusDispatchClaims } from '../../../src/connector/luvus/claims.js'
import { HerdrInstallation, createHerdrHostServices } from '../../../src/connector/herdr/installation.js'
import { inspectHerdrPath } from '../../../src/connector/herdr/local.js'
import { persistentHerdrBackend } from '../../../src/connector/herdr/persistence.js'
import type { HerdrReadonlyBackend } from '../../../src/connector/herdr/readonly.js'
import { createHerdrRuntime } from '../../../src/connector/herdr/runtime.js'
import { createHerdrWireAdapter } from '../../../src/connector/herdr/wire.js'
import { fixture, until } from '../../transport/helpers.js'

/** 先完成现有 mock 配对并暴露完整 Target；调用方随后显式安装/监管自己的 Herdr，再传入 connect。 */
export function createHerdrRuntimeChain(root: string, methods: readonly string[] = ['ping']) {
  inspectHerdrPath(root, 'directory')
  const config_ref = 'owned-herdr-runtime-chain'
  const binding_revision = 1
  const gatewayRoot = join(root, 'gateway-store')
  const claimsRoot = join(root, 'connector-claims')
  mkdirSync(gatewayRoot, { mode: 0o700 })
  mkdirSync(claimsRoot, { mode: 0o700 })
  const claimPath = join(claimsRoot, 'send-claims.sqlite')
  const failures: { stage: string; code: string }[] = []
  const activity = {
    gateway_sessions: 0,
    connector_sessions: 0,
    gateway_encodes: 0,
    gateway_decodes: 0,
    connector_encodes: 0,
    connector_decodes: 0,
    connector_readiness: 0
  }
  const gateways: Adapter[] = []
  const runtimes: ReturnType<typeof createHerdrRuntime>[] = []
  let installation: HerdrInstallation | undefined
  let claims: LuvusDispatchClaims | undefined
  let client: ReturnType<typeof createConnector> | undefined
  let closed = false

  /** 只记录稳定错误码用于测试定位，不保存原始 socket、schema、环境、凭据或响应。 */
  function trace<T>(stage: string, action: () => T): T {
    try {
      return action()
    } catch (error) {
      failures.push({
        stage,
        code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
      })
      throw error
    }
  }

  /** 只从当前已安装对象建立生产后端；认证和策略复用既有 fixture，来源没有替身。 */
  function backend(connection: Connection): HerdrReadonlyBackend {
    if (!installation) {
      fail('herdr_chain_installation_required')
    }
    const installed = installation
    return persistentHerdrBackend(
      f.store,
      createHerdrHostServices(installed, {
        /** 当前测试 reader 与现有 Router 共享，不从 Wire 参数接受 principal。 */
        currentPrincipal: () => f.principal.id,
        /** 保留受保护完整 provider 配置，并由 persistentHerdrBackend 与 Store 逐项核对。 */
        localProvider: (target) => f.localBindings.get(target.machine_id + '/' + target.provider_id),
        /** 只向已有认证连接注入当前双端策略和实际安装的契约记录。 */
        context(principal: string, direction: Direction) {
          if (principal && principal !== f.principal.id) {
            fail('attempt_binding_mismatch')
          }
          return {
            phase: 'authenticated',
            direction,
            connection,
            policies: { caller: f.principal.policy, local: f.local },
            resolveContract: /** 每次从同一实际安装对象取得固定完整来源。 */ (ref) => {
              const record = installed.record()
              return contractRef(record.wire.source) === ref ? record.wire : undefined
            }
          }
        }
      })
    )
  }

  const offer = { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'], required: ['rpc'] }
  const f = fixture(
    {
      offer,
      retainOriginalRead: true,
      limits: { heartbeat_ms: 100, idle_ms: 10_000, handshake_ms: 1000 }
    },
    {},
    {
      /** 私有真实 SQLite 保存调用与证据；没有改库或补造原 attempt。 */
      store: (now, options) => new Store(join(gatewayRoot, 'gateway.sqlite'), now, options),
      /** Gateway 持有独立生产 Wire 状态，来源仍由同一安装逐次验证。 */
      adapter(connection) {
        activity.gateway_sessions++
        const adapter = trace(
          'gateway_session',
          /** 构造原生产 Wire，不替换认证或来源校验。 */ () => createHerdrWireAdapter(backend(connection))
        )
        gateways.push(adapter)
        return {
          ...adapter,
          /** 只对实际业务编码增加计数和固定错误码，原帧不进入诊断。 */
          encode(frame, direction) {
            activity.gateway_encodes++
            return trace('gateway_encode', /** 保留生产编码器的全部检查。 */ () => adapter.encode(frame, direction))
          },
          /** 保留失败层次而不将原始业务帧写入验收报告。 */
          decode(input, direction) {
            activity.gateway_decodes++
            return trace(
              'gateway_decode',
              /** 使用实际 Wire decoder，不能在测试中补造成功响应。 */ () => adapter.decode(input, direction)
            )
          }
        }
      }
    }
  )
  const device = f.pair('owned-herdr-native-chain')
  const authenticate = f.credentials.authenticate.bind(f.credentials)
  f.credentials.authenticate = /** 仅记录现有 fixture 身份核验的错误码，参数和凭据不留存。 */ (...args) =>
    trace('fixture_authenticate', /** 原认证实现及其返回值均保持原样。 */ () => authenticate(...args))
  const provider: ProviderBinding = {
    machine_id: device.machine_id,
    provider_id: 'herdr',
    kind: 'herdr',
    config_ref,
    binding_revision,
    enabled: true
  }
  f.store.defineProvider(provider)
  f.localBindings.delete(device.machine_id + '/' + device.target.provider_id)
  f.localBindings.set(device.machine_id + '/' + provider.provider_id, provider)
  const target = Object.freeze({
    machine_id: device.machine_id,
    provider_id: provider.provider_id,
    profile: 'session' as const,
    session: 'synthetic'
  })
  // pair 原有 Luvus 授权只属于 fixture；只为本测试显式选择的 Herdr 方法建立完整 Target grants。
  f.principal.policy.grants.splice(0, f.principal.policy.grants.length, {
    target,
    methods: [...methods],
    actions: ['dispatch', 'read', 'cancel']
  })

  /** 只查询本测试真实发送账本，不把 accepted、socket 写入或 native 完成当作 durable claim。 */
  function claimCount(): number {
    const reader = new DatabaseSync(claimPath, { readOnly: true })
    try {
      return Number(reader.prepare('SELECT COUNT(*) AS n FROM luvus_dispatch_claims').get()!.n)
    } finally {
      reader.close()
    }
  }

  /** 经真实 Router/Wire/Store 发送显式请求；产品门禁仍逐次决定方法和参数是否可执行。 */
  async function request(
    nativeRequest: NativeRequest
  ): Promise<{ binding: AttemptBinding; response: JsonObject; claims: number }> {
    if (closed || !installation || !client || client.status().phase !== 'ready') {
      fail('herdr_chain_not_ready')
    }
    const call = f.router.create(f.principal, target, nativeRequest, {
      binding_revision,
      contract_ref: contractRef(installation.record().wire.source),
      validation: 'strict',
      timeoutMs: 10_000
    })
    const binding = f.gateway.dispatch(call.call_id)
    await until(
      /** 只有 Gateway 的真实证据 COMMIT 才产生 responded。 */ () =>
        f.store.call(f.principal.id, call.call_id).state === 'responded',
      8000
    )
    const original = f.gateway.resolveOriginalRead(call.call_id)
    if (!original) {
      fail('herdr_chain_original_read_required')
    }
    assertBinding(binding, original.binding)
    const result = f.router.get(f.principal, call.call_id)
    if (!result.response) {
      fail('herdr_chain_response_required')
    }
    const response = JSON.parse(result.response) as JsonObject
    original.wire.checkResult(binding, response)
    original.wire.checkResultRetention(binding, response)
    return { binding, response, claims: claimCount() }
  }

  return {
    root,
    target,
    config_ref,
    binding_revision,
    f,
    gateways,
    runtimes,
    failures,
    /** 交付同一个真实 transport 的只读 status 端口，供 CLI 观察循环验收使用；不建立第二通道。 */
    transport(): { status: () => ReturnType<ReturnType<typeof createConnector>['status']> } {
      if (!client) {
        fail('herdr_chain_state_invalid')
      }
      return { status: () => client!.status() }
    },
    /** 仅输出阶段、计数和 provider 健康布尔值；不包含凭据、连接 ID、原生帧或文件路径。 */
    diagnostics() {
      let connector: unknown = { phase: 'not_created' }
      let gateway: unknown
      try {
        const status = client?.status()
        if (status) {
          connector = {
            phase: status.phase,
            running: status.running,
            reconnects: status.reconnects,
            provider_ready: status.providers.map(
              /** 只保留布尔健康，不输出 provider 或设备标识。 */ (entry) => entry.ready
            )
          }
        }
      } catch (error) {
        connector = {
          phase: 'status_failed',
          code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
        }
      }
      try {
        const status = f.gateway.status()
        gateway = {
          stopped: status.stopped,
          connections: status.connections,
          unauthenticated: status.unauthenticated,
          inflight: status.inflight,
          read_contexts: status.read_contexts,
          devices: status.devices.map(
            /** 只返回认证和ready结果，不返回任何身份材料。 */ (entry) => ({
              authenticated: entry.authenticated,
              ready: entry.ready,
              provider_ready: entry.providers.map(/** 单实例仅保留就绪布尔值。 */ (value) => value.ready)
            })
          )
        }
      } catch (error) {
        gateway = { code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown' }
      }
      return { activity: { ...activity }, connector, gateway, failures: failures.slice() }
    },
    claimCount,
    /** 安装必须已经匹配完整目标和受保护配置；不会改写 installation、启动 server 或发现其它会话。 */
    async connect(installed: HerdrInstallation): Promise<void> {
      if (closed || installation || client || claims || !(installed instanceof HerdrInstallation)) {
        fail('herdr_chain_state_invalid')
      }
      if (
        boundedJson(installed.config.target) !== boundedJson(target) ||
        installed.config.config_ref !== config_ref ||
        installed.config.binding_revision !== binding_revision
      ) {
        fail('herdr_chain_installation_mismatch')
      }
      installed.assert()
      installation = installed
      claims = new LuvusDispatchClaims({
        path: claimPath,
        mode: 'create',
        ledger_id: 'owned-herdr-chain',
        limits: { entries: 128, bytes: 1_048_576 },
        /** 与真实 Store 共用 fixture 的固定可信时钟。 */
        now: () => f.store.clock()
      })
      client = createConnector({
        url: f.gateway.url,
        developmentLoopback: true,
        offer,
        /** 只向本 loopback Gateway 提供既有配对 fixture 的凭据。 */
        credential: () => device.credential,
        /** Wire 和唯一发送账本都使用原 Store 时钟。 */
        now: () => f.store.clock(),
        random: /** 固定重连采样，关闭测试后不产生额外随机重连。 */ () => 1,
        limits: { heartbeat_ms: 100, idle_ms: 10_000, handshake_ms: 1000, reconnect_ms: 50, reconnect_max_ms: 200 },
        /** 每个实际 welcome epoch 独立构造生产 runtime，共享宿主持有的 durable claims。 */
        session(connection): ConnectorWireSession {
          activity.connector_sessions++
          const runtime = trace(
            'connector_session',
            /** 实际runtime构造的任何失败均不能被ready等待吞掉。 */ () =>
              createHerdrRuntime(installed, backend(connection), claims!)
          )
          runtimes.push(runtime)
          return {
            adapter: {
              ...runtime.adapter,
              /** 追踪心跳与请求编码的固定失败码，不保存帧。 */
              encode(frame, direction) {
                activity.connector_encodes++
                return trace(
                  'connector_encode',
                  /** 调用同一生产adapter，不派生放行模块。 */ () => runtime.adapter.encode(frame, direction)
                )
              },
              /** 追踪当前连接收到的普通Wire帧，不改变解码语义。 */
              decode(input, direction) {
                activity.connector_decodes++
                return trace(
                  'connector_decode',
                  /** 调用同一生产解码和原生来源校验。 */ () => runtime.adapter.decode(input, direction)
                )
              }
            },
            /** 只执行原始已校验 Wire 请求，不注入 Luvus auth 或另造 ID。 */
            async executeWire(raw, signal) {
              try {
                return await runtime.executeWire(raw, signal)
              } catch (error) {
                failures.push({
                  stage: 'runtime',
                  code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
                })
                throw error
              }
            },
            /** 本机安装仍活跃且配置与 Store 同值才将这个 provider 报为就绪。 */
            readiness() {
              activity.connector_readiness++
              return trace(
                'connector_readiness',
                /** 就绪仍须通过同一安装和双端provider配置。 */ () => {
                  installed.assert()
                  const local = f.localBindings.get(target.machine_id + '/' + target.provider_id)
                  if (!local) {
                    fail('provider_binding_unavailable')
                  }
                  return {
                    policy_revision: 'trusted_policy1',
                    peer_policy_revision: 'trusted_policy1',
                    providers: [
                      { expected: f.store.provider(target.machine_id, target.provider_id)!, local, native_ready: true }
                    ]
                  }
                }
              )
            },
            /** 只关闭本 epoch 的桥接，不停止 caller 所有的 Herdr 安装或实例。 */
            close: runtime.close
          }
        }
      })
      await until(
        /** 只认本客户端实际握手后的 ready，不以监听端口或 TCP 连接替代。 */ () => client!.status().phase === 'ready',
        8000
      )
    },
    request,
    /** 固定 ping 沿用同一实际路径，不为健康探测建立另一执行通道。 */
    ping(): Promise<{ binding: AttemptBinding; response: JsonObject; claims: number }> {
      return request({ method: 'ping', params: {} })
    },
    /** 清理本 helper 自有通道、runtime 与 SQLite 句柄；安装、server 和目录仍由 caller 清理。 */
    close(): void {
      if (closed) {
        return
      }
      closed = true
      client?.stop()
      for (const runtime of runtimes) {
        runtime.close()
      }
      try {
        f.stop()
      } finally {
        claims?.close()
      }
    }
  }
}
