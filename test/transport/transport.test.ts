// 验证两台模拟 Connector、多 provider 隔离、epoch 不重放、配额和资源回收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, rawConnect, until } from './helpers.js'
import { createConnector } from '../../src/transport/index.js'
import { responseFrame } from '../storage/helpers.js'

test(
  '两个 mock Connector 的身份、ready、调用、响应账本彼此隔离',
  /** 同时连接两台 mock 设备，验证 link 不等于 ready、响应独立且错设备凭据不能冒充。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock-a')
      const b = f.pair('mock-b')
      f.configs.get(a.machine_id)!.native = false
      const ca = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential
      )
      const cb = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => b.credential
      )
      await until(
        /** 等待两台 mock 设备分别完成独立握手登记。 */
        () => f.gateway.status().devices.length === 2
      )
      assert.equal(
        f.gateway.status().devices.find(
          /** 选取指定设备的健康观测，检查设备间状态隔离。 */
          (d) => d.machine_id === a.machine_id
        )!.ready,
        false
      )
      const first = f.call(a.target)
      assert.throws(
        /** 在该 provider 尚未通过可信核对时请求派发，确认没有发送许可。 */
        () => f.gateway.dispatch(first.call_id),
        /provider_not_ready/
      )
      f.configs.get(a.machine_id)!.native = true
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => ca.status().phase === 'ready' && cb.status().phase === 'ready'
      )
      f.gateway.dispatch(first.call_id)
      const second = f.call(b.target)
      f.gateway.dispatch(second.call_id)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () =>
          f.router.get(f.principal, first.call_id).state === 'responded' &&
          f.router.get(f.principal, second.call_id).state === 'responded'
      )
      assert.equal(f.executions, 2)
      assert.equal(f.gateway.status().inflight, 0)
      const copy = f.connector(
        /** 把 A 的 mock 凭据错误绑定到 B 的 machine ID，验证不能跨设备冒充。 */
        () => ({
          ...a.credential,
          machine_id: b.machine_id
        })
      )
      await until(
        /** 等待失败连接进入退避重连，观察握手或 TLS 的拒绝结果。 */
        () => copy.status().reconnects > 0
      )
      assert.equal(f.gateway.status().devices.length, 2)
      assert.equal(cb.status().phase, 'ready')
    } finally {
      f.stop()
    }
    assert.deepEqual(f.sessions, { opened: 4, closed: 4 })
  }
)

test(
  '复制凭据不能抢连接；重连稳定 ID、新 epoch，旧调用保持 unknown 且不重放',
  /** 阻塞原生结果并建立复制连接，断言复制者不抢占、重连新 epoch 且旧调用不重放。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      let release: ((value: Record<string, unknown>) => void) | undefined
      let inputId = ''
      const ca = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential,
        {
          /** 记录原生请求 ID 并阻塞结果，保留跨断线释放旧响应的可控入口。 */
          execute: (raw) => {
            inputId = JSON.parse(raw).id
            return new Promise(
              /** 保存 mock 原生响应完成入口，使测试可在重连后交付旧 epoch 的结果。 */
              (resolve) => {
                release = resolve
              }
            )
          }
        }
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => ca.status().phase === 'ready'
      )
      const oldEpoch = ca.status().connection_epoch
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待 mock 原生请求进入可由测试释放的阻塞点。 */
        () => !!release
      )
      const duplicate = rawConnect(f.gateway.url, a.credential)
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => duplicate.ws.readyState === 3
      )
      assert.equal(ca.status().connection_epoch, oldEpoch)
      ca.disconnect()
      await until(
        /** 等待同一设备在新的 epoch 完成 ready，验证重连没有复用旧连接。 */
        () => ca.status().phase === 'ready' && ca.status().connection_epoch !== oldEpoch
      )
      assert.equal(ca.status().machine_id, a.machine_id)
      assert.equal(f.router.get(f.principal, call.call_id).state, 'outcome_unknown')
      release!({ id: inputId, result: { id: 'late_mock' } })
      await until(
        /** 等待实际执行 Promise 收尾并释放 Connector 并发计数。 */
        () => ca.status().running === 0
      )
      assert.equal(f.router.get(f.principal, call.call_id).state, 'outcome_unknown')
      assert.throws(
        /** 再次派发已有 attempt，确认账本禁止重连后重放原动作。 */
        () => f.gateway.dispatch(call.call_id),
        /dispatch_rejected/
      )
    } finally {
      f.stop()
    }
  }
)

