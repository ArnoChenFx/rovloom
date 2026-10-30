/**
 * `terminal.events` 的长轮询后台：一条无过滤的 framed 订阅 + 有界环形缓冲。
 *
 * 为什么是长轮询而不是 Wire 流式：Wire 桥接只做普通 RPC（ADR 0009），`events.subscribe`
 * 只能由本地入口使用。这里由 Connector 自己维护订阅，`runtime_call` 的一个普通请求
 * 最多等 `timeout_ms`，一次返回「当前快照 + 自水位以来至多 N 条事件」。
 *
 * 语义（全部原样告诉调用方，不假装连续）：
 * - `seq` 只在同一个 core 进程内有效；`after_seq` 大于当前水位（core 重启后归零）时
 *   丢弃旧水位、整份重建，并返回 `rebuilt:true`；
 * - 环形缓冲装不下时返回 `truncated:true` 与 `dropped` 计数，绝不静默丢事件；
 * - 订阅遇到 `missed` 或 EOF 都按重建处理（快照替换全部状态），不拿旧 `seq` 去重。
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

/** 只等待到期限；与事件通知竞争，超时是检查点而不是失败。 */
async function waitFor(signal: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    signal,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  if (timer !== undefined) {
    clearTimeout(timer)
  }
}

/** 按 address 与 labels 过滤终端；没有过滤条件时全返回。 */
function matches(
  terminal: JsonObject,
  input: { address?: string; labels?: Readonly<Record<string, string>> }
): boolean {
  if (input.address !== undefined && terminal.address !== input.address) {
    return false
  }
  if (input.labels !== undefined) {
    const labels = (terminal.labels ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(input.labels)) {
      if (labels[key] !== value) {
        return false
      }
    }
  }
  return true
}

/**
 * 建立一个长轮询 feed。`clientProvider` 每次现取当前连接：Connector 重新附着后
 * 旧订阅必然失效，这里整体重建并让调用方看到 `rebuilt:true`。
 */
export function createHerdrCoreEventFeed(options: {
  client(): HerdrCoreClient
  contract(): HerdrCoreContract
  buffer?: number
}): HerdrCoreEventFeed {
  const capacity = options.buffer ?? HERDR_CORE_EVENT_BUFFER
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) {
    fail('herdr_core_event_invalid')
  }
  let subscription: HerdrCoreEventSubscription | undefined
  let subscriptionClient: HerdrCoreClient | undefined
  let ring: HerdrCoreEventFeedEvent[] = []
  let watermark = -1
  let dropped = 0
  let rebuilt = false
  let truncated = false
  let closed = false
  let notify: (() => void) | undefined
  let coreId: string | undefined

  /** 唤醒所有等待者；只做一次通知，避免重复 resolve。 */
  function wake(): void {
    const resolve = notify
    notify = undefined
    resolve?.()
  }

  function push(event: HerdrCoreEventFeedEvent): void {
    if (event.seq <= watermark) {
      // missed 之后 core 仍可能送来旧序号的事件：丢弃并计数，不当作新事实。
      dropped += 1
      return
    }
    watermark = event.seq
    if (ring.length >= capacity) {
      ring.shift()
      dropped += 1
      // 缓冲溢出：只标截断，不用快照替换状态（快照由本次轮询现读）。
      truncated = true
    }
    ring.push(event)
    wake()
  }

  async function pump(current: HerdrCoreEventSubscription): Promise<void> {
    for (;;) {
      const notice = await current.next()
      if (notice.kind === 'closed') {
        if (subscription === current) {
          subscription = undefined
          subscriptionClient = undefined
          rebuilt = true
          // 订阅结束意味着这之后的事件可能已经丢了；由下一次订阅重建，标记截断。
          truncated = true
        }
        wake()
        return
      }
      if (notice.kind === 'snapshot') {
        // missed：快照替换全部状态，水位换成快照序号，旧事件全部作废。
        ring = []
        watermark = notice.seq
        rebuilt = true
        truncated = false
        dropped = 0
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

  /** 订阅失效或换了连接时重建；失败只给固定码，不悄悄降级。 */
  async function ensureSubscription(): Promise<void> {
    const client = options.client()
    if (subscription && subscriptionClient === client && !closed) {
      return
    }
    // 首次订阅没有「以前的状态」可替换；只有替换已有订阅才算重建。
    const replacing = subscription !== undefined || watermark >= 0
    subscription?.close()
    subscription = undefined
    subscriptionClient = undefined
    ring = []
    dropped = 0
    rebuilt = replacing
    // 订阅队列比环形缓冲大：让「截断」由本层的缓冲决定，而不是订阅先背压后静默重订。
    const next = await subscribeHerdrCoreEvents({
      client,
      contract: options.contract(),
      max_queued: Math.min(4096, Math.max(64, capacity * 4))
    })
    subscription = next
    subscriptionClient = client
    coreId = client.hello.core.id
    watermark = next.snapshot.seq
    void pump(next).catch(
      /** pump 内部只结束订阅；这里消费拒绝，避免无人观察的 Promise。 */ () => {
        if (subscription === next) {
          subscription = undefined
          subscriptionClient = undefined
          rebuilt = true
          truncated = true
        }
        wake()
      }
    )
  }

  return Object.freeze({
    async poll(input) {
      if (closed) {
        fail('herdr_core_events_closed')
      }
      await ensureSubscription()
      // 水位比当前还大 = core 重启后 seq 归零（或调用方拿了别的连接的水位）：
      // 丢弃旧水位并整份重建，明确告诉调用方中间事件可能已经丢了。
      if (input.after_seq > watermark) {
        ring = []
        rebuilt = true
        truncated = false
        dropped = 0
      }
      // 重置之后调用方必须从新水位开始：不能让它把旧水位继续当成有效的。
      const after = input.after_seq > watermark ? watermark : input.after_seq
      const current = options.client()
      const started = Date.now()
      // 等「有自水位以来的事件」或到期限；超时是检查点，返回空事件数组。
      for (;;) {
        if (closed) {
          fail('herdr_core_events_closed')
        }
        if (!subscription) {
          // 订阅已结束（EOF/背压）：标记重建并重新订阅；失败即固定码。
          await ensureSubscription()
          continue
        }
        const fresh = ring.filter(
          /** 只返回水位之后的事件；过滤后的事件仍推进调用方水位。 */ (event) => event.seq > after
        )
        if (fresh.length > 0 || Date.now() - started >= input.timeout_ms) {
          // 当前快照现读：快照与事件可以有重叠，调用方按事件增量更新即可。
          const listed = options
            .contract()
            .validateResult('terminal.list', await current.request('terminal.list', {}, 5_000))
          const terminals = (listed.terminals as JsonObject[]).filter((terminal) => matches(terminal, input))
          const selected = fresh
            .filter(
              /** 只保留快照里仍存在、且通过过滤的终端的事件。 */ (event) =>
                event.terminal === undefined || terminals.some((terminal) => terminal.address === event.terminal)
            )
            .slice(0, input.limit)
          const nextAfter = selected.length > 0 ? selected.at(-1)!.seq : Math.max(after, watermark)
          return Object.freeze({
            core_id: coreId ?? current.hello.core.id,
            rebuilt,
            truncated,
            dropped,
            seq: watermark,
            next_after_seq: nextAfter,
            terminals: Object.freeze(terminals),
            events: Object.freeze(selected)
          })
        }
        const remaining = input.timeout_ms - (Date.now() - started)
        await waitFor(
          new Promise<void>((resolve) => {
            notify = resolve
          }),
          remaining
        )
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
