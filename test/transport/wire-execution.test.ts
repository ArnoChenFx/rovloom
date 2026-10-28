// 验证原始已校验 Wire 帧接入实际 Luvus RPC adapter，原请求状态、发送 claim、auth 与提交职责不混用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { persistentBackend } from '../../src/integration/persistence.js'
import type { WireConnectorOptions } from '../../src/transport/index.js'
import { until } from './helpers.js'
import { wireFixture } from './wire-execution-helpers.js'
import { connectorTypeChecks } from './wire-execution-types.js'
import { verifyRpcCapacity } from './wire-capacity-helpers.js'

void connectorTypeChecks

/** 创建可由测试显式释放的无副作用等待，用于 auth、原生响应与关闭之间的确定性竞态。 */
function gate() {
  let release!: () => void
  const promise = new Promise<void>(
    /** 只保存本测试等待的完成入口，不触碰生产任务或真实设备。 */
    (resolve) => {
      release = resolve
    }
  )
  return { promise, release }
}

test(
  '原始 Wire request 无重包装进入实际 IPC adapter，原生错误深度保真且唯一 auth/claim/commit',
  { timeout: 15_000 },
  /** 通过真实 Gateway/Connector、各自 Wire 和临时 SQLite claim 完成一次隔离原生 RPC。 */
  async () => {
    const f = await wireFixture()
    const auth = gate()
    f.state.beforeAuth =
      /** 暂停实际 adapter 的 auth，观察 Gateway 和 Connector 是否仍持有各自原请求状态。 */
      () => auth.promise
    try {
      const device = f.pair('mock_wire_rpc')
      const client = f.connect(device)
      await f.ready(client)
      const call = f.f.call(device.target)
      const binding = f.f.gateway.dispatch(call.call_id)
      await until(
        /** 等待实际 adapter 已经进入受保护 auth，尚未领取发送 claim。 */
        () => f.state.auth === 1
      )
      assert.equal(f.gateways[0]!.stats().executions, 1)
      assert.equal(f.sessions[0]!.wire.adapter.stats().executions, 1)
      assert.equal(f.claimCount(), 0)
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).state, 'connector_accepted')
      const sent = f.f.encoded.find(
        /** 从真实 Gateway 编码记录中取出携带外层空白的原始 request。 */
        (raw) => JSON.parse(raw).type === 'request'
      )!
      assert.equal(f.state.requests[0], sent)
      assert.equal(sent.startsWith(' \n'), true)
      const frame = JSON.parse(sent)
      assert.equal(Object.hasOwn(frame.payload.native_request, 'id'), false)
      assert.equal(Object.hasOwn(frame.payload.native_request, 'auth'), false)
      auth.release()
      await until(
        /** 只有 Gateway 的真实证据事务提交后才观察到 responded。 */
        () => f.f.store.call(f.f.principal.id, call.call_id).state === 'responded'
      )
      assert.deepEqual(JSON.parse(f.f.store.call(f.f.principal.id, call.call_id).response!), {
        ...f.native.response,
        id: binding.native_request_id
      })
      const native = JSON.parse(f.native.received())
      assert.equal(native.id, binding.native_request_id)
      assert.equal(native.auth, f.native.state.auth)
      assert.equal(native.method, frame.payload.native_request.method)
      assert.deepEqual(native.params, frame.payload.native_request.params)
      assert.equal(f.state.auth, 1)
      assert.equal(f.state.claim, 1)
      assert.equal(f.claimCount(), 1)
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.f.executions, 0)
      assert.equal(f.gateways[0]!.stats().executions, 1)
      const original = f.f.gateway.resolveOriginalRead(call.call_id)!
      assert.equal(original.binding.attempt_id, binding.attempt_id)
      assert.equal(original.wire, f.f.gateway.resolveOriginalRead(call.call_id)!.wire)
      original.wire.checkResult(original.binding)
      assert.equal(f.sessions[0]!.wire.adapter.stats().executions, 0)
      client.stop()
      assert.equal(f.state.subscriptions, 0)
      assert.equal(f.sessions[0]!.wire.adapter.stats().closed, true)
      await until(
        /** Connector 本地 close 的通知须先抵达 Gateway，之后才断言远端上下文失效。 */
        () => f.f.gateway.status().connections === 0
      )
      assert.equal(f.f.gateway.resolveOriginalRead(call.call_id), undefined)
    } finally {
      auth.release()
      await f.close()
    }
  }
)

