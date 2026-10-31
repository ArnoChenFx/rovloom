/**
 * herdr-core 的本地身份实证：端点位置、session 长度上限、对端 pid 的 exe/argv/environ 核对，
 * 以及终端标识三元组。全部只读本机文件，不拉起进程、不改目录权限、不接管实例。
 */
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from '../../wire/index.js'
import type { JsonObject } from '../../wire/types.js'
import type { NativePeer } from '../local/linux-peer.js'

/** Linux 上 Unix 套接字路径上限；macOS 更短，未在本仓库验证。 */
export const HERDR_CORE_SOCKET_PATH_LIMIT = 107
/** core 在 holder 套接字后追加的分隔符与 8 位十六进制 id。 */
const HOLDER_SUFFIX = 9
const HOLDER_NAME = '.holder.sock'
const BINARY_LIMIT = 64 * 1024 * 1024
const ENVIRON_LIMIT = 1024 * 1024

export type HerdrCoreEndpoint = Readonly<{
  socket: string
  /** 端点来源：XDG 运行时目录或回退的状态目录。 */
  origin: 'runtime' | 'state'
  session: string
}>

/** 只接受字母数字与 . _ -，与 core 的拒绝规则和现有配置字符集一致。 */
export function herdrCoreSessionName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(value)) {
    fail('herdr_core_session_invalid')
  }
  return value
}

/**
 * core 的最长路径是 `<dir>/<session>.holder.<8 位 id>.sock`：
 * 无 XDG_RUNTIME_DIR 时回退目录本身已经含 session，所以 session 名出现两次。
 * 配置阶段就按这个公式拒绝，不能等 core 报 usage。
 */
export function herdrCoreSessionLimit(env: Readonly<Record<string, string | undefined>> = process.env): Readonly<{
  limit: number
  directory: string
  origin: 'runtime' | 'state'
}> {
  const runtime = env.XDG_RUNTIME_DIR
  const stateHome = env.XDG_STATE_HOME ?? (env.HOME ? join(env.HOME, '.local/state') : undefined)
  if (runtime && runtime.startsWith('/')) {
    const directory = join(runtime, 'herdr-core')
    return Object.freeze({
      limit: HERDR_CORE_SOCKET_PATH_LIMIT - HOLDER_SUFFIX - directory.length - 1 - HOLDER_NAME.length,
      directory,
      origin: 'runtime'
    })
  }
  if (!stateHome || !stateHome.startsWith('/')) {
    fail('herdr_core_endpoint_unavailable')
  }
  const base = join(stateHome, 'herdr-core')
  // `<base>/<session>/<session>.holder.sock` + 9 字节：session 出现两次。
  const limit = Math.floor((HERDR_CORE_SOCKET_PATH_LIMIT - HOLDER_SUFFIX - base.length - 2 - HOLDER_NAME.length) / 2)
  return Object.freeze({ limit, directory: base, origin: 'state' })
}

/**
 * 定位已在运行的 core 端点。优先 XDG_RUNTIME_DIR，其次 XDG_STATE_HOME/HOME 下的状态目录；
 * 不探测任意路径，也不为缺失的端点创建目录。
 */
export function herdrCoreEndpoint(
  session: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): HerdrCoreEndpoint {
  const name = herdrCoreSessionName(session)
  const bound = herdrCoreSessionLimit(env)
  if (bound.limit < 1) {
    fail('herdr_core_endpoint_too_long')
  }
  if (name.length > bound.limit) {
    fail('herdr_core_session_too_long')
  }
  const socket =
    bound.origin === 'runtime' ? join(bound.directory, `${name}.sock`) : join(bound.directory, name, `${name}.sock`)
  return Object.freeze({ socket, origin: bound.origin, session: name })
}

/** 配对时固定的端点位置：只由配置中的 runtime_dir 或 state_home 重算，运行时不再读进程环境。 */
export function herdrCorePinnedEndpoint(
  pin: Readonly<{ runtime_dir?: string; state_home?: string }>,
  session: string
): HerdrCoreEndpoint {
  if ((pin.runtime_dir === undefined) === (pin.state_home === undefined)) {
    fail('herdr_core_endpoint_unavailable')
  }
  return herdrCoreEndpoint(
    session,
    pin.runtime_dir !== undefined ? { XDG_RUNTIME_DIR: pin.runtime_dir } : { XDG_STATE_HOME: pin.state_home }
  )
}

/** 端点必须是我们自己的套接字，目录必须是私有的；不改权限，不跟随链接。 */
export function inspectHerdrCoreSocket(socket: string): Readonly<{ uid: number; directory_uid: number }> {
  if (typeof socket !== 'string' || !socket.startsWith('/') || socket.includes('\0')) {
    fail('herdr_core_endpoint_unavailable')
  }
  const directory = socket.slice(0, socket.lastIndexOf('/'))
  const directoryStat = lstatSync(directory)
  const socketStat = lstatSync(socket)
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o777) !== 0o700 ||
    directoryStat.uid !== process.getuid?.()
  ) {
    fail('herdr_core_endpoint_untrusted')
  }
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid?.()) {
    fail('herdr_core_endpoint_untrusted')
  }
  return Object.freeze({ uid: socketStat.uid, directory_uid: directoryStat.uid })
}

