/**
 * `terminal.events` 长轮询的状态语义：rebuilt/truncated/dropped 按调用方水位现算且不黏住、
 * 订阅单飞、并发等待者全部被唤醒、removed 事件不被快照过滤吞掉、读快照期间到达的事件不被水位跳过。
 * 订阅与连接都是可控的桩：只验证 feed 自己的逻辑，真实 core 的行为由 e2e 覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import type { HerdrCoreEventNotice, HerdrCoreEventSubscription } from '../../../src/connector/herdr-core/events.js'
import { createHerdrCoreEventFeed } from '../../../src/connector/herdr-core/feed.js'
import type { HerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import type { JsonObject } from '../../../src/wire/types.js'

const status = (seq: number, terminal = 't1'): HerdrCoreEventNotice => ({
  kind: 'event',
  seq,
  fact: 'status',
  terminal,
  data: { state: 'working' }
})

function rig(options: { buffer?: number; snapshotSeq?: number; terminals?: JsonObject[]; delay?: number } = {}) {
  const state = {
    snapshotSeq: options.snapshotSeq ?? 0,
    terminals: options.terminals ?? [{ address: 't1', labels: { role: 'review' } }],
    subscribes: 0,
    onList: undefined as undefined | (() => void)
  }
  let feedNotices: HerdrCoreEventNotice[] = []
  let wake: (() => void) | undefined
  const closed = { value: false }
  const subscription = (): HerdrCoreEventSubscription => {
    feedNotices = []
    const mine = { value: false }
    return {
      snapshot: { seq: state.snapshotSeq, terminals: state.terminals },
      async next() {
        for (;;) {
          if (feedNotices.length > 0) {
            return feedNotices.shift()!
          }
          if (mine.value) {
            return { kind: 'closed', reason: 'eof' }
          }
          await new Promise<void>((resolve) => (wake = resolve))
        }
      },
      close() {
        mine.value = true
        closed.value = true
        wake?.()
      },
      stats: () => ({ stale_events: 0, delivered: 0, closed: mine.value })
    }
  }
  const client = {
    hello: { core: { id: 'core-a' } },
    async request(method: string) {
      assert.equal(method, 'terminal.list')
      if (state.onList) {
        state.onList()
        // 让到达的事件在读快照返回之前被 pump 消费，模拟真实 core 上读快照需要往返的时间。
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return { terminals: state.terminals }
    }
  } as unknown as HerdrCoreClient
  const contract = { validateResult: (_method: string, value: unknown) => value } as unknown as HerdrCoreContract
  const feed = createHerdrCoreEventFeed({
    client: () => client,
    contract: () => contract,
    ...(options.buffer === undefined ? {} : { buffer: options.buffer }),
    subscribe: async () => {
      state.subscribes += 1
      if (options.delay) {
        await new Promise((resolve) => setTimeout(resolve, options.delay))
      }
      return subscription()
    }
  })
  return {
    feed,
    state,
    /** 向当前订阅推送通知并唤醒 pump。 */
    push(...notices: HerdrCoreEventNotice[]) {
      feedNotices.push(...notices)
      wake?.()
    },
    close: () => feed.close()
  }
}

const poll = (r: ReturnType<typeof rig>, after: number, extra: Record<string, unknown> = {}) =>
  r.feed.poll({ after_seq: after, limit: 100, timeout_ms: 200, ...extra })

test('截断只对确实错过事件的调用方成立，追平后不黏住', async () => {
  const r = rig({ buffer: 4 })
  try {
    // 先建立订阅，再一口气推 12 条：缓冲只留最后 4 条（9..12）。
    await poll(r, 0, { timeout_ms: 10 })
    r.push(...Array.from({ length: 12 }, (_, index) => status(index + 1)))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const behind = await poll(r, 2)
    assert.equal(behind.truncated, true)
    assert.equal(behind.dropped, 6)
    assert.deepEqual(
      behind.events.map((event) => event.seq),
      [9, 10, 11, 12]
    )
    // 追平的调用方、以及同一个调用方带着新水位再来，都不该再被告知截断。
    const caughtUp = await poll(r, 12)
    assert.deepEqual([caughtUp.truncated, caughtUp.dropped, caughtUp.rebuilt], [false, 0, false])
    const again = await poll(r, behind.next_after_seq)
    assert.deepEqual([again.truncated, again.dropped], [false, 0])
  } finally {
    r.close()
  }
})

test('rebuilt 只对水位失效的调用方成立：报告一次后接着追不再重复', async () => {
  const r = rig()
  try {
    r.push(status(1))
    const reset = await poll(r, 999)
    assert.equal(reset.rebuilt, true)
    assert.equal(reset.next_after_seq, reset.seq)
    const next = await poll(r, reset.next_after_seq)
    assert.equal(next.rebuilt, false)
  } finally {
    r.close()
  }
})

test('missed 的新快照让更早的水位 rebuilt，快照之前的旧事件不再当作新事实', async () => {
  const r = rig()
  try {
    await poll(r, 0, { timeout_ms: 10 })
    r.push(status(1), status(2))
    const before = await poll(r, 0)
    assert.equal(before.next_after_seq, 2)
    r.push({ kind: 'snapshot', seq: 100, terminals: [], rebuilt: true }, status(50), status(101))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const stale = await poll(r, before.next_after_seq)
    assert.equal(stale.rebuilt, true)
    // seq 50 早于快照，被丢弃；只剩快照之后的 101。
    assert.deepEqual(
      stale.events.map((event) => event.seq),
      [101]
    )
    const fresh = await poll(r, stale.next_after_seq)
    assert.equal(fresh.rebuilt, false)
  } finally {
    r.close()
  }
})