test(
  '真实 RPC attempt 满额拒绝并保留 seen；fresh epoch 只执行显式新意图',
  { timeout: 15_000 },
  /** 标准验收收紧至两条；完整默认 128 上限另以同一 harness 运行，不能借旧式 executor 代证。 */
  async () => {
    await verifyRpcCapacity(2)
  }
)

test(
  '真实 RPC 完成后宿主等待期间只按设备范围与归属放行，小响应正文正常交付',
  { timeout: 15_000 },
  /** 暂停 executeWire 返回；当前调用权限只来自 token 设备范围，同一主体与设备仍须交付。 */
  async () => {
    const f = await wireFixture()
    const late = gate()
    f.state.afterDispatch =
      /** 原生已完成且私有 RPC Wire 可回收，此处仅延迟宿主 hook 的交付。 */
      () => late.promise
    try {
      const device = f.pair('mock_small_response_read_revoked')
      const client = f.connect(device)
      await f.ready(client)
      const epoch = client.status().connection_epoch
      const call = f.f.call(device.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** 确保已经真实执行并收到原生结果，撤权发生在 adapter 返回与 transport 写出之间。 */
        () => f.state.nativeCompleted === 1
      )
      assert.equal(f.state.receivedResponses, 0)
      late.release()
      await until(
        /** 同一主体与设备范围下响应正常提交，连接与 epoch 都不需要更换。 */
        () => f.f.store.call(f.f.principal.id, call.call_id).state === 'responded'
      )
      assert.equal(f.state.receivedResponses, 1)
      assert(f.f.store.call(f.f.principal.id, call.call_id).response)
      assert.equal(f.claimCount(), 1)
      assert.equal(f.native.state.responses, 1)
      await until(
        /** 旧结果不会触发重发，连接 epoch 保持不变。 */
        () => client.status().phase === 'ready' && client.status().connection_epoch === epoch
      )
      assert.equal(f.claimCount(), 1)
      assert.equal(f.state.hook, 1)
    } finally {
      late.release()
      await f.close()
    }
  }
)

test(
  '单帧内的响应唯一提交，超过单帧上限的响应不分片、调用保持 unknown',
  { timeout: 20_000 },
  /** 通过真实 IPC 返回单帧内与超过单帧上限的合法原生错误，覆盖提交与失败收敛两条路径。 */
  async () => {
    for (const scenario of ['within', 'oversized'] as const) {
      const f = await wireFixture({ frameBytes: 131_072 })
      const data = { text: '汉'.repeat(scenario === 'within' ? 20_000 : 75_000), nested: [{ keep: true }] }
      f.native.respond(
        /** 使用实际 native id 返回大错误，未放大原生 adapter 自身的在线帧预算。 */
        (socket, input) => {
          const request = JSON.parse(input.trim().split('\n').at(-1)!)
          socket.end(
            JSON.stringify({ id: request.id, error: { code: 'mock_large', message: 'preserve', data } }) + '\n'
          )
        }
      )
      try {
        const device = f.pair('mock_response_' + scenario)
        const client = f.connect(device)
        await f.ready(client)
        const call = f.f.call(device.target)
        const binding = f.f.gateway.dispatch(call.call_id)
        await until(
          /** 以真实持久结果或关闭后的 unknown 作为终结条件。 */
          () => ['responded', 'outcome_unknown'].includes(f.f.store.call(f.f.principal.id, call.call_id).state)
        )
        const result = f.f.store.call(f.f.principal.id, call.call_id)
        assert.equal(f.claimCount(), 1)
        assert.equal(f.native.state.responses, 1)
        if (scenario === 'within') {
          assert.equal(result.state, 'responded')
          assert.deepEqual(JSON.parse(result.response!), {
            id: binding.native_request_id,
            error: { code: 'mock_large', message: 'preserve', data }
          })
          assert(f.f.gateway.resolveOriginalRead(call.call_id))
          assert.deepEqual(f.failures, [])
        } else {
          assert.equal(result.state, 'outcome_unknown')
          assert.equal(result.response, null)
          assert.equal(f.f.gateway.resolveOriginalRead(call.call_id), undefined)
        }
      } finally {
        await f.close()
      }
    }
  }
)

