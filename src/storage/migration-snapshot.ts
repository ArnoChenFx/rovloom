// 迁移前证据：在既有 <state>.backups 边界内导出整库副本，复用原有目录边界、私有权限与备份配额。
import type { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GatewayError } from '../contracts.js'
import { assertBudget } from './budget.js'
import type { Retention } from './config.js'
import { createPrivate, managedBytes, privateFile } from './files.js'
import { assertSnapshotDirectoryBoundary } from './snapshot-directory.js'

/** 迁移前副本固定命名：带源版本与迁移时刻，便于人工判断是哪一次升级的完整状态。 */
export function migrationSnapshotPath(backupDirectory: string, from: number, now: number): string {
  return join(backupDirectory, `migration-v${from}-${now}.db`)
}

/**
 * 用 SQLite 自身的 VACUUM INTO 生成整库一致性副本：不把正文读进进程、不解析凭据，
 * 产物是可直接打开的完整库。目的文件先以 0600 排他创建，再由 SQLite 覆盖写入。
 */
export function writeMigrationSnapshot(source: DatabaseSync, destination: string): void {
  createPrivate(destination)
  let written = false
  try {
    // VACUUM INTO 不接受参数绑定；路径只来自本模块按固定目录与数字拼出的字符串。
    source.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`)
    written = true
  } finally {
    if (!written) {
      try {
        privateFile(destination)
        unlinkSync(destination)
      } catch {
        /* 产物已不存在或已不是普通文件时不再追究清理细节。 */
      }
    }
  }
  const fd = openSync(destination, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 迁移前把整库副本写入固定备份目录，并按既有配额与登记表记账；任何一步失败都让迁移整体不开始。
 * 配额判断复用运行时的 assertBudget：整库副本与目录内既有快照一起计入原备份预算。
 * 返回登记后的绝对路径，供审计与运维定位；不含库内容。
 */
export function recordMigrationSnapshot(
  db: DatabaseSync,
  databasePath: string,
  backupDirectory: string,
  from: number,
  now: number,
  limits: Retention
): string {
  // 目录缺失时按既有私有目录约定新建 0700 目录，不改变已有对象的权限与内容。
  if (!existsSync(backupDirectory)) {
    mkdirSync(backupDirectory, { mode: 0o700 })
  }
  assertSnapshotDirectoryBoundary(backupDirectory)
  const destination = migrationSnapshotPath(backupDirectory, from, now)
  if (existsSync(destination)) {
    throw new GatewayError('backup_exists')
  }
  // 与普通快照同一预检：把本次产物估进原备份预算与总存储预算，超限时不产生任何文件。
  // 旧库还没有 storage_usage 表，此时只核对备份目录与文件本身的物理占用。
  const estimate =
    Number(db.prepare('PRAGMA page_count').get()!.page_count) *
      Number(db.prepare('PRAGMA page_size').get()!.page_size) +
    65_536
  if (hasUsage(db)) {
    assertBudget(db, databasePath, limits, backupDirectory, false, estimate)
  } else {
    assertPhysicalBudget(databasePath, backupDirectory, limits, estimate)
  }
  writeMigrationSnapshot(db, destination)
  // 与普通快照共用同一张登记表和同一份期限/数量清理规则，不新造一套落盘逻辑。
  db.prepare('INSERT INTO backups VALUES(?,?,?)').run(destination, now, now + limits.backup_ttl)
  return destination
}

/** 旧库没有用量账本；只有在当前 schema 上才能按既有 assertBudget 核对逻辑用量。 */
function hasUsage(db: DatabaseSync): boolean {
  return db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name='storage_usage'").get()!.n === 1
}

/**
 * 旧 schema 的物理预检：整库文件、其 sidecar 与备份目录既有占用之和不得超出原备份/总存储预算。
 * 与 assertBudget 使用同一组 limits 字段，不引入第二套阈值。
 */
function assertPhysicalBudget(
  databasePath: string,
  backupDirectory: string,
  limits: Retention,
  estimate: number
): void {
  assertSnapshotDirectoryBoundary(backupDirectory)
  const backupBytes = existsSync(backupDirectory) ? managedBytes(backupDirectory) : 0
  if (backupBytes + estimate > limits.backup_bytes) {
    throw new GatewayError('backup_quota')
  }
  const directory = dirname(databasePath)
  if (managedBytes(directory) + backupBytes + estimate > limits.storage_total_bytes) {
    throw new GatewayError('storage_exhausted')
  }
}

/**
 * 迁移失败后删除本次未登记的副本：只删普通文件，且只在固定备份目录内。
 * 删除失败不影响原错误，也不留下可被误用的"成功迁移"印象。
 */
export function cleanupMigrationSnapshot(path: string): void {
  try {
    privateFile(path)
    unlinkSync(path)
  } catch {
    /* 副本已不存在或已不是普通文件时保留现场，不掩盖迁移失败本身。 */
  }
}

/** 只复核固定目录当前仍是普通目录；只读检查路径不创建目录。 */
export function assertMigrationSnapshotDirectory(backupDirectory: string): void {
  assertSnapshotDirectoryBoundary(backupDirectory)
  if (existsSync(backupDirectory) && !statSync(backupDirectory).isDirectory()) {
    throw new GatewayError('invalid_backup_directory')
  }
}
