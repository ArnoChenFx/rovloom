/**
 * `terminal.events` 的长轮询后台：一条无过滤的 framed 订阅 + 有界环形缓冲。
 *
 * 为什么是长轮询而不是 Wire 流式：Wire 桥接只做普通 RPC（ADR 0009），`events.subscribe`
 * 只能由本地入口使用。这里由 Connector 自己维护订阅，`runtime_call` 的一个普通请求
 * 最多等 `timeout_ms`，一次返回「当前快照 + 自水位以来至多 N 条事件」。
 *
 * 语义（全部原样告诉调用方，不假装连续）。`rebuilt`/`truncated`/`dropped` 是对「这一个调用方」
 * 的回答，由它带来的 `after_seq` 与 feed 当前保有的范围现算，不在 feed 上累积、也不会黏住：
 * - `seq` 只在同一个 core 进程内有效；`after_seq` 大于当前水位（core 重启后归零）时
 *   丢弃旧水位、整份重建，并返回 `rebuilt:true`；
 * - 调用方的水位早于本订阅的快照起点（`missed`、EOF 后重新订阅）同样 `rebuilt:true`；
 * - 环形缓冲已经挤掉了调用方还没取走的事件时 `truncated:true`，`dropped` 是被挤掉的条数
 *   （无过滤订阅的 `seq` 连续，空洞即丢失），绝不静默丢事件；
 * - 事件不按「终端是否还在快照里」过滤：`removed`/`finished`/`lost` 恰恰发生在终端消失之后。
 */
import { fail, fields, object } from '../../wire/index.js'
import type { JsonObject } from '../../wire/types.js'
import type { HerdrCoreClient } from './client.js'
import { subscribeHerdrCoreEvents } from './events.js'
import type { HerdrCoreEventSubscription } from './events.js'
import type { HerdrCoreContract } from './schema.js'

/** 环形缓冲上限：超出即标 `truncated`，不静默丢。 */
export const HERDR_CORE_EVENT_BUFFER = 256
/** 单次轮询最多等待的时间（参数上限在 methods.ts 里审核）。 */
export const HERDR_CORE_EVENTS_MAX_WAIT_MS = 30_000

export type HerdrCoreEventFeedEvent = Readonly<{
  seq: number
  fact: string
  terminal?: string
  data: JsonObject
}>

export type HerdrCoreEventFeedPoll = Readonly<{
  core_id: string
  rebuilt: boolean
  truncated: boolean
  dropped: number
  /** 当前水位（订阅看到的最新事件序号）；调用方下次带 `after_seq = next_after_seq`。 */
  seq: number
  next_after_seq: number
  /** 当前终端快照（本次轮询现读；与事件可能有重叠，事件是增量）。 */
  terminals: readonly JsonObject[]
  events: readonly HerdrCoreEventFeedEvent[]
}>

export type HerdrCoreEventFeed = Readonly<{
  /** 用当前连接（重新）建立订阅；失败只给固定码。 */
  poll(input: {
    after_seq: number
    limit: number
    timeout_ms: number
    address?: string
    labels?: Readonly<Record<string, string>>
  }): Promise<HerdrCoreEventFeedPoll>
  /** 只结束本地订阅，不关闭 core 连接。 */
  close(): void
}>

/** 结果逐层收紧：任何多余或缺失字段都是协议不符，不当作空成功。 */
export function validateEventsPoll(value: unknown): HerdrCoreEventFeedPoll {
  const result = object(value)
  fields(result, ['core_id', 'rebuilt', 'truncated', 'dropped', 'seq', 'next_after_seq', 'terminals', 'events'])
  const sequence = (entry: unknown): number => {
    if (!Number.isSafeInteger(entry) || (entry as number) < 0) {
      fail('herdr_core_event_invalid')
    }
    return entry as number
  }
  if (
    typeof result.core_id !== 'string' ||
    typeof result.rebuilt !== 'boolean' ||
    typeof result.truncated !== 'boolean'
  ) {
    fail('herdr_core_event_invalid')
  }
  if (!Array.isArray(result.terminals) || !Array.isArray(result.events)) {
    fail('herdr_core_event_invalid')
  }
  return Object.freeze({
    core_id: result.core_id,
    rebuilt: result.rebuilt,
    truncated: result.truncated,
    dropped: sequence(result.dropped),
    seq: sequence(result.seq),
    next_after_seq: sequence(result.next_after_seq),
    terminals: Object.freeze(result.terminals.map(/** 每项必须是对象。 */ (entry) => object(entry))),
    events: Object.freeze(
      result.events.map(
        /** 每条事件都带 seq 与 type。 */ (entry) => {
          const event = object(entry)
          fields(event, ['seq', 'fact', 'data'], ['terminal'])
          if (typeof event.fact !== 'string' || (event.terminal !== undefined && typeof event.terminal !== 'string')) {
            fail('herdr_core_event_invalid')
          }
          return Object.freeze({
            seq: sequence(event.seq),
            fact: event.fact,
            ...(event.terminal === undefined ? {} : { terminal: event.terminal as string }),
            data: object(event.data)
          })
        }
      )
    )
  })
}