test(
  '原始读取仅引用活 Wire，每次重新核对当前 caller；discard/TTL 后不重建',
  { timeout: 15_000 },
  /** 核对冷 adapter 无读取许可，当前 caller、内容清理和固定 TTL 都约束活上下文。 */
  async () => {
    const f = await wireFixture()
    try {
      const device = f.pair('mock_original_read')
      const client = f.connect(device)
      await f.ready(client)
      const call = f.f.call(device.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** 等待唯一 Gateway 提交点完成，之后读取仍须当前权限。 */
        () => f.f.store.call(f.f.principal.id, call.call_id).state === 'responded'
      )
      const original = f.f.gateway.resolveOriginalRead(call.call_id)!
      const cold = createLuvusWireAdapter(persistentBackend(f.f.store, f.f.backendServices(f.sessions[0]!.connection)))
      try {
        assert.throws(
          /** 相同可信后端和 binding 不能替代实际持有原请求的 Wire 私有状态。 */
          () => cold.checkResult(original.binding),
          /dispatch_permit_unavailable/
        )
      } finally {
        cold.close()
      }
      const caller = f.f.principal.id
      f.f.principal.id = 'other_caller'
      assert.equal(f.f.gateway.resolveOriginalRead(call.call_id), undefined)
      assert.throws(
        /** 先前取得的真实 Wire 引用也不能绕过当前 caller 检查。 */
        () => original.wire.checkResult(original.binding),
        /forbidden/
      )
      f.f.principal.id = caller
      assert.equal(f.f.gateway.resolveOriginalRead(call.call_id)!.wire, original.wire)
      f.f.store.discardResponse(caller, call.call_id)
      assert.equal(f.f.gateway.resolveOriginalRead(call.call_id), undefined)
      assert.throws(
        /** discard 后不从持久 JSON 或旧引用恢复读取许可。 */
        () => original.wire.checkResult(original.binding)
      )
      const fresh = f.f.call(device.target)
      f.f.gateway.dispatch(fresh.call_id)
      await until(
        /** 新意图仍可正常完成，不复用已经清理的旧调用。 */
        () => f.f.store.call(caller, fresh.call_id).state === 'responded'
      )
      assert(f.f.gateway.resolveOriginalRead(fresh.call_id))
      f.f.now = f.f.store.call(caller, fresh.call_id).content_expires
      f.f.store.expire()
      assert.equal(f.f.gateway.resolveOriginalRead(fresh.call_id), undefined)
    } finally {
      await f.close()
    }
  }
)

test(
  '读取上下文限额在派发提交前拒绝；清理内容或释放原 Wire 后回收容量',
  { timeout: 15_000 },
  /** 有界保留成功调用的原 Wire，不提前驱逐有效读取状态或创建无法发送的新 attempt。 */
  async () => {
    const f = await wireFixture({ readContexts: 1 })
    try {
      const device = f.pair('mock_read_capacity')
      const client = f.connect(device)
      await f.ready(client)
      const first = f.f.call(device.target)
      f.f.gateway.dispatch(first.call_id)
      await until(
        /** 首次完成后仍占有一个可读取的原上下文。 */
        () => f.f.store.call(f.f.principal.id, first.call_id).state === 'responded'
      )
      const second = f.f.call(device.target)
      const before = f.f.store.call(f.f.principal.id, second.call_id).state
      assert.throws(
        /** 容量拒绝必须发生在 Router/Store 派发事务之前。 */
        () => f.f.gateway.dispatch(second.call_id),
        /transport_concurrency_limit/
      )
      assert.equal(f.f.store.call(f.f.principal.id, second.call_id).state, before)
      assert.equal(f.claimCount(), 1)
      assert(f.f.gateway.resolveOriginalRead(first.call_id))
      f.f.store.discardResponse(f.f.principal.id, first.call_id)
      f.f.gateway.dispatch(second.call_id)
      await until(
        /** 真实内容清理释放读取容量后，只派发该明确的新调用一次。 */
        () => f.f.store.call(f.f.principal.id, second.call_id).state === 'responded'
      )
      assert.equal(f.claimCount(), 2)
      const original = f.f.gateway.resolveOriginalRead(second.call_id)!
      original.wire.release(original.binding)
      const third = f.f.call(device.target)
      f.f.gateway.dispatch(third.call_id)
      await until(
        /** 宿主显式释放后直接派发新调用即可回收容量，不依赖额外一次读取查询。 */
        () => f.f.store.call(f.f.principal.id, third.call_id).state === 'responded'
      )
      assert.equal(f.f.gateway.resolveOriginalRead(second.call_id), undefined)
      assert.equal(f.claimCount(), 3)
    } finally {
      await f.close()
    }
  }
)

