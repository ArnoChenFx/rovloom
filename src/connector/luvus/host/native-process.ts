/** 持有开发启动的直接子进程与 Linux pidfd，核对启动身份并只终止自己拥有的实例。 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { getSystemErrorName } from 'node:util'
import { childEnvironment, withPrivateUmask } from '../local.js'
import { LuvusAdapterError } from '../types.js'
import type { LuvusLocalConfig } from '../types.js'
import type { EndpointIdentity, PeerIdentity } from '../types.js'
import type { Socket } from 'node:net'
import { readLinuxLuvusPeer } from '../linux-peer.js'
import { readMacosLuvusPeer, readWindowsLuvusPeer } from '../peer.js'
import { WINDOWS_PIPE } from '../local.js'
import { macosProcessArgv, macosProcessImage, macosProcessState, macosProcessUid } from '../../../platform/macos.js'
import { windowsInspectPath, windowsProcessFacts, windowsProcessState } from '../../../platform/windows.js'

export interface ReadonlyNativeProcess {
  assertLive(): void
  identity(): PeerIdentity
}
export interface ObservedNativeProcess extends ReadonlyNativeProcess {
  close(): void
}

type Libc = {
  symbols: {
    pidfd_open(pid: number, flags: number): number
    pidfd_send_signal(fd: number, signal: number, info: number, flags: number): number
    __errno_location(): number
    poll(buffer: number, count: number, timeout: number): number
    close(fd: number): number
  }
}
type Ffi = {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): Libc
  ptr(buffer: Uint8Array): number
  read: { i32(pointer: number): number }
}
let nativeKernel: { ffi: Ffi; libc: Libc } | undefined

export type OwnedProcessSignal = 'SIGTERM' | 'SIGKILL'
export type OwnedProcessSignalAttempt = Readonly<{
  operation: 'pidfd_send_signal' | 'pidfd_open'
  signal: OwnedProcessSignal | null
  sent: boolean
  errno: number | null
  os_code: string | null
}>
export type OwnedProcessStopPort = Readonly<{
  exited: Promise<void>
  hasExited(): boolean
  send(signal: OwnedProcessSignal): OwnedProcessSignalAttempt
}>

/** 保留真实 syscall 错误及退出确认快照；超时或发送失败不能伪装成物理退出。 */
export class OwnedProcessShutdownError extends LuvusAdapterError {
  readonly attempts: readonly OwnedProcessSignalAttempt[]
  readonly errno: number | null
  readonly os_code: string | null
  readonly signal: OwnedProcessSignal | null
  readonly cleanup_pending: boolean

  /** 错误仅携带固定码、signal 和 errno，永不包含路径、原始 OS message 或秘密。 */
  constructor(
    code: string,
    attempts: readonly OwnedProcessSignalAttempt[],
    readonly exit_confirmed: boolean
  ) {
    super(code)
    this.attempts = Object.freeze(
      attempts.map(/* 冻结安全 syscall 元数据。 */ (attempt) => Object.freeze({ ...attempt }))
    )
    const last = attempts.at(-1)
    this.errno = last?.errno ?? null
    this.os_code = last?.os_code ?? null
    this.signal = last?.signal ?? null
    this.cleanup_pending = !exit_confirmed
  }
}

/** 延迟加载真实 libc 与线程 errno，不以合成 errno 替代失败 syscall。 */
function kernel(): { ffi: Ffi; libc: Libc } {
  if (process.platform !== 'linux' || !process.versions.bun) {
    throw new LuvusAdapterError('owned_pidfd_unavailable')
  }
  if (!nativeKernel) {
    const ffi = createRequire(import.meta.url)('bun:ffi') as Ffi
    const libc = ffi.dlopen('libc.so.6', {
      pidfd_open: { args: ['int', 'u32'], returns: 'int' },
      pidfd_send_signal: { args: ['int', 'int', 'ptr', 'u32'], returns: 'int' },
      __errno_location: { args: [], returns: 'ptr' },
      poll: { args: ['ptr', 'u64', 'int'], returns: 'int' },
      close: { args: ['int'], returns: 'int' }
    })
    nativeKernel = { ffi, libc }
  }
  return nativeKernel
}

