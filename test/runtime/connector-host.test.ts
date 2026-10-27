// 验证中性 Connector 角色的共享关闭、真实 welcome 重入和 provider 资源回收，不冒充任何原生协议。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {} from 'node:fs'
import {} from 'node:path'
import {} from 'node:url'
import { GatewayError } from '../../src/contracts.js'
import { ConnectorHostStartupError, createProviderConnectorRuntime } from '../../src/runtime/connector-host.js'
import type { ConnectorHostOptions } from '../../src/runtime/connector-host.js'
import type { Connection, ConnectorWireSession } from '../../src/transport/index.js'
import type {} from '../../src/wire/types.js'
import { decodeWireFrame, encodeWireFrame } from '../../src/wire/index.js'
import { fixture, until } from '../transport/helpers.js'
import { composeConnectorSessions } from '../../src/runtime/provider-sessions.js'
import { probeHostProfile } from '../../src/platform/host.js'
import { PRODUCT_VERSION } from '../../src/mcp/version.js'

const privateFailure = 'ISOLATED_PRIVATE_PROVIDER_FAILURE /not-a-real-private-path'

/** 无 Gateway 的启动/关闭测试只提供未使用的隔离凭据，不能建立任何 provider 来源。 */
function options(release: ConnectorHostOptions['release']): ConnectorHostOptions {
  return {
    transport: {
      url: 'ws://127.0.0.1:1/connector',
      developmentLoopback: true,
      credential: /** 此端口没有接收方，凭据仅供本进程关闭回归。 */ () => ({
        machine_id: 'isolated_machine',
        recovery_generation: 'isolated_generation',
        credential: 'isolated_unused_credential'
      })
    },
    /** 无 Gateway 时不能意外创建会话，也没有默认原生 adapter。 */
    session() {
      throw new Error('unexpected_session')
    },
    release
  }
}

