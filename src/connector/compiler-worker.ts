/** 两种原生编译器共享的 Worker 所有权、取消和结算；不解析 schema 或产物。 */
export interface CompilerWorkerPort {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: { message?: string; preventDefault?(): void }) => void) | null
  terminate(): void
  ref(): void
  unref(): void
  addEventListener(type: 'close', listener: () => void): void
}

export class CompilerWorkerOwner<P extends CompilerWorkerPort> {
  current?: P
  private closed = false
  constructor(
    private readonly factory: () => P,
    private readonly receive: (worker: P, value: unknown) => void,
    private readonly fail: (reason: string) => void
  ) {}

  open(): P {
    if (this.closed) {
      throw new Error('compiler_closed')
    }
    if (!this.current) {
      const worker = this.factory()
      this.current = worker
      worker.onmessage = (event) => {
        if (this.current === worker && !this.closed) {
          this.receive(worker, event.data)
        }
      }
      worker.onerror = (event) => {
        event.preventDefault?.()
        if (this.current === worker && !this.closed) {
          this.fail('compiler_failed')
        }
      }
      worker.addEventListener('close', () => {
        if (this.current === worker && !this.closed) {
          this.fail('compiler_closed')
        }
      })
    }
    this.current.ref()
    return this.current
  }

  /** 先撤销代次再请求终止；不把 terminate 当作物理退出证明。 */
  close(): void {
    this.closed = true
    const worker = this.current
    this.current = undefined
    try {
      worker?.terminate()
    } catch {
      /* 撤销后不再接纳旧消息。 */
    }
  }
}

export type CompilerDeadline = {
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  cancel(): void
}

export function compilerDeadline(
  until: number,
  signal: AbortSignal | undefined,
  retire: (reason: string) => void
): CompilerDeadline {
  const cancel = () => retire('compiler_cancelled')
  const timer = setTimeout(() => retire('compiler_timeout'), Math.max(0, until - performance.now()))
  signal?.addEventListener('abort', cancel, { once: true })
  return { timer, signal, cancel }
}

/** 先解除定时器/取消监听和存活引用，再由 provider 发布其原有成功/失败结果。 */
export function settleCompilerTask(task: CompilerDeadline, worker: CompilerWorkerPort | undefined): void {
  clearTimeout(task.timer)
  task.signal?.removeEventListener('abort', task.cancel)
  try {
    worker?.unref()
  } catch {
    /* 清理失败不能恢复任务。 */
  }
}