/** 把立即读取的真实 errno 转为安全名称，未知 errno 不猜测为权限或退出错误。 */
function osCode(errno: number | null): string | null {
  if (!errno) {
    return null
  }
  try {
    return getSystemErrorName(-errno)
  } catch {
    return null
  }
}

/** 仅操作调用方持有的 fd，不选择 PID、更不建立任何 native 来源或执行授权。 */
export function signalOwnedPidfd(fd: number, signal: OwnedProcessSignal): OwnedProcessSignalAttempt {
  const { ffi, libc } = kernel()
  const result = libc.symbols.pidfd_send_signal(fd, signal === 'SIGTERM' ? 15 : 9, 0, 0)
  const errno = result === 0 ? null : ffi.read.i32(libc.symbols.__errno_location())
  return Object.freeze({ operation: 'pidfd_send_signal', signal, sent: result === 0, errno, os_code: osCode(errno) })
}

/** 有界等待真正的退出通知；结束本地等待不会修改拥有者的物理退出事实。 */
function waitOwnedExit(port: OwnedProcessStopPort, milliseconds: number): Promise<boolean> {
  if (port.hasExited()) {
    return Promise.resolve(true)
  }
  return new Promise(
    /* 只让真实退出事件或本次等待截止结算。 */ (resolve, reject) => {
      const timer = setTimeout(/* 期限仅停止等待，不把 child 标记为已退出。 */ () => resolve(false), milliseconds)
      void port.exited.then(
        /* 实际退出观察完成后重新核对拥有者的独立退出事实。 */ () => {
          clearTimeout(timer)
          resolve(port.hasExited())
        },
        /* 观察通道丢失也不能冒充退出确认。 */ () => {
          clearTimeout(timer)
          reject(new OwnedProcessShutdownError('owned_process_exit_observation_failed', [], false))
        }
      )
    }
  )
}

/** 内部关闭接缝只消费拥有者端口；可注入测试失败，不能创建或伪造任何来源句柄。 */
export async function stopOwnedProcess(
  port: OwnedProcessStopPort,
  limits: Readonly<{ grace_ms: number; exit_ms: number }> = { grace_ms: 500, exit_ms: 2000 }
): Promise<void> {
  if (
    !Number.isSafeInteger(limits.grace_ms) ||
    limits.grace_ms < 1 ||
    limits.grace_ms > 500 ||
    !Number.isSafeInteger(limits.exit_ms) ||
    limits.exit_ms < 1 ||
    limits.exit_ms > 2000
  ) {
    throw new LuvusAdapterError('owned_shutdown_limits_invalid')
  }
  if (port.hasExited()) {
    return
  }
  const attempts: OwnedProcessSignalAttempt[] = []
  const term = port.send('SIGTERM')
  attempts.push(term)
  if (port.hasExited() || (term.sent && (await waitOwnedExit(port, limits.grace_ms)))) {
    return
  }
  const kill = port.send('SIGKILL')
  attempts.push(kill)
  if (port.hasExited()) {
    return
  }
  if (!kill.sent && kill.errno !== 3) {
    throw new OwnedProcessShutdownError('owned_process_signal_failed', attempts, false)
  }
  // ESRCH 仅表示这次 syscall 未找到活目标，仍须等实际 child 退出通知，不能直接确认退出。
  if (!(await waitOwnedExit(port, limits.exit_ms))) {
    throw new OwnedProcessShutdownError(
      kill.sent ? 'owned_process_exit_timeout' : 'owned_process_signal_failed',
      attempts,
      false
    )
  }
}