/** 只接纳稳定的中性错误码，provider 的原始异常不能进入公开结果。 */
function failure(code: string) {
  return /** 核对类型、码和全部 message，不接受带路径或原始异常的包装。 */ (error: unknown) => {
    assert(error instanceof GatewayError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.equal(error.message.includes(privateFailure), false)
    return true
  }
}

test(
  'provider Connector shares close and closed, stops before release and releases once under reentry',
  /** 释放回调重入只观察同一个 Promise，连接拒绝与客户端状态不改变角色关闭顺序。 */ async () => {
    let releases = 0
    const runtime = await createProviderConnectorRuntime(
      options(
        /** 真实 transport 已停止后才可释放长期 provider 资源。 */ async () => {
          releases++
          assert.equal(runtime.transport.status().phase, 'stopped')
          assert.equal(runtime.close(), runtime.closed)
        }
      )
    )
    try {
      const first = runtime.close()
      assert.equal(first, runtime.closed)
      assert.equal(runtime.close(), first)
      await first
      assert.equal(runtime.close(), first)
      assert.equal(releases, 1)
      assert.equal(await runtime.releaseSettled, 'released')
      assert.deepEqual(runtime.releaseStatus(), { state: 'released', owner_held: false })
      assert.equal(runtime.transport.status().phase, 'stopped')
    } finally {
      await runtime.close()
    }
  }
)

test(
  'provider Connector release failure rejects its shared close result without exposing the owner error',
  /** 释放失败仍保持 stopped，不重试释放，也不能把 raw provider 异常交给上层。 */ async () => {
    let releases = 0
    const runtime = await createProviderConnectorRuntime(
      options(
        /** 故意失败的长期所有者不包含任何真实秘密。 */ async () => {
          releases++
          throw new Error(privateFailure)
        }
      )
    )
    const first = runtime.close()
    assert.equal(runtime.closed, first)
    assert.equal(runtime.close(), first)
    await assert.rejects(first, failure('connector_runtime_close_failed'))
    await assert.rejects(runtime.closed, failure('connector_runtime_close_failed'))
    assert.equal(runtime.close(), first)
    assert.equal(runtime.transport.status().phase, 'stopped')
    assert.equal(releases, 1)
    assert.equal(await runtime.releaseSettled, 'failed')
    assert.deepEqual(runtime.releaseStatus(), { state: 'failed', owner_held: true })
  }
)

test(
  'provider Connector invalid startup waits for owner release and returns a stable startup error',
  /** 非法地址在原 transport 中失败，工厂仍等真实 release 收尾，不产生替代连接或协议。 */ async () => {
    let released = false
    const input = options(
      /** 通过实际异步步骤确认启动拒绝不会越过尚未完成的释放。 */ async () => {
        await Promise.resolve()
        released = true
      }
    )
    await assert.rejects(
      createProviderConnectorRuntime({ ...input, transport: { ...input.transport, url: 'invalid' } }),
      failure('connector_runtime_start_failed')
    )
    assert.equal(released, true)
  }
)

type Stage = 'none' | 'session' | 'adapter' | 'readiness' | 'reconnect'
type CleanupFailure = 'none' | 'adapter' | 'resource' | 'async_resource' | 'release'

/** 仅处理真实 Wire 握手后的心跳；没有原生 validator、方法分类或可执行请求，不能冒充 Herdr/UHP。 */
function dummySession(
  connection: Connection,
  callbacks: {
    adapter(): void
    readiness(): void
    adapterClose(): void
    resourceClose(): unknown
  }
): ConnectorWireSession {
  let closed = false
  const adapter = {
    /** 心跳继续使用既有 Wire codec，不在测试中重写 envelope 或 native 协议。 */
    encode(
      frame: Parameters<ConnectorWireSession['adapter']['encode']>[0],
      direction: Parameters<ConnectorWireSession['adapter']['encode']>[1]
    ) {
      assert.equal(closed, false)
      return encodeWireFrame(frame, { phase: 'authenticated', direction, connection })
    },
    /** 对端心跳也由真实 codec 验证；缺原生门禁的 request 无法因此获得执行许可。 */
    decode(input: string | Uint8Array, direction: Parameters<ConnectorWireSession['adapter']['decode']>[1]) {
      assert.equal(closed, false)
      return decodeWireFrame(input, { phase: 'authenticated', direction, connection })
    },
    /** 本文件不发送重复业务消息；这里只让心跳经过 transport 的既有观察路径。 */
    observeMessage() {
      return 'new' as const
    },
    stats: () => ({ closed, executions: 0, responses: 0 }),
    /** 回收本 dummy adapter 并统计角色实际调用次数。 */
    close() {
      closed = true
      callbacks.adapterClose()
    }
  } as unknown as ConnectorWireSession['adapter']
  return {
    /** 属性读取本身也可同步触发角色关闭，模拟 provider 交付期间的重入。 */
    get adapter() {
      callbacks.adapter()
      return adapter
    },
    /** 空 provider 集合只表示没有实例就绪，不能据此建立任何 native 来源。 */
    readiness() {
      callbacks.readiness()
      return { policy_revision: 'isolated_policy', peer_policy_revision: 'isolated_policy', providers: [] }
    },
    /** 此生命周期 fixture 从不派发原生请求；意外调用必须立即失败。 */
    async executeWire() {
      throw new Error('unexpected_native_execution')
    },
    /** 所有者实际清理仍由 provider 交付，角色只计量失败。 */
    close() {
      return callbacks.resourceClose() as void
    }
  }
}

for (const mixed of [false, true]) {
  for (const collector of ['default', 'explicit'] as const) {
    test(`中性 Connector ${mixed ? '混合' : 'Herdr'} 使用 ${collector} 采集器上报真实 host 帧与原版本 getter`, async () => {
      const offer = { major: 2, minor: 2, capabilities: ['rpc', 'host_profile'], required: ['rpc'] }
      const f = fixture({ offer })
      const paired = f.pair('neutral_host_profile')
      const herdr = f.store.defineProvider({
        machine_id: paired.machine_id,
        provider_id: 'herdr',
        kind: 'herdr',
        config_ref: 'synthetic_herdr',
        binding_revision: 1,
        enabled: true
      })
      f.localBindings.set(paired.machine_id + '/herdr', herdr)
      const versions = mixed
        ? [
            { provider_id: 'provider', native_version: '0.14.3' },
            { provider_id: 'herdr', native_version: '0.9.5' }
          ]
        : [{ provider_id: 'herdr', native_version: '0.9.5' }]
      let reads = 0
      const runtime = await createProviderConnectorRuntime({
        transport: {
          url: f.gateway.url,
          developmentLoopback: true,
          credential: () => paired.credential,
          offer,
          now: () => f.now,
          ...(collector === 'explicit' ? { hostProfile: () => probeHostProfile(PRODUCT_VERSION) } : {})
        },
        session(connection) {
          const groups = versions.map((version) => {
            const binding = f.store.provider(paired.machine_id, version.provider_id)!
            const target = { ...paired.target, provider_id: version.provider_id }
            const session = dummySession(connection, {
              adapter() {},
              readiness() {},
              adapterClose() {},
              resourceClose() {}
            })
            session.readiness = () => ({
              policy_revision: 'synthetic',
              peer_policy_revision: 'synthetic',
              providers: [{ expected: binding, local: binding, native_ready: true }]
            })
            session.nativeVersions = function () {
              assert.equal(this, session)
              reads++
              return [version]
            }
            return { providers: [{ binding, target }], session }
          })
          return mixed ? composeConnectorSessions(connection, groups, () => f.now) : groups[0]!.session
        },
        async release() {}
      })
      try {
        const scope = { machine_ids: [paired.machine_id], include_host: true }
        await until(() => !!f.gateway.observations.snapshot(scope).machine_metadata?.[0]?.host)
        const host = f.gateway.observations.snapshot(scope).machine_metadata![0]!.host!
        assert.equal(host.agent_version, PRODUCT_VERSION)
        assert.equal(host.os.family, process.platform)
        assert.equal(host.source, 'connector_handshake')
        assert.deepEqual(host.providers, versions)
        assert.equal(reads, versions.length)
      } finally {
        await runtime.close()
        f.stop()
      }
    })
  }
}

for (const phase of ['getter', 'callback'] as const) {
  test(`中性版本 ${phase} 关闭角色后不能交付 host 或晚到版本`, async () => {
    const offer = { major: 2, minor: 2, capabilities: ['rpc', 'host_profile'], required: ['rpc'] }
    const f = fixture({ offer })
    const paired = f.pair('closing_version_source')
    let calls = 0
    const runtime: Awaited<ReturnType<typeof createProviderConnectorRuntime>> = await createProviderConnectorRuntime({
      transport: {
        url: f.gateway.url,
        developmentLoopback: true,
        credential: () => paired.credential,
        offer,
        now: () => f.now
      },
      session(connection) {
        const current = dummySession(connection, {
          adapter() {},
          readiness() {},
          adapterClose() {},
          resourceClose() {}
        })
        Object.defineProperty(current, 'nativeVersions', {
          get() {
            if (phase === 'getter') {
              void runtime.close()
            }
            return function () {
              calls++
              void runtime.close()
              return [{ provider_id: 'provider', native_version: '0.14.3' }]
            }
          }
        })
        return current
      },
      async release() {}
    })
    try {
      await until(() => runtime.transport.status().phase === 'stopped')
      await runtime.closed
      assert.equal(calls, phase === 'getter' ? 0 : 1)
      assert.equal(
        f.gateway.observations.snapshot({ machine_ids: [paired.machine_id], include_host: true }).machine_metadata?.[0]
          ?.host,
        undefined
      )
    } finally {
      await runtime.close()
      f.stop()
    }
  })
}

/** 用已有隔离身份 fixture 完成真实 authenticate/welcome，只验证角色资源，不调用 native 方法。 */
async function welcome(stage: Stage, cleanupFailure: CleanupFailure = 'none'): Promise<void> {
  const gateway = fixture()
  const paired = gateway.pair('isolated_provider_host')
  let runtime!: Awaited<ReturnType<typeof createProviderConnectorRuntime>>
  let callbackClose: Promise<void> | undefined
  let sessionCalls = 0
  let adapterCloses = 0
  let resourceCloses = 0
  let releases = 0

  /** 实际认证回调中的关闭必须与后续观察者使用同一个最终 Promise。 */
  function stopFromCallback(): void {
    callbackClose ??= runtime.close()
    assert.equal(runtime.close(), callbackClose)
  }

  try {
    runtime = await createProviderConnectorRuntime({
      transport: {
        url: gateway.gateway.url,
        developmentLoopback: true,
        credential: /** 只使用本 fixture 真实一次性配对后的合成设备凭据。 */ () => paired.credential,
        now: /** 设备通道共用 fixture 的可信时间，不给原生执行提供时间来源。 */ () => gateway.now,
        limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 1000, reconnect_ms: 30, reconnect_max_ms: 30 }
      },
      /** 只有真实 welcome 才交付本机对应连接；provider 在返回前关闭也必须被工厂回收。 */
      session(connection) {
        sessionCalls++
        assert.equal(connection.authenticated, true)
        assert.equal(connection.machine_id, paired.machine_id)
        gateway.store.assertConnection(connection)
        const result = dummySession(connection, {
          /** 在读取已返回的 adapter 时重入关闭，不能继续注册该会话。 */
          adapter() {
            if (stage === 'adapter') {
              stopFromCallback()
            }
          },
          /** 注册后健康查询重入关闭，返回值不能让 stopped 变回 authenticated。 */
          readiness() {
            if (stage === 'readiness') {
              stopFromCallback()
            }
          },
          /** adapter 清理异常也须影响角色结果，同时不能阻止 resource 清理。 */
          adapterClose() {
            adapterCloses++
            if (cleanupFailure === 'adapter') {
              throw new Error(privateFailure)
            }
          },
          /** 逐次关闭 provider 所有者；非法异步返回也必须失败并消费其拒绝。 */
          resourceClose() {
            resourceCloses++
            if (cleanupFailure === 'resource') {
              throw new Error(privateFailure)
            }
            if (cleanupFailure === 'async_resource') {
              return Promise.reject(new Error(privateFailure))
            }
          }
        })
        if (stage === 'session') {
          stopFromCallback()
        }
        return result
      },
      /** 回滚及全部 epoch 资源同步回收后，才释放唯一长期所有者。 */
      async release() {
        releases++
        assert.equal(runtime.transport.status().phase, 'stopped')
        assert.equal(resourceCloses, sessionCalls)
        assert.equal(adapterCloses, sessionCalls)
        if (cleanupFailure === 'release') {
          throw new Error(privateFailure)
        }
      }
    })
    await until(/** 等待实际 welcome 而非 TCP 打开。 */ () => sessionCalls > 0)
    if (stage === 'reconnect') {
      gateway.gateway.disconnect(paired.machine_id)
      await until(/** 新 epoch 必须真正再次认证并创建独立 provider 会话。 */ () => sessionCalls === 2)
    }
    if (stage === 'none' || stage === 'reconnect') {
      callbackClose = runtime.close()
    } else {
      await until(/** session、adapter 或健康回调须实际触发关闭。 */ () => callbackClose !== undefined)
    }
    assert.equal(runtime.closed, callbackClose)
    assert.equal(runtime.close(), callbackClose)
    if (cleanupFailure === 'none') {
      await callbackClose
    } else {
      await assert.rejects(callbackClose!, failure('connector_runtime_close_failed'))
      await assert.rejects(runtime.closed, failure('connector_runtime_close_failed'))
    }
    assert.equal(sessionCalls, stage === 'reconnect' ? 2 : 1)
    assert.equal(adapterCloses, sessionCalls)
    assert.equal(resourceCloses, sessionCalls)
    assert.equal(releases, 1)
    assert.equal(runtime.transport.status().phase, 'stopped')
    assert.equal(gateway.executions, 0)
  } finally {
    try {
      await runtime?.close().catch(/** 已验证的关闭失败不阻止 fixture 释放自有 Gateway。 */ () => {})
    } finally {
      gateway.stop()
    }
  }
}

