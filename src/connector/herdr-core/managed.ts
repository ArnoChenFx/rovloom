/**
 * managed 模式的 core 生命周期：由 Connector 在私有目录里拉起 `<bin> serve`。
 *
 * 硬规则（见 ADR 0009）：
 * - **绝不调用 `hc`**：它的自动启动路径可能走 systemd-run 并执行 `loginctl enable-linger`（改系统状态）。
 *   这里直接 exec `<bin> serve`，并给整个进程树一个私有 XDG_RUNTIME_DIR，systemd 路径也走不到。
 * - 不下载、不更新、不安装：二进制只从 `native.runtime_bin_dirs`（或 PATH）里找。
 * - 不停止：Connector 退出后 core 与终端继续运行（holder 持有它们），重连复用第四阶段的完整身份核对。
 * - 不碰真实 HOME 的 `~/.config/herdr-core` 与 `~/.local/state/herdr-core`：状态与 config 默认都在 Connector 私有目录。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, lstatSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, normalize } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { ProviderAdapterError } from '../provider-error.js'
import { fail } from '../../wire/index.js'

/** core 二进制名；与发布清单一致，不做别名或包装脚本。 */
const CORE_BINARY = 'herdr-core'
/** 单次拉起后等待套接字的上限；真实的 serve 在 100 ms 级别就绪。 */
const START_TIMEOUT_MS = 15_000
export type HerdrCoreManagedDirs = Readonly<{
  /** 私有运行时目录（短路径，0700）：core 的套接字与 holder 套接字都在这里。 */
  run: string
  /** 私有状态目录：core.json / terminals.json 等，不碰真实 ~/.local/state。 */
  state: string
  /** 模板与 config.toml 所在目录；默认是 Connector 私有的空目录。 */
  config: string
  session: string
  socket: string
}>

/** 只接受规范绝对路径：不从 cwd 或环境变量推断。 */
function absolute(value: string, code: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value.includes('\0')) {
    fail(code)
  }
  return value
}

