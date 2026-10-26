// 版本化迁移链：把已发布的旧库按顺序升级到当前 schema，未来版本仍拒绝，全程单事务且不吞掉原文。
import type { DatabaseSync } from 'node:sqlite'
import { GatewayError } from '../contracts.js'
import { SCHEMA_VERSION } from './schema.js'

/**
 * 一次迁移步骤：从 `from` 版本升级到 `from + 1`。
 * `apply` 只能执行本步 schema 变更；调用方已在同一事务内，不得自行 BEGIN/COMMIT。
 */
export type MigrationStep = Readonly<{ from: number; apply(db: DatabaseSync): void }>

/** 已发布版本的下界：v1-v4 从未带用户数据发布，不猜测来源，也不伪造迁移。 */
export const OLDEST_SUPPORTED_VERSION = 5

// v5 → v6：设备凭据签发序号。带缺省值，旧行无需回填，也不改变既有凭据摘要。
const V5_TO_V6: MigrationStep = {
  from: 5,
  apply(db) {
    db.exec('ALTER TABLE machines ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0')
  }
}

// v6 的 calls 表带 history 外键与 (history_epoch,key_digest) 去重键；v7 去掉 history 表，改为按调用方去重。
const CALLS_V7 = `CREATE TABLE calls_migrated (
  call_id TEXT PRIMARY KEY, principal TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES machines,
  provider_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, provider_kind TEXT NOT NULL,
  request_hash TEXT NOT NULL, key_digest TEXT,
  state TEXT NOT NULL, epoch TEXT, attempt_id TEXT, identity_json TEXT NOT NULL,
  binding_json TEXT, target_json TEXT NOT NULL, method TEXT NOT NULL,
  mode TEXT NOT NULL, request_json TEXT, response TEXT,
  created INTEGER NOT NULL, deadline INTEGER NOT NULL, content_expires INTEGER NOT NULL,
  metadata_expires INTEGER NOT NULL, dedup_expires INTEGER NOT NULL,
  content_status TEXT NOT NULL, response_hash TEXT, response_bytes INTEGER,
  response_category TEXT, reserved INTEGER NOT NULL DEFAULT 0,
  UNIQUE(principal,key_digest)
);`

// v6 → v7：删除 history 账本，calls 重建为按调用方去重，并新增配对认领账本。
// 列集合与 v7 一致，逐列显式搬运，旧原文与各层期限原样保留。
const V6_TO_V7: MigrationStep = {
  from: 6,
  apply(db) {
    const columns = [
      'call_id',
      'principal',
      'machine_id',
      'provider_id',
      'binding_revision',
      'provider_kind',
      'request_hash',
      'key_digest',
      'state',
      'epoch',
      'attempt_id',
      'identity_json',
      'binding_json',
      'target_json',
      'method',
      'mode',
      'request_json',
      'response',
      'created',
      'deadline',
      'content_expires',
      'metadata_expires',
      'dedup_expires',
      'content_status',
      'response_hash',
      'response_bytes',
      'response_category',
      'reserved'
    ].join(',')
    db.exec(CALLS_V7)
    db.exec(`INSERT INTO calls_migrated(${columns}) SELECT ${columns} FROM calls ORDER BY call_id`)
    // 旧索引随原表一起删除；先删表再改名，避免同名索引冲突。
    db.exec('DROP TABLE calls')
    db.exec('DROP TABLE history')
    db.exec('ALTER TABLE calls_migrated RENAME TO calls')
    db.exec('CREATE INDEX calls_expiry ON calls(metadata_expires)')
    db.exec(`CREATE TABLE pairing_claims (claim_id TEXT PRIMARY KEY, pairing_id TEXT NOT NULL REFERENCES admin_pairings ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines, secret_hash TEXT NOT NULL, user_code TEXT NOT NULL,
  status TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE UNIQUE INDEX pairing_claims_active ON pairing_claims(pairing_id) WHERE status IN ('pending','approved');`)
  }
}