/** 等待事件或到期；所有并发的等待者都登记在同一个集合里，一次通知唤醒全部。 */
function waitFor(waiters: Set<() => void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      waiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    waiters.add(done)
  })
}

/** 已知终端标签表的上限：只用来给「已消失终端的事件」套 labels 过滤，满了就丢最旧的。 */
const KNOWN_LABELS_MAX = 4096

/**
 * 建立一个长轮询 feed。`client()` 每次现取当前连接：Connector 重新附着后
 * 旧订阅必然失效，这里整体重建，调用方按自己的水位看到 `rebuilt:true`。
 */
export function createHerdrCoreEventFeed(options: {
  client(): HerdrCoreClient
  contract(): HerdrCoreContract
  buffer?: number
  /** 测试注入点：默认就是真实的 framed 订阅。 */
  subscribe?: typeof subscribeHerdrCoreEvents
}): HerdrCoreEventFeed {
  const capacity = options.buffer ?? HERDR_CORE_EVENT_BUFFER
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) {
    fail('herdr_core_event_invalid')
  }
  const subscribe = options.subscribe ?? subscribeHerdrCoreEvents
  let subscription: HerdrCoreEventSubscription | undefined
  let subscriptionClient: HerdrCoreClient | undefined
  let subscribing: Promise<void> | undefined
  /** 连续的 seq 区间：环形缓冲只保有 (floor, watermark]，floor 之前的事件已不可得。 */
  let ring: HerdrCoreEventFeedEvent[] = []
  /** 本订阅快照的 seq：调用方水位早于它，说明它们之间的事件已被快照替换。 */
  let baseSeq = -1
  let watermark = -1
  let closed = false
  let coreId: string | undefined
  const waiters = new Set<() => void>()
  /** address → labels：让已消失终端（removed/finished）的事件仍能按 labels 过滤。 */
  const known = new Map<string, Readonly<Record<string, unknown>>>()

  /** 唤醒全部等待者。 */
  function wake(): void {
    for (const done of [...waiters]) {
      done()
    }
  }

  function remember(terminals: readonly JsonObject[]): void {
    for (const terminal of terminals) {
      if (typeof terminal.address !== 'string') {
        continue
      }
      known.delete(terminal.address)
      known.set(terminal.address, (terminal.labels ?? {}) as Record<string, unknown>)
      if (known.size > KNOWN_LABELS_MAX) {
        known.delete(known.keys().next().value!)
      }
    }
  }

  /** 缓冲下界：(floor, watermark] 内的事件都还在；ring 为空时下界就是水位。 */
  function floorSeq(): number {
    return ring.length > 0 ? ring[0]!.seq - 1 : watermark
  }

  function push(event: HerdrCoreEventFeedEvent): void {
    if (event.seq <= watermark) {
      // missed 之后 core 仍可能送来比快照更旧的事件：它们已被快照替换，不是新事实。
      return
    }
    watermark = event.seq
    if (ring.length >= capacity) {
      // 挤掉最旧的一条；调用方是否因此错过事件由它自己的水位对 floor 现算，不在这里记账。
      ring.shift()
    }
    ring.push(event)
    wake()
  }

  async function pump(current: HerdrCoreEventSubscription): Promise<void> {
    for (;;) {
      const notice = await current.next()
      if (notice.kind === 'closed') {
        if (subscription === current) {
          // 订阅结束意味着之后的事件可能已经丢了；下一次轮询重新订阅，新快照起点会让旧水位 rebuilt。
          subscription = undefined
          subscriptionClient = undefined
        }
        wake()
        return
      }
      if (notice.kind === 'snapshot') {
        // missed：快照替换全部状态，水位换成快照序号，旧事件全部作废。
        ring = []
        baseSeq = notice.seq
        watermark = notice.seq
        remember(notice.terminals)
        wake()
        continue
      }
      if (notice.kind === 'event') {
        push({
          seq: notice.seq,
          fact: notice.fact,
          ...(notice.terminal === undefined ? {} : { terminal: notice.terminal }),
          data: notice.data
        })
      }
      // heartbeat 只表示连接还活着；不能拿它推进调用方的水位（会跳过还没送到的事件）。
    }
  }

  /** 订阅失效或换了连接时重建；并发调用共用同一次订阅（单飞），失败只给固定码。 */
  function ensureSubscription(): Promise<void> {
    const client = options.client()
    if (subscription && subscriptionClient === client) {
      return Promise.resolve()
    }
    if (subscribing) {
      return subscribing
    }
    const attempt = (async (): Promise<void> => {
      subscription?.close()
      subscription = undefined
      subscriptionClient = undefined
      ring = []
      // 订阅队列比环形缓冲大：让「挤掉」由本层的缓冲决定，而不是订阅先背压后静默重订。
      const next = await subscribe({
        client,
        contract: options.contract(),
        max_queued: Math.min(4096, Math.max(64, capacity * 4))
      })
      if (closed) {
        next.close()
        fail('herdr_core_events_closed')
      }
      subscription = next
      subscriptionClient = client
      coreId = client.hello.core.id
      baseSeq = next.snapshot.seq
      watermark = next.snapshot.seq
      remember(next.snapshot.terminals)
      void pump(next).catch(
        /** pump 内部只结束订阅；这里消费拒绝，避免无人观察的 Promise。 */ () => {
          if (subscription === next) {
            subscription = undefined
            subscriptionClient = undefined
          }
          wake()
        }
      )
    })()
    subscribing = attempt.finally(
      /** 无论成败都放开单飞，下一次轮询可以重试。 */ () => {
        subscribing = undefined
      }
    )
    return subscribing
  }

  /** 对一个调用方水位现算「它错过了什么」；feed 自己不保存这些标志。 */
  function classify(after: number): {
    rebuilt: boolean
    truncated: boolean
    dropped: number
    from: number
  } {
    const floor = floorSeq()
    if (after > watermark) {
      // 比当前水位还大：core 重启后 seq 归零，或水位来自别的连接。旧水位作废，从当前水位重新开始。
      return { rebuilt: true, truncated: false, dropped: 0, from: watermark }
    }
    if (after > 0 && after < baseSeq) {
      // 调用方的基线早于本订阅的快照（missed 或重新订阅）：之间的事件已被快照替换。
      return { rebuilt: true, truncated: false, dropped: 0, from: floor }
    }
    if (after > 0 && after < floor) {
      // 缓冲已把它还没取走的事件挤掉了；无过滤订阅 seq 连续，所以差值就是丢掉的条数。
      return { rebuilt: false, truncated: true, dropped: floor - after, from: floor }
    }
    return { rebuilt: false, truncated: false, dropped: 0, from: after }
  }

  /** 事件是否属于调用方的过滤：address 直接比对；labels 用已知标签表（已消失的终端也查得到）。 */
  function wanted(
    event: HerdrCoreEventFeedEvent,
    input: { address?: string; labels?: Readonly<Record<string, string>> }
  ): boolean {
    if (event.terminal === undefined) {
      return true
    }
    if (input.address !== undefined && event.terminal !== input.address) {
      return false
    }
    if (input.labels !== undefined) {
      const labels = known.get(event.terminal)
      if (labels === undefined) {
        return false
      }
      for (const [key, value] of Object.entries(input.labels)) {
        if (labels[key] !== value) {
          return false
        }
      }
    }
    return true
  }

  return Object.freeze({
    async poll(input) {
      if (closed) {
        fail('herdr_core_events_closed')
      }
      const started = Date.now()
      // 等「有调用方关心的新事件、或它需要知道自己错过了什么」或到期限；超时是检查点，返回空事件数组。
      for (;;) {
        if (closed) {
          fail('herdr_core_events_closed')
        }
        await ensureSubscription()
        if (!subscription) {
          continue
        }
        const view = classify(input.after_seq)
        // 水位与事件在同一个同步片段里取定：之后读快照期间到达的事件留给下一次轮询，不会被 next_after_seq 跳过。
        const horizon = watermark
        const matching = ring.filter(
          /** 只取调用方水位之后、并通过它过滤的事件；其余事件由水位前进跳过。 */ (event) =>
            event.seq > view.from && wanted(event, input)
        )
        const expired = Date.now() - started >= input.timeout_ms
        if (matching.length === 0 && !view.rebuilt && !view.truncated && !expired) {
          const remaining = input.timeout_ms - (Date.now() - started)
          await waitFor(waiters, remaining)
          continue
        }
        const current = options.client()
        // 当前快照现读：快照与事件可以有重叠，调用方按事件增量更新即可。
        const listed = options
          .contract()
          .validateResult('terminal.list', await current.request('terminal.list', {}, 5_000))
        const all = listed.terminals as JsonObject[]
        remember(all)
        const terminals = all.filter(
          /** 只保留通过 address 与 labels 过滤的终端。 */ (terminal) =>
            (input.address === undefined || terminal.address === input.address) &&
            (input.labels === undefined ||
              Object.entries(input.labels).every(
                ([key, value]) => ((terminal.labels ?? {}) as Record<string, unknown>)[key] === value
              ))
        )
        const selected = matching.slice(0, input.limit)
        // 还有没返回的匹配事件时只前进到最后一条已返回的；否则整段已看完，前进到取定时的水位。
        const nextAfter = matching.length > selected.length ? selected.at(-1)!.seq : horizon
        return Object.freeze({
          core_id: coreId ?? current.hello.core.id,
          rebuilt: view.rebuilt,
          truncated: view.truncated,
          dropped: view.dropped,
          seq: horizon,
          next_after_seq: nextAfter,
          terminals: Object.freeze(terminals),
          events: Object.freeze(selected)
        })
      }
    },
    close: /** 只结束本地订阅；不向 core 发取消，也不关闭连接。 */ () => {
      closed = true
      subscription?.close()
      subscription = undefined
      subscriptionClient = undefined
      ring = []
      wake()
    }
  })
}