for (const stage of ['none', 'session', 'adapter', 'readiness', 'reconnect'] as const) {
  test(
    'provider Connector owns real welcome sessions across ' + stage + ' lifecycle',
    /** 各个真实回调边界都须维持最终 stopped、独立 epoch 和一次资源回收。 */ async () => welcome(stage)
  )
}

for (const cleanupFailure of ['adapter', 'resource', 'async_resource', 'release'] as const) {
  test(
    'provider Connector propagates ' + cleanupFailure + ' failure after welcome reentrant rollback',
    /** 关闭失败不能被 transport 的内部捕获或较早安排的成功 closed 覆盖。 */ async () =>
      welcome('session', cleanupFailure)
  )
}

/** 显式控制原 release 的唯一结算，不依靠额外释放或重试来结束回归。 */
function releaseGate() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>(
    /** 保存原回调的唯一结算入口，晚结果仍属于同一次所有者释放。 */ (accept, refuse) => {
      resolve = accept
      reject = refuse
    }
  )
  return { promise, resolve, reject }
}

/** 为坏实现设置较宽测试等待上限；产品关闭预算仍由公开的 release_timeout_ms 决定。 */
async function bounded<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>(
        /** 缺产品逻辑上限时快速暴露回归，不让测试进程永久等待。 */ (_resolve, reject) => {
          timer = setTimeout(
            /** 只使用隔离错误，不能混入 owner 原异常。 */ () => reject(new Error('isolated_test_wait_exceeded')),
            milliseconds
          )
        }
      )
    ])
  } finally {
    clearTimeout(timer)
  }
}

