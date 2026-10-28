// 通过真实 loopback、Store 和 Wire 验证逐调用取消；只中止观察，不把它当作原生回滚。
import { phaseTiming } from '../support/phase-timing.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { NativeConnectorOptions } from '../../src/transport/connector.js'
import { fixture, rawConnect, until } from './helpers.js'
import { wireFixture } from './wire-execution-helpers.js'
import { responseFrame } from '../storage/helpers.js'
import type { ServerSocket } from '../../src/transport/common.js'

/** 保存未结束的合成原生 Promise，取消只改变 signal，实际完成仍由测试独立触发。 */
function blocked(extra: Parameters<typeof fixture>[0] = {}, storage: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(extra, storage)
  const work = new Map<string, { signal: AbortSignal; aborts: number; finish: () => void }>()
  const execute: NativeConnectorOptions['execute'] =
    /** 保留精确 call 的控制器和完成入口，不从 JSON 构造身份或复用其它 attempt。 */
    (raw, signal, binding) =>
      new Promise(
        /** 不响应 abort 的合成工作继续占用运行额度，直至显式完成。 */
        (resolve) => {
          const item = {
            signal,
            aborts: 0,
            /** 用原生原请求 ID 完成本次工作，不制造新请求或续期。 */
            finish: () => resolve({ id: JSON.parse(raw).id, result: { id: 'mock_task' } })
          }
          signal.addEventListener(
            'abort',
            /** 只统计观察中止，不假设原生副作用已经停止。 */
            () => item.aborts++
          )
          work.set(binding.call_id, item)
        }
      )
  return {
    f,
    work,
    /** 使用实际出站 Connector 和本 fixture 的无生产效力凭据。 */
    connect(device: ReturnType<typeof f.pair>) {
      return f.connector(
        /** 只取配对 fixture 已交付的固定设备凭据。 */
        () => device.credential,
        { execute }
      )
    },
    /** 显式结束测试工作，再停止连接、维护计时器和临时 Store。 */
    stop() {
      for (const item of work.values()) {
        item.finish()
      }
      f.stop()
    }
  }
}

/** 仅统计实际经过原 Wire 编码的取消帧，不把持久取消等同于已送达。 */
function cancels(f: ReturnType<typeof fixture>) {
  return f.encoded.filter(
    /** 固定帧类型即可检查发送次数，不读取或输出任何秘密字段。 */
    (raw) => JSON.parse(raw).type === 'cancel'
  )
}

/** 捕获 fixture 已升级的真实 Gateway socket，仅供重复/损坏帧注入回归。 */
function sockets(f: ReturnType<typeof fixture>) {
  const captured: Pick<ServerSocket<unknown>, 'send'>[] = []
  const open = f.gateway.channels.open.bind(f.gateway.channels)
  f.gateway.channels.open =
    /** 仍委托原注册表建立并绑定通道，不伪造认证状态。 */
    (socket, close) => {
      captured.push(socket as Pick<ServerSocket<unknown>, 'send'>)
      return open(socket, close)
    }
  return captured
}

