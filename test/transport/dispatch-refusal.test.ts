// 使用真实 loopback、Store 和 Wire，执行层为明确不启动原生进程的合成 stub。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConnectorCapacityError } from '../../src/connector/capacity.js'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import { contractRef } from '../../src/wire/index.js'
import { fixture, rawConnect, until } from './helpers.js'
import { wireFixture } from './wire-execution-helpers.js'
import { Store } from '../../src/store.js'
import { createGateway } from '../../src/transport/gateway.js'
import { randomUUID } from 'node:crypto'
import { createLuvusWireAdapter } from '../../src/wire/native.js'
import { persistentBackend } from '../../src/wire/persistence.js'
import { responseFrame } from '../storage/helpers.js'
import type { AttemptBinding, AuthenticatedEnvelope } from '../../src/wire/types.js'

test(
  'Gateway raw 编码拒绝未写 socket，释放逐调用资源且不打断同通道的在途调用',
  /** 真实 Store/Router/原生 raw gate 与 loopback；执行器只返回合成 task，不启动 native。 */ async () => {
    const f = fixture({ limits: { inflight: 2, read_contexts: 2 }, retainOriginalRead: true })
    const device = f.pair('synthetic_gateway_raw_refusal')
    let finish: (() => void) | undefined
    let executions = 0
    const client = f.connector(() => device.credential, {
      execute(raw) {
        executions++
        const result = { id: JSON.parse(raw).id, result: { id: 'synthetic_task' } }
        return executions === 1
          ? new Promise((resolve) => {
              finish = () => resolve(result)
            })
          : Promise.resolve(result)
      }
    })
    try {
      await until(() => client.status().phase === 'ready')
      const epoch = client.status().connection_epoch
      const pending = f.call(device.target)
      const pendingBinding = f.gateway.dispatch(pending.call_id)
      await until(
        () => finish !== undefined && f.store.call(f.principal.id, pending.call_id).state === 'connector_accepted'
      )
      for (let index = 0; index < 4; index++) {
        const denied = f.router.create(
          f.principal,
          device.target,
          { method: 'agent.prompt', params: { pane: 99, text: 'synthetic' } },
          {
            binding_revision: 1,
            contract_ref: pendingBinding.contract_ref,
            validation: 'strict',
            timeoutMs: 1000
          }
        )
        f.gateway.dispatch(denied.call_id)
        assert.equal(f.store.call(f.principal.id, denied.call_id).state, 'not_dispatched')
        assert.equal(f.gateway.resolveOriginalRead(denied.call_id), undefined)
        assert.equal(f.gateway.status().connections, 1)
        assert.equal(client.status().connection_epoch, epoch)
        assert.equal(executions, 1)
      }
      assert.equal(f.encoded.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'request').length, 1)
      assert.equal(f.store.call(f.principal.id, pending.call_id).state, 'connector_accepted')
      finish!()
      await until(() => f.store.call(f.principal.id, pending.call_id).state === 'responded')
      const healthy = f.call(device.target)
      f.gateway.dispatch(healthy.call_id)
      await until(() => f.store.call(f.principal.id, healthy.call_id).state === 'responded')
      assert.equal(executions, 2)
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(f.sessions.closed, 0)
    } finally {
      f.stop()
    }
  }
)

