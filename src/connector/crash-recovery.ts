/** provider 中立的崩溃恢复：只有证明持有者进程已死才接管锁，其余一律保持 fail-closed。 */
import { lockOwnerFields, recoverStaleLock } from '../storage/lock-recovery.js'
import { DISPATCH_CLAIMS_LOCK_FORMAT } from './claims.js'

export { lockOwnerFields }

/**
 * claim 账本互斥锁：内容带持有者进程身份且该进程已死，才删除锁（SQLite 回滚日志在下次打开时自行恢复，
 * 账本里的派发墓碑原样保留）。空锁、旧格式或无法判断时返回 false，沿用原 fail-closed。
 */
export function recoverDispatchClaimsLock(lockPath: string): boolean {
  return recoverStaleLock(lockPath, DISPATCH_CLAIMS_LOCK_FORMAT)
}