test(
  'provider Connector permanent release has a bounded logical failure and retains its unsettled owner',
  /** 永久 pending 不能卡死 close，也不能伪称释放完成、解除 owner 或启动第二次释放。 */ async () => {
    const owner = releaseGate()
    let releases = 0
    const runtime = await createProviderConnectorRuntime({
      ...options(
        /** 这个唯一回调始终不结算，长期观察入口必须保持 pending。 */ () => {
          releases++
          return owner.promise
        }
      ),
      release_timeout_ms: 20
    })
    assert.deepEqual(runtime.releaseStatus(), { state: 'not_started', owner_held: true })
    const closing = runtime.close()
    assert.equal(closing, runtime.closed)
    await assert.rejects(bounded(closing), failure('connector_runtime_close_timeout'))
    assert.equal(runtime.close(), closing)
    assert.equal(releases, 1)
    assert.deepEqual(runtime.releaseStatus(), { state: 'pending', owner_held: true })
    assert.equal(runtime.transport.status().phase, 'stopped')
    let observed = false
    void runtime.releaseSettled.then(
      /** 逻辑超时不结算独立的物理回调观察。 */ () => {
        observed = true
      }
    )
    await new Promise<void>(/** 留出事件循环证明长期观察尚未被伪结算。 */ (resolve) => setImmediate(resolve))
    assert.equal(observed, false)
  }
)

