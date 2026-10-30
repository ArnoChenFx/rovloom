/**
 * herdr-core 的事件订阅：只走 framed 通道，信用按实际消费的字节回补（由 client 的帧循环完成），
 * 并且只接受无过滤订阅。`missed` 与 EOF 都按「重订阅并重建」处理：前者用新快照重建当前状态，
 * 后者结束本地等待，由调用方重新握手。`seq` 只在同一个 core 进程内有意义，重连后丢弃旧水位，
 * 绝不拿它去重或排序跨进程事件。
 */
import { boundedJson, fail, object, parseJson } from '../../wire/index.js'
import type { JsonObject } from '../../wire/types.js'
import type { HerdrCoreClient, HerdrCoreEvent } from './client.js'
import { HERDR_CORE_MAX_REQUEST_BYTES, reviewHerdrCoreParams } from './methods.js'
import type { HerdrCoreContract } from './schema.js'

/** 事件与快照都带 core 进程内序号；`rebuilt` 表示这条快照替换了本订阅之前的全部状态。 */
export type HerdrCoreEventNotice =
  | Readonly<{ kind: 'snapshot'; seq: number; terminals: readonly JsonObject[]; rebuilt: boolean }>
  | Readonly<{ kind: 'event'; seq: number; fact: string; terminal?: string; data: JsonObject }>
  | Readonly<{ kind: 'heartbeat'; seq: number }>
  /** 订阅已结束：EOF 或本地背压。调用方必须重新订阅并重建，不能沿用旧 seq 水位。 */
  | Readonly<{ kind: 'closed'; reason: 'eof' | 'backpressure' }>

export type HerdrCoreEventSubscription = Readonly<{
  /** 订阅时 core 给出的快照；`seq` 只是本 core 进程内的起点。 */
  snapshot: Readonly<{ seq: number; terminals: readonly JsonObject[] }>
  /** 取下一条通知；订阅结束后持续返回 `closed`，不会假装还有事件。 */
  next(): Promise<HerdrCoreEventNotice>
  close(): void
  stats(): Readonly<{ stale_events: number; delivered: number; closed: boolean }>
}>

/** 慢消费者先结束本地等待而不是静默丢事件；上限只约束尚未取走的通知条数。 */
const DEFAULT_QUEUE = 256

/** seq 必须是安全非负整数；缺失或越界即协议不符，不猜测顺序。 */
function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('herdr_core_event_invalid')
  }
  return value as number
}

/**
 * 订阅本 core 的全部终端事件。参数必须是空对象：按终端/子终端/标签过滤的订阅会留下空洞
 * （spike 4a1 实测 3,5,7…），不能当成连续流；需要过滤时由调用方在重建后的快照上自行筛选。
 */