/** 私有目录：已存在则核对是本用户 0700 的目录，绝不改权限。 */
function privateDirectory(path: string): void {
  try {
    const entry = lstatSync(path)
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (entry.mode & 0o777) !== 0o700 ||
      entry.uid !== process.getuid?.()
    ) {
      fail('herdr_core_managed_directory_untrusted')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const created = lstatSync(path)
  if (!created.isDirectory() || (created.mode & 0o777) !== 0o700) {
    fail('herdr_core_managed_directory_untrusted')
  }
}

/** 套接字路径上限 107 字节；managed 目录本身要短，不能放深层 state 目录下。 */
function runtimeBase(): string {
  const configured = process.env.XDG_RUNTIME_DIR
  if (configured !== undefined && isAbsolute(configured)) {
    try {
      accessSync(configured, constants.W_OK)
      return configured
    } catch {
      /* 不可写就退回系统临时目录。 */
    }
  }
  return tmpdir()
}

/**
 * managed 的固定位置。run 目录按状态目录摘要命名，保证同一台机器上多个 Connector 互不干扰，
 * 同时把套接字路径压在上限内；state/config 放在 Connector 的私有状态目录下。
 */
export function herdrCoreManagedDirs(
  input: Readonly<{
    state_dir: string
    session: string
    config_home?: string
  }>
): HerdrCoreManagedDirs {
  const stateDir = absolute(input.state_dir, 'herdr_core_managed_directory_untrusted')
  const digest = createHash('sha256').update(stateDir).digest('hex').slice(0, 16)
  const run = join(runtimeBase(), `rovloom-hc-${digest}`)
  const state = join(stateDir, 'managed', 'herdr-core', 'state')
  const config =
    input.config_home === undefined
      ? join(stateDir, 'managed', 'herdr-core', 'config')
      : absolute(input.config_home, 'herdr_core_managed_directory_untrusted')
  for (const directory of [run, state, config]) {
    privateDirectory(directory)
  }
  // 套接字路径上限 107 字节还要给 holder 留 9 字节；放不下就在配置阶段拒绝，不留给 core 报 usage。
  const socket = join(run, 'herdr-core', `${input.session}.sock`)
  if (socket.length + 9 + '.holder.'.length > 107) {
    fail('herdr_core_session_too_long')
  }
  return Object.freeze({
    run,
    state,
    config,
    session: input.session,
    socket
  })
}

/** 只从显式目录或 PATH 里找 `herdr-core`；找到的必须是本用户可执行的正规文件。 */
export function findHerdrCoreBinary(
  input: Readonly<{
    runtime_bin_dirs?: readonly string[]
    path?: string
  }>
): string {
  const directories = input.runtime_bin_dirs?.length
    ? input.runtime_bin_dirs.map(
        /** 显式目录必须是规范绝对路径。 */ (entry) => absolute(entry, 'herdr_core_binary_unavailable')
      )
    : (input.path ?? process.env.PATH ?? '')
        .split(delimiter)
        .filter(/** 空段与相对段都不搜。 */ (entry) => entry.length > 0 && isAbsolute(entry))
  for (const directory of directories) {
    const candidate = join(directory, CORE_BINARY)
    try {
      const entry = statSync(candidate)
      if (entry.isFile() && entry.uid === process.getuid?.()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch {
      continue
    }
  }
  fail('herdr_core_binary_unavailable')
}

/** 拉起用的环境：只给 core 需要的最小集合，身份变量逐个显式设定，不透传宿主环境。 */
export function herdrCoreManagedEnv(dirs: HerdrCoreManagedDirs): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    LANG: process.env.LANG ?? 'C.UTF-8',
    XDG_RUNTIME_DIR: dirs.run,
    XDG_STATE_HOME: dirs.state,
    XDG_CONFIG_HOME: dirs.config,
    HC_SESSION: dirs.session,
    // 误触更新时只会失败，不会联网。
    HERDR_RELEASES_URL: 'http://127.0.0.1:9'
  }
}

/** 套接字是否已经可用（只 stat，不连接；连接会由附着层做完整身份核对）。 */
function socketReady(socket: string): boolean {
  try {
    return lstatSync(socket).isSocket()
  } catch {
    return false
  }
}

/**
 * 确保 managed core 在跑：已有套接字就直接附着；否则起一个脱离本进程的 `serve` 并等它就绪。
 * 同 session 已有 core（core.lock 被占）时新起的进程会静默退出，此时等原 core 的套接字出现即可。
 * 任何失败都只给固定码，不拉起第二个实例、不自动重试成热循环。
 */
export async function ensureHerdrCoreManaged(
  input: Readonly<{
    dirs: HerdrCoreManagedDirs
    binary: string
    /** 测试注入点：默认用 node:child_process.spawn。 */
    spawnProcess?: typeof spawn
    timeout_ms?: number
  }>
): Promise<void> {
  if (socketReady(input.dirs.socket)) {
    return
  }
  const binary = absolute(input.binary, 'herdr_core_binary_unavailable')
  const launch = input.spawnProcess ?? spawn
  const child = launch(binary, ['serve'], {
    env: herdrCoreManagedEnv(input.dirs),
    cwd: input.dirs.run,
    // 脱离 Connector：Connector 退出后 core 与终端继续运行。
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', /** 启动失败由等待超时统一报告，不在这里抛出异步异常。 */ () => {})
  child.unref()
  // 新起的进程可能因 core.lock 被占而静默退出：这时原 core 的套接字随后会出现，继续等到期限。
  const deadline = Date.now() + (input.timeout_ms ?? START_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (socketReady(input.dirs.socket)) {
      return
    }
    await pause(50)
  }
  throw new ProviderAdapterError('herdr_core_managed_start_failed')
}