test(
  '旧 epoch、错误方向和未认证业务帧均关闭通道，不能伪造 principal',
  /** 向通道注入旧 epoch 与未认证请求，断言伪造 principal 不会创建执行。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      const raw = rawConnect(f.gateway.url, a.credential)
      await until(
        /** 等待收到匹配 welcome 的真实 epoch，供手工帧负例使用。 */
        () => !!raw.epoch
      )
      raw.ws.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'heartbeat',
          message_id: 'old',
          machine_id: a.machine_id,
          recovery_generation: a.credential.recovery_generation,
          connection_epoch: 'old_epoch',
          payload: { sequence: 0 }
        })
      )
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => raw.ws.readyState === 3
      )
      const unauthed = new WebSocket(f.gateway.url)
      unauthed.onopen =
        /** 直接发送带伪造 owner 字段的未认证业务输入，测试身份不能由 JSON 建立。 */
        () => unauthed.send(JSON.stringify({ type: 'request', principal: 'owner' }))
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => unauthed.readyState === 3
      )
      assert.equal(f.gateway.status().connections, 0)
      assert.equal(f.executions, 0)
    } finally {
      f.stop()
    }
  }
)

test(
  'major 拒绝、minor 取交集，双端 revision/策略不一致不得 ready',
  /** 覆盖 major 拒绝和 minor 交集，逐次修复策略及 binding 后才允许 ready。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      const unsupported = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential,
        {
          offer: { major: 3, minor: 0, capabilities: ['rpc'], required: [] }
        }
      )
      await until(
        /** 等待失败连接进入退避重连，观察握手或 TLS 的拒绝结果。 */
        () => unsupported.status().reconnects > 0
      )
      unsupported.stop()
      const ca = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential,
        {
          offer: { major: 2, minor: 9, capabilities: ['rpc'], required: ['rpc'] }
        }
      )
      await until(
        /** 等待握手认证完成，同时观察配置不一致时保持不可 ready。 */
        () => ca.status().phase === 'ready'
      )
      assert.equal(f.gateway.status().devices[0]!.ready, true)
      const binding = f.localBindings.get(a.machine_id + '/provider')!
      binding.binding_revision = 2
      assert.equal(f.gateway.status().devices[0]!.ready, false)
      binding.binding_revision = 1
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => ca.status().phase === 'ready'
      )
      const c = f.call(a.target)
      f.gateway.dispatch(c.call_id)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () => f.router.get(f.principal, c.call_id).state === 'responded'
      )
    } finally {
      f.stop()
    }
  }
)

test(
  'provider 禁用与 caller 撤权立即阻止新派发和读取，不影响其它设备',
  /** 即时撤掉 caller grant 并禁用单个 provider，验证读取拒绝且其它设备不受影响。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock-a')
      const b = f.pair('mock-b')
      f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential
      )
      f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => b.credential
      )
      await until(
        /** 等待两台设备都通过各自 provider 核对，随后再测试单目标撤权。 */
        () =>
          f.gateway.status().devices.filter(
            /** 只保留已经通过可信 provider 核对的健康记录。 */
            (d) => d.ready
          ).length === 2
      )
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () => f.router.get(f.principal, call.call_id).state === 'responded'
      )
      f.principal.device_scope = { mode: 'selected', machine_ids: [b.machine_id] }
      assert.throws(
        /** 撤回 caller grant 后读取原响应，确认当前读取授权即时拒绝。 */
        () => f.router.get(f.principal, call.call_id),
        /forbidden/
      )
      f.store.setProviderEnabled(a.machine_id, 'provider', 1, false)
      assert.equal(
        f.gateway.status().devices.find(
          /** 选取指定设备的健康观测，检查设备间状态隔离。 */
          (d) => d.machine_id === a.machine_id
        )!.ready,
        false
      )
      assert.equal(
        f.gateway.status().devices.find(
          /** 选取指定设备的健康观测，检查设备间状态隔离。 */
          (d) => d.machine_id === b.machine_id
        )!.ready,
        true
      )
      const second = f.call(b.target)
      f.gateway.dispatch(second.call_id)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () => f.router.get(f.principal, second.call_id).state === 'responded'
      )
    } finally {
      f.stop()
    }
  }
)