test(
  '原生完成后断线使用 fresh epoch，迟到 hook 不提交旧结果或影响另一设备',
  { timeout: 15_000 },
  /** 暂停旧 hook 返回，重连并完成新调用后再释放旧结果；不迁移原请求状态或重放。 */
  async () => {
    const f = await wireFixture()
    const late = gate()
    let blocked: string | undefined
    f.state.afterDispatch =
      /** 只延迟第一个登记调用；其它设备或新意图正常返回。 */
      async (binding) => {
        blocked ??= binding.call_id
        if (binding.call_id === blocked) {
          await late.promise
        }
      }
    try {
      const a = f.pair('mock_wire_reconnect_a')
      const b = f.pair('mock_wire_reconnect_b')
      const ca = f.connect(a)
      const cb = f.connect(b)
      await f.ready(ca, cb)
      const oldEpoch = ca.status().connection_epoch
      const otherEpoch = cb.status().connection_epoch
      const old = f.f.call(a.target)
      f.f.gateway.dispatch(old.call_id)
      await until(
        /** 原生已经实际接收并验证响应，失败属于发送后的 unknown。 */
        () => f.state.nativeCompleted === 1
      )
      ca.disconnect()
      await until(
        /** 等待明确的新认证 epoch，旧 hook 仍保持未结算。 */
        () => ca.status().phase === 'ready' && ca.status().connection_epoch !== oldEpoch
      )
      assert.equal(f.f.store.call(f.f.principal.id, old.call_id).state, 'outcome_unknown')
      assert.equal(f.f.gateway.resolveOriginalRead(old.call_id), undefined)
      assert.equal(f.claimCount(), 1)
      const other = f.f.call(b.target)
      f.f.gateway.dispatch(other.call_id)
      await until(
        /** 另一设备仍在原 epoch 完成自己的响应提交。 */
        () => f.f.store.call(f.f.principal.id, other.call_id).state === 'responded'
      )
      late.release()
      await until(
        /** 迟到 Promise 只返还旧工作额度，不能把错误传播到新 socket。 */
        () => ca.status().running === 0
      )
      assert.equal(cb.status().connection_epoch, otherEpoch)
      assert.equal(ca.status().phase, 'ready')
      assert.equal(f.f.store.call(f.f.principal.id, old.call_id).response, null)
      assert.equal(f.claimCount(), 2)
      assert.equal(f.sessions[0]!.wire.adapter.stats().closed, true)
    } finally {
      late.release()
      await f.close()
    }
  }
)