test(
  '取消只到同一 call，双 Connector 和同设备另一调用隔离，重复取消不重发也不提前释放原生额度',
  /** Gateway 停止本地等待后，忽略 signal 的工作仍运行；其它调用和持久结果保持独立。 */
  async () => {
    const b = blocked()
    const { f, work } = b
    const captured = sockets(f)
    const a = f.pair('mock_cancel_a')
    const other = f.pair('mock_cancel_b')
    const ca = b.connect(a)
    const cb = b.connect(other)
    try {
      await until(
        /** 两个模拟连接分别完成认证和 provider 核对。 */
        () => ca.status().phase === 'ready' && cb.status().phase === 'ready'
      )
      const calls = [f.call(a.target), f.call(a.target), f.call(other.target)]
      for (const call of calls) {
        f.gateway.dispatch(call.call_id)
      }
      await until(
        /** 三份原生工作均已启动，取消不得借用邻近 call 的控制器。 */
        () => work.size === 3
      )
      const first = calls[0]!
      const epoch = ca.status().connection_epoch
      const stopped = f.gateway.cancel(first.call_id)
      assert.equal(stopped.state, 'outcome_unknown')
      assert.equal(stopped.response, null)
      await until(
        /** 等待真实 cancel 接收，而非只看 Gateway 持久状态。 */
        () => work.get(first.call_id)!.signal.aborted
      )
      assert.equal(work.get(first.call_id)!.signal.reason, 'caller_cancelled')
      assert.equal(ca.status().running, 2)
      assert.equal(cb.status().running, 1)
      assert.equal(f.gateway.status().inflight, 2)
      assert.equal(f.gateway.status().connections, 2)
      assert.equal(ca.status().connection_epoch, epoch)
      assert.equal(work.get(calls[1]!.call_id)!.signal.aborted, false)
      assert.equal(work.get(calls[2]!.call_id)!.signal.aborted, false)
      assert.equal(f.gateway.cancel(first.call_id).state, 'outcome_unknown')
      assert.equal(cancels(f).length, 1)
      const raw = cancels(f)[0]!
      captured[0]!.send(raw)
      captured[0]!.send(JSON.stringify({ ...JSON.parse(raw), message_id: randomUUID() }))
      const followup = f.call(a.target)
      calls.push(followup)
      f.gateway.dispatch(followup.call_id)
      await until(
        /** 同 socket 的后续请求启动，证明前面的重复取消已处理且没有误关共享连接。 */
        () => work.has(followup.call_id)
      )
      for (const item of work.values()) {
        item.finish()
      }
      await until(
        /** 取消后的迟到合成返回不交付，其它两份响应仍走原事务提交。 */
        () => ca.status().running === 0 && cb.status().running === 0 && f.gateway.status().inflight === 0
      )
      assert.equal(work.get(first.call_id)!.aborts, 1)
      assert.equal(work.size, 4)
      assert.equal(f.router.get(f.principal, first.call_id).state, 'outcome_unknown')
      assert.equal(f.router.get(f.principal, calls[1]!.call_id).state, 'responded')
      assert.equal(f.router.get(f.principal, calls[2]!.call_id).state, 'responded')
      assert.equal(f.router.get(f.principal, followup.call_id).state, 'responded')
      assert.equal(f.gateway.status().connections, 2)
      assert.equal(f.gateway.cancel(calls[1]!.call_id).state, 'responded')
      assert.equal(cancels(f).length, 1)
    } finally {
      b.stop()
    }
  }
)

test(
  '取消先于 accepted 到达时不复活状态或误关连接，后续独立调用仍可完成',
  /** 同步连续 dispatch/cancel，使 accepted 必然在持久取消之后才由 Gateway 接收。 */
  async () => {
    const b = blocked()
    const { f, work } = b
    const a = f.pair('mock_cancel_before_accept')
    const client = b.connect(a)
    try {
      await until(
        /** 等待真实认证连接可派发。 */
        () => client.status().phase === 'ready'
      )
      const first = f.call(a.target)
      f.gateway.dispatch(first.call_id)
      assert.equal(f.gateway.cancel(first.call_id).state, 'outcome_unknown')
      await until(
        /** 先写出的请求仍可能启动工作；只确认同 attempt 的取消已到达。 */
        () => work.get(first.call_id)?.signal.aborted === true
      )
      const second = f.call(a.target)
      f.gateway.dispatch(second.call_id)
      await until(
        /** 后续请求能启动，证明迟到 accepted 没有误关共享通道。 */
        () => work.has(second.call_id)
      )
      work.get(second.call_id)!.finish()
      await until(
        /** 后续独立响应经过真实 Store 提交。 */
        () => f.router.get(f.principal, second.call_id).state === 'responded'
      )
      assert.equal(f.router.get(f.principal, first.call_id).state, 'outcome_unknown')
      assert.equal(f.gateway.status().connections, 1)
    } finally {
      b.stop()
    }
  }
)

