/** 附着模式的 Herdr 来源：优先接入用户已在运行的实例，没有才自建；实例消失后自动重新附着或重建。 */
import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { createConnection } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'
import { observeHerdrServer } from '../connector/herdr/attach.js'
import { HerdrInstallation } from '../connector/herdr/installation.js'
import { HerdrLocalError, herdrEndpoint, herdrEnvironment, verifyHerdrInstallation } from '../connector/herdr/local.js'
import type { HerdrAttachedBinding, HerdrLocalConfig } from '../connector/herdr/local.js'
import { createHerdrConnectorResources } from '../connector/herdr/provider.js'
import type { HerdrConnectorResources } from '../connector/herdr/provider.js'
import type { Connection } from '../transport/index.js'
import type { HerdrProductionOwnerConfig } from './production-herdr.js'

const START_DEADLINE_MS = 10_000
const WATCH_INTERVAL_MS = 1000
const BACKOFF_FIRST_MS = 500
const BACKOFF_MAX_MS = 30_000

type Acquired = Readonly<{ installation: HerdrInstallation; resources: HerdrConnectorResources }>

/** 端点上有没有监听者：不存在或连接被拒（遗留的 socket 文件）算无；能连上算有；其它错误不猜测。 */
export function herdrServerPresent(local: HerdrLocalConfig): Promise<boolean> {
  let address: string
  let file: string
  try {
    const endpoint = herdrEndpoint(local)
    address = endpoint.address
    // Windows：存在性看端点记录文件，连接走命名管道；Linux 上两者是同一个 socket 路径。
    file = endpoint.file ?? endpoint.address
  } catch {
    // 端点目录或 socket 不存在（或不可信）：没有可附着的实例。已存在但不可信的情形由后续 observe 拒绝。
    return Promise.resolve(false)
  }
  try {
    lstatSync(file)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: address })
    const timer = setTimeout(() => finish(() => reject(new HerdrLocalError('herdr_timeout'))), 2000)
    function finish(settle: () => void): void {
      clearTimeout(timer)
      socket.destroy()
      settle()
    }
    socket.once('connect', () => finish(() => resolve(true)))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(() =>
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
          ? resolve(false)
          : // 管道的所有实例都在使用中（Windows 的 ERROR_PIPE_BUSY）说明服务端存在。
            process.platform === 'win32' && error.code === 'EBUSY'
            ? resolve(true)
            : reject(new HerdrLocalError('herdr_local_path_untrusted'))
      )
    )
  })
}

/**
 * 在用户自己的配置目录里拉起一个独立的 herdr 服务端并立即放手：
 * 它是用户的持久会话，Connector 退出不终止它；之后与手动运行的实例没有区别，由 observe 证明身份后附着。
 */
async function startDetachedServer(local: HerdrLocalConfig): Promise<void> {
  verifyHerdrInstallation(local)
  const child = spawn(local.binary, ['--session', local.target.session, 'server'], {
    cwd: local.cwd,
    env: herdrEnvironment(local),
    shell: false,
    stdio: 'ignore',
    detached: true,
    windowsHide: true
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new HerdrLocalError('herdr_launch_unavailable')))
    child.once('spawn', () => resolve())
  })
  child.unref()
}

/** 附着优先；确认没有实例才自建。存在但身份不符的实例一律拒绝，不覆盖也不终止。 */
async function acquireBinding(local: HerdrLocalConfig, signal: AbortSignal): Promise<HerdrAttachedBinding> {
  if (await herdrServerPresent(local)) {
    return observeHerdrServer(local, signal)
  }
  await startDetachedServer(local)
  const deadline = Date.now() + START_DEADLINE_MS
  for (;;) {
    try {
      return await observeHerdrServer(local, signal)
    } catch (error) {
      if (signal.aborted || Date.now() >= deadline) {
        throw error
      }
      await pause(50)
    }
  }
}

/** 单个 Connector 交付一个 Herdr provider；实例丢失时在后台重新附着/重建，期间新连接被拒、已有 epoch 关闭。 */
export async function startAttachedHerdr(
  selected: HerdrProductionOwnerConfig,
  options: Readonly<{ terminalExecution?: () => boolean }>
): Promise<HerdrConnectorResources> {
  const config = selected.config
  const local = config.connector.local
  const stop = new AbortController()
  let closed = false
  let current: Acquired | undefined
  let recovering: Promise<void> | undefined
  const replacedListeners = new Set<() => void>()

  /** 附着（或自建后附着）→ 打开安装 → 建立资源；失败时释放已取得的部分。 */
  async function acquire(): Promise<Acquired> {
    let installation: HerdrInstallation | undefined
    try {
      const binding = await acquireBinding(local, stop.signal)
      installation = await HerdrInstallation.open(local, binding, stop.signal)
      const resources = await createHerdrConnectorResources({
        config,
        installation,
        now: Date.now,
        ...(options.terminalExecution ? { terminalExecution: options.terminalExecution } : {}),
        /** 固定 principal 的策略来自受保护配置快照，不读取消息自报身份或打开 Gateway Store。 */

        /** 实例不归 Connector 所有：释放只撤去来源，不终止任何进程。 */
        releaseOwner: async () => {}
      })
      return { installation, resources }
    } catch (error) {
      installation?.close()
      throw error
    }
  }

  function healthy(value: Acquired): boolean {
    try {
      value.installation.assert()
      return true
    } catch {
      return false
    }
  }

  /** 丢失后：先关掉旧资源（关闭全部 epoch 与 claim writer），再带退避地重新附着或重建。 */
  async function recover(lost: Acquired): Promise<void> {
    current = undefined
    try {
      await lost.resources.release()
    } catch {
      // 旧资源释放失败不阻止重建；claim 账本是持久文件，不依赖旧 writer。
    }
    let delay = BACKOFF_FIRST_MS
    while (!closed) {
      try {
        const next = await acquire()
        if (closed) {
          await next.resources.release().catch(() => {})
          return
        }
        current = next
        // 旧 epoch 绑着已丢失的实例；通知宿主结束当前连接周期，下一次认证取到新资源。
        for (const listener of replacedListeners) {
          try {
            listener()
          } catch {
            // 宿主侧的通知失败不影响来源本身。
          }
        }
        return
      } catch {
        await pause(delay, undefined, { signal: stop.signal }).catch(() => {})
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
      }
    }
  }

  const watcher = setInterval(() => {
    if (closed || recovering || !current || healthy(current)) {
      return
    }
    recovering = recover(current).finally(() => {
      recovering = undefined
    })
  }, WATCH_INTERVAL_MS)
  watcher.unref()

  try {
    current = await acquire()
  } catch (error) {
    // 附着与自建都不成：保留原固定错误码（如 herdr_native_instance_untrusted、herdr_launch_unavailable）供启动诊断。
    clearInterval(watcher)
    throw error
  }
  const first = current

  return Object.freeze({
    ...first.resources,
    /** 每个认证 epoch 取当前资源；丢失期间拒绝，传输层按既有退避重连。 */
    session(connection: Connection) {
      if (closed || !current) {
        throw new HerdrLocalError('herdr_production_source_closed')
      }
      return current.resources.session(connection)
    },
    session_replaced(listener: () => void): () => void {
      replacedListeners.add(listener)
      return () => {
        replacedListeners.delete(listener)
      }
    },
    async release(): Promise<void> {
      closed = true
      stop.abort()
      clearInterval(watcher)
      await recovering?.catch(() => {})
      const active = current
      current = undefined
      await active?.resources.release()
    }
  })
}