for (const later of ['released', 'failed'] as const) {
  test(
    'provider Connector keeps the timed-out close result after its original release later ' + later,
    /** 晚成功或晚拒绝只更新原回调观察，close 同一 Promise 不改判且永远只释放一次。 */ async () => {
      const owner = releaseGate()
      let releases = 0
      const runtime = await createProviderConnectorRuntime({
        ...options(
          /** 原回调重入也只能观察同一个有界关闭结果。 */ () => {
            releases++
            assert.equal(runtime.close(), runtime.closed)
            return owner.promise
          }
        ),
        release_timeout_ms: 20
      })
      const closing = runtime.close()
      await assert.rejects(bounded(closing), failure('connector_runtime_close_timeout'))
      const initial = await Promise.allSettled([closing, runtime.closed])
      assert.deepEqual(runtime.releaseStatus(), { state: 'pending', owner_held: true })
      if (later === 'released') {
        owner.resolve()
      } else {
        owner.reject(new Error(privateFailure))
      }
      assert.equal(await bounded(runtime.releaseSettled), later)
      assert.deepEqual(runtime.releaseStatus(), { state: later, owner_held: later !== 'released' })
      assert.equal(runtime.close(), closing)
      const final = await Promise.allSettled([closing, runtime.closed])
      for (let index = 0; index < initial.length; index++) {
        const before = initial[index]!
        const after = final[index]!
        assert.equal(before.status, 'rejected')
        assert.equal(after.status, 'rejected')
        if (before.status === 'rejected' && after.status === 'rejected') {
          assert.equal(after.reason, before.reason)
          failure('connector_runtime_close_timeout')(after.reason)
        }
      }
      assert.equal(releases, 1)
    }
  )
}

test(
  'provider Connector startup failure exposes the same bounded shutdown while its owner remains pending',
  /** 启动异常同样有界返回，错误对象继续保留唯一 owner 和长期观察入口。 */ async () => {
    const owner = releaseGate()
    let releases = 0
    const input = options(
      /** 即使 transport 启动失败也必须保留并调用这个原所有者。 */ () => {
        releases++
        return owner.promise
      }
    )
    const error = await bounded(
      createProviderConnectorRuntime({
        ...input,
        transport: { ...input.transport, url: 'invalid' },
        release_timeout_ms: 20
      })
    ).catch(/** 只取公开错误对象验证归属，不展开原异常。 */ (failure: unknown) => failure)
    assert(error instanceof ConnectorHostStartupError)
    failure('connector_runtime_start_failed')(error)
    assert.equal(error.shutdown.close(), error.shutdown.closed)
    await assert.rejects(error.shutdown.closed, failure('connector_runtime_close_timeout'))
    assert.deepEqual(error.shutdown.releaseStatus(), { state: 'pending', owner_held: true })
    let observed = false
    void error.shutdown.releaseSettled.then(
      /** 未结算的原回调不能被 startup 包装伪装成释放完成。 */ () => {
        observed = true
      }
    )
    await new Promise<void>(/** 检查 pending 观察经过事件循环仍保持未结算。 */ (resolve) => setImmediate(resolve))
    assert.equal(observed, false)
    assert.equal(releases, 1)
  }
)

