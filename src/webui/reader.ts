/** 管理页面的有界只读快照生命周期；不建立管理员身份，也不执行管理变更。 */

export type ReadProblem =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'invalid_response'
  | 'timeout'

/** 只携带可公开的失败分类，禁止把后端原始错误或响应正文显示给页面。 */
export class ReadError extends Error {
  /** 将适配层失败约束为页面固定分类。 */
  constructor(public readonly problem: ReadProblem) {
    super(problem)
    this.name = 'ReadError'
  }
}

/** 页面内部的时间投影，不是另一个管理 API 契约。 */
export interface TimedSnapshot<T> {
  value: T
  serverTime: number
  observedAt: number
  sessionExpiresAt: number | null
}

export interface ReaderState<T> {
  snapshot: TimedSnapshot<T> | null
  pending: boolean
  stale: boolean
  ageMs: number
  problem: ReadProblem | 'cancelled' | null
}

export interface ReadClock {
  now(): number
  schedule(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}

export interface SnapshotReader<T> {
  state(): ReaderState<T>
  refresh(): Promise<void>
  cancel(): void
  visible(value: boolean): void
  dispose(): void
}

/** 使用浏览器单调时间，避免系统时钟调整延长快照或会话寿命。 */
export const browserClock: ReadClock = {
  /** 返回与墙上时间无关的经过时间。 */
  now: () => performance.now(),
  /** 安排一个有界页面任务。 */
  schedule: (callback, delay) => setTimeout(callback, delay),
  /** 释放页面任务。 */
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** 每个页面只有一个在途读取；取消、隐藏、超时及离开后均拒绝迟到响应。 */
export function createSnapshotReader<T>(
  read: (signal: AbortSignal) => Promise<TimedSnapshot<T>>,
  changed: (state: ReaderState<T>) => void,
  clock: ReadClock = browserClock
): SnapshotReader<T> {
  let snapshot: TimedSnapshot<T> | null = null
  let receivedAt = 0
  let lastNow = clock.now()
  let problem: ReaderState<T>['problem'] = null
  let visible = true
  let disposed = false
  let stopped = false
  let poll: unknown
  let tick: unknown
  let active: { abort: AbortController; promise: Promise<void>; finish: () => void } | null = null

  /** 防御注入时钟回退，已过时间不能减少。 */
  function now(): number {
    lastNow = Math.max(lastNow, clock.now())
    return lastNow
  }

  /** 读取现有快照年龄；首次读和失败后始终按过期处理。 */
  function state(): ReaderState<T> {
    const ageMs = snapshot ? Math.max(0, snapshot.serverTime - snapshot.observedAt + now() - receivedAt) : 0
    return {
      snapshot,
      pending: active !== null,
      stale: !snapshot || problem !== null || ageMs >= 15_000,
      ageMs,
      problem
    }
  }

  /** 发布页面状态，但已卸载页面不再收到任何通知。 */
  function publish(): void {
    if (!disposed) {
      changed(state())
    }
  }

  /** 清理下一次轮询，避免重复刷新累积定时器。 */
  function clearPoll(): void {
    clock.clear(poll)
    poll = undefined
  }

  /** 当前会话到期立即清空内存、取消读取并停止轮询。 */
  function expire(): boolean {
    if (snapshot?.sessionExpiresAt !== null && snapshot?.sessionExpiresAt !== undefined) {
      if (snapshot.serverTime + now() - receivedAt >= snapshot.sessionExpiresAt) {
        snapshot = null
        problem = 'unauthenticated'
        stopped = true
        clearPoll()
        active?.abort.abort()
        active?.finish()
        return true
      }
    }
    return false
  }

  /** 只有可见且仍有权限的页面安排下一次五秒读取。 */
  function schedulePoll(): void {
    clearPoll()
    if (visible && !disposed && !stopped) {
      poll = clock.schedule(refresh, 5_000)
    }
  }

  /** 时间变化只更新显示与过期门禁，不发起额外网络读取。 */
  function updateAge(): void {
    if (visible && !disposed && !stopped) {
      expire()
      publish()
      if (!stopped) {
        tick = clock.schedule(updateAge, 1_000)
      }
    }
  }

  /** 合并重复点击，并用请求对象身份阻止被取消的旧响应修改当前页面。 */
  function refresh(): Promise<void> {
    // 认证类失败后用户主动刷新是明确的重新尝试信号，允许再次读取以复用已恢复的 cookie 会话。
    if (problem === 'unauthenticated' || problem === 'forbidden' || problem === 'not_found') {
      stopped = false
    }
    if (disposed || stopped || !visible) {
      return Promise.resolve()
    }
    if (expire()) {
      publish()
      return Promise.resolve()
    }
    if (active) {
      return active.promise
    }
    clearPoll()
    const startedAt = now()
    const abort = new AbortController()
    let resolve!: () => void
    const promise = new Promise<void>(
      /** 保存完成回调，取消和超时无需等待不响应 AbortSignal 的适配层。 */
      (done) => {
        resolve = done
      }
    )
    const request = {
      abort,
      promise,
      /** 释放当前请求；旧请求无权清理新请求或重新安排轮询。 */
      finish: () => {
        clock.clear(timeout)
        if (active === request) {
          active = null
          schedulePoll()
          publish()
        }
        resolve()
      }
    }
    active = request
    const timeout = clock.schedule(
      /** 超时即脱离旧请求，迟到成功或失败均不再生效。 */
      () => {
        if (active === request) {
          problem = 'timeout'
          abort.abort()
          request.finish()
        }
      },
      5_000
    )
    publish()
    // Promise 链也捕获同步抛错；所有拒绝均转固定失败分类，不向页面泄露正文。
    void Promise.resolve()
      .then(
        /** 在已取消时不再调用读取适配层。 */
        () => (abort.signal.aborted ? null : read(abort.signal))
      )
      .then(
        /** 仅接收当前有效请求，并验证内部时间投影不能延长有效期。 */
        (result) => {
          if (active !== request || abort.signal.aborted || result === null) {
            return
          }
          if (
            !Number.isFinite(result.serverTime) ||
            !Number.isFinite(result.observedAt) ||
            result.observedAt > result.serverTime ||
            (result.sessionExpiresAt !== null && !Number.isFinite(result.sessionExpiresAt))
          ) {
            throw new ReadError('invalid_response')
          }
          snapshot = result
          receivedAt = startedAt
          problem = null
          expire()
        }
      )
      .catch(
        /** 认证失败清空旧数据，网络失败保留明确过期的只读快照。 */
        (error: unknown) => {
          if (active !== request || abort.signal.aborted) {
            return
          }
          problem = error instanceof ReadError ? error.problem : 'unavailable'
          if (problem === 'conflict') {
            snapshot = null
          }
          if (problem === 'unauthenticated' || problem === 'forbidden' || problem === 'not_found') {
            snapshot = null
            // 认证类失败先停下轮询，但保留重新建立的机会：页面重新可见或用户主动刷新时再试一次。
            // 这样 cookie 会话恢复后无需手动重新加载整个页面。
            stopped = true
            clearPoll()
            clock.clear(tick)
          }
        }
      )
      .finally(request.finish)
    return promise
  }

  /** 取消仅停止本次读取，不发送设备变更，也不把迟到读取当刷新成功。 */
  function cancel(): void {
    if (active) {
      problem = 'cancelled'
      active.abort.abort()
      active.finish()
    }
  }

  /** 隐藏暂停全部任务；恢复可见时立即刷新并重新检查会话期限。 */
  function setVisible(value: boolean): void {
    if (disposed || visible === value) {
      return
    }
    visible = value
    clearPoll()
    clock.clear(tick)
    if (!visible) {
      cancel()
    } else {
      void refresh()
      updateAge()
    }
  }

  /** 离开页面立即清空数据、释放任务与在途请求，不允许后退重放任何操作。 */
  function dispose(): void {
    disposed = true
    clearPoll()
    clock.clear(tick)
    active?.abort.abort()
    active?.finish()
    snapshot = null
  }

  tick = clock.schedule(updateAge, 1_000)
  return { state, refresh, cancel, visible: setVisible, dispose }
}
