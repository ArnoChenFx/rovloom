/**
 * `terminal.events` 长轮询：快照 + 自水位以来的事件、core 重启后水位重建、缓冲截断标记、
 * address/labels 过滤与参数收紧。用假 core 的真实 framed 事件流。
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { createHerdrCoreEventFeed } from '../../../src/connector/herdr-core/feed.js'
import { reviewHerdrCoreParams } from '../../../src/connector/herdr-core/methods.js'
import { startFakeCore } from './fake-core.js'
import { CONTRACT, OPENRPC, fakeTerminalForEvents } from './events-poll-harness.js'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import { attachment, connection, fixture, request } from './connector-harness.js'

/** 一条状态事件：type=status，data 带状态词。 */
function statusEvent(seq: number, terminal: string, state: string): string {
  return JSON.stringify({ seq, type: 'status', terminal, data: { state, app: 'fakeagent' } })
}

async function feedFor(options: Parameters<typeof startFakeCore>[0], buffer = 8) {
  const core = await startFakeCore(options)
  const client = await openHerdrCoreClient(core.socket)
  const feed = createHerdrCoreEventFeed({ client: () => client, contract: () => CONTRACT, buffer })
  return {
    core,
    client,
    feed,
    async close() {
      feed.close()
      client.close()
      await core.close()
    }
  }
}

test('一次轮询返回当前快照与水位之后的事件', async () => {
  const context = await feedFor({
    discover: JSON.parse(OPENRPC.toString('utf8')),
    events: [statusEvent(1, 't1', 'working'), statusEvent(2, 't1', 'blocked'), statusEvent(3, 't1', 'done')],
    terminal: fakeTerminalForEvents()
  })
  try {
    // 长轮询在第一条新事件就返回；剩下的用返回的水位继续追。
    let first = await context.feed.poll({ after_seq: 0, limit: 10, timeout_ms: 2000 })
    assert.equal(first.rebuilt, false)
    assert.equal(first.truncated, false)
    const seen = first.events.map((event) => event.seq)
    for (let round = 0; round < 10 && first.next_after_seq < 3; round++) {
      first = await context.feed.poll({ after_seq: first.next_after_seq, limit: 10, timeout_ms: 1000 })
      seen.push(...first.events.map((event) => event.seq))
    }
    assert.deepEqual(seen, [1, 2, 3])
    assert.equal(first.next_after_seq, 3)
    assert.equal(first.terminals.length, 1)
    // 用返回的水位再轮询：没有新事件，只有空数组，不重复旧事件。
    const second = await context.feed.poll({ after_seq: first.next_after_seq, limit: 10, timeout_ms: 100 })
    assert.deepEqual(second.events, [])
    assert.equal(second.next_after_seq, 3)
  } finally {
    await context.close()
  }
})

test('水位比当前大（core 重启后 seq 归零）时整份重建并标 rebuilt', async () => {
  const context = await feedFor({
    discover: JSON.parse(OPENRPC.toString('utf8')),
    events: [statusEvent(1, 't1', 'working')],
    terminal: fakeTerminalForEvents()
  })
  try {
    const poll = await context.feed.poll({ after_seq: 999, limit: 10, timeout_ms: 500 })
    assert.equal(poll.rebuilt, true)
    assert.deepEqual(poll.events, [])
    assert.equal(poll.next_after_seq, poll.seq)
  } finally {
    await context.close()
  }
})

