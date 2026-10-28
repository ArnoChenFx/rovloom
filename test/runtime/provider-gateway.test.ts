/** 用实际认证连接、Store 与原 Luvus Wire 验证中性 Gateway；合成身份与响应均无生产效力。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProviderGatewayRuntime } from '../../src/runtime/gateway.js'
import type {
  GatewayProviderServices,
  ProviderGatewayRuntimeOptions,
  RuntimeCallInput
} from '../../src/runtime/types.js'
import { persistentBackend } from '../../src/connector/luvus/persistence.js'
import { createLuvusWireAdapter } from '../../src/connector/luvus/wire.js'
import type { Adapter, Session } from '../../src/transport/index.js'
import type { ProviderBinding } from '../../src/wire/types.js'
import { contractRef, LIMITS } from '../../src/wire/index.js'
import { DEFAULT_LIMITS } from '../../src/connector/luvus/contract/index.js'
import { fixture as transportFixture, until } from '../transport/helpers.js'
import { source as contractSource } from '../wire/helpers.js'
import { G } from '../connector/luvus/contract/helpers.js'

type Gateway = Awaited<ReturnType<typeof createProviderGatewayRuntime>>
type Stage = 'none' | 'session' | 'adapter' | 'readiness' | 'provider'
type Settings = {
  stage?: Stage
  ready?: boolean
  revision?: string
  max_response_bytes?: number
  binding?: Partial<ProviderBinding>
  afterSession?: () => void
  observed?: { releases: number }
  close_getter_once?: boolean
}

/** 只暂停本 fixture 原生回调，后续仍由原 Connector 执行、编码和发送真实 Wire response。 */
function latch() {
  let release!: () => void
  const promise = new Promise<void>(
    /** 保存唯一恢复口，不产生第二个派发动作。 */ (resolve) => {
      release = resolve
    }
  )
  return { promise, release }
}