test(
  '逐次复验取消归属及当前双端 cancel 权限，取消不额外要求 read，未派发调用不发帧',
  /** 拒绝时不修改调用或发送；取消仅有 cancel 权限的原调用也保持原生结果未知。 */
  async () => {
    const b = blocked()
    const { f, work } = b
    const a = f.pair('mock_cancel_policy')
    const client = b.connect(a)
    const owner = f.principal.id
    try {
      await until(
        /** 等待当前设备可派发。 */
        () => client.status().phase === 'ready'
      )
      const created = f.call(a.target)
      assert.equal(f.gateway.cancel(created.call_id).state, 'not_dispatched')
      assert.equal(cancels(f).length, 0)
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 建立仍运行的真实 attempt，再撤销取消授权。 */
        () => work.has(call.call_id)
      )
      f.principal.id = 'different_owner'
      assert.throws(
        /** 其它受信主体也不能取消不属于自己的调用。 */
        () => f.gateway.cancel(call.call_id)
      )
      f.principal.id = owner
      f.principal.device_scope = { mode: 'selected', machine_ids: [] }
      assert.throws(() => f.gateway.cancel(call.call_id), /forbidden/)
      assert.equal(cancels(f).length, 0)
      assert.equal(work.get(call.call_id)!.signal.aborted, false)
      delete f.principal.device_scope
      assert.equal(f.gateway.cancel(call.call_id).state, 'outcome_unknown')
      await until(
        /** 不要求 read 的取消仍须经过 Wire 双端 cancel 门禁才能到达。 */
        () => work.get(call.call_id)!.signal.aborted
      )
    } finally {
      f.principal.id = owner
      b.stop()
    }
  }
)

for (const field of ['epoch', 'call', 'attempt', 'native_id'] as const) {
  test(
    `损坏 cancel 的 ${field} 被真实 Connector Wire 拒绝，不能按伪造 binding 选择控制器`,
    /** 只在真实 Gateway 编码完成后破坏单轴，连接级拒绝不能冒称目标调用取消已送达。 */
    async () => {
      const b: ReturnType<typeof blocked> = blocked({
        /** 保留真实 session、账本和 Wire，只在发送边界注入协议负例。 */
        session(connection, channel) {
          const base = b.f.session(connection, channel)
          return {
            ...base,
            adapter: {
              ...base.adapter,
              /** 真实编码先完整授权；损坏只用于检验接收端的独立 binding 复验。 */
              encode(frame, direction) {
                const raw = base.adapter.encode(frame, direction)
                if (frame.type !== 'cancel') {
                  return raw
                }
                const changed = JSON.parse(raw)
                if (field === 'epoch') {
                  changed.connection_epoch = 'different_epoch'
                }
                if (field === 'call') {
                  changed.payload.attempt.call_id = 'different_call'
                }
                if (field === 'attempt') {
                  changed.payload.attempt.attempt_id = 'different_attempt'
                }
                if (field === 'native_id') {
                  changed.payload.attempt.native_request_id = 'different_native_id'
                }
                return JSON.stringify(changed)
              }
            }
          }
        }
      })
      const { f, work } = b
      const a = f.pair('mock_invalid_cancel')
      const client = b.connect(a)
      try {
        await phaseTiming(`transport.cancel.${field}.ready`, () => until(() => client.status().phase === 'ready'))
        const call = f.call(a.target)
        f.gateway.dispatch(call.call_id)
        await phaseTiming(`transport.cancel.${field}.dispatch`, () => until(() => work.has(call.call_id)))
        f.gateway.cancel(call.call_id)
        await phaseTiming(`transport.cancel.${field}.closed`, () => until(() => work.get(call.call_id)!.signal.aborted))
        assert.notEqual(work.get(call.call_id)!.signal.reason, 'caller_cancelled')
        assert.equal(work.size, 1)
        assert.equal(f.router.get(f.principal, call.call_id).state, 'outcome_unknown')
      } finally {
        b.stop()
      }
    }
  )
}

