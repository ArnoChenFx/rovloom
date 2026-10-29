/**
 * 内核 advisory 锁（Linux flock）：持有者退出（含 SIGKILL）时由内核释放，且不依赖 PID，
 * 所以共享同一卷的不同容器（各有独立的 PID 命名空间）也能互相看到存活的持有者。
 * 其它平台、非 Bun 运行时与不支持 flock 的文件系统返回 unsupported，由调用方回退到进程身份证据。
 */
import { createRequire } from 'node:module'

export type KernelLockResult = 'acquired' | 'held' | 'unsupported'

type Libc = { symbols: { flock(fd: number, operation: number): number; __errno_location(): number } }
type BunFfi = {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): Libc
  read: { i32(pointer: number): number }
}

const LOCK_EX = 2
const LOCK_NB = 4
// Linux 的 EWOULDBLOCK 与 EAGAIN 同值：锁正被另一个打开的文件描述持有。
const EWOULDBLOCK = 11

let kernel: { ffi: BunFfi; libc: Libc } | null | undefined

/** 延迟加载真实 libc；任何加载失败都按不支持处理，不用合成结果放行。 */
function loadKernel(): { ffi: BunFfi; libc: Libc } | null {
  if (kernel !== undefined) {
    return kernel
  }
  kernel = null
  if (process.platform === 'linux' && process.versions.bun) {
    try {
      const ffi = createRequire(import.meta.url)('bun:ffi') as BunFfi
      const libc = ffi.dlopen('libc.so.6', {
        flock: { args: ['int', 'int'], returns: 'int' },
        __errno_location: { args: [], returns: 'ptr' }
      })
      kernel = { ffi, libc }
    } catch {
      kernel = null
    }
  }
  return kernel
}

/**
 * 对已打开的文件句柄非阻塞地取得独占内核锁；锁随该句柄关闭或进程退出释放。
 * held 只表示别的打开文件描述正持有它；ENOLCK、EOPNOTSUPP 等无法判断的失败一律是 unsupported，不当作“无人持有”。
 */
export function tryKernelLock(fd: number): KernelLockResult {
  const loaded = loadKernel()
  if (!loaded) {
    return 'unsupported'
  }
  try {
    if (loaded.libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
      return 'acquired'
    }
    // 失败后立即读取线程 errno，不插入其它调用。
    return loaded.ffi.read.i32(loaded.libc.symbols.__errno_location()) === EWOULDBLOCK ? 'held' : 'unsupported'
  } catch {
    return 'unsupported'
  }
}