/** 复用既有隔离身份与 backend 服务，换装唯一中性 listener，不复制认证或原生授权实现。 */
async function fixture(settings: Settings = {}) {
  const base = transportFixture()
  const paired = base.pair('isolated_neutral_gateway')
  base.gateway.stop()
  const binding = base.store.provider(paired.machine_id, paired.target.provider_id)!
  const principal = { ...base.principal }
  const reference = contractRef({ ...contractSource, runtime_generation: G, classification_revision: 'review1' })
  let runtime: Gateway | undefined
  let client: ReturnType<typeof base.connector> | undefined
  let services: GatewayProviderServices | undefined
  const natives: Adapter[] = []
  const state = {
    sessionCalls: 0,
    sessionCloses: 0,
    releases: 0,
    ready: settings.ready ?? true,
    revision: settings.revision ?? 'local1',
    observer: true,
    caller: true,
    nativeCalls: 0,
    callbackClose: undefined as Promise<void> | undefined
  }
  const gate = latch()
  let delay = false

  /** 回调期间关闭也只观察真正角色的同一个终态，不能把客户端退出当角色释放。 */
  function closeFromCallback(): void {
    state.callbackClose ??= runtime!.close()
    assert.equal(state.callbackClose, runtime!.closed)
  }

  const options: ProviderGatewayRuntimeOptions = {
    lifecycle: { store: base.store, identityHost: base.credentials },
    identities: {
      /** 管理/设备身份不能替代请求主体；第二个主体只用于验证当前 HTTP reader 的隔离。 */
      principal(caller) {
        if (caller.principal_id === 'synthetic' && state.caller) {
          return principal
        }
        return caller.principal_id === 'observer' && state.observer ? { id: 'observer' } : null
      },
      /** 本中性 Gateway 测试从不创建或升级管理员。 */ administrator() {
        return null
      }
    },
    providers: [
      {
        binding: { ...binding, ...settings.binding },
        target: paired.target,
        max_response_bytes: settings.max_response_bytes ?? DEFAULT_LIMITS.object_bytes,
        ready: /** 设备认证不能代替当前 provider 的独立健康，回调关闭也不能越过fence。 */ () => {
          if (settings.stage === 'provider') {
            closeFromCallback()
          }
          return state.ready
        }
      }
    ],
    listener: {
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 500 }
    },
    /** 实际认证 epoch 交付冻结的原 Luvus adapter，核心仅包装当前 caller 和资源寿命。 */
    session(connection, _channel, ports): Session {
      state.sessionCalls++
      services = ports
      assert.equal(ports.store, base.store)
      assert.equal(ports.router, runtime!.router)
      assert.equal(connection.authenticated, true)
      base.store.assertConnection(connection)
      const native = createLuvusWireAdapter(
        persistentBackend(base.store, {
          ...base.backendServices(connection),
          localProvider: ports.localProvider,
          currentPrincipal: ports.currentPrincipal
        })
      )
      assert.equal(Object.isFrozen(native), true)
      natives.push(native)
      let closed = false
      let closeReads = 0
      /** 回收本epoch的真实资源；访问器异常后仍可供宿主rollback使用。 */
      function closeOwned(): void {
        if (!closed) {
          closed = true
          state.sessionCloses++
        }
      }
      const result: Session = {
        /** 读取 adapter 属性也可重入关闭；真实 adapter 不能被 Proxy 绑定方法的不变式拒绝。 */
        get adapter() {
          if (settings.stage === 'adapter') {
            closeFromCallback()
          }
          return native
        },
        /** 当前会话自己的政策及原生 readiness 必须与角色受保护配置同时通过。 */
        readiness() {
          if (settings.stage === 'readiness') {
            closeFromCallback()
          }
          return {
            providers: [{ expected: binding, local: binding, native_ready: state.ready }]
          }
        },
        /** 只释放本 epoch 资源，adapter 自身仍由原 transport/channel 关闭。 */
        get close() {
          if (settings.close_getter_once && ++closeReads === 1) {
            throw new Error('isolated_close_accessor_failure')
          }
          return closeOwned
        }
      }
      settings.afterSession?.()
      if (settings.stage === 'session') {
        closeFromCallback()
      }
      return result
    },
    /** 先停止真实 listener 和 epoch，再由唯一长期所有者关闭原 fixture Store。 */
    async release() {
      state.releases++
      if (settings.observed) {
        settings.observed.releases++
      }
      if (runtime) {
        assert.equal(runtime.transport.status().stopped, true)
        assert.equal(runtime.close(), runtime.closed)
      }
      assert.equal(state.sessionCloses, state.sessionCalls)
      for (const native of natives) {
        assert.equal(native.stats().closed, true)
      }
      base.stop()
    }
  }
  try {
    runtime = await createProviderGatewayRuntime(options)
    const active = runtime
    client = base.connector(/** 仅交付 fixture 真正一次性配对的测试设备凭据。 */ () => paired.credential, {
      url: active.transport.url,
      /** 模拟异步原生工作但不跳过原编解码/schema/permit；每次实际回调统计一次。 */
      async execute(raw) {
        state.nativeCalls++
        if (delay) {
          await gate.promise
        }
        const request = JSON.parse(raw)
        return { id: request.id, error: { code: 'isolated', message: 'preserved', data: { text: '你好🌍' } } }
      }
    })
    return {
      base,
      principal,
      paired,
      binding,
      gateway: active,
      client,
      natives,
      state,
      /** 等待真实认证与双方实际 provider readiness，不以 socket 打开代替。 */
      async ready() {
        await until(
          /** 只有同一设备和 Connector 都ready才开始派发。 */ () =>
            client!.status().phase === 'ready' &&
            active.transport
              .status()
              .devices.some(
                /** 只匹配此次实际认证的机器。 */ (device) => device.machine_id === paired.machine_id && device.ready
              )
        )
      },
      /** 暂停本 fixture 唯一原生执行，在另一 HTTP 主体活动时恢复回应。 */
      pause() {
        delay = true
      },
      resume: gate.release,
      /** 认证上下文仅由 Gateway 注入，不保存最近请求主体。 */
      currentPrincipal() {
        return services?.currentPrincipal()
      },
      /** 从已安装 fixture 契约来源取得原ref，不在请求中生成新协议身份。 */
      input(): RuntimeCallInput {
        return {
          target: paired.target,
          native_request: { method: 'task.add', params: { title: 'synthetic' } },
          options: { binding_revision: 1, contract_ref: reference, deadline: base.now + 30_000 }
        }
      },
      /** 请求结束以后仅检查持久状态，后台回应不借用当前 HTTP 身份。 */
      async responded(callId: string) {
        await until(
          /** 原生与Wire实际完成后才观察responded。 */ () => base.store.call('synthetic', callId).state === 'responded'
        )
      },
      /** 唯一角色关闭并释放全部隔离资源；恢复latch避免测试失败留下前端等待。 */
      async close() {
        gate.release()
        try {
          await active.close()
        } finally {
          base.stop()
        }
      }
    }
  } catch (error) {
    gate.release()
    try {
      await runtime?.close()
    } finally {
      base.stop()
    }
    throw error
  }
}

