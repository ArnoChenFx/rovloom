/**
 * 重新附着的策略：退避、单飞、冷却与固定失败码。
 * 真实身份核对（内核 peer、exe 摘要、契约摘要）在真实 core 端到端里覆盖，这里只测轮询策略。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderAdapterError } from '../../../src/connector/provider-error.js'
import {
  HERDR_CORE_REATTACH_COOLDOWN_MS,
  HERDR_CORE_REATTACH_DELAYS_MS,
  createAttachmentSupervisor
} from '../../../src/connector/herdr-core/installation.js'

/** 假时钟：sleep 直接推进时间，测试不等待真实毫秒。 */
function clockwork() {
  let clock = 0
  const slept: number[] = []
  return {
    now: () => clock,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms)
      clock += ms
    },
    advance: (ms: number) => {
      clock += ms
    }
  }
}

test('断线后按退避序列重试，成功即返回，失败保留最后一个固定码', async () => {
  const clock = clockwork()
  const calls: number[] = []
  let failures = 2
  const supervisor = createAttachmentSupervisor<{ id: string }>({
    attach: async () => {
      calls.push(clock.now())
      if (failures-- > 0) {
        throw new ProviderAdapterError('herdr_core_connection_closed')
      }
      return { id: 'attached' }
    },
    stale: () => false,
    now: clock.now,
    sleep: clock.sleep
  })
  const attached = await supervisor.ensure(6000)
  assert.equal(attached.id, 'attached')
  // 第一次立即尝试，之后按 250、500 毫秒退避；没有热循环。
  assert.deepEqual(calls, [0, 250, 750])
  assert.deepEqual(clock.slept, [250, 500])
  assert.equal(supervisor.stats().attempts, 3)
  assert.equal(supervisor.current()?.id, 'attached')
  assert.equal(supervisor.stats().last_error, undefined)
})

test('一轮失败后冷却期内直接失败，不逐请求重试', async () => {
  const clock = clockwork()
  let calls = 0
  const supervisor = createAttachmentSupervisor<{ id: string }>({
    attach: async () => {
      calls += 1
      throw new ProviderAdapterError('herdr_core_connection_closed')
    },
    stale: () => false,
    now: clock.now,
    sleep: clock.sleep
  })
  await assert.rejects(supervisor.ensure(6000), /herdr_core_connection_closed/u)
  const attempts = calls
  // 退避序列的每一次都试过；预算内没有成功就收敛。
  assert.equal(attempts, HERDR_CORE_REATTACH_DELAYS_MS.length)
  // 冷却期内再调用：不再连接。
  await assert.rejects(supervisor.ensure(6000), /herdr_core_connection_closed/u)
  assert.equal(calls, attempts)
  // 冷却结束后才允许新的一轮。
  clock.advance(HERDR_CORE_REATTACH_COOLDOWN_MS)
  await assert.rejects(supervisor.ensure(100), /herdr_core_connection_closed/u)
  assert.ok(calls > attempts)
})

test('并发的 ensure 共享同一轮，不会同时建立多条连接', async () => {
  const clock = clockwork()
  let calls = 0
  let release!: (value: { id: string }) => void
  const supervisor = createAttachmentSupervisor<{ id: string }>({
    attach: () => {
      calls += 1
      return new Promise<{ id: string }>((resolve) => {
        release = resolve
      })
    },
    stale: () => false,
    now: clock.now,
    sleep: clock.sleep
  })
  const first = supervisor.ensure(6000)
  const second = supervisor.ensure(6000)
  await Promise.resolve()
  assert.equal(calls, 1)
  release({ id: 'attached' })
  assert.deepEqual(await Promise.all([first, second]), [{ id: 'attached' }, { id: 'attached' }])
})

test('预算只够一次尝试时立即失败，不为退避等待', async () => {
  const clock = clockwork()
  let calls = 0
  const supervisor = createAttachmentSupervisor<{ id: string }>({
    attach: async () => {
      calls += 1
      throw new ProviderAdapterError('herdr_core_connection_closed')
    },
    stale: () => false,
    now: clock.now,
    sleep: clock.sleep
  })
  await assert.rejects(supervisor.ensure(1), /herdr_core_connection_closed/u)
  assert.equal(calls, 1)
  // 退避等待也被剩余预算截断，不会为一个不可能完成的轮次多等。
  assert.ok(clock.slept.reduce((total, ms) => total + ms, 0) <= 1)
})

test('已关闭的连接不再代表来源：current 变空后重新附着', async () => {
  const clock = clockwork()
  const attached = { id: 'first', closed: false }
  let calls = 0
  const supervisor = createAttachmentSupervisor<{ id: string; closed: boolean }>({
    attach: async () => {
      calls += 1
      return { id: 'second', closed: false }
    },
    stale: (value) => value.closed,
    now: clock.now,
    sleep: clock.sleep,
    seed: attached
  })
  assert.equal(supervisor.current()?.id, 'first')
  // 断线后 current 立即不可用，但不会自动重连（重连只在 ensure 里）。
  attached.closed = true
  assert.equal(supervisor.current(), undefined)
  assert.equal(calls, 0)
  assert.equal((await supervisor.ensure(6000)).id, 'second')
  assert.equal(calls, 1)
  // invalidate 只丢弃当前值。
  supervisor.invalidate()
  assert.equal(supervisor.current(), undefined)
})

test('身份变化不被折叠成连接失败，冷却后仍报告同一固定码', async () => {
  const clock = clockwork()
  const supervisor = createAttachmentSupervisor<{ id: string }>({
    attach: async () => {
      throw new ProviderAdapterError('herdr_core_installation_changed')
    },
    stale: () => false,
    now: clock.now,
    sleep: clock.sleep,
    delays: [0],
    cooldownMs: 50
  })
  await assert.rejects(supervisor.ensure(1000), /herdr_core_installation_changed/u)
  await assert.rejects(supervisor.ensure(1000), /herdr_core_installation_changed/u)
  // 非 ProviderAdapterError 只折叠成连接失败，不泄露底层文本。
  const other = createAttachmentSupervisor<{ id: string }>({
    attach: async () => {
      throw new Error('/tmp/hcs.secret: ENOENT')
    },
    stale: () => false,
    now: clock.now,
    sleep: clock.sleep,
    delays: [0]
  })
  await assert.rejects(other.ensure(1000), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'herdr_core_connection_closed')
    assert.ok(!String((error as Error).message).includes('hcs.secret'))
    return true
  })
})