test(
  'Wire hook 与原生注入路径互斥，错误配置在执行前拒绝而不降级',
  { timeout: 15_000 },
  /** 故意用运行时无类型输入混合两条路径，确认错误接线不会进行任何原生认证或发送。 */
  async () => {
    const f = await wireFixture()
    let legacy = 0
    try {
      const device = f.pair('mock_wire_conflict')
      const client = f.connect(device, {
        /** 此负例故意提供禁用的旧式注入，不能在 Wire 模式失败时调用它。 */
        nativeInput(input: unknown) {
          legacy++
          return input
        },
        /** 此负例故意提供禁用的旧式执行，不能作为任何回退路径。 */
        async execute() {
          legacy++
          return {}
        }
      } as unknown as Partial<WireConnectorOptions>)
      await until(
        /** 等待 welcome 的配置校验关闭第一条连接，不把尚未开始执行误判为拒绝。 */
        () => client.status().reconnects > 0
      )
      assert.equal(f.state.hook, 0)
      assert.equal(f.state.auth, 0)
      assert.equal(f.state.claim, 0)
      assert.equal(f.native.received(), '')
      assert.equal(legacy, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  '证据 COMMIT 失败不报告 responded，也不保留可读取的旧 Wire',
  { timeout: 15_000 },
  /** 只在 Gateway 原 commitLuvusResponse 事务故障，确认本机 RpcResult 不能替代持久提交。 */
  async () => {
    let failCommit = false
    const f = await wireFixture({
      store: {
        /** 精确拒绝响应证据的原事务，不拒绝派发锚点、accepted 或独立发送 claim。 */
        fault(point) {
          if (failCommit && point === 'evidence_commit') {
            throw new Error('mock_evidence_commit_failure')
          }
        }
      }
    })
    try {
      const device = f.pair('mock_object_commit_failure')
      const client = f.connect(device)
      await f.ready(client)
      const call = f.f.call(device.target)
      failCommit = true
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** 只有实际证据提交尝试才能触发存储降级，原生完成不算持久成功。 */
        () => f.f.store.health().mode === 'storage_degraded'
      )
      assert.equal(f.claimCount(), 1)
      assert.equal(f.state.nativeCompleted, 1)
      assert.equal(f.f.gateway.resolveOriginalRead(call.call_id), undefined)
      failCommit = false
      f.f.store.resumeStorage()
      const result = f.f.store.call(f.f.principal.id, call.call_id)
      assert.notEqual(result.state, 'responded')
      assert.equal(result.response, null)
      assert.equal(f.claimCount(), 1)
    } finally {
      failCommit = false
      await f.close()
    }
  }
)

test(
  '完整原生 auth 帧超预算或唯一 claim 失败都不写入，Wire hook 不重试或另走 execute',
  { timeout: 15_000 },
  /** 让实际 adapter 在 auth 后预算检查或原子 claim 处拒绝，确认原生 listener 没有收到字节。 */
  async () => {
    for (const cause of ['budget', 'claim'] as const) {
      const f = await wireFixture(cause === 'budget' ? { nativeLimits: { request_bytes: 160 } } : {})
      try {
        f.native.state.auth = cause === 'budget' ? 'x'.repeat(256) : 'mock-only-token'
        f.state.failClaim = cause === 'claim'
        const device = f.pair('mock_wire_' + cause)
        const client = f.connect(device)
        await f.ready(client)
        const call = f.f.call(device.target)
        f.f.gateway.dispatch(call.call_id)
        await until(
          /** 明确等待失败关闭，不把短暂的 auth 等待当作最终无写入。 */
          () => client.status().reconnects > 0
        )
        assert.equal(f.state.hook, 1)
        assert.equal(f.state.auth, 1)
        assert.equal(f.state.claim, cause === 'budget' ? 0 : 1)
        assert.equal(f.claimCount(), 0)
        assert.equal(f.native.received(), '')
        assert.equal(f.f.store.call(f.f.principal.id, call.call_id).state, 'outcome_unknown')
        assert.equal(f.f.executions, 0)
      } finally {
        await f.close()
      }
    }
  }
)

test(
  'Wire hook 返回其它 attempt 的响应不得在 Gateway 提交为 responded',
  { timeout: 15_000 },
  /** 原生执行已发生，故意破坏返回 binding；保守 unknown 且不重放或串用响应。 */
  async () => {
    const f = await wireFixture()
    try {
      f.state.badBinding = true
      const device = f.pair('mock_wire_result_binding')
      const client = f.connect(device)
      await f.ready(client)
      const call = f.f.call(device.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** 等待返回 binding 校验失败导致会话关闭。 */
        () => client.status().reconnects > 0
      )
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.claimCount(), 1)
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).state, 'outcome_unknown')
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).response, null)
      assert.equal(f.state.hook, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  '关闭 auth 等待取消本会话 adapter，迟到 token 不新增 claim 或写入',
  { timeout: 15_000 },
  /** 中止实际 Luvus adapter 的异步 auth，并在关闭后释放 token；原 attempt 不能重放。 */
  async () => {
    const f = await wireFixture()
    const auth = gate()
    f.state.beforeAuth =
      /** 只阻塞本次 fixture token 交付，模拟忽略外部取消的受信 custody。 */
      () => auth.promise
    try {
      const device = f.pair('mock_wire_auth_close')
      const client = f.connect(device)
      await f.ready(client)
      const call = f.f.call(device.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** 必须确认原生 adapter 已等待 auth 后才关闭，形成真实异步窗口。 */
        () => f.state.auth === 1
      )
      client.stop()
      auth.release()
      await until(
        /** 等待旧异步请求结算并释放 transport 在途额度。 */
        () => client.status().running === 0 && f.f.gateway.status().connections === 0
      )
      assert.equal(f.state.claim, 0)
      assert.equal(f.native.received(), '')
      assert.equal(f.state.subscriptions, 0)
      assert.equal(f.sessions[0]!.wire.adapter.stats().closed, true)
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).state, 'outcome_unknown')
    } finally {
      auth.release()
      await f.close()
    }
  }
)
