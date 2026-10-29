/** 用户自己的 Luvus 来源：优先附着已在运行的会话，没有才在用户的 LUVUS_HOME 里自建；实例消失后重新附着或重建。 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { parseNativeJson } from '../contract/index.js'
import { object } from '../../../wire/index.js'
import { LuvusAdapterError } from '../types.js'
import type { LuvusLocalConfig } from '../types.js'
import { agentSearchPath } from '../../local/agent-path.js'
import { localLimits, pinConfig, verifyInstallation, withPrivateUmask } from '../local.js'
import { deadline, runFixedProcess } from '../io.js'
import { attachExistingLuvus } from './native-attach.js'
import type { AttachedLuvusInstance } from './native-attach.js'

const START_DEADLINE_MS = 15_000
const WATCH_INTERVAL_MS = 1000
const BACKOFF_FIRST_MS = 500
const BACKOFF_MAX_MS = 30_000

export interface UserLuvusSource {
  /** 当前可用实例；丢失到重新取得之间为 undefined。 */
  current(): AttachedLuvusInstance | undefined
  /** 实例被后台替换后通知宿主结束当前连接周期，使下一个认证 epoch 取到新实例。 */
  session_replaced(listener: () => void): () => void
  /** 只释放观察者；不终止用户的 Luvus（包括我们为用户自建的那个）。 */
  close(): void
}

/** 用户的登录 shell（来自 Connector 自己的环境）；不是绝对路径或不存在则回退 /bin/sh。 */
function userShell(): string {
  const shell = process.env.SHELL
  try {
    return shell && isAbsolute(shell) && statSync(shell).isFile() ? shell : '/bin/sh'
  } catch {
    return '/bin/sh'
  }
}

/** 自建 server 用用户真实的 HOME 与 shell（Agent 登录、Git 配置才可用），不继承 SSH agent、API key 等其它变量。 */
export function userLuvusEnvironment(config: LuvusLocalConfig): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot ?? 'C:\\Windows'
    const home = config.user_home!
    const local = process.env.LOCALAPPDATA
    const roaming = process.env.APPDATA
    return {
      PATH: agentSearchPath(config.agent_bin_dirs, `${system}\\System32;${system}`),
      // 用户真实的配置位置：Agent 登录、Git 配置才可用；不继承 SSH agent、API key 等其它变量。
      USERPROFILE: home,
      HOME: home,
      ...(roaming && isAbsolute(roaming) ? { APPDATA: roaming } : {}),
      ...(local && isAbsolute(local) ? { LOCALAPPDATA: local } : {}),
      TEMP: process.env.TEMP ?? `${home}\\AppData\\Local\\Temp`,
      TMP: process.env.TMP ?? process.env.TEMP ?? `${home}\\AppData\\Local\\Temp`,
      LUVUS_HOME: config.state_root,
      SystemRoot: system,
      windir: system,
      ComSpec: process.env.ComSpec ?? `${system}\\System32\\cmd.exe`,
      PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
      TERM: 'xterm-256color'
    }
  }
  const env: NodeJS.ProcessEnv = {
    PATH: agentSearchPath(config.agent_bin_dirs, '/usr/bin:/bin'),
    HOME: config.user_home!,
    LUVUS_HOME: config.state_root,
    SHELL: userShell(),
    TERM: 'xterm-256color',
    LANG: process.env.LANG && /^[A-Za-z0-9_.@-]{1,64}$/u.test(process.env.LANG) ? process.env.LANG : 'C.UTF-8'
  }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    const value = process.env[key]
    if (value && isAbsolute(value)) {
      env[key] = value
    }
  }
  return env
}

