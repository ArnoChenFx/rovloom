/** 写锁文件的崩溃恢复：锁内容带持有者进程身份，只有证明持有者已死才删除，其余一律保持 fail-closed。 */
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tryKernelLock } from './file-lock.js'
import { privatePath, syncParentDirectory } from './files.js'
import { currentProcessIdentity, ownerIsDead } from './process-identity.js'
import type { ProcessIdentity } from './process-identity.js'

/** 锁内容里的标记：持有者先取得了内核锁、之后才写入身份，所以它的存活与否以内核锁为准而不是 PID。 */
const KERNEL_LOCK_FIELD = 'kernel_lock'

/** 带本进程身份的锁内容；没有死亡证据的平台写空内容，保持不自动接管的语义。 */
export function lockContent(format: string): string {
  const identity = currentProcessIdentity()
  return identity ? JSON.stringify({ format, process: identity }) : ''
}

/** 带本进程身份的锁字段（用于 JSON 记录）；没有死亡证据的平台返回 undefined。 */
export function lockOwnerFields(): Readonly<{ process: ProcessIdentity }> | undefined {
  const identity = currentProcessIdentity()
  return identity ? Object.freeze({ process: identity }) : undefined
}

/** 解析 owner 身份；格式、字段或类型任何不符都视为无证据。 */
export function recordedProcess(value: unknown, format: string): ProcessIdentity | undefined {
  const record = value as { format?: unknown; process?: { pid?: unknown; start?: unknown } } | null
  if (
    record?.format !== format ||
    !Number.isSafeInteger(record.process?.pid) ||
    (record.process!.pid as number) <= 0 ||
    typeof record.process?.start !== 'string'
  ) {
    return undefined
  }
  return Object.freeze({ pid: record.process.pid as number, start: record.process.start })
}

/** 本用户的普通文件才可能是我们留下的锁；其它类型或归属一律放弃恢复。 */
export function ownedFile(path: string): boolean | undefined {
  try {
    const info = lstatSync(path)
    // Windows 没有 uid：锁所在目录的属主/ACL 已由各账本自己的 protectedPath 核验。
    return info.isFile() && (process.platform === 'win32' || info.uid === process.geteuid!()) ? true : undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined
  }
}

/**
 * 独占创建锁文件，先尽力取得内核锁、再写入持有者身份，返回保持打开的句柄；关闭句柄（或进程退出）即释放内核锁。
 * 先持锁再写内容：别人读到带 kernel_lock 标记的完整内容时，持有者必然已经持锁。
 * 取不到内核锁（非 Linux、文件系统不支持）时不写标记，沿用进程身份证据。
 */
export function createHeldLock(path: string, format: string): number {
  privatePath(path)
  const fd = openSync(path, 'wx', 0o600)
  try {
    const kernel = tryKernelLock(fd)
    if (kernel === 'held') {
      // 刚独占创建的文件不该已被别人加锁；保守按被占用处理。
      throw Object.assign(new Error('lock_held'), { code: 'EEXIST' })
    }
    const identity = currentProcessIdentity()
    writeFileSync(
      fd,
      identity
        ? JSON.stringify({ format, process: identity, ...(kernel === 'acquired' ? { [KERNEL_LOCK_FIELD]: true } : {}) })
        : ''
    )
    fsyncSync(fd)
    return fd
  } catch (error) {
    closeSync(fd)
    // 创建者唯一：写入失败不留下半成品锁。
    try {
      unlinkSync(path)
    } catch {
      /* 保留原始失败。 */
    }
    throw error
  }
}

/** 内核锁无人持有才删除（持锁期间核对路径仍指向同一文件）；查询不了或仍被持有时保守保留。 */
function removeIfUnheld(lockPath: string): boolean {
  let fd: number
  try {
    fd = openSync(lockPath, 'r')
  } catch {
    return false
  }
  try {
    if (tryKernelLock(fd) !== 'acquired') {
      return false
    }
    const held = fstatSync(fd)
    const current = lstatSync(lockPath)
    if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino) {
      return false
    }
    unlinkSync(lockPath)
    syncParentDirectory(lockPath)
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * 互斥锁：持有者已死才删除锁（SQLite 回滚日志在下次打开时自行恢复）。
 * 带 kernel_lock 标记的锁以内核为准：持有者退出（含 SIGKILL）内核即释放，不同 PID 命名空间（容器）里的存活持有者也能被看到，
 * 且 PID 被复用（包括被本进程自己复用）不影响判断。其余锁沿用进程身份证据。
 * 空锁、旧格式、持有者仍存活或无法判断时返回 false，沿用原 fail-closed。
 */
export function recoverStaleLock(lockPath: string, format: string): boolean {
  if (ownedFile(lockPath) !== true) {
    return false
  }
  let record: Record<string, unknown> | null
  try {
    const bytes = readFileSync(lockPath)
    if (bytes.length === 0 || bytes.length > 1024) {
      return false
    }
    record = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> | null
  } catch {
    return false
  }
  const recorded = recordedProcess(record, format)
  if (!recorded) {
    return false
  }
  if (record?.[KERNEL_LOCK_FIELD] === true) {
    return removeIfUnheld(lockPath)
  }
  if (!ownerIsDead(recorded)) {
    return false
  }
  try {
    unlinkSync(lockPath)
    syncParentDirectory(lockPath)
  } catch {
    return false
  }
  return true
}