test(
  '旧 epoch 的取消不转交新连接，旧原生 Promise 收尾也不影响新调用',
  /** 先实际关闭原 socket，再在 fresh epoch 取消旧 call，禁止重连后重放取消或工作。 */
  async () => {
    const b = blocked()
    const { f, work } = b
    const a = f.pair('mock_cancel_reconnect')
    const old = b.connect(a)
    try {
      await until(
        /** 等待原连接可派发。 */
        () => old.status().phase === 'ready'
      )
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 确认旧 epoch 有真实未完成工作。 */
        () => work.has(call.call_id)
      )
      const epoch = old.status().connection_epoch
      old.stop()
      await until(
        /** 等待 Gateway 也处理关闭，不能只用 Connector abort 替代收敛。 */
        () => f.gateway.status().connections === 0
      )
      const fresh = b.connect(a)
      await until(
        /** 新 socket 必须重新认证并取得独立 epoch。 */
        () => fresh.status().phase === 'ready'
      )
      assert.notEqual(fresh.status().connection_epoch, epoch)
      const next = f.call(a.target)
      f.gateway.dispatch(next.call_id)
      await until(
        /** 在新 epoch 上建立另一真实调用。 */
        () => work.has(next.call_id)
      )
      assert.equal(f.gateway.cancel(call.call_id).state, 'outcome_unknown')
      assert.equal(cancels(f).length, 0)
      assert.equal(work.get(next.call_id)!.signal.aborted, false)
      work.get(call.call_id)!.finish()
      work.get(next.call_id)!.finish()
      await until(
        /** 只接纳新 epoch 的独立响应。 */
        () => f.router.get(f.principal, next.call_id).state === 'responded'
      )
      assert.equal(f.router.get(f.principal, call.call_id).state, 'outcome_unknown')
      assert.equal(work.size, 2)
    } finally {
      b.stop()
    }
  }
)

test(
  '真实 Luvus IPC adapter 经现有 AbortSignal 连接取消本地等待，不关闭其它设备或声称原生回滚',
  { timeout: 15_000 },
  /** 保留已写出的实际 IPC 请求，验证取消到达已有 adapter 的中止路径而非另建执行框架。 */
  async () => {
    const w = await wireFixture()
    let received = 0
    w.native.respond(
      /** 原生模拟 peer 接收后保持未回复，取消不证明其副作用撤销。 */
      () => {
        received++
      }
    )
    const a = w.pair('mock_cancel_ipc')
    const client = w.connect(a)
    try {
      await until(
        /** 真实两端完成认证及 adapter ready。 */
        () => client.status().phase === 'ready'
      )
      const call = w.f.call(a.target)
      w.f.gateway.dispatch(call.call_id)
      await until(
        /** 实际 IPC 已写出，取消只能报告结果未知。 */
        () => received === 1
      )
      assert.equal(w.f.gateway.cancel(call.call_id).state, 'outcome_unknown')
      await until(
        /** 等待已有 adapter 的本地等待被中止，Connector 释放真正结束的执行。 */
        () => client.status().running === 0 && w.state.rpcErrors.length === 1
      )
      assert.equal(w.state.rpcErrors[0]!.outcome, 'outcome_unknown')
      assert.equal(w.f.gateway.status().connections, 1)
      assert.equal(w.f.gateway.status().inflight, 0)
      assert.equal(w.f.router.get(w.f.principal, call.call_id).state, 'outcome_unknown')
      assert.equal(w.state.claim, 1)
      assert.equal(received, 1)
    } finally {
      await w.close()
    }
  }
)

test(
  '持久取消提交失败不写出 cancel，也不把未提交意图当成观察中止',
  /** 仅在既有 Store fault 接缝失败，不增加旁路事务或假成功。 */
  async () => {
    let rejectCommit = false
    const b = blocked(
      {},
      {
        /** 在当前取消所需事务提交前中断；断言发生在维护关闭传播之前。 */
        fault(point) {
          if (rejectCommit && point === 'before_commit') {
            throw new Error('mock_cancel_commit_failure')
          }
        }
      }
    )
    const { f, work } = b
    const a = f.pair('mock_cancel_commit')
    const client = b.connect(a)
    try {
      await until(
        /** 等待真实连接可派发。 */
        () => client.status().phase === 'ready'
      )
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 先确认有实际原生等待，再失败取消事务。 */
        () => work.has(call.call_id)
      )
      rejectCommit = true
      assert.throws(
        /** 失败必须对宿主可见，不能发送尚未持久提交的取消。 */
        () => f.gateway.cancel(call.call_id)
      )
      assert.equal(cancels(f).length, 0)
      assert.equal(work.get(call.call_id)!.signal.aborted, false)
      assert.equal(f.store.health().mode, 'storage_degraded')
    } finally {
      rejectCommit = false
      b.stop()
    }
  }
)

