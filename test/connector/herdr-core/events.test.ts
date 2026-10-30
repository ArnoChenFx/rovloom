/**
 * 用假 core 核对事件订阅：只走 framed、按字节回补信用、只接受无过滤订阅；
 * missed 用新快照重建并丢弃旧 seq，EOF 结束等待交给调用方重订阅。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { subscribeHerdrCoreEvents } from '../../../src/connector/herdr-core/events.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { startFakeCore } from './fake-core.js'

const CONTRACT = compileHerdrCoreContract(
  readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
)

/** 真实 core 的 event 通知参数：type/terminal/data 加进程内 seq。 */
const event = (seq: number, type = 'status') =>
  JSON.stringify({ type, terminal: 't1', data: { status: { state: 'working' } }, seq })
/** missed 通知参数就是一份新快照。 */
const missed = (seq: number) =>
  JSON.stringify({
    method: 'missed',
    params: {
      seq,
      terminals: [
        {
          core: { id: '0f0e0d0c0b0a0908', name: 'fake-core' },
          address: 't1',
          created_ms: 1793335137041,
          status: { state: 'done' }
        }
      ]
    }
  })
const heartbeat = (seq: number) => JSON.stringify({ method: 'heartbeat', params: { seq } })

test('订阅先拿快照，再按 seq 递增交付事件并回补信用', async () => {
  const core = await startFakeCore({ events: [event(1), event(2, 'turn'), heartbeat(2)] })
  try {
    const client = await openHerdrCoreClient(core.socket)
    const subscription = await subscribeHerdrCoreEvents({ client, contract: CONTRACT })
    assert.equal(subscription.snapshot.seq, 0)
    assert.equal(subscription.snapshot.terminals.length, 1)
    assert.deepEqual(core.requests, ['events.subscribe'])
    const first = await subscription.next()
    assert.equal(first.kind, 'event')
    assert.equal(first.kind === 'event' && first.seq, 1)
    assert.equal(first.kind === 'event' && first.terminal, 't1')
    const second = await subscription.next()
    assert.equal(second.kind === 'event' && second.fact, 'turn')
    const beat = await subscription.next()
    assert.equal(beat.kind, 'heartbeat')
    // 事件通道上的每一帧都按实际字节数回补信用；没有回补，假 core 不会继续推送。
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(core.credits.length >= 3)
    subscription.close()
    client.close()
  } finally {
    await core.close()
  }
})

test('missed 用新快照重建，并丢弃不超过快照序号的在途事件', async () => {
  // 快照序号 10 之后先来一条旧事件 9（必须丢弃），再来 11（必须交付）。
  const core = await startFakeCore({ events: [missed(10), event(9), event(11)] })
  try {
    const client = await openHerdrCoreClient(core.socket)
    const subscription = await subscribeHerdrCoreEvents({ client, contract: CONTRACT })
    const rebuilt = await subscription.next()
    assert.equal(rebuilt.kind, 'snapshot')
    assert.equal(rebuilt.kind === 'snapshot' && rebuilt.rebuilt, true)
    assert.equal(rebuilt.kind === 'snapshot' && rebuilt.seq, 10)
    const after = await subscription.next()
    assert.equal(after.kind, 'event')
    assert.equal(after.kind === 'event' && after.seq, 11)
    assert.equal(subscription.stats().stale_events, 1)
    subscription.close()
    client.close()
  } finally {
    await core.close()
  }
})

test('EOF 结束本地等待，交给调用方重订阅而不是假装还有事件', async () => {
  const core = await startFakeCore({ events: [event(1)] })
  try {
    const client = await openHerdrCoreClient(core.socket)
    const subscription = await subscribeHerdrCoreEvents({ client, contract: CONTRACT })
    assert.equal((await subscription.next()).kind, 'event')
    core.disconnect()
    const closed = await subscription.next()
    assert.deepEqual(closed, { kind: 'closed', reason: 'eof' })
    // 结束后重复取仍然是同一个 closed，不会挂起。
    assert.deepEqual(await subscription.next(), { kind: 'closed', reason: 'eof' })
    subscription.close()
    client.close()
  } finally {
    await core.close()
  }
})

test('过滤参数在发出原生请求之前被拒绝', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    // 过滤订阅会留下空洞；本期只接受无过滤订阅，且拒绝发生在任何原生请求之前。
    await assert.rejects(
      (async () => {
        const { reviewHerdrCoreEventParams } = await import('../../../src/connector/herdr-core/methods.js')
        reviewHerdrCoreEventParams({ terminal: 't1' })
      })(),
      /herdr_core_param_blocked/u
    )
    assert.deepEqual(core.requests, [])
    client.close()
  } finally {
    await core.close()
  }
})

test('慢消费者以背压结束订阅，不静默丢中间事件', async () => {
  const core = await startFakeCore({ events: [event(1), event(2), event(3)] })
  try {
    const client = await openHerdrCoreClient(core.socket)
    const subscription = await subscribeHerdrCoreEvents({ client, contract: CONTRACT, max_queued: 1 })
    // 不取事件，等假 core 把三条都推完。
    await new Promise((resolve) => setTimeout(resolve, 50))
    const first = await subscription.next()
    assert.equal(first.kind, 'event')
    const second = await subscription.next()
    assert.deepEqual(second, { kind: 'closed', reason: 'backpressure' })
    subscription.close()
    client.close()
  } finally {
    await core.close()
  }
})

test('未审核的 core 版本在握手阶段就拒绝', async () => {
  const core = await startFakeCore({ hello: { version: '0.1.15' } })
  try {
    await assert.rejects(openHerdrCoreClient(core.socket), /herdr_core_version_unreviewed/u)
  } finally {
    await core.close()
  }
})

test('订阅不是普通 RPC：观察入口与 Wire 准入都拒绝，原生一次都不收到', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    const methods = await import('../../../src/connector/herdr-core/methods.js')
    assert.equal(methods.herdrCoreExposed('events.subscribe'), false)
    assert.throws(() => methods.reviewHerdrCoreParams('events.subscribe', {}), /herdr_core_method_unavailable/u)
    assert.deepEqual(core.requests, [])
    client.close()
  } finally {
    await core.close()
  }
})