/** 固定会话是否已在运行：`running:false`（含遗留 socket）算无；列表无法解析不猜测，按错误处理。 */
export async function luvusSessionRunning(config: LuvusLocalConfig, signal: AbortSignal): Promise<boolean> {
  const limits = localLimits(config.limits)
  const scope = deadline(signal, limits.timeout_ms)
  try {
    const listing = await runFixedProcess(config, limits, 'sessions', scope.signal)
    const parsed = parseNativeJson(listing.stdout, { object_bytes: Math.min(limits.discovery_bytes, 1_048_576) })
    if (listing.exit_code !== 0 || !parsed.ok) {
      throw new LuvusAdapterError('native_control_discovery_invalid')
    }
    const rows = object(parsed.value).sessions
    if (!Array.isArray(rows) || rows.length > 256) {
      throw new LuvusAdapterError('native_control_discovery_invalid')
    }
    const matches = rows.filter(/* 只按固定会话名匹配。 */ (row) => object(row).name === config.target.session)
    return matches.length === 1 && object(matches[0]).running === true
  } finally {
    scope.close()
  }
}

/** 在用户的 LUVUS_HOME 里拉起一个脱离的 server 并立即放手：它是用户的持久会话，Connector 退出不终止它。 */
async function startDetachedServer(config: LuvusLocalConfig): Promise<void> {
  await verifyInstallation(config)
  const child = withPrivateUmask(() =>
    spawn(config.binary, ['--session', config.target.session, 'server'], {
      cwd: config.user_home!,
      env: userLuvusEnvironment(config),
      shell: false,
      stdio: 'ignore',
      detached: true,
      windowsHide: true
    })
  )
  await new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new LuvusAdapterError('native_source_start_failed')))
    child.once('spawn', () => resolve())
  })
  child.unref()
}

/** 附着优先；确认没有运行的会话才自建。存在但身份不符的实例一律拒绝，不覆盖也不终止。 */
async function acquire(config: LuvusLocalConfig, signal: AbortSignal): Promise<AttachedLuvusInstance> {
  if (await luvusSessionRunning(config, signal)) {
    return attachExistingLuvus(config, { signal })
  }
  await startDetachedServer(config)
  const deadlineAt = Date.now() + START_DEADLINE_MS
  for (;;) {
    try {
      return await attachExistingLuvus(config, { signal })
    } catch (error) {
      if (signal.aborted || Date.now() >= deadlineAt) {
        throw error
      }
      await pause(100)
    }
  }
}

/** 取得首个实例并开始监督；首次附着与自建都失败时抛出固定错误码，供启动诊断。 */
export async function startUserLuvus(input: LuvusLocalConfig): Promise<UserLuvusSource> {
  const config = pinConfig(input)
  if (!config.attach || !config.user_home || !isAbsolute(config.user_home)) {
    throw new LuvusAdapterError('invalid_local_config')
  }
  const stop = new AbortController()
  let closed = false
  let current: AttachedLuvusInstance | undefined
  let recovering: Promise<void> | undefined
  const listeners = new Set<() => void>()

  /** 丢失后：释放旧观察者，再带退避地重新附着或重建，成功后通知宿主结束当前连接周期。 */
  async function recover(lost: AttachedLuvusInstance): Promise<void> {
    current = undefined
    try {
      lost.close()
    } catch {
      // 旧观察者释放失败不阻止重建；claim 账本是持久文件，不依赖旧句柄。
    }
    let delay = BACKOFF_FIRST_MS
    while (!closed) {
      try {
        const next = await acquire(config, stop.signal)
        if (closed) {
          next.close()
          return
        }
        current = next
        for (const listener of listeners) {
          try {
            listener()
          } catch {
            // 宿主侧通知失败不影响来源本身。
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
    if (closed || recovering || !current || current.ready()) {
      return
    }
    recovering = recover(current).finally(() => {
      recovering = undefined
    })
  }, WATCH_INTERVAL_MS)
  watcher.unref()
  try {
    current = await acquire(config, stop.signal)
  } catch (error) {
    clearInterval(watcher)
    throw error
  }
  return Object.freeze({
    current: () => current,
    session_replaced(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close(): void {
      closed = true
      stop.abort()
      clearInterval(watcher)
      const active = current
      current = undefined
      active?.close()
    }
  })
}
