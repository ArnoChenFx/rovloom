/** 离线只读存储检查：持有同一写锁阻止并发启动，不构造 Store 或改写业务状态。 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, statfsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { GatewayError } from '../contracts.js'
import { GATEWAY_LOCK_FORMAT } from '../store.js'
import { assertBudget, assertUsage } from './budget.js'
import { DEFAULT_RETENTION } from './config.js'
import { createPrivate, databasePath, managedBytes, syncParentDirectory } from './files.js'
import { lockContent } from './lock-recovery.js'
import { SCHEMA_VERSION } from './schema.js'
import { migrationRequired } from './migration.js'
import { configuredSnapshotDirectory } from './snapshot-directory.js'

/** 报告固定模式、schema、用量和检查结论，不读取原文、凭据或对外返回恢复 generation。 */
export function inspectStorage(input: string) {
  const path = databasePath(input)
  if (!existsSync(path)) {
    throw new GatewayError('storage_missing')
  }
  const lock = path + '.lock'
  try {
    createPrivate(lock, lockContent(GATEWAY_LOCK_FORMAT))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new GatewayError('storage_writer_locked')
    }
    throw error
  }
  const identity = lstatSync(lock)
  /** 检查期间所有者身份不可被替换；只删除本轮独占创建的锁。 */
  function releaseLock(): void {
    const current = lstatSync(lock)
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new GatewayError('storage_lock_changed')
    }
    unlinkSync(lock)
    syncParentDirectory(lock)
  }
  let db: DatabaseSync | undefined
  let transaction = false
  try {
    syncParentDirectory(lock)
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA query_only=ON; BEGIN')
    transaction = true
    const versions = db.prepare('SELECT version,mode FROM metadata').all()
    // 离线检查只读报告是否需要迁移，绝不写库、不建备份目录；旧版本不当作损坏。
    if (versions.length !== 1 || !Number.isSafeInteger(versions[0]!.version)) {
      throw new GatewayError('database_integrity_failed')
    }
    const version = Number(versions[0]!.version)
    // 未来版本与比 v9 更旧的库都不可迁移，只读路径同样明确拒绝。
    const required = migrationRequired(version)
    if (db.prepare('PRAGMA quick_check(1)').get()!.quick_check !== 'ok') {
      throw new GatewayError('database_integrity_failed')
    }
    // 用量与预算只在当前 schema 上可核对；待迁移旧库先报告需迁移，不自行升级。
    if (!required) {
      assertUsage(db)
    }
    const mode = versions[0]!.mode
    if (mode !== 'active' && mode !== 'storage_degraded') {
      throw new GatewayError('database_mode_invalid')
    }
    let quota: string | undefined
    if (!required) {
      try {
        assertBudget(db, path, DEFAULT_RETENTION, configuredSnapshotDirectory(path), true)
      } catch (error) {
        if (
          error instanceof GatewayError &&
          ['content_quota', 'result_quota', 'backup_quota', 'storage_exhausted'].includes(error.code)
        ) {
          quota = error.code
        } else {
          throw error
        }
      }
    }
    const storageMode = mode === 'storage_degraded' || existsSync(path + '.degraded') ? 'storage_degraded' : 'active'
    const fs = statfsSync(dirname(path))
    return Object.freeze({
      schema: SCHEMA_VERSION,
      schema_version: version,
      migration_required: required,
      mode: storageMode,
      integrity: 'ok' as const,
      quota: quota ?? (required ? 'not_checked' : 'ok'),
      read_only: true,
      bytes: managedBytes(dirname(path)),
      free_bytes: fs.bavail * fs.bsize,
      storage_limit_bytes: DEFAULT_RETENTION.storage_total_bytes,
      admission_reserve_bytes: DEFAULT_RETENTION.storage_reserve_bytes,
      healthy: storageMode === 'active' && !quota && !required
    })
  } finally {
    try {
      // 明确结束只读事务；Bun 的连接关闭可能等待已准备语句回收，不能让读锁存活至 GC。
      if (transaction) {
        db!.exec('ROLLBACK')
      }
    } finally {
      db?.close()
    }
    releaseLock()
  }
}