for (const later of ['released', 'failed'] as const) {
  test(
    'provider Connector startup shutdown retains observation when the original owner later ' + later,
    /** 工厂已经拒绝后，错误句柄仍能观察原回调晚结算且不产生第二次释放。 */ async () => {
      const owner = releaseGate()
      let releases = 0
      const input = options(
        /** 此 promise 在启动失败返回以后才由测试结算。 */ () => {
          releases++
          return owner.promise
        }
      )
      const error = await bounded(
        createProviderConnectorRuntime({
          ...input,
          transport: { ...input.transport, url: 'invalid' },
          release_timeout_ms: 20
        })
      ).catch(/** 保留同一个带 shutdown 的安全启动错误。 */ (failure: unknown) => failure)
      assert(error instanceof ConnectorHostStartupError)
      failure('connector_runtime_start_failed')(error)
      const closing = error.shutdown.close()
      await assert.rejects(closing, failure('connector_runtime_close_timeout'))
      if (later === 'released') {
        owner.resolve()
      } else {
        owner.reject(new Error(privateFailure))
      }
      assert.equal(await bounded(error.shutdown.releaseSettled), later)
      assert.deepEqual(error.shutdown.releaseStatus(), { state: later, owner_held: later !== 'released' })
      assert.equal(error.shutdown.close(), closing)
      await assert.rejects(closing, failure('connector_runtime_close_timeout'))
      assert.equal(releases, 1)
    }
  )
}

test(
  'provider Connector invalid release budgets still clean the accepted owner with a safe startup error',
  /** 坏配置不能在 owner 交付后直接抛错跳过释放；默认清理预算适用于全部非法值。 */ async () => {
    for (const budget of [0, -1, 1.5, NaN, Infinity, 5001, null, '20']) {
      let releases = 0
      const error = await bounded(
        createProviderConnectorRuntime({
          ...options(
            /** 原所有者快速结算，验证非法预算也会恰好清理一次。 */ async () => {
              releases++
            }
          ),
          release_timeout_ms: budget as number
        })
      ).catch(/** 只验证稳定启动错误与关闭观察，不泄露校验内部细节。 */ (failure: unknown) => failure)
      assert(error instanceof ConnectorHostStartupError)
      failure('connector_runtime_start_failed')(error)
      await error.shutdown.closed
      assert.equal(await error.shutdown.releaseSettled, 'released')
      assert.deepEqual(error.shutdown.releaseStatus(), { state: 'released', owner_held: false })
      assert.equal(releases, 1)
    }
  }
)

test(
  'provider Connector invalid release budget uses the finite product default for an indefinitely pending owner',
  { timeout: 10_000 },
  /** Infinity 不能使启动清理永久等待；默认五秒预算结束后仍保留未确认 owner。 */ async () => {
    const owner = releaseGate()
    let releases = 0
    const error = await bounded(
      createProviderConnectorRuntime({
        ...options(
          /** 永久等待用于核实坏配置的默认有界兜底。 */ () => {
            releases++
            return owner.promise
          }
        ),
        release_timeout_ms: Infinity
      }),
      8000
    ).catch(/** 超时只能公开稳定启动错误和同一个长期观察句柄。 */ (failure: unknown) => failure)
    assert(error instanceof ConnectorHostStartupError)
    failure('connector_runtime_start_failed')(error)
    await assert.rejects(error.shutdown.closed, failure('connector_runtime_close_timeout'))
    assert.deepEqual(error.shutdown.releaseStatus(), { state: 'pending', owner_held: true })
    assert.equal(error.shutdown.close(), error.shutdown.closed)
    assert.equal(releases, 1)
  }
)
