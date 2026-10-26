// 迁移前证据：在既有 <state>.backups 边界内导出整库副本，复用原有目录边界、私有权限与备份配额。
import type { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GatewayError } from '../contracts.js'
import { assertBudget } from './budget.js'
import type { Retention } from './config.js'
import { privatePath, syncParentDirectory } from './files.js'
import { assertSnapshotDirectoryBoundary, snapshotCleanup } from './snapshot-directory.js'

/** 迁移前副本固定命名：带源版本与迁移时刻，便于人工判断是哪一次升级的完整状态。 */
export function migrationSnapshotPath(backupDirectory: string, from: number, now: number): string {
  return join(backupDirectory, `migration-v${from}-${now}.db`)
}

/**
 * 用 SQLite 自身的 VACUUM INTO 生成整库一致性副本：不把正文读进进程、不解析凭据，
 * 产物是可直接打开的完整库。目的文件先以 0600 排他创建，再由 SQLite 覆盖写入。
 */
export function writeMigrationSnapshot(source: DatabaseSync, destination: string): void {
  privatePath(destination)
  const cleanup = snapshotCleanup(dirname(destination))
  let created = false
  let fd: number | undefined
  try {
    fd = openSync(destination, 'wx', 0o600)
    created = true
    closeSync(fd)
    fd = undefined
    source.prepare('VACUUM INTO ?').run(destination)
    fd = openSync(destination, 'r')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    syncParentDirectory(destination)
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不掩盖原错误，也不妨碍回收本次独占创建的副本。
      }
    }
    if (created) {
      cleanup(destination)
    }
    // SQLite 与文件系统错误都只交付固定码；不删除同名的既有文件。
    throw new GatewayError('migration_snapshot_failed')
  }
}

/**
 * 迁移前把整库副本写入固定备份目录，并按既有配额预检；任何一步失败都让迁移整体不开始。
 * 配额判断复用运行时的 assertBudget：整库副本与目录内既有快照一起计入原备份预算。
 * 这里**不**写 backups 登记行：调用方必须在自己的迁移事务内登记，失败时才能随事务回滚，
 * 否则失败迁移会留下永久占用备份数量配额的孤儿行。
 * 返回路径与锚定原目录身份的清理闭包；回滚不能沿替换后的目录删除别处文件。
 */
export function recordMigrationSnapshot(
  db: DatabaseSync,
  databasePath: string,
  backupDirectory: string,
  from: number,
  now: number,
  limits: Retention
): Readonly<{ path: string; cleanup(): void }> {
  if (Number(db.prepare('SELECT COUNT(*) n FROM backups').get()!.n) >= limits.backup_max_count) {
    throw new GatewayError('backup_count_quota')
  }
  // 目录缺失时按既有私有目录约定新建 0700 目录，不改变已有对象的权限与内容。
  if (!existsSync(backupDirectory)) {
    mkdirSync(backupDirectory, { mode: 0o700 })
    syncParentDirectory(backupDirectory)
  }
  assertSnapshotDirectoryBoundary(backupDirectory)
  const destination = migrationSnapshotPath(backupDirectory, from, now)
  if (existsSync(destination)) {
    throw new GatewayError('backup_exists')
  }
  // 与普通快照同一预检：把本次产物估进原备份预算与总存储预算，超限时不产生任何文件。
  const estimate =
    Number(db.prepare('PRAGMA page_count').get()!.page_count) *
      Number(db.prepare('PRAGMA page_size').get()!.page_size) +
    65_536
  assertBudget(db, databasePath, limits, backupDirectory, false, estimate)
  const cleanup = snapshotCleanup(backupDirectory)
  writeMigrationSnapshot(db, destination)
  return Object.freeze({ path: destination, cleanup: () => cleanup(destination) })
}