test(
  '一条设备连接承载多个受信 provider，单实例禁用不关闭其它实例',
  /** 同一 socket 配置两个独立 provider，禁用一个后仍能向另一个按可信 binding 派发。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      const second = f.store.defineProvider({
        machine_id: a.machine_id,
        provider_id: 'second',
        kind: 'luvus',
        config_ref: 'mock_second',
        binding_revision: 1,
        enabled: true
      })
      f.localBindings.set(a.machine_id + '/second', second)
      const target = { ...a.target, provider_id: 'second' }
      const client = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential,
        {
          /** 检查 execute 收到的账本 binding，确认 provider 选择不依赖原生 JSON 自报。 */
          execute: async (raw, _signal, binding) => {
            assert.equal(binding.target.provider_id, 'second')
            assert.equal(binding.machine_id, a.machine_id)
            return { id: JSON.parse(raw).id, result: { id: 'mock_second_task' } }
          }
        }
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => client.status().phase === 'ready'
      )
      const epoch = client.status().connection_epoch
      assert.equal(
        f.gateway.status().devices[0]!.providers.filter(
          /** 只保留已经通过可信 provider 核对的健康记录。 */
          (p) => p.ready
        ).length,
        2
      )
      f.store.setProviderEnabled(a.machine_id, 'provider', 1, false)
      assert.equal(f.gateway.status().devices[0]!.ready, true)
      const call = f.call(target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () => f.router.get(f.principal, call.call_id).state === 'responded'
      )
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(f.gateway.status().connections, 1)
    } finally {
      f.stop()
    }
  }
)

test(
  '原生 auth 注入后的完整帧超预算时不执行原生调用',
  /** 注入超过原生完整帧预算的 mock auth，断言派发收敛 unknown 且没有原生执行。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      const ca = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential,
        {
          /** 仅向 mock auth 添加超大字段，确保预算检查覆盖注入后的完整 JSON。 */
          nativeInput: (input) => ({ ...input, auth: { mock_only: 'x'.repeat(2000) } }),
          limits: { native_bytes: 1000, heartbeat_ms: 30, reconnect_ms: 100, handshake_ms: 200 }
        }
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => ca.status().phase === 'ready'
      )
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待断线把可能已派发的调用收敛为 outcome_unknown。 */
        () => f.router.get(f.principal, call.call_id).state === 'outcome_unknown'
      )
      assert.equal(f.executions, 0)
    } finally {
      f.stop()
    }
  }
)

test(
  '未认证连接、握手超时和认证洪泛均有界清理',
  /** 限制握手和认证额度，断言超时及洪泛拒绝都会释放连接状态。 */
  async () => {
    const f = fixture({
      limits: {
        connections: 2,
        unauthenticated: 1,
        handshake_ms: 1000,
        heartbeat_ms: 20,
        idle_ms: 100,
        auth_per_minute: 1
      }
    })
    try {
      const first = new WebSocket(f.gateway.url)
      await until(
        /** 等待仅链路建立的测试 socket，保留尚未认证的握手状态。 */
        () => first.readyState === 1
      )
      const refused = new WebSocket(f.gateway.url)
      refused.onerror =
        /** 接住预期的连接额度拒绝事件，避免负例产生未处理的网络错误。 */
        () => {}
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => refused.readyState === 3
      )
      assert.equal(f.gateway.status().connections, 1)
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => first.readyState === 3
      )
      assert.equal(f.gateway.status().connections, 0)
      const fake = rawConnect(f.gateway.url, {
        machine_id: 'fake',
        recovery_generation: f.store.generation(),
        credential: 'mock_only_invalid'
      })
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => fake.ws.readyState === 3
      )
      const flood = new WebSocket(f.gateway.url)
      flood.onerror =
        /** 接住预期的认证洪泛拒绝事件，保留对资源清理的断言。 */
        () => {}
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => flood.readyState === 3
      )
      assert.equal(f.gateway.status().connections, 0)
    } finally {
      f.stop()
    }
  }
)

test(
  'WS/WSS URL 不携带凭据、查询或任意端点',
  /** 枚举非法协议与夹带秘密的 URL，断言配置在启动连接前被拒绝。 */
  () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      for (const url of [
        'http://example.invalid/connector',
        'wss://user:secret@example.invalid/connector',
        f.gateway.url + '?secret=mock',
        'wss://example.invalid/other'
      ]) {
        assert.throws(
          /** 用禁止的 URL 构造 Connector，检查连接前的 TLS 和地址边界。 */
          () =>
            createConnector({
              url,
              developmentLoopback: true,
              /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
              credential: () => a.credential,
              session: f.session,
              /** 保留不会执行的 URL 负例输入形状，不注入或建立任何原生授权。 */
              nativeInput: (v) => v,
              /** 提供不会执行的 URL 负例宿主占位；地址校验应先于原生调用。 */
              execute: async () => ({})
            })
        )
      }
    } finally {
      f.stop()
    }
  }
)

