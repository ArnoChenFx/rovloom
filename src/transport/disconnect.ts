// 把断连事件收敛为固定、有界的观测：只保留白名单原因与数值关闭码，绝不透传对端正文、凭据或路径。
/** 断开原因固定词；对端给出的任意文本只能在白名单命中时保留。 */
export type DisconnectReason =
  | 'transport_closed'
  | 'transport_abnormal'
  | 'transport_unavailable'
  | 'handshake_timeout'
  | 'transport_idle'
  | 'connector_failure'
  | 'connector_disconnected'
  | 'connector_stopped'
  | 'transport_unclassified'

/** 断开观测最多包含一个关闭码和原因；本机主动断开不伪造对端关闭码。 */
export type DisconnectObservation = Readonly<{ code?: number; reason: DisconnectReason }>

/** 只接受本端与 Gateway 约定的固定关闭原因；其余对端文本一律不进入观测。 */
const REMOTE_REASONS: readonly DisconnectReason[] = Object.freeze(['transport_closed'])

/** 全部固定原因词；本机原因与对端白名单共用同一集合供二次复核。 */
const REASONS: ReadonlySet<string> = new Set<DisconnectReason>([
  ...REMOTE_REASONS,
  'transport_abnormal',
  'transport_unavailable',
  'handshake_timeout',
  'transport_idle',
  'connector_failure',
  'connector_disconnected',
  'connector_stopped',
  'transport_unclassified'
])

/** WebSocket 关闭码是有界整数；缺失、非整数或越界一律不交付，避免伪造未观察到的码。 */
function closeCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1000 && value <= 4999 ? value : undefined
}

/** 只从原关闭事件读取 code/reason；原因白名单未命中时按关闭码定性，不输出任何远端文本。 */
export function remoteDisconnect(event: unknown): DisconnectObservation {
  let code: number | undefined
  let reason = ''
  try {
    const source = event && typeof event === 'object' ? (event as { code?: unknown; reason?: unknown }) : {}
    code = closeCode(source.code)
    const text: unknown = source.reason
    reason = typeof text === 'string' ? text : ''
  } catch {
    // 事件字段的宿主 getter 不可信；异常原文不参与观测，按未收到关闭帧定性。
    return Object.freeze({ reason: 'transport_abnormal' })
  }
  // 白名单命中的固定原因保留，仍只附带实际观察到的有界关闭码。
  if (REMOTE_REASONS.includes(reason as DisconnectReason)) {
    return Object.freeze(
      code === undefined ? { reason: reason as DisconnectReason } : { code, reason: reason as DisconnectReason }
    )
  }
  // 1006 表示没有关闭帧（TCP 被掐或 terminate），其余有码关闭无法归属到固定原因。
  return Object.freeze(
    code === undefined
      ? { reason: 'transport_abnormal' }
      : { code, reason: code === 1006 ? 'transport_abnormal' : 'transport_unclassified' }
  )
}

/** 复核任意来源的断开观测；原因必须在白名单内、码必须是有界整数，否则整条丢弃。 */
export function boundedDisconnect(value: unknown): DisconnectObservation | undefined {
  let reason: unknown
  let code: unknown
  try {
    if (!value || typeof value !== 'object') {
      return undefined
    }
    ;({ reason, code } = value as { reason?: unknown; code?: unknown })
  } catch {
    // 不可信的 getter 不产生观测，也不把异常文本带出边界。
    return undefined
  }
  if (typeof reason !== 'string' || !REASONS.has(reason)) {
    return undefined
  }
  if (code === undefined) {
    return Object.freeze({ reason: reason as DisconnectReason })
  }
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 1000 || code > 4999) {
    return undefined
  }
  return Object.freeze({ code, reason: reason as DisconnectReason })
}

/**
 * 断开记录只增不减：每次收敛 +1，并保留有界队列供采样侧逐条补报。
 * 单个 250ms 采样窗口内可能发生多次断开（例如先收到 1008，重连又被拒收到 1006），
 * 只留「最近一条」会把更早的事件覆盖掉，因此按时间从旧到新保留最多 QUEUE 条。
 * 晚到的远端关闭事件只订正队列里最新一条，不重复计数。
 */
export class DisconnectLog {
  #count = 0
  #queue: DisconnectObservation[] = []
  #sequence = 0
  #changes: Readonly<{ sequence: number; correction: boolean; observation: DisconnectObservation }>[] = []

  /** 队列上限：只保留最新 QUEUE 条，超出丢最老的；计数仍完整记录累计断开次数。 */
  static readonly QUEUE = 16

  /** 新断开与订正共用独立事件序号；有界事件日志不会把订正误记为第二次断开。 */
  #change(observation: DisconnectObservation, correction: boolean): void {
    const bounded = boundedDisconnect(observation)
    if (!bounded) {
      return
    }
    this.#changes.push(Object.freeze({ sequence: ++this.#sequence, correction, observation: bounded }))
    this.#changes.splice(0, Math.max(0, this.#changes.length - DisconnectLog.QUEUE))
  }

  /** 记录一次新的断开收敛；只有这里推进计数。 */
  record(observation: DisconnectObservation): void {
    this.#count++
    this.#queue.push(observation)
    this.#change(observation, false)
    if (this.#queue.length > DisconnectLog.QUEUE) {
      this.#queue.splice(0, this.#queue.length - DisconnectLog.QUEUE)
    }
  }

  /** 用远端实际观察到的 code/reason 订正队列里最新一条；不推进计数，队列为空时不生效。 */
  refine(observation: DisconnectObservation): void {
    if (this.#queue.length > 0) {
      const previous = this.#queue[this.#queue.length - 1]!
      if (previous.code === observation.code && previous.reason === observation.reason) {
        return
      }
      this.#queue[this.#queue.length - 1] = observation
      this.#change(observation, true)
    }
  }

  /** 只读交付累计断开次数与有界队列（从旧到新）；每条都重新复核，非法整条丢弃。 */
  snapshot(): Readonly<{ disconnects: number; disconnect_recent: readonly DisconnectObservation[] }> {
    const recent: DisconnectObservation[] = []
    for (const entry of this.#queue) {
      const bounded = boundedDisconnect(entry)
      if (bounded !== undefined) {
        recent.push(bounded)
      }
    }
    return Object.freeze({ disconnects: this.#count, disconnect_recent: Object.freeze(recent) })
  }

  /** 观察器按独立序号补报新断开和晚到订正；每条记录及返回数组均不可回写。 */
  changes() {
    return Object.freeze({
      disconnect_change_sequence: this.#sequence,
      disconnect_changes: Object.freeze([...this.#changes])
    })
  }
}