/** 对路径链逐层检查归属与可写性；目录 ctime 的正常内容变化不改变其身份。 */
export function ownedPathStamp(path: string, kind: 'directory' | 'binary' | 'socket'): string {
  if (process.platform === 'win32') {
    // Windows：命名管道端点以名称为身份；目录/二进制按属主 SID + DACL 逐级核验。
    if (kind === 'socket') {
      if (!WINDOWS_PIPE.test(path)) {
        throw new LuvusAdapterError('owned_path_untrusted')
      }
      return path
    }
    try {
      return windowsInspectPath(path, kind)
    } catch {
      throw new LuvusAdapterError('owned_path_untrusted')
    }
  }
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    throw new LuvusAdapterError('owned_path_untrusted')
  }
  const paths = [path]
  while (paths[0] !== sep) {
    const parent = dirname(paths[0]!)
    if (parent === paths[0]) {
      throw new LuvusAdapterError('owned_path_untrusted')
    }
    paths.unshift(parent)
  }
  const rootOwner = lstatSync(sep, { bigint: true }).uid
  const uid = BigInt(process.geteuid!())
  const stamps: string[] = []
  for (const component of paths) {
    const info = lstatSync(component, { bigint: true })
    const last = component === path
    const mode = Number(info.mode & 0o777n)
    if (
      info.isSymbolicLink() ||
      (mode & 0o022) !== 0 ||
      (info.uid !== uid && info.uid !== 0n && info.uid !== rootOwner) ||
      (!last && !info.isDirectory()) ||
      (last && kind === 'directory' && (!info.isDirectory() || info.uid !== uid || mode !== 0o700)) ||
      (last && kind === 'socket' && (!info.isSocket() || info.uid !== uid || mode !== 0o600)) ||
      (last && kind === 'binary' && (!info.isFile() || (mode & 0o111) === 0 || (info.mode & 0o6000n) !== 0n))
    ) {
      throw new LuvusAdapterError('owned_path_untrusted')
    }
    stamps.push(
      [
        component,
        info.dev,
        info.ino,
        info.uid,
        info.gid,
        info.mode,
        last && kind !== 'directory' ? info.size : '',
        last && kind !== 'directory' ? info.ctimeNs : ''
      ].join(':')
    )
  }
  return stamps.join('\n')
}

/** 命令行固定为 `--session <name> server`；default 会话手动运行时可省略 `--session default`。 */
function attachedServerArguments(config: LuvusLocalConfig, tail: readonly string[]): boolean {
  const joined = tail.join('\0')
  return (
    joined === '--session\0' + config.target.session + '\0server' ||
    (config.target.session === 'default' && joined === 'server')
  )
}

/**
 * 附着用户自己的 Luvus：进程不是我们派生的，环境与工作目录都是用户的，所以只以内核事实证明身份——
 * 存活、exe 与已安装二进制是同一 inode（同属主）、argv 恰为 `server` 的固定形态。
 * 用户经 TUI 启动的 default 会话是 `luvus --session default server`，手动运行可省略 `--session default`。
 */
function attachedProcessStamp(
  pid: number,
  config: LuvusLocalConfig,
  prefix: string,
  start: string | undefined,
  state: string | undefined
): string {
  const binary = lstatSync(config.binary, { bigint: true })
  const executable = statSync(prefix + '/exe', { bigint: true })
  const argv = readFileSync(prefix + '/cmdline', 'utf8').split('\0')
  if (argv.at(-1) === '') {
    argv.pop()
  }
  if (
    !start ||
    !/^\d+$/u.test(start) ||
    ['Z', 'X', 'x'].includes(state!) ||
    !attachedServerArguments(config, argv.slice(1)) ||
    executable.dev !== binary.dev ||
    executable.ino !== binary.ino ||
    executable.uid !== binary.uid ||
    executable.uid !== BigInt(process.geteuid!()) ||
    pid <= 0
  ) {
    throw new LuvusAdapterError('owned_process_identity_changed')
  }
  return start
}