// v7 → v8：认领记录批准者与原生清单指纹；两者都允许为空，旧认领保持未激活语义。
const V7_TO_V8: MigrationStep = {
  from: 7,
  apply(db) {
    db.exec('ALTER TABLE pairing_claims ADD COLUMN approved_by TEXT')
    db.exec('ALTER TABLE pairing_claims ADD COLUMN native_fingerprint TEXT')
  }
}

// v8 → v9：用量账本、结果/期限索引与六个同事务触发器；用量按现有行重算，不沿用旧计数。
const V8_TO_V9: MigrationStep = {
  from: 8,
  apply(db) {
    db.exec(`CREATE INDEX calls_deadline ON calls(deadline) WHERE state IN ('created','dispatching','connector_accepted');
CREATE INDEX calls_content_expiry ON calls(content_expires) WHERE content_status='available' OR request_json IS NOT NULL OR response IS NOT NULL;
CREATE INDEX calls_dedup_expiry ON calls(dedup_expires);
CREATE INDEX results_expiry ON results(expires);
CREATE TABLE storage_usage (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
  result_bytes INTEGER NOT NULL CHECK(result_bytes>=0),
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0)
);
INSERT INTO storage_usage VALUES(1,0,0,0);
CREATE TRIGGER calls_usage_insert AFTER INSERT ON calls WHEN NEW.request_json IS NOT NULL OR NEW.response IS NOT NULL OR NEW.reserved<>0 BEGIN
  UPDATE storage_usage SET content_bytes=content_bytes+COALESCE(length(CAST(NEW.request_json AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0), reserved_bytes=reserved_bytes+NEW.reserved WHERE singleton=1;
END;
CREATE TRIGGER calls_usage_delete AFTER DELETE ON calls WHEN OLD.request_json IS NOT NULL OR OLD.response IS NOT NULL OR OLD.reserved<>0 BEGIN
  UPDATE storage_usage SET content_bytes=content_bytes-COALESCE(length(CAST(OLD.request_json AS BLOB)),0)-COALESCE(length(CAST(OLD.response AS BLOB)),0), reserved_bytes=reserved_bytes-OLD.reserved WHERE singleton=1;
END;
CREATE TRIGGER calls_usage_update AFTER UPDATE OF request_json,response,reserved ON calls WHEN NEW.request_json IS NOT OLD.request_json OR NEW.response IS NOT OLD.response OR NEW.reserved<>OLD.reserved BEGIN
  UPDATE storage_usage SET content_bytes=content_bytes+COALESCE(length(CAST(NEW.request_json AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0)-COALESCE(length(CAST(OLD.request_json AS BLOB)),0)-COALESCE(length(CAST(OLD.response AS BLOB)),0), reserved_bytes=reserved_bytes+NEW.reserved-OLD.reserved WHERE singleton=1;
END;
CREATE TRIGGER results_usage_insert AFTER INSERT ON results BEGIN
  UPDATE storage_usage SET result_bytes=result_bytes+NEW.bytes WHERE singleton=1;
END;
CREATE TRIGGER results_usage_delete AFTER DELETE ON results BEGIN
  UPDATE storage_usage SET result_bytes=result_bytes-OLD.bytes WHERE singleton=1;
END;
CREATE TRIGGER results_usage_update AFTER UPDATE OF bytes ON results WHEN NEW.bytes<>OLD.bytes BEGIN
  UPDATE storage_usage SET result_bytes=result_bytes+NEW.bytes-OLD.bytes WHERE singleton=1;
END;`)
    // 用量是派生计数：按既有原文与结果句柄重算，避免旧库带进不一致的累计值。
    db.exec(`UPDATE storage_usage SET
  content_bytes=(SELECT COALESCE(SUM(COALESCE(length(CAST(request_json AS BLOB)),0)+COALESCE(length(CAST(response AS BLOB)),0)),0) FROM calls),
  result_bytes=(SELECT COALESCE(SUM(bytes),0) FROM results),
  reserved_bytes=(SELECT COALESCE(SUM(reserved),0) FROM calls)
WHERE singleton=1`)
  }
}