test('订阅结束后重新订阅：新快照晚于调用方水位才 rebuilt，期间没有事件则不是', async () => {
  for (const [snapshotSeq, expected] of [
    [7, true],
    [5, false]
  ] as const) {
    const r = rig()
    try {
      await poll(r, 0, { timeout_ms: 10 })
      r.push(...[1, 2, 3, 4, 5].map((seq) => status(seq)))
      await new Promise((resolve) => setTimeout(resolve, 30))
      const at = await poll(r, 1)
      assert.equal(at.next_after_seq, 5)
      r.state.snapshotSeq = snapshotSeq
      r.push({ kind: 'closed', reason: 'eof' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      const after = await poll(r, 5)
      assert.equal(r.state.subscribes, 2)
      assert.equal(after.rebuilt, expected, `snapshotSeq=${snapshotSeq}`)
    } finally {
      r.close()
    }
  }
})

test('并发的首次轮询共用同一次订阅', async () => {
  const r = rig({ delay: 50 })
  try {
    await Promise.all([poll(r, 0, { timeout_ms: 30 }), poll(r, 0, { timeout_ms: 30 }), poll(r, 0, { timeout_ms: 30 })])
    assert.equal(r.state.subscribes, 1)
  } finally {
    r.close()
  }
})

test('并发等待的调用方全部被同一条事件唤醒', async () => {
  const r = rig()
  try {
    await poll(r, 0, { timeout_ms: 10 })
    const started = Date.now()
    const waiting = Promise.all([
      poll(r, 0, { timeout_ms: 5_000 }),
      poll(r, 0, { timeout_ms: 5_000 }),
      poll(r, 0, { timeout_ms: 5_000 })
    ])
    await new Promise((resolve) => setTimeout(resolve, 50))
    r.push(status(1))
    const results = await waiting
    assert(Date.now() - started < 2_000, '等待者没有被及时唤醒')
    for (const result of results) {
      assert.deepEqual(
        result.events.map((event) => event.seq),
        [1]
      )
    }
  } finally {
    r.close()
  }
})

test('removed 事件不因终端已不在快照里而被丢弃，address 与 labels 过滤仍然生效', async () => {
  const r = rig({ terminals: [{ address: 't7', labels: { role: 'review' } }] })
  try {
    await poll(r, 0, { timeout_ms: 10 })
    // 终端 t7 之后被移除：快照里已经没有它，但它的 removed 事件仍然要送达。
    r.state.terminals = []
    r.push(
      { kind: 'event', seq: 1, fact: 'finished', terminal: 't7', data: {} },
      { kind: 'event', seq: 2, fact: 'removed', terminal: 't7', data: {} },
      status(3, 't9')
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const unfiltered = await poll(r, 0)
    assert.deepEqual(
      unfiltered.events.map((event) => `${event.fact}:${event.terminal}`),
      ['finished:t7', 'removed:t7', 'status:t9']
    )
    const byAddress = await poll(r, 0, { address: 't7' })
    assert.deepEqual(
      byAddress.events.map((event) => event.fact),
      ['finished', 'removed']
    )
    const byLabels = await poll(r, 0, { labels: { role: 'review' } })
    assert.deepEqual(
      byLabels.events.map((event) => event.fact),
      ['finished', 'removed']
    )
    const other = await poll(r, 0, { labels: { role: 'other' }, timeout_ms: 50 })
    assert.deepEqual(other.events, [])
  } finally {
    r.close()
  }
})

test('读快照期间到达的事件不会被 next_after_seq 跳过', async () => {
  const r = rig()
  try {
    await poll(r, 0, { timeout_ms: 10 })
    // 超时检查点：读 terminal.list 的这一刻事件 1 到达。
    r.state.onList = () => {
      r.state.onList = undefined
      r.push(status(1))
    }
    const checkpoint = await poll(r, 0, { timeout_ms: 20 })
    assert.deepEqual(checkpoint.events, [])
    assert(checkpoint.next_after_seq < 1, '水位必须停在读快照之前')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const next = await poll(r, checkpoint.next_after_seq)
    assert.deepEqual(
      next.events.map((event) => event.seq),
      [1]
    )
  } finally {
    r.close()
  }
})

test('limit 只分页不丢事件：next_after_seq 停在最后一条已返回的事件', async () => {
  const r = rig()
  try {
    await poll(r, 0, { timeout_ms: 10 })
    r.push(...[1, 2, 3, 4, 5].map((seq) => status(seq)))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const seen: number[] = []
    let after = 0
    const nexts: number[] = []
    for (let round = 0; round < 3; round++) {
      const page = await poll(r, after, { limit: 2 })
      seen.push(...page.events.map((event) => event.seq))
      nexts.push(page.next_after_seq)
      after = page.next_after_seq
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5])
    assert.deepEqual(nexts, [2, 4, 5])
  } finally {
    r.close()
  }
})

test('被过滤掉的事件不会让长轮询提前返回，但水位照常前进', async () => {
  const r = rig({ terminals: [{ address: 't1', labels: {} }] })
  try {
    await poll(r, 0, { timeout_ms: 10 })
    const started = Date.now()
    const waiting = poll(r, 0, { address: 't1', timeout_ms: 300 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    r.push(status(1, 't9'))
    const result = await waiting
    assert(Date.now() - started >= 250, '无关终端的事件不该结束等待')
    assert.deepEqual(result.events, [])
    assert.equal(result.next_after_seq, 1)
  } finally {
    r.close()
  }
})