test(
  'neutral Gateway retains original caller evidence while another HTTP reader is active',
  /** 冻结的原 adapter 真正完成认证/派发/回应；保留使用原caller，交付仍按当前reader归属。 */ async () => {
    const f = await fixture()
    try {
      await f.ready()
      f.pause()
      const admitted = await f.gateway.runAuthenticated(
        { principal_id: 'synthetic' },
        /** 准入只返回元数据，不泄露内联正文。 */ () => f.gateway.admit(f.input())
      )
      assert.equal(admitted.created, true)
      assert.equal(admitted.call.response, null)
      await until(/** 原生执行已实际开始但尚未响应。 */ () => f.state.nativeCalls === 1)
      assert.equal(f.currentPrincipal(), undefined)
      await f.gateway.runAuthenticated(
        { principal_id: 'observer' },
        /** 在不同HTTP主体存续期间恢复原caller的真实回应。 */ async () => {
          assert.equal(f.currentPrincipal(), 'observer')
          f.resume()
          await f.responded(admitted.call.call_id)
          assert.equal(f.currentPrincipal(), 'observer')
          assert.throws(
            /** 即使拥有同范围grant，另一caller仍不能取得原结果。 */ () => f.gateway.results.open(admitted.call.call_id)
          )
        }
      )
      assert.equal(f.currentPrincipal(), undefined)
      assert.notEqual(f.base.store.call('synthetic', admitted.call.call_id).response, null)
      await f.gateway.runAuthenticated(
        { principal_id: 'synthetic' },
        /** 原caller重新认证后仍需原Wire及当前ACL才可以读取已保留结果。 */ () => {
          assert.equal(f.gateway.get(admitted.call.call_id).response, null)
          const result = f.gateway.results.open(admitted.call.call_id)
          const page = f.gateway.results.read(result.result_id)
          assert.equal(JSON.parse(Buffer.from(page.data, 'base64').toString()).error.data.text, '你好🌍')
          assert.equal(page.expires, result.expires)
        }
      )
      assert.equal(f.state.nativeCalls, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'neutral Gateway response budget commits only minimum evidence for oversized native responses',
  /** 原Wire生成真实证据后只收窄保留意图，超provider预算不能创建正文或结果句柄。 */ async () => {
    const f = await fixture({ max_response_bytes: 8 })
    try {
      await f.ready()
      const admitted = await f.gateway.runAuthenticated(
        { principal_id: 'synthetic' },
        /** 小结果预算不变成新的派发或原生许可。 */ () => f.gateway.admit(f.input())
      )
      await f.responded(admitted.call.call_id)
      const stored = f.base.store.call('synthetic', admitted.call.call_id)
      assert.equal(stored.state, 'responded')
      assert.equal(stored.response, null)
      assert.equal(stored.content_status, 'unavailable')
      await f.gateway.runAuthenticated(
        { principal_id: 'synthetic' },
        /** 已保留的最小证据不可以恢复正文或句柄。 */ () => {
          const attempt = f.gateway.originalAttempt(stored.call_id, stored.attempt_id!)!
          const evidence = f.base.store.responseAnchor(attempt.binding).evidence!
          assert(evidence.response_bytes > 8)
          assert.match(evidence.response_hash, /^[0-9a-f]{64}$/)
          assert.throws(
            /** 原caller也不能越过metadata-only结果。 */ () => f.gateway.results.open(stored.call_id),
            /result_not_ready/
          )
        }
      )
      assert.equal(f.state.nativeCalls, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'neutral Gateway keeps the original caller result while another HTTP reader is active',
  /** 另一 HTTP 主体存续期间，后台响应仍按原派发主体提交并只对原主体可读。 */ async () => {
    const f = await fixture()
    try {
      await f.ready()
      f.pause()
      const admitted = await f.gateway.runAuthenticated(
        { principal_id: 'synthetic' },
        /** 先在真实read/dispatch授权下建立原请求。 */ () => f.gateway.admit(f.input())
      )
      await until(/** 只在实际派发之后切换另一个 reader。 */ () => f.state.nativeCalls === 1)
      await f.gateway.runAuthenticated(
        { principal_id: 'observer' },
        /** 保持另一个已授权reader活动，后台响应仍只能按原caller判保留。 */ async () => {
          f.resume()
          await f.responded(admitted.call.call_id)
        }
      )
      const stored = f.base.store.call('synthetic', admitted.call.call_id)
      assert.notEqual(stored.response, null)
      assert.equal(stored.content_status, 'available')
      await f.gateway.runAuthenticated({ principal_id: 'synthetic' }, () => {
        const meta = f.gateway.results.open(stored.call_id)
        assert.equal(Buffer.from(f.gateway.results.read(meta.result_id).data, 'base64').toString(), stored.response)
      })
      assert.equal(f.state.nativeCalls, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'neutral Gateway rejects another session target and stale canonical provider configuration',
  /** 完整session目标与持久revision/config始终一致，不按同kind或provider名退回最近实例。 */ async () => {
    const f = await fixture()
    try {
      await f.ready()
      const request = f.input()
      await assert.rejects(
        f.gateway.runAuthenticated(
          { principal_id: 'synthetic' },
          /** 同provider不能改选未配置的原生session。 */ () =>
            f.gateway.admit({
              ...request,
              target: {
                machine_id: request.target.machine_id,
                provider_id: request.target.provider_id,
                profile: 'session',
                session: 'other_session'
              }
            })
        ),
        /provider_binding_mismatch/
      )
      f.base.store.setProviderEnabled(f.binding.machine_id, f.binding.provider_id, 1, true)
      await assert.rejects(
        f.gateway.runAuthenticated(
          { principal_id: 'synthetic' },
          /** 旧静态配置不能热认领新的canonical provider。 */ () => f.gateway.admit(request)
        ),
        /provider_binding_mismatch/
      )
      assert.equal(f.state.nativeCalls, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  'neutral Gateway rolls back a returned session when its close accessor throws before registration',
  /** 真实原adapter尚未注册到channel时的属性异常也必须触发closeSession完整回滚。 */ async () => {
    const f = await fixture({ close_getter_once: true })
    try {
      await until(/** 等待真实身份验证后的provider工厂确实返回会话。 */ () => f.state.sessionCalls > 0)
      f.client.stop()
      assert.equal(f.state.sessionCalls, 1)
      assert.equal(f.state.sessionCloses, 1)
      assert.equal(f.natives[0]!.stats().closed, true)
      assert.equal(f.state.nativeCalls, 0)
    } finally {
      await f.close()
    }
  }
)

for (const condition of ['not_ready'] as const) {
  test(
    'neutral Gateway refuses dispatch while provider ' + condition + ' is current',
    /** 设备已认证也不能替代独立原生健康或双端配置修订。 */ async () => {
      const f = await fixture(condition === 'not_ready' ? { ready: false } : { revision: 'wrong_revision' })
      try {
        await until(/** 先证明真正建立了被认证epoch及provider会话。 */ () => f.state.sessionCalls === 1)
        const admitted = await f.gateway.runAuthenticated(
          { principal_id: 'synthetic' },
          /** 只登记可对账元数据，拒绝在ready失败时创建派发锚点。 */ () => f.gateway.admit(f.input())
        )
        assert.equal(admitted.call.state, 'created')
        assert.equal(admitted.call.attempt_id, null)
        assert.equal(f.state.nativeCalls, 0)
      } finally {
        await f.close()
      }
    }
  )
}

for (const stage of ['session', 'adapter', 'readiness', 'provider'] as const) {
  test(
    'neutral Gateway closes reentrantly during ' + stage + ' and releases the returned provider once',
    /** 关闭回调返回的真实会话不得晚注册或遗留；长期release必须在epoch清理后恰好执行一次。 */ async () => {
      const f = await fixture({ stage })
      try {
        await until(
          /** 实际状态观测触发真实readiness，关闭仍须由认证会话回调产生。 */ () => {
            f.gateway.transport.status()
            return f.state.callbackClose !== undefined
          }
        )
        assert.equal(f.state.callbackClose, f.gateway.closed)
        await f.gateway.closed
        assert.equal(f.gateway.transport.status().stopped, true)
        assert.equal(f.state.sessionCalls, 1)
        assert.equal(f.state.sessionCloses, 1)
        assert.equal(f.state.releases, 1)
        assert.equal(f.state.nativeCalls, 0)
      } finally {
        await f.close()
      }
    }
  )
}

for (const invalid of ['binding', 'zero', 'oversized'] as const) {
  test(
    'neutral Gateway rejects startup provider ' + invalid + ' and still releases its owner',
    /** 启动配置不能伪造canonical provider或扩大硬预算，失败仍按已有Gateway生命周期清理。 */ async () => {
      const observed = { releases: 0 }
      const settings: Settings = { observed }
      if (invalid === 'binding') {
        settings.binding = { config_ref: 'other_config' }
      } else if (invalid === 'zero') {
        settings.max_response_bytes = 0
      } else {
        settings.max_response_bytes = LIMITS.object_bytes + 1
      }
      await assert.rejects(fixture(settings))
      assert.equal(observed.releases, 1)
    }
  )
}