// v9 → v10：设备最近一次上报的平台。旧行保持 NULL，表示从未记录，不编造平台。
const V9_TO_V10: MigrationStep = {
  from: 9,
  apply(db) {
    db.exec('ALTER TABLE machines ADD COLUMN platform_json TEXT')
  }
}

/** 顺序迁移链，只覆盖真正发布过的版本；每一步都必须能从前一步真实产生。 */
export const MIGRATIONS: readonly MigrationStep[] = Object.freeze([V5_TO_V6, V6_TO_V7, V7_TO_V8, V8_TO_V9, V9_TO_V10])

// 启动期核对迁移链覆盖到当前版本且没有重复或断档，避免发布后才在用户库上发现。
function assertChain(): void {
  const oldest: number = OLDEST_SUPPORTED_VERSION
  const current: number = SCHEMA_VERSION
  if (oldest > current) {
    throw new GatewayError('migration_chain_invalid')
  }
  if (MIGRATIONS.length !== current - oldest) {
    throw new GatewayError('migration_chain_invalid')
  }
  for (let index = 0; index < MIGRATIONS.length; index++) {
    if (MIGRATIONS[index]!.from !== oldest + index) {
      throw new GatewayError('migration_chain_invalid')
    }
  }
}
assertChain()

/** 读取单例元数据版本；缺表、缺行或多行都不是可迁移的旧库，按完整性失败拒绝。 */
export function storedVersion(db: DatabaseSync): number {
  const rows = db.prepare('SELECT version FROM metadata').all()
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]!.version) || (rows[0]!.version as number) < 1) {
    throw new GatewayError('database_integrity_failed')
  }
  return Number(rows[0]!.version)
}

/**
 * 判断给定版本能否就地升级：未来版本、从未发布的版本和当前版本分别处理。
 * 未来版本必须拒绝并保持文件字节不变，因此这个判断先于任何写操作。
 */
export function migrationPlan(version: number): readonly MigrationStep[] {
  if (version > SCHEMA_VERSION) {
    throw new GatewayError('unsupported_database_version')
  }
  if (version < OLDEST_SUPPORTED_VERSION) {
    throw new GatewayError('unsupported_database_version')
  }
  return MIGRATIONS.filter(/* 只取当前版本之后的步骤，保证顺序应用且不重复。 */ (step) => step.from >= version)
}

/**
 * 在调用方已开启的单个事务内按序应用迁移，并把 metadata 版本推进到当前版本。
 * 调用方必须先关闭外键约束：重建引用表需要删表，约束开着时 ON DELETE CASCADE 会连带删掉子表行。
 * 任何一步失败都由调用方整体回滚；这里不吞异常，也不写半升级状态。
 */
export function applyMigrations(db: DatabaseSync, plan: readonly MigrationStep[]): void {
  if (Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys) !== 0) {
    throw new GatewayError('migration_constraints_enabled')
  }
  for (const step of plan) {
    step.apply(db)
  }
  // 关闭约束只是为了让重建安全，提交前仍要核对引用完整性，不能把断裂的外键带进新版本。
  if (db.prepare('PRAGMA foreign_key_check').all().length) {
    throw new GatewayError('migration_foreign_key_violation')
  }
  db.prepare('UPDATE metadata SET version=?').run(SCHEMA_VERSION)
}

/** 只读地报告是否需要迁移，供 `storage check` 使用；不写库、不创建目录、不预演步骤。 */
export function migrationStatus(version: number): Readonly<{ required: boolean; from: number; to: number }> {
  return Object.freeze({ required: version !== SCHEMA_VERSION, from: version, to: SCHEMA_VERSION })
}