/** 读整个文件并算 SHA-256；传 `/proc/<pid>/exe` 时读的是正在运行的映像，不是路径上现在的文件。 */
function digestFile(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(1 << 20)
    let total = 0
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) {
        break
      }
      total += read
      if (total > BINARY_LIMIT) {
        fail('herdr_core_binary_too_large')
      }
      hash.update(chunk.subarray(0, read))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

export type HerdrCoreProcessFacts = Readonly<{
  pid: number
  exe: string
  binary_sha256: string
  argv: readonly string[]
  session: string | undefined
}>

/**
 * 只核对服务端自报 pid 的进程事实：exe 必须是绝对路径、argv 恒为 `<bin> serve`、
 * HC_SESSION 与本次 session 一致。pid 由 core 自报，所以这些文件核对才是实际约束。
 */
export function herdrCoreProcessFacts(pid: unknown, session: string): HerdrCoreProcessFacts {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1 || (pid as number) > 4194304) {
    fail('herdr_core_peer_pid_invalid')
  }
  const base = `/proc/${pid as number}`
  let exe: string
  try {
    exe = realpathSync(join(base, 'exe'))
  } catch {
    fail('herdr_core_peer_unavailable')
  }
  const argv = readFileSync(join(base, 'cmdline'))
    .toString('utf8')
    .split('\0')
    .filter(/** 末尾分隔符不产生空参数。 */ (entry) => entry.length > 0)
  if (argv.length !== 2 || argv[1] !== 'serve' || !argv[0]!.startsWith('/')) {
    fail('herdr_core_peer_argv_untrusted')
  }
  // exe 必须就是 argv[0] 指向的二进制，不能是包装脚本或另一个版本。
  let resolvedArgv: string
  try {
    resolvedArgv = realpathSync(argv[0]!)
  } catch {
    fail('herdr_core_peer_unavailable')
  }
  if (resolvedArgv !== exe) {
    fail('herdr_core_peer_argv_untrusted')
  }
  let environ: Buffer
  try {
    environ = readFileSync(join(base, 'environ'))
  } catch {
    fail('herdr_core_peer_unavailable')
  }
  if (environ.byteLength > ENVIRON_LIMIT) {
    fail('herdr_core_peer_environ_untrusted')
  }
  const declared = environ
    .toString('utf8')
    .split('\0')
    .filter(/** 空项来自末尾分隔符。 */ (entry) => entry.length > 0)
    .filter(/** 只看 HC_SESSION，不保留其它环境变量。 */ (entry) => entry.startsWith('HC_SESSION='))
  if (declared.length > 1) {
    fail('herdr_core_peer_environ_untrusted')
  }
  const declaredSession = declared[0]?.slice('HC_SESSION='.length)
  if (declaredSession !== undefined && declaredSession !== session) {
    fail('herdr_core_peer_session_mismatch')
  }
  return Object.freeze({
    pid: pid as number,
    exe,
    // 直接读 /proc/<pid>/exe：映像被替换或删除后，按路径读到的已经不是正在运行的程序。
    binary_sha256: digestFile(join(base, 'exe')),
    argv: Object.freeze(argv),
    session: declaredSession
  })
}

/**
 * 真正的身份入口：pid 必须来自这条连接的内核 peer（SO_PEERCRED），且属于本用户；
 * 服务端在 server.status 里自报的 pid 只用来与内核值互相印证，不单独成立。
 * 否则同机另一个监听者可以报一个真 core 的 pid，让后面的 exe/argv 核对对着别的进程通过。
 */
export function herdrCorePeerFacts(peer: NativePeer, advertisedPid: unknown, session: string): HerdrCoreProcessFacts {
  if (peer.uid !== process.getuid?.()) {
    fail('herdr_core_peer_uid_mismatch')
  }
  if (advertisedPid !== peer.pid) {
    fail('herdr_core_peer_pid_mismatch')
  }
  return herdrCoreProcessFacts(peer.pid, session)
}

/** 终端标识三元组：core 实例、创建时间与地址；只删 terminals.json 时地址会被复用。 */
export type HerdrCoreTerminalIdentity = Readonly<{
  core_id: string
  created_ms: number
  address: string
}>

/** 地址在同一 core 内永久，但实例重建后会复用，所以不能只用 (core.id, 地址)。 */
export function herdrCoreTerminalIdentity(coreId: unknown, terminal: JsonObject): HerdrCoreTerminalIdentity {
  if (typeof coreId !== 'string' || !/^[a-f0-9]{8,64}$/u.test(coreId)) {
    fail('herdr_core_core_id_invalid')
  }
  const created = terminal.created_ms
  const address = terminal.address
  if (!Number.isSafeInteger(created) || (created as number) < 0) {
    fail('herdr_core_terminal_identity_invalid')
  }
  if (typeof address !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(address)) {
    fail('herdr_core_terminal_identity_invalid')
  }
  return Object.freeze({ core_id: coreId, created_ms: created as number, address })
}