export async function subscribeHerdrCoreEvents(options: {
  client: HerdrCoreClient
  contract: HerdrCoreContract
  max_queued?: number
}): Promise<HerdrCoreEventSubscription> {
  const { client, contract } = options
  const limit = options.max_queued ?? DEFAULT_QUEUE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) {
    fail('herdr_core_event_invalid')
  }
  const params = object(parseJson(boundedJson({}, HERDR_CORE_MAX_REQUEST_BYTES)))
  reviewHerdrCoreParams('events.subscribe', params)
  const checked = contract.validateParams('events.subscribe', params)

  const queue: HerdrCoreEventNotice[] = []
  /** 通道号未知前先按到达顺序缓存：core 在订阅回复之后立刻推送，晚挂观察者会丢掉开头的事件。 */
  const early: HerdrCoreEvent[] = []
  let channel = -1
  let watermark = 0
  let waiting: ((notice: HerdrCoreEventNotice) => void) | undefined
  let closed: HerdrCoreEventNotice | undefined
  let delivered = 0
  let stale = 0

  /** 只结算一次；队列满时以背压结束订阅，不丢中间事件继续假装连续。 */
  function push(notice: HerdrCoreEventNotice): void {
    if (closed) {
      return
    }
    if (waiting) {
      const resolve = waiting
      waiting = undefined
      delivered += 1
      resolve(notice)
      return
    }
    if (queue.length >= limit) {
      finish('backpressure')
      return
    }
    queue.push(notice)
  }

  function finish(reason: 'eof' | 'backpressure'): void {
    if (closed) {
      return
    }
    closed = Object.freeze({ kind: 'closed', reason })
    // 已收到的通知仍然有效：先让调用方取走队列，再返回 closed；不在这里静默清空。
    if (waiting) {
      const resolve = waiting
      waiting = undefined
      resolve(closed)
    }
  }

  /** 通知只有 event/missed/heartbeat 三种；其它方法属于协议不符。 */
  function receive(event: HerdrCoreEvent): void {
    if (event.channel !== channel) {
      return
    }
    const body = object(event.message.params)
    if (event.method === 'heartbeat') {
      push(Object.freeze({ kind: 'heartbeat', seq: sequence(body.seq) }))
      return
    }
    if (event.method === 'missed') {
      // 快照替换本订阅的全部状态：水位换成快照序号，其后旧 seq 的事件必须丢弃。
      watermark = sequence(body.seq)
      const list = Array.isArray(body.terminals) ? body.terminals : fail('herdr_core_event_invalid')
      push(
        Object.freeze({
          kind: 'snapshot',
          seq: watermark,
          terminals: Object.freeze(list.map(/** 每项必须仍是对象。 */ (entry) => object(entry))),
          rebuilt: true
        })
      )
      return
    }
    if (event.method !== 'event') {
      fail('herdr_core_event_invalid')
    }
    const seq = sequence(body.seq)
    if (seq <= watermark) {
      // missed 之后 core 仍可能送来旧序号的在途事件；丢弃并计数，不当作新事实。
      stale += 1
      return
    }
    watermark = seq
    const fact = body.type
    if (typeof fact !== 'string') {
      fail('herdr_core_event_invalid')
    }
    const terminal = body.terminal
    if (terminal !== undefined && typeof terminal !== 'string') {
      fail('herdr_core_event_invalid')
    }
    push(
      Object.freeze({
        kind: 'event',
        seq,
        fact,
        ...(terminal === undefined ? {} : { terminal }),
        data: object(body.data)
      })
    )
  }

  const offEvent = client.onEvent(
    /** 通道号未知前先缓存，订阅回复后再按通道筛选重放。 */ (event) => {
      if (channel < 0) {
        early.push(event)
        return
      }
      if (event.channel === channel) {
        receive(event)
      }
    }
  )
  const offClose = client.onClose(/** EOF 一律当作重订阅信号，不假设事件完整。 */ () => finish('eof'))

  let raw: JsonObject
  try {
    raw = contract.validateResult('events.subscribe', await client.request('events.subscribe', checked, 10_000))
  } catch (error) {
    offEvent()
    offClose()
    throw error
  }
  const value = raw.channel
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    // framed 连接必须给出通道号；没有通道就无法按字节回补信用。
    fail('herdr_core_event_invalid')
  }
  channel = value as number
  const terminals = Array.isArray(raw.terminals) ? raw.terminals : fail('herdr_core_event_invalid')
  watermark = sequence(raw.seq)
  const snapshot = Object.freeze({
    seq: watermark,
    terminals: Object.freeze(terminals.map(/** 逐项保持原样；结果 schema 已核对形状。 */ (entry) => object(entry)))
  })
  for (const buffered of early) {
    if (buffered.channel === channel) {
      receive(buffered)
    }
  }
  early.length = 0

  return Object.freeze({
    snapshot,
    next: /** 队列为空时等待下一条；结束后立即返回同一个 closed。 */ () => {
      const queued = queue.shift()
      if (queued) {
        delivered += 1
        return Promise.resolve(queued)
      }
      if (closed) {
        return Promise.resolve(closed)
      }
      return new Promise<HerdrCoreEventNotice>(
        /** 只保留一个等待者；重复并发等待属于调用方错误。 */ (resolve) => {
          if (waiting) {
            fail('herdr_core_event_invalid')
          }
          waiting = resolve
        }
      )
    },
    close: /** 取消观察者；不向 core 发送取消，也不关闭连接。 */ () => {
      offEvent()
      offClose()
      finish('eof')
    },
    stats: () => Object.freeze({ stale_events: stale, delivered, closed: closed !== undefined })
  })
}