test(
  '已 responded 后原 tuple 的新拒绝帧不能驱逐原结果读取上下文',
  /** 原生客户端为明确的合成回包 stub；原 Gateway codec、Store 和活 Wire 读取检查均为真实实现。 */
  async () => {
    let observed = 0
    const f = fixture(
      { retainOriginalRead: true },
      {},
      {
        /** 只观察原 decoder 真正接纳的拒绝帧，不伪造认证或账本结果。 */ adapter(_connection, _channel, services) {
          const original = createLuvusWireAdapter(persistentBackend(f.store, services))
          return {
            ...original,
            /** 原始字节仍完整经过独立原请求锚点和原生许可校验。 */ decode(input, direction) {
              const frame = original.decode(input, direction)
              if (frame.type === 'dispatch_refused') {
                observed++
              }
              return frame
            }
          }
        }
      }
    )
    const device = f.pair('synthetic_responded_refusal')
    const raw = rawConnect(f.gateway.url, device.credential, {
      major: 2,
      minor: 0,
      capabilities: ['rpc', 'dispatch_refusal'],
      required: ['rpc', 'dispatch_refusal']
    })
    try {
      await until(/** 只从真实 welcome 取得当前认证 epoch。 */ () => raw.epoch !== '')
      const call = f.call(device.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待实际 Gateway 写出的原 request。 */ () =>
          raw.frames.some(/** 固定请求类型的无密钥观察。 */ (value: any) => value.type === 'request')
      )
      const request = raw.frames.find(
        /** 精确选择本次唯一已登记请求。 */ (value: any) => value.type === 'request'
      ) as Extract<AuthenticatedEnvelope, { type: 'request' }>
      const binding: AttemptBinding = {
        machine_id: request.machine_id,
        recovery_generation: request.recovery_generation,
        connection_epoch: request.connection_epoch,
        ...request.payload.attempt
      }
      const response = responseFrame(binding, { result: { id: 'synthetic_task' } })
      raw.ws.send(JSON.stringify(response))
      await until(
        /** 合成回包必须通过真实证据事务后才成为 responded。 */ () =>
          f.store.call(f.principal.id, call.call_id).state === 'responded'
      )
      const original = f.gateway.resolveOriginalRead(call.call_id)
      assert(original)
      original.wire.checkResult(binding, response.payload.native_response)
      const handle = f.store.saveResult(f.principal.id, call.call_id)
      const page = f.store.readResult(f.principal.id, handle.result_id)
      raw.ws.send(
        JSON.stringify({
          ...response,
          type: 'dispatch_refused',
          message_id: randomUUID(),
          payload: { attempt: request.payload.attempt, code: 'terminal_execution_disabled' }
        })
      )
      await until(/** 确认原 decoder 已实际接收新 message_id 的合法拒绝帧。 */ () => observed === 1)
      assert.equal(f.store.call(f.principal.id, call.call_id).state, 'responded')
      const retained = f.gateway.resolveOriginalRead(call.call_id)
      assert(retained, 'responded refusal must preserve the original read context')
      assert.equal(retained.wire, original.wire)
      retained.wire.checkResult(binding, response.payload.native_response)
      assert.deepEqual(f.store.readResult(f.principal.id, handle.result_id), page)
      assert.equal(f.gateway.status().connections, 1)
      assert.equal(f.executions, 0)
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  '缺真实拒绝事务后端时不协商能力，显式必需配置拒绝启动',
  /** 主动移除隔离 Store 的可选 port，不能由收到的帧或执行 stub 补出后端成功。 */ async () => {
    const f = fixture(
      {},
      {},
      {
        /** 实际 Store 仍处理认证/登记；仅声明拒绝接口尚未接线。 */ store(now, options) {
          const store = new Store(':memory:', now, options)
          Object.defineProperty(store, 'commitDispatchRefusal', { value: undefined })
          return store
        }
      }
    )
    const device = f.pair('synthetic_missing_refusal_ledger')
    const offer = { major: 2, minor: 0, capabilities: ['rpc', 'dispatch_refusal'], required: ['rpc'] }
    const raw = rawConnect(f.gateway.url, device.credential, offer)
    try {
      await until(/** 等待真实已认证 welcome。 */ () => raw.epoch !== '')
      const welcome = raw.frames.find(/** 仅查看无密钥的协商结果。 */ (value: any) => value.type === 'welcome') as any
      assert.equal(welcome.payload.selected.capabilities.includes('dispatch_refusal'), false)
      assert.throws(
        /** 宿主要求未接线能力时必须在开启新 listener 前拒绝。 */ () =>
          createGateway({
            hostname: '127.0.0.1',
            port: 0,
            developmentLoopback: true,
            identity: f.credentials,
            store: f.store,
            router: f.router,
            principal: /** 沿用 fixture 独立 caller，不接受帧内身份。 */ () => f.principal,
            session: f.session,
            offer: { ...offer, required: ['rpc', 'dispatch_refusal'] }
          }),
        /dispatch_refusal_backend_unavailable/
      )
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  '可能写出或伪造形状的异常不产生 not_dispatched 证明',
  /** 即使后端已接线，普通异常和 unknown 也保持断连后的保守结局。 */ async () => {
    for (const error of [
      new LuvusAdapterError('terminal_execution_disabled', 'outcome_unknown'),
      { code: 'terminal_execution_disabled', outcome: 'not_dispatched' }
    ]) {
      const f = fixture()
      const device = f.pair('synthetic_unknown_refusal')
      const client = f.connector(/** 仅使用 fixture 身份。 */ () => device.credential, {
        limits: { reconnect_ms: 5000, reconnect_max_ms: 5000 },
        execute: /** 明确异常 stub，不触发真实 IO。 */ async () => {
          throw error
        }
      })
      try {
        await until(/** 等待合成设备通过真实认证。 */ () => client.status().phase === 'ready')
        const call = f.call(device.target)
        f.gateway.dispatch(call.call_id)
        await until(
          /** 等待未知结局在原 Store 收敛。 */ () =>
            f.store.call(f.principal.id, call.call_id).state === 'outcome_unknown'
        )
        assert.equal(f.store.call(f.principal.id, call.call_id).response, null)
      } finally {
        f.stop()
      }
    }
  }
)

test(
  '确定拒绝在原 deadline 后到达时不倒退账本，也不中止同连接另一调用',
  /** 拒绝 port 是明确只能抛错的服务 stub；过期路径不得调用它或假报提交成功。 */ async () => {
    let commits = 0
    const f = fixture(
      {},
      {},
      {
        /** 原 Store 保持所有真实行为；只为验证未调用性质暴露一个必定拒绝的合成 port。 */ store(now, options) {
          return Object.assign(new Store(':memory:', now, options), {
            /** 若错误触及过期提交路径就使测试失败，绝不 mock 持久化成功。 */ commitDispatchRefusal() {
              commits++
              throw new Error('synthetic_refusal_port_must_not_run')
            }
          })
        }
      }
    )
    let second = ''
    let signal: AbortSignal | undefined
    let finish: (() => void) | undefined
    let refuse: (() => void) | undefined
    const device = f.pair('synthetic_expired_refusal')
    const client = f.connector(/** 仅取隔离 fixture 身份。 */ () => device.credential, {
      limits: { reconnect_ms: 5000, reconnect_max_ms: 5000 },
      /** 两份合成工作均手动推进，不启动原生进程。 */ execute(raw, active, binding) {
        return new Promise(
          /** 先等真实 accepted 提交，再投递晚到的确定拒绝。 */ (resolve, reject) => {
            if (binding.call_id === second) {
              refuse = /** 固定未写出异常不携带请求、原生响应或秘密。 */ () =>
                reject(new LuvusAdapterError('terminal_execution_disabled', 'not_dispatched'))
            } else {
              signal = active
              finish = /** 完成未到期的原合成请求。 */ () =>
                resolve({ id: JSON.parse(raw).id, result: { id: 'synthetic_task' } })
            }
          }
        )
      }
    })
    try {
      await until(/** 等待实际认证及就绪。 */ () => client.status().phase === 'ready')
      const epoch = client.status().connection_epoch
      const first = f.call(device.target)
      f.gateway.dispatch(first.call_id)
      await until(/** 正常调用已占有独立 signal。 */ () => signal !== undefined)
      const registered = f.store.call(f.principal.id, first.call_id)
      const ref = f.store.attempt(first.call_id, registered.attempt_id!)!.binding.contract_ref
      const short = f.router.create(
        f.principal,
        device.target,
        { method: 'task.add', params: { title: 'synthetic' } },
        { binding_revision: 1, contract_ref: ref, timeoutMs: 5 }
      )
      second = short.call_id
      f.gateway.dispatch(second)
      await until(
        /** 必须先收到并持久化 accepted，避免把先到的过期确认误当逐调用拒绝。 */ () =>
          refuse !== undefined && f.store.call(f.principal.id, second).state === 'connector_accepted'
      )
      f.now = short.deadline + 1
      refuse!()
      await until(
        /** 固定 deadline 只结束已到期调用。 */ () => f.store.call(f.principal.id, second).state === 'outcome_unknown'
      )
      assert.equal(commits, 0)
      assert.equal(signal!.aborted, false)
      assert.equal(client.status().connection_epoch, epoch)
      finish!()
      await until(
        /** 另一调用仍可提交真实响应证据。 */ () => f.store.call(f.principal.id, first.call_id).state === 'responded'
      )
      assert.equal(client.status().connection_epoch, epoch)
    } finally {
      refuse?.()
      finish?.()
      f.stop()
    }
  }
)

test(
  'accepted 后的确定未写出拒绝只结束本 call，同连接的在途调用继续完成',
  /** 第二次执行在 stub 写入前明确拒绝；第一份合成工作保持原 epoch、signal 和结果归属。 */
  async () => {
    const f = fixture()
    let rejected = ''
    let signal: AbortSignal | undefined
    let finish: (() => void) | undefined
    let refused = false
    const device = f.pair('synthetic_refusal')
    const client = f.connector(/** 只使用本 fixture 的无生产效力身份。 */ () => device.credential, {
      limits: { reconnect_ms: 5000, reconnect_max_ms: 5000 },
      /** 明确合成的执行 stub；不接触任何真实原生 endpoint、终端或模型。 */
      execute: (raw, active, binding) => {
        if (binding.call_id === rejected) {
          refused = true
          throw new LuvusAdapterError('terminal_execution_disabled', 'not_dispatched')
        }
        signal = active
        return new Promise(
          /** 手动控制第一份合成回包，以暴露连接级中止的附带影响。 */ (resolve) => {
            finish = /** 仅返回本次原生请求 ID 的合成回包。 */ () =>
              resolve({ id: JSON.parse(raw).id, result: { id: 'synthetic_task' } })
          }
        )
      }
    })
    try {
      await until(/** 等待真实 welcome 与 provider readiness。 */ () => client.status().phase === 'ready')
      const epoch = client.status().connection_epoch
      const first = f.call(device.target)
      f.gateway.dispatch(first.call_id)
      await until(/** 确认第一份工作已占用实际在途槽位。 */ () => signal !== undefined)
      const second = f.call(device.target)
      rejected = second.call_id
      f.gateway.dispatch(second.call_id)
      await until(/** 等待确定拒绝到达当前执行 stub。 */ () => refused)
      await until(
        /** 修复前连接会被关闭；修复后账本必须收到逐调用拒绝。 */ () =>
          client.status().phase !== 'ready' || f.store.call(f.principal.id, second.call_id).state === 'not_dispatched'
      )
      assert.equal(signal!.aborted, false)
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(f.gateway.status().connections, 1)
      assert.equal(f.store.call(f.principal.id, second.call_id).state, 'not_dispatched')
      assert.equal(f.store.call(f.principal.id, first.call_id).state, 'connector_accepted')
      finish!()
      await until(
        /** 原调用必须仍能通过原 permit 和真实响应事务完成。 */ () =>
          f.store.call(f.principal.id, first.call_id).state === 'responded'
      )
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(client.status().running, 0)
    } finally {
      finish?.()
      f.stop()
    }
  }
)

test(
  '真实 Luvus 最终终端门禁拒绝经 Wire hook 独立收敛，另一个原请求继续使用原 adapter',
  /** 原生来源与回包均为明确 fixture；实际 Store、原始 Wire、LuvusRpcAdapter 和 loopback 保持生产实现。 */
  async () => {
    const w = await wireFixture({ dispatchRefusal: true })
    const { f, state } = w
    let unblock: (() => void) | undefined
    let first = ''
    state.beforeAuth = /** 第一份真实 adapter 工作在唯一 claim 前受控等待。 */ async (binding) => {
      if (binding.call_id === first) {
        await new Promise<void>(/** 只控制合成宿主 auth 的返回时刻。 */ (resolve) => (unblock = resolve))
      }
    }
    try {
      const device = w.pair('synthetic_original_refusal')
      const client = w.connect(device)
      await w.ready(client)
      const epoch = client.status().connection_epoch
      first = f.call(device.target).call_id
      f.gateway.dispatch(first)
      await until(/** 确认正常工作已进入原生 adapter 的 auth 等待。 */ () => unblock !== undefined)
      const second = f.router.create(
        f.principal,
        device.target,
        { method: 'task.add', params: { title: 'synthetic', gate: 'printf synthetic' } },
        { binding_revision: 1, contract_ref: contractRef(w.native.origin), timeoutMs: 10_000 }
      )
      f.gateway.dispatch(second.call_id)
      await until(
        /** 实际 adapter 的默认关闭门禁必须产生确定拒绝，不写入合成 endpoint。 */ () =>
          f.store.call(f.principal.id, second.call_id).state === 'not_dispatched'
      )
      assert.deepEqual(state.rpcErrors, [{ code: 'terminal_execution_disabled', outcome: 'not_dispatched' }])
      assert.equal(state.claim, 0)
      assert.equal(w.native.received(), '')
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(f.gateway.status().connections, 1)
      unblock!()
      await until(
        /** 第一份请求沿原许可完成真实证据事务。 */ () => f.store.call(f.principal.id, first).state === 'responded'
      )
      assert.equal(state.claim, 1)
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(state.requests.length, 2)
    } finally {
      unblock?.()
      await w.close()
    }
  }
)

test(
  'capacity refusal reports local resource and reclaim time without forging a Wire terminal result',
  /** 合成执行层只抛明确容量异常；原 transport 与 Store 仍按 unknown 收敛，不自动重发。 */ async () => {
    const f = fixture()
    const device = f.pair('synthetic_capacity')
    const client = f.connector(/** 只用本用例无生产效力的身份。 */ () => device.credential, {
      limits: { reconnect_ms: 5000, reconnect_max_ms: 5000 },
      execute: /** 无 native 写入的容量拒绝 stub。 */ async () => {
        throw new ConnectorCapacityError('claim_entries', f.now + 1000)
      }
    })
    try {
      await until(/** 等待真实认证连接。 */ () => client.status().phase === 'ready')
      const call = f.call(device.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 未新增协议证明，仍保守保留未知结局。 */ () =>
          f.store.call(f.principal.id, call.call_id).state === 'outcome_unknown'
      )
      assert.equal(client.status().failure, 'claim_capacity')
      assert.deepEqual(client.status().capacity, { resource: 'claim_entries', reclaim_at: f.now + 1000 })
      assert.equal(f.executions, 0)
      assert.equal(f.store.call(f.principal.id, call.call_id).response, null)
    } finally {
      f.stop()
    }
  }
)

for (const resource of ['attempt_entries', 'attempt_bytes'] as const) {
  test(
    'synchronous admission capacity retains local diagnostics without a Wire refusal: ' + resource,
    /** 模拟准入表的同步满额；先经过真实 decoder，不能把未执行误造为协议拒绝证明。 */ async () => {
      const f = fixture()
      const device = f.pair('synthetic_admission_capacity')
      const reclaimAt = resource === 'attempt_entries' ? f.now + 1000 : null
      const client = f.connector(/** 仅使用本测试的隔离设备身份。 */ () => device.credential, {
        limits: { reconnect_ms: 5000, reconnect_max_ms: 5000 },
        /** 独立模拟生产准入包装在真实 Wire decode 内抛出的容量错误。 */ session(connection) {
          const original = f.session(connection)
          return {
            ...original,
            adapter: {
              ...original.adapter,
              /** 其它帧沿用原 decoder，只有合法 request 命中本测试的满额条件。 */ decode(input, direction) {
                const frame = original.adapter.decode(input, direction)
                if (frame.type === 'request') {
                  throw new ConnectorCapacityError(resource, reclaimAt)
                }
                return frame
              }
            }
          }
        }
      })
      try {
        await until(/** 仅在真实认证及 readiness 完成后派发。 */ () => client.status().phase === 'ready')
        const call = f.call(device.target)
        f.gateway.dispatch(call.call_id)
        await until(
          /** Gateway 已发送原 request，缺少 Wire 拒绝证明时保持 unknown。 */ () =>
            f.store.call(f.principal.id, call.call_id).state === 'outcome_unknown'
        )
        assert.equal(client.status().failure, 'connector_attempt_capacity')
        assert.deepEqual(client.status().capacity, { resource, reclaim_at: reclaimAt })
        assert.equal(f.executions, 0)
        assert.equal(f.store.call(f.principal.id, call.call_id).response, null)
        assert(
          !f.encoded.some(
            /** 容量异常不得编码为 dispatch_refused。 */ (raw) => JSON.parse(raw).type === 'dispatch_refused'
          )
        )
      } finally {
        f.stop()
      }
    }
  )
}
