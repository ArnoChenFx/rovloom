// 版本化迁移：只把 v9 库就地升级到 v10，未来版本与更旧版本仍拒绝，全程单事务。
import type { DatabaseSync } from 'node:sqlite'
import { GatewayError } from '../contracts.js'
import { SCHEMA_VERSION } from './schema.js'

/** 唯一可迁移的源版本：v9 是本次 schema bump 的直接前身。 */
export const MIGRATION_FROM_VERSION = 9

// v10 相对 v9 的全部差异：设备最近一次上报的平台。旧行保持 NULL，表示从未记录，不编造平台。
const V9_TO_V10 = 'ALTER TABLE machines ADD COLUMN platform_json TEXT'

// 启动期核对：迁移源版本必须正好是当前版本的前一步，避免发布后才在用户库上发现错位。
if (MIGRATION_FROM_VERSION !== SCHEMA_VERSION - 1) {
  throw new GatewayError('migration_chain_invalid')
}

/** 读取单例元数据版本；缺表、缺行或多行都不是可迁移的旧库，按完整性失败拒绝。 */
export function storedVersion(db: DatabaseSync): number {
  const rows = db.prepare('SELECT version FROM metadata').all()
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]!.version) || (rows[0]!.version as number) < 1) {
    throw new GatewayError('database_integrity_failed')
  }
  return Number(rows[0]!.version)
}

/**
 * 判断给定版本能否就地升级。未来版本必须拒绝并保持文件字节不变，因此这个判断先于任何写操作；
 * 比 v9 更旧的库不在迁移范围内，同样在任何写入前拒绝。
 */
export function migrationRequired(version: number): boolean {
  if (version > SCHEMA_VERSION || version < MIGRATION_FROM_VERSION) {
    throw new GatewayError('unsupported_database_version')
  }
  return version !== SCHEMA_VERSION
}

/**
 * 在调用方已开启的单个事务内把 v9 升到 v10 并推进 metadata 版本。
 * 这一步只新增列，不重建被引用的表，因此不需要关闭外键约束。
 * 任何失败都由调用方整体回滚；这里不吞异常，也不写半升级状态。
 */
export function applyMigration(db: DatabaseSync): void {
  db.exec(V9_TO_V10)
  // 迁移后仍核对引用完整性：不能把断裂的外键带进新版本。
  if (db.prepare('PRAGMA foreign_key_check').all().length) {
    throw new GatewayError('migration_foreign_key_violation')
  }
  db.prepare('UPDATE metadata SET version=?').run(SCHEMA_VERSION)
}