/** 读取内核启动时钟与完整 argv/env/cwd/exe；不从 session discovery 中采信 PID。 */
function processStamp(pid: number, config: LuvusLocalConfig): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new LuvusAdapterError('owned_process_identity_changed')
  }
  const prefix = '/proc/' + pid
  const line = readFileSync(prefix + '/stat', 'utf8')
  const fields = line
    .slice(line.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u)
  const start = fields[19]
  const state = fields[0]
  if (config.attach) {
    return attachedProcessStamp(pid, config, prefix, start, state)
  }
  const expectedArgs = [config.binary, '--session', config.target.session, 'server'].join('\0') + '\0'
  const expectedEnv = Object.entries(childEnvironment(config))
    .map(/* 固定环境只接受本模块列明的键和值，不继承宿主凭据。 */ ([key, value]) => key + '=' + value)
    .sort()
    .join('\0')
  const binary = lstatSync(config.binary, { bigint: true })
  const executable = statSync(prefix + '/exe', { bigint: true })
  if (
    !start ||
    !/^\d+$/u.test(start) ||
    ['Z', 'X', 'x'].includes(state!) ||
    readlinkSync(prefix + '/exe') !== config.binary ||
    readlinkSync(prefix + '/cwd') !== config.cwd ||
    readFileSync(prefix + '/cmdline', 'utf8') !== expectedArgs ||
    executable.dev !== binary.dev ||
    executable.ino !== binary.ino ||
    executable.uid !== binary.uid
  ) {
    throw new LuvusAdapterError('owned_process_identity_changed')
  }
  // 先确认固定 exe/argv/cwd，避免把同 uid 的无关进程当作环境读取目标。
  const actualEnv = readFileSync(prefix + '/environ', 'utf8')
    .split('\0')
    .filter(Boolean)
    .sort()
    .join('\0')
  if (actualEnv !== expectedEnv) {
    throw new LuvusAdapterError('owned_process_identity_changed')
  }
  return start
}

/** 仅观察真实 socket peer 的固定实例；持有 pidfd 防 PID 重用，绝不发送信号或取得 child 所有权。 */
class LinuxLuvusObservation implements ObservedNativeProcess {
  readonly #peer: PeerIdentity
  readonly #config: LuvusLocalConfig
  readonly #start: string
  readonly #binary: string
  readonly #directories: readonly [string, string][]
  readonly #ffi: Ffi
  readonly #libc: Libc
  #pidfd: number