test(
  '重复响应不重复提交，冲突 message_id 关闭通道且不改已提交结果',
  /** 重复发送同一响应后再注入消息 ID 冲突，断言终态只提交一次且原结果不被改写。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      const peer = rawConnect(f.gateway.url, a.credential)
      await until(
        /** 等待收到匹配 welcome 的真实 epoch，供手工帧负例使用。 */
        () => !!peer.epoch
      )
      const call = f.call(a.target)
      const binding = f.gateway.dispatch(call.call_id)
      const response = responseFrame(binding, { result: { id: 'mock_task' } })
      const raw = JSON.stringify(response)
      peer.ws.send(raw)
      peer.ws.send(raw)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () => f.router.get(f.principal, call.call_id).state === 'responded'
      )
      assert.equal(f.gateway.status().connections, 1)
      peer.ws.send(
        JSON.stringify({
          ...response,
          payload: {
            ...response.payload,
            native_response: { id: binding.native_request_id, result: { id: 'conflicting' } }
          }
        })
      )
      await until(
        /** 等待被拒绝或过期的测试 socket 完成关闭。 */
        () => peer.ws.readyState === 3
      )
      assert.equal(JSON.parse(f.router.get(f.principal, call.call_id).response!).result.id, 'mock_task')
      const responses = f.store.auditRecords().filter(
        /** 仅统计持久响应终态审计，检查重复响应没有二次提交。 */
        (r) => r.action === 'responded'
      )
      assert.equal(responses.length, 1)
    } finally {
      f.stop()
    }
  }
)

test(
  '发送超限/原生并发上限拒绝新工作；关闭回收计数且不虚报原生回滚',
  /** 将原生并发限制为一，注入第二次请求并检查中止、unknown 与真实收尾计数。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      let started = 0
      let aborted = 0
      const finish: (() => void)[] = []
      const ca = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential,
        {
          limits: { inflight: 1, heartbeat_ms: 30, reconnect_ms: 100, handshake_ms: 200 },
          /** 记录 mock 原生启动和中止，并阻塞返回以观察并发上限行为。 */
          execute: (raw, signal) => {
            started++
            signal.addEventListener(
              'abort',
              /** 只统计观察用 AbortSignal 的传播，不把它当作原生工作已回滚。 */
              () => {
                aborted++
              }
            )
            return new Promise(
              /** 保存 mock 原生完成回调，供关闭后验证执行 Promise 仍占用额度直到结束。 */
              (resolve) => {
                finish.push(
                  /** 按原请求 ID 完成受控 mock 响应，让测试显式回收未结束的执行。 */
                  () => resolve({ id: JSON.parse(raw).id, result: { id: 'mock_task' } })
                )
              }
            )
          }
        }
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => ca.status().phase === 'ready'
      )
      const first = f.call(a.target)
      f.gateway.dispatch(first.call_id)
      await until(
        /** 等待首个原生请求实际启动，以制造可观察的并发占用。 */
        () => started === 1
      )
      const second = f.call(a.target)
      f.gateway.dispatch(second.call_id)
      await until(
        /** 两端关闭独立传播；AbortSignal 不能代替 Gateway 账本与额度已收敛的事实。 */
        () =>
          aborted > 0 &&
          f.router.get(f.principal, first.call_id).state === 'outcome_unknown' &&
          f.router.get(f.principal, second.call_id).state === 'outcome_unknown' &&
          f.gateway.status().inflight === 0
      )
      assert.equal(started, 1)
      assert.equal(f.router.get(f.principal, first.call_id).state, 'outcome_unknown')
      assert.equal(f.router.get(f.principal, second.call_id).state, 'outcome_unknown')
      assert.equal(f.gateway.status().inflight, 0)
      assert.equal(ca.status().running, 1)
      finish.forEach(
        /** 逐个完成受控原生 Promise，回收测试中仍占用的并发额度。 */
        (fn) => fn()
      )
      await until(
        /** 等待实际执行 Promise 收尾并释放 Connector 并发计数。 */
        () => ca.status().running === 0
      )
    } finally {
      f.stop()
    }
  }
)

test(
  '已完成 attempt 释放原生状态，持续连接跨越 adapter 默认 128 条容量',
  { timeout: 120_000 },
  /** 在单个 epoch 连续完成 130 次调用，验证已完成 adapter 状态被释放且无需重连。 */
  async () => {
    const f = fixture({ limits: { heartbeat_ms: 100, idle_ms: 3000, messages_per_second: 2000 } })
    try {
      const a = f.pair('mock')
      const ca = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential,
        {
          limits: { heartbeat_ms: 100, idle_ms: 3000, messages_per_second: 2000 }
        }
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => ca.status().phase === 'ready'
      )
      const epoch = ca.status().connection_epoch
      for (let i = 0; i < 130; i++) {
        const call = f.call(a.target)
        f.gateway.dispatch(call.call_id)
        await until(
          /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
          () => f.router.get(f.principal, call.call_id).state === 'responded'
        )
      }
      assert.equal(f.executions, 130)
      assert.equal(ca.status().connection_epoch, epoch)
      assert.equal(ca.status().running, 0)
    } finally {
      f.stop()
    }
  }
)