test('缓冲溢出标 truncated 与 dropped，不静默丢事件', { timeout: 30_000 }, async () => {
  const events = Array.from({ length: 12 }, (_, index) => statusEvent(index + 1, 't1', 'working'))
  const context = await feedFor(
    { discover: JSON.parse(OPENRPC.toString('utf8')), events, terminal: fakeTerminalForEvents() },
    4
  )
  try {
    // 慢消费者：先取一条，然后等一会儿让 core 把剩下的事件全推完（缓冲只有 4 条）。
    let poll = await context.feed.poll({ after_seq: 0, limit: 100, timeout_ms: 3000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (let round = 0; round < 40 && poll.next_after_seq < 12; round++) {
      poll = await context.feed.poll({ after_seq: poll.next_after_seq, limit: 100, timeout_ms: 200 })
    }
    assert.equal(poll.truncated, true)
    assert(poll.dropped > 0)
    assert.equal(poll.seq, 12)
    // 环形缓冲只留最后 4 条。
    const last = await context.feed.poll({ after_seq: poll.next_after_seq - 4, limit: 100, timeout_ms: 100 })
    assert.deepEqual(
      last.events.map((event) => event.seq),
      [9, 10, 11, 12]
    )
  } finally {
    await context.close()
  }
})

test('按 address 与 labels 过滤快照与事件', async () => {
  const terminal = { ...fakeTerminalForEvents(), labels: { role: 'review' } }
  const context = await feedFor({
    discover: JSON.parse(OPENRPC.toString('utf8')),
    events: [statusEvent(1, 't1', 'working'), statusEvent(2, 't9', 'working')],
    terminal
  })
  try {
    // t1 在快照里：保留它的事件，t9 不在快照里（不是真实终端）：事件被丢掉。
    const byAddress = await context.feed.poll({ after_seq: 0, limit: 10, timeout_ms: 1000, address: 't1' })
    assert.deepEqual(
      byAddress.terminals.map((terminal) => terminal.address),
      ['t1']
    )
    assert.deepEqual(
      byAddress.events.map((event) => event.terminal),
      ['t1']
    )
    const byLabels = await context.feed.poll({ after_seq: 0, limit: 10, timeout_ms: 200, labels: { role: 'other' } })
    assert.deepEqual(byLabels.terminals, [])
    assert.deepEqual(byLabels.events, [])
  } finally {
    await context.close()
  }
})

test('长轮询参数逐项收紧', () => {
  for (const params of [
    { after_seq: -1 },
    { after_seq: 1.5 },
    { limit: 0 },
    { limit: 257 },
    { timeout_ms: 0 },
    { timeout_ms: 30_001 },
    { address: 'e2e' },
    { address: 'm1/t1' },
    { labels: { 'bad key': 'x' } },
    { labels: { a: 1 } },
    { extra: true }
  ]) {
    assert.throws(() => reviewHerdrCoreParams('terminal.events', params), JSON.stringify(params))
  }
  assert.doesNotThrow(() => reviewHerdrCoreParams('terminal.events', { after_seq: 0, limit: 64, timeout_ms: 1000 }))
})

test('经 Connector 的 Wire 路径也能长轮询：参数与结果都走本仓库审核', async () => {
  const core = await startFakeCore({
    discover: JSON.parse(OPENRPC.toString('utf8')),
    events: [statusEvent(1, 't1', 'working'), statusEvent(2, 't1', 'blocked')],
    terminal: fakeTerminalForEvents()
  })
  const { root, config } = fixture(core)
  const resources = await createHerdrCoreConnectorResources({
    config,
    now: Date.now,
    allow_terminal_execution: false,
    open: async () => attachment(core)
  })
  try {
    const session = resources.session(connection())
    // 长轮询在第一条新事件就返回：用返回的水位继续追到 blocked。
    let after = 0
    const states: string[] = []
    for (let index = 0; index < 5; index++) {
      const raw = request('terminal.events', { after_seq: after, limit: 10, timeout_ms: 1000 }, String(index + 1))
      session.adapter.decode(raw, 'gateway_to_connector')
      const result = await session.executeWire(raw, new AbortController().signal)
      const poll = result.native_response as {
        events: { seq: number; data: { state?: string } }[]
        rebuilt: boolean
        next_after_seq: number
      }
      assert.equal(poll.rebuilt, false)
      states.push(...poll.events.map((event) => String(event.data.state)))
      after = poll.next_after_seq
      if (states.includes('blocked')) {
        break
      }
    }
    assert.deepEqual(states, ['working', 'blocked'])
    // 观察档不受 allow_terminal_execution 约束。
    assert.equal(core.requests.includes('events.subscribe'), true)
  } finally {
    await resources.release()
    await core.close()
    rmSync(root, { recursive: true, force: true })
  }
})