  /** 私有类只由下方同 socket 测量入口创建，不接受公开 JSON PID。 */
  constructor(socket: Socket, config: LuvusLocalConfig) {
    const peer = readLinuxLuvusPeer(socket)
    if (peer.uid !== process.geteuid!() || peer.gid !== process.getegid!()) {
      throw new LuvusAdapterError('attached_peer_mismatch')
    }
    const { ffi, libc } = kernel()
    this.#ffi = ffi
    this.#libc = libc
    this.#peer = peer
    this.#config = config
    this.#pidfd = libc.symbols.pidfd_open(peer.pid, 0)
    if (this.#pidfd < 0) {
      throw new LuvusAdapterError('attached_process_observation_unavailable')
    }
    try {
      this.#binary = ownedPathStamp(config.binary, 'binary')
      this.#directories = [
        config.state_root,
        config.home,
        config.cwd,
        ...['config', 'data', 'cache', 'runtime'].map(
          /* 固定环境引用的 XDG 目录同样绑定实际 inode。 */ (name) => config.home + '/' + name
        )
      ].map(
        /* 只读取明确配置的自有根目录身份，不枚举或读取其它用户会话。 */ (path) => [
          path,
          ownedPathStamp(path, 'directory')
        ]
      )
      this.#start = processStamp(peer.pid, config)
      this.assertLive()
      if (JSON.stringify(readLinuxLuvusPeer(socket)) !== JSON.stringify(peer)) {
        throw new LuvusAdapterError('attached_peer_mismatch')
      }
    } catch (error) {
      this.close()
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('attached_process_unavailable')
    }
  }

  /** 非阻塞核对原 pidfd、完整启动身份与路径；旧 PID 或同 uid 不能替代原进程。 */
  assertLive(): void {
    try {
      if (this.#pidfd < 0) {
        throw new LuvusAdapterError('attached_process_unavailable')
      }
      const poll = Buffer.alloc(8)
      poll.writeInt32LE(this.#pidfd)
      poll.writeInt16LE(1, 4)
      if (
        this.#libc.symbols.poll(this.#ffi.ptr(poll), 1, 0) !== 0 ||
        poll.readInt16LE(6) !== 0 ||
        processStamp(this.#peer.pid, this.#config) !== this.#start ||
        ownedPathStamp(this.#config.binary, 'binary') !== this.#binary
      ) {
        throw new LuvusAdapterError('attached_process_identity_changed')
      }
      for (const [path, stamp] of this.#directories) {
        if (ownedPathStamp(path, 'directory') !== stamp) {
          throw new LuvusAdapterError('attached_process_identity_changed')
        }
      }
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('attached_process_unavailable')
    }
  }

  /** 身份只能来自原 socket 的内核观测，使用时再次复验对应进程。 */
  identity(): PeerIdentity {
    this.assertLive()
    return this.#peer
  }

  /** 仅关闭本观察者持有的 pidfd；从不停止被观察的外部实例。 */
  close(): void {
    if (this.#pidfd >= 0) {
      const fd = this.#pidfd
      this.#pidfd = -1
      this.#libc.symbols.close(fd)
    }
  }
}

/**
 * macOS：附着用户自己的 Luvus。对端 PID 与 uid/gid 来自实际 socket 的 LOCAL_PEERPID/LOCAL_PEERCRED；
 * 进程镜像（proc_pidpath）必须是已安装 luvus 的同一文件（按文件身份比较，不信任路径文本），
 * 命令行取自 KERN_PROCARGS2 且为固定的 server 形态，启动时间在整个观察期内不变。macOS 没有 pidfd：
 * pid + 启动时间共同防止 PID 复用，每次使用都重新测量。
 */
class MacosLuvusObservation implements ObservedNativeProcess {
  readonly #peer: PeerIdentity
  readonly #config: LuvusLocalConfig
  readonly #start: string
  readonly #binary: string
  readonly #directories: readonly [string, string][]

  /** 只能由下方同 socket 测量入口创建，不接受公开 JSON PID。 */
  constructor(socket: Socket, config: LuvusLocalConfig) {
    this.#config = config
    try {
      this.#peer = readMacosLuvusPeer(socket)
      if (this.#peer.uid !== process.geteuid!() || this.#peer.gid !== process.getegid!()) {
        throw new LuvusAdapterError('attached_peer_mismatch')
      }
      this.#binary = ownedPathStamp(config.binary, 'binary')
      this.#directories = [config.state_root, config.home, config.cwd].map(
        /* 只读取明确配置的根目录身份，不枚举或读取其它会话。 */ (path) => [path, ownedPathStamp(path, 'directory')]
      )
      this.#start = this.#inspect()
      if (JSON.stringify(readMacosLuvusPeer(socket)) !== JSON.stringify(this.#peer)) {
        throw new LuvusAdapterError('attached_peer_mismatch')
      }
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('attached_process_unavailable')
    }
  }

  /** 服务端进程存活、同属主、镜像是已安装的同一文件且命令行为固定形态，返回其启动时间。 */
  #inspect(): string {
    const pid = this.#peer.pid
    const state = macosProcessState(pid)
    const image = macosProcessImage(pid)
    const argv = macosProcessArgv(pid)
    if (state.kind !== 'alive' || image === undefined || argv === undefined) {
      throw new LuvusAdapterError('attached_process_unavailable')
    }
    const executable = statSync(image, { bigint: true })
    const installed = lstatSync(this.#config.binary, { bigint: true })
    if (
      macosProcessUid(pid) !== process.geteuid!() ||
      executable.dev !== installed.dev ||
      executable.ino !== installed.ino ||
      executable.uid !== installed.uid ||
      executable.uid !== BigInt(process.geteuid!()) ||
      !attachedServerArguments(this.#config, argv.slice(1)) ||
      macosProcessState(pid).kind !== 'alive'
    ) {
      throw new LuvusAdapterError('attached_process_identity_changed')
    }
    return state.start
  }

  /** 逐次核对启动时间不变、镜像与命令行仍是固定形态、安装与目录未被替换。 */
  assertLive(): void {
    try {
      if (this.#inspect() !== this.#start || ownedPathStamp(this.#config.binary, 'binary') !== this.#binary) {
        throw new LuvusAdapterError('attached_process_identity_changed')
      }
      for (const [path, stamp] of this.#directories) {
        if (ownedPathStamp(path, 'directory') !== stamp) {
          throw new LuvusAdapterError('attached_process_identity_changed')
        }
      }
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('attached_process_unavailable')
    }
  }

  /** 身份只能来自原 socket 的内核观测，使用时再次复验对应进程。 */
  identity(): PeerIdentity {
    this.assertLive()
    return this.#peer
  }

  /** 没有需要释放的内核句柄；从不停止被观察的外部实例。 */
  close(): void {}
}

/**
 * Windows：附着用户自己的 Luvus。对端 PID 来自命名管道服务端（内核回答），其镜像必须是已安装 luvus.exe 的同一文件
 * （按文件身份比较，不信任路径文本），创建时间在整个观察期内不变，且服务端 PID 始终是同一进程；命令行不作判据。
 */
class WindowsLuvusObservation implements ObservedNativeProcess {
  readonly #peer: PeerIdentity
  readonly #config: LuvusLocalConfig
  readonly #start: string
  readonly #binary: string
  readonly #directories: readonly [string, string][]

  /** 只能由下方同端点测量入口创建，不接受公开 JSON PID。 */
  constructor(endpoint: EndpointIdentity, config: LuvusLocalConfig) {
    this.#config = config
    try {
      this.#peer = readWindowsLuvusPeer(endpoint)
      this.#binary = ownedPathStamp(config.binary, 'binary')
      this.#directories = [config.state_root, config.home, config.cwd].map(
        /* 只读取明确配置的根目录身份，不枚举或读取其它会话。 */ (path) => [path, ownedPathStamp(path, 'directory')]
      )
      this.#start = this.#inspect()
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('attached_process_unavailable')
    }
  }

  /** 服务端进程存活、镜像是已安装的同一文件，返回其创建时间。 */
  #inspect(): string {
    const facts = windowsProcessFacts(this.#peer.pid)
    if (!facts) {
      throw new LuvusAdapterError('attached_process_unavailable')
    }
    const image = statSync(facts.image, { bigint: true })
    const installed = statSync(this.#config.binary, { bigint: true })
    if (image.dev !== installed.dev || image.ino !== installed.ino) {
      throw new LuvusAdapterError('attached_process_identity_changed')
    }
    return facts.created.toString()
  }

  /**
   * 逐次核对 PID 仍存活且创建时间不变、镜像仍是已安装的同一文件、安装与目录未被替换。
   * 不在这里再开管道连接读服务端 PID：每次调用的 verifyPeer 会用同一端点读一次新值并与 identity() 比较，
   * 管道由同一进程服务的证明正来自那次比较；频繁开管道客户端会干扰服务端。
   */
  assertLive(): void {
    try {
      const state = windowsProcessState(this.#peer.pid)
      if (
        state.kind !== 'alive' ||
        state.start !== this.#start ||
        this.#inspect() !== this.#start ||
        ownedPathStamp(this.#config.binary, 'binary') !== this.#binary
      ) {
        throw new LuvusAdapterError('attached_process_identity_changed')
      }
      for (const [path, stamp] of this.#directories) {
        if (ownedPathStamp(path, 'directory') !== stamp) {
          throw new LuvusAdapterError('attached_process_identity_changed')
        }
      }
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('attached_process_unavailable')
    }
  }

  /** 身份只能来自命名管道服务端的内核回答，使用时再次复验对应进程。 */
  identity(): PeerIdentity {
    this.assertLive()
    return this.#peer
  }

  /** 没有需要释放的内核句柄；从不停止被观察的外部实例。 */
  close(): void {}
}

/** 按平台建立只读进程观察：Linux 取自实际 socket 的 SO_PEERCRED，macOS 取自 LOCAL_PEERPID/LOCAL_PEERCRED，Windows 取自管道服务端 PID。 */
export function observeLuvusProcess(
  socket: Socket,
  config: LuvusLocalConfig,
  endpoint: EndpointIdentity
): ObservedNativeProcess {
  if (process.platform === 'win32') {
    return new WindowsLuvusObservation(endpoint, config)
  }
  return process.platform === 'darwin'
    ? new MacosLuvusObservation(socket, config)
    : new LinuxLuvusObservation(socket, config)
}

/** 从实际已连接 socket 建立只读进程观察，不提供按 PID 认领入口。 */
export function observeLinuxLuvusProcess(socket: Socket, config: LuvusLocalConfig): ObservedNativeProcess {
  return new LinuxLuvusObservation(socket, config)
}

/** 受控 child/pidfd 的内部所有者；构造失败也不向调用方交付可伪造的进程快照。 */
export class OwnedNativeProcess {
  readonly #config: LuvusLocalConfig
  readonly #ffi: Ffi
  readonly #libc: Libc
  readonly #child: ChildProcess
  readonly #binary: string
  readonly #directories: readonly [string, string][]
  readonly #exited: Promise<void>
  readonly #launched: Promise<boolean>
  readonly #spawnPid: number | undefined
  readonly #openFailure: OwnedProcessSignalAttempt | undefined
  #pidfd = -1
  #gone = false
  #didSpawn = false
  #closeRequested = false
  #start: string | undefined
  #closing: Promise<void> | undefined

  /** 在固定 argv/env/cwd 下直接 spawn 并立即持有 pidfd，拒绝旧 PID 的重新认领。 */
  constructor(config: LuvusLocalConfig) {
    this.#config = config
    this.#binary = ownedPathStamp(config.binary, 'binary')
    this.#directories = [
      config.state_root,
      config.home,
      config.cwd,
      ...['config', 'data', 'cache', 'runtime'].map(
        /* 绑定每个隔离 XDG 目录的实际 inode。 */ (name) => config.home + '/' + name
      )
    ].map(/* 固定目录身份用于后续同步复核。 */ (path) => [path, ownedPathStamp(path, 'directory')])
    const native = kernel()
    this.#ffi = native.ffi
    this.#libc = native.libc
    this.#child = withPrivateUmask(() =>
      spawn(config.binary, ['--session', config.target.session, 'server'], {
        cwd: config.cwd,
        env: childEnvironment(config),
        shell: false,
        stdio: 'ignore'
      })
    )
    this.#spawnPid = this.#child.pid
    this.#exited = new Promise(
      /* 永久保留直接 child 退出事实，绝不重启或重新认领。 */ (resolve) => {
        this.#child.once(
          'exit',
          /* 退出后本来源永久失效。 */ () => {
            this.#gone = true
            resolve()
            this.#releaseExitedHandle()
          }
        )
        this.#child.once(
          'error',
          /* 只有确认没有生成 child 的启动失败可结束等待，一般 error 不能冒充物理退出。 */ () => {
            if (!this.#didSpawn && !Number.isInteger(this.#spawnPid)) {
              this.#gone = true
              resolve()
            }
          }
        )
      }
    )
    this.#launched = new Promise(
      /* 在构造时观察启动，避免 started 较晚调用时漏掉 spawn 事件。 */ (resolve) => {
        this.#child.once(
          'spawn',
          /* 实际 spawn 通知独立于退出与 signal 错误。 */ () => {
            this.#didSpawn = true
            resolve(true)
          }
        )
        this.#child.once('error', /* 启动失败返回安全状态，不创建未消费的拒绝 promise。 */ () => resolve(false))
      }
    )
    if (Number.isInteger(this.#child.pid)) {
      this.#pidfd = this.#libc.symbols.pidfd_open(this.#child.pid!, 0)
      if (this.#pidfd < 0) {
        const errno = this.#ffi.read.i32(this.#libc.symbols.__errno_location())
        this.#openFailure = Object.freeze({
          operation: 'pidfd_open',
          signal: null,
          sent: false,
          errno,
          os_code: osCode(errno)
        })
      }
    }
  }

  /** 完成 spawn 后记录真实启动身份；缺原子停止句柄时有界报告未完成清理，不按 PID 补杀。 */
  async started(): Promise<void> {
    // spawn 返回时 /proc/exe 可能仍在 exec 切换，等待 Node 的 spawn 通知再固定身份。
    const launched = await new Promise<boolean>(
      /* 启动观察本身也设最终截止，不等待无限缺失的通知。 */ (resolve, reject) => {
        const timer = setTimeout(
          /* 截止只结束启动等待，后续仍须通过拥有者确认清理结果。 */ () =>
            reject(new LuvusAdapterError('owned_spawn_timeout')),
          2000
        )
        void this.#launched.then(
          /* 实际启动结果到达后移除等待期限。 */ (value) => {
            clearTimeout(timer)
            resolve(value)
          }
        )
      }
    )
    if (!launched) {
      throw new LuvusAdapterError('owned_spawn_failed')
    }
    if (this.#pidfd < 0) {
      // 缺 pidfd 不能建立无 PID 重用风险的原子停止；有界报告清理未完成，绝不按 PID 补杀。
      await this.close()
      throw new OwnedProcessShutdownError(
        'owned_pidfd_unavailable',
        this.#openFailure ? [this.#openFailure] : [],
        this.#gone
      )
    }
    this.#start = processStamp(this.#child.pid!, this.#config)
    this.assertLive()
  }

  /** 逐次检查 pidfd、退出事实、路径及内核启动身份，不能用 uid 相等代替归属。 */
  assertLive(): void {
    try {
      if (
        this.#gone ||
        this.#closeRequested ||
        this.#pidfd < 0 ||
        !this.#start ||
        this.#child.exitCode !== null ||
        this.#child.signalCode !== null
      ) {
        throw new LuvusAdapterError('owned_process_unavailable')
      }
      const poll = Buffer.alloc(8)
      poll.writeInt32LE(this.#pidfd)
      poll.writeInt16LE(1, 4)
      if (
        this.#libc.symbols.poll(this.#ffi.ptr(poll), 1, 0) !== 0 ||
        ownedPathStamp(this.#config.binary, 'binary') !== this.#binary ||
        processStamp(this.#child.pid!, this.#config) !== this.#start
      ) {
        throw new LuvusAdapterError('owned_process_identity_changed')
      }
      for (const [path, stamp] of this.#directories) {
        if (ownedPathStamp(path, 'directory') !== stamp) {
          throw new LuvusAdapterError('owned_process_identity_changed')
        }
      }
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('owned_process_unavailable')
    }
  }

  /** 返回直接 child 的内核对照身份；调用前必须仍通过启动身份核验。 */
  identity(): { pid: number; uid: number; gid: number } {
    this.assertLive()
    return { pid: this.#child.pid!, uid: process.geteuid!(), gid: process.getegid!() }
  }

  /** 通过持续持有的 pidfd 终止自有实例；幂等关闭不会按 discovery PID 杀进程。 */
  close(): Promise<void> {
    this.#closeRequested = true
    if (this.#closing) {
      return this.#closing
    }
    const attempt = this.#stop()
    this.#closing = attempt
    void attempt.then(
      /* 成功后重复 close 仍复核已确认退出状态。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      },
      /* 失败只清除本次等待，保留真实 child/pidfd 供后续显式清理重试。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      }
    )
    return attempt
  }

  /** 显式区分逻辑关闭请求、真实退出确认和仍持有的内核句柄，不把超时当作退出。 */
  terminationState(): Readonly<{ close_requested: boolean; exit_confirmed: boolean; pidfd_retained: boolean }> {
    return Object.freeze({
      close_requested: this.#closeRequested,
      exit_confirmed: this.#gone,
      pidfd_retained: this.#pidfd >= 0
    })
  }

  /** 只有观察到真正退出后才释放 pidfd；失败/超时后晚到退出也会回收句柄。 */
  #releaseExitedHandle(): void {
    if (this.#closeRequested && this.#gone && this.#pidfd >= 0) {
      const fd = this.#pidfd
      this.#pidfd = -1
      this.#libc.symbols.close(fd)
    }
  }

  /** 关闭等待有最终期限；每次 syscall 均检查结果，未退出时保留拥有句柄与准确失败。 */
  async #stop(): Promise<void> {
    try {
      if (!this.#gone && this.#pidfd < 0) {
        throw new OwnedProcessShutdownError(
          'owned_pidfd_unavailable',
          this.#openFailure ? [this.#openFailure] : [],
          false
        )
      }
      await stopOwnedProcess({
        exited: this.#exited,
        /* 退出事实只由真实 exit 或确定未 spawn 的失败事件更新。 */ hasExited: () => this.#gone,
        /* 每个实际停止请求都只使用本构造器持续持有的 pidfd，不存在 PID 补杀路径。 */ send: (signal) =>
          signalOwnedPidfd(this.#pidfd, signal)
      })
    } finally {
      this.#releaseExitedHandle()
    }
  }
}
