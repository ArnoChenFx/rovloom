/** Luvus Connector 崩溃（kill -9 / 掉电）后的锁恢复：只有证明持有者进程已死才接管，其余一律保持 fail-closed。 */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { listening, ownerIsDead } from '../../../storage/process-identity.js'
import { ownedFile, recordedProcess } from '../../../storage/lock-recovery.js'
import type { ProcessIdentity } from '../../../storage/process-identity.js'
import { nativeRecordStamp, readNativeRecord, removeNativeRecord } from '../../../connector/native-record-files.js'
import { lockOwnerFields, recoverDispatchClaimsLock } from '../../../connector/crash-recovery.js'
import type { LuvusLocalConfig } from '../types.js'

export { lockOwnerFields, recoverDispatchClaimsLock }

export const LUVUS_OWNER_FORMAT = 'rovloom-luvus-owner-v1'

/**
 * root 拥有锁：记录的 Connector 已死，且该会话的 Luvus 端点都无人监听（没有孤儿 server）时才移除。
 * 孤儿 server 仍在监听、锁无身份或证据不确定时返回 false，调用方沿用原 fail-closed。
 */
export async function recoverLuvusOwnerLock(
  ownerLockPath: string,
  config: Pick<LuvusLocalConfig, 'state_root' | 'target'>
): Promise<boolean> {
  if (ownedFile(ownerLockPath) !== true) {
    return false
  }
  let stamp: string
  let recorded: ProcessIdentity | undefined
  try {
    const read = readNativeRecord(ownerLockPath)
    stamp = read.stamp
    recorded = recordedProcess(read.value, LUVUS_OWNER_FORMAT)
  } catch {
    return false
  }
  if (!recorded || !ownerIsDead(recorded)) {
    return false
  }
  const directory = join(config.state_root, 'sessions', config.target.session)
  for (const name of ['luvus.sock', 'luvus-client.sock']) {
    const path = join(directory, name)
    try {
      const info = lstatSync(path)
      if (!info.isSocket() || info.uid !== process.geteuid!() || (await listening(path))) {
        return false
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return false
      }
    }
  }
  try {
    if (nativeRecordStamp(ownerLockPath) !== stamp) {
      return false
    }
    removeNativeRecord(ownerLockPath, stamp)
  } catch {
    return false
  }
  return true
}