test(
  '取消编码期间关闭同一 socket 保留持久 unknown，不重发或重建原生工作',
  /** 在真实 Wire 已校验之后触发正常连接关闭，覆盖发送与关闭的同步竞争。 */
  async () => {
    const b: ReturnType<typeof blocked> = blocked({
      /** 所有身份与 adapter 仍来自实际 fixture，仅控制关闭时刻。 */
      session(connection, channel) {
        const base = b.f.session(connection, channel)
        return {
          ...base,
          adapter: {
            ...base.adapter,
            /** 先完成真实编码，再关闭该 socket；发送失败不能撤销持久取消。 */
            encode(frame, direction) {
              const raw = base.adapter.encode(frame, direction)
              if (frame.type === 'cancel') {
                b.f.gateway.disconnect(connection.machine_id)
              }
              return raw
            }
          }
        }
      }
    })
    const { f, work } = b
    const a = f.pair('mock_cancel_close_race')
    const client = b.connect(a)
    try {
      await until(
        /** 等待真实 ready。 */
        () => client.status().phase === 'ready'
      )
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 确认原工作已进入不可假定回滚的等待。 */
        () => work.has(call.call_id)
      )
      assert.equal(f.gateway.cancel(call.call_id).state, 'outcome_unknown')
      client.stop()
      await until(
        /** 独立核验两端关闭收敛，不能只以本地 abort 代替 Gateway 状态。 */
        () => work.get(call.call_id)!.signal.aborted && f.gateway.status().connections === 0
      )
      assert.equal(f.gateway.cancel(call.call_id).state, 'outcome_unknown')
      assert.equal(f.gateway.status().inflight, 0)
      assert.equal(work.size, 1)
      assert.equal(client.status().running, 1)
    } finally {
      b.stop()
    }
  }
)

test(
  '取消保留原锚点，合法迟到响应仍按同 attempt 事务补证，不改写取消历史或续期限',
  /** raw peer 在取消之后发送合法 accepted/response，Gateway 只忽略旧确认而保留真实证据。 */
  async () => {
    const offer = { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'], required: ['rpc'] }
    const f = fixture({ offer })
    const a = f.pair('mock_cancel_late')
    const raw = rawConnect(f.gateway.url, a.credential, offer)
    try {
      await until(
        /** welcome 提供真实 epoch，测试不构造认证事实。 */
        () => !!raw.epoch
      )
      const client_request_key = 'mock_cancel_history'
      const call = f.call(a.target, client_request_key)
      const binding = f.gateway.dispatch(call.call_id)
      assert.equal(f.gateway.cancel(call.call_id).state, 'outcome_unknown')
      const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
      raw.ws.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          machine_id,
          recovery_generation,
          connection_epoch,
          type: 'accepted',
          message_id: randomUUID(),
          payload: { attempt }
        })
      )
      f.now += 20
      const response = JSON.stringify(responseFrame(binding, { result: { id: 'mock_task' } }))
      raw.ws.send(response)
      raw.ws.send(response)
      await until(
        /** 同一合法旧 attempt 可以补充真实迟到证据，不能借取消重新派发。 */
        () => f.router.get(f.principal, call.call_id).state === 'responded'
      )
      const settled = f.router.get(f.principal, call.call_id)
      assert.equal(settled.deadline, call.deadline)
      assert.equal(settled.content_expires, call.content_expires)
      assert.equal(settled.dedup_expires, call.dedup_expires)
      const duplicate = f.call(a.target, client_request_key)
      assert.equal(duplicate.call_id, call.call_id)
      assert.equal(duplicate.deadline, call.deadline)
      assert.equal(duplicate.dedup_expires, call.dedup_expires)
      assert.throws(
        /** 原 history key 仍命中旧意图，终态调用不能因取消或迟到结果再次发送。 */
        () => f.gateway.dispatch(duplicate.call_id),
        /dispatch_rejected/
      )
      assert.equal(f.gateway.status().connections, 1)
      const actions = f.store.auditRecords().map(
        /** 保留原取消记录及独立 late_evidence，不把结果改称按时完成。 */
        (record) => record.action
      )
      assert.equal(
        actions.filter(
          /** 只统计本次取消的既有持久审计。 */
          (action) => action === 'cancelled'
        ).length,
        1
      )
      assert.equal(
        actions.filter(
          /** 重复响应不能再提交第二份晚到证据。 */
          (action) => action === 'late_evidence'
        ).length,
        1
      )
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)
