// 当前持久化表、管理事务及过期索引；既有数据库按迁移链升级到当前版本，见 migration.ts。
export const SCHEMA_VERSION = 10
// 待发布旧库有校验过的历史迁移链；高于当前版本的未来库仍拒绝，见 migration.ts 与不变量。
export const SCHEMA = `
CREATE TABLE metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
  generation TEXT NOT NULL, mode TEXT NOT NULL, clock INTEGER NOT NULL
);
CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, credential_hash TEXT, epoch TEXT, needs_confirmation INTEGER NOT NULL DEFAULT 0,
  resource_revision INTEGER NOT NULL DEFAULT 1 CHECK(resource_revision>0 AND resource_revision<9007199254740991), labels_json TEXT NOT NULL DEFAULT '[]',
  credential_revision INTEGER NOT NULL DEFAULT 0,
  platform_json TEXT
);
CREATE TABLE enrollments (
  token_hash TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines,
  expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
  pairing_id TEXT REFERENCES admin_pairings ON DELETE CASCADE, pairing_policy_ref TEXT, pairing_generation TEXT
);
CREATE TABLE providers (
  machine_id TEXT NOT NULL REFERENCES machines, provider_id TEXT NOT NULL,
  kind TEXT NOT NULL, config_ref TEXT NOT NULL, binding_revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL, PRIMARY KEY(machine_id,provider_id)
);
CREATE TABLE calls (
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
);
CREATE INDEX calls_expiry ON calls(metadata_expires);
CREATE INDEX calls_deadline ON calls(deadline) WHERE state IN ('created','dispatching','connector_accepted');
CREATE INDEX calls_content_expiry ON calls(content_expires) WHERE content_status='available' OR request_json IS NOT NULL OR response IS NOT NULL;
CREATE INDEX calls_dedup_expiry ON calls(dedup_expires);
CREATE TABLE results (
  result_id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE REFERENCES calls ON DELETE CASCADE,
  bytes INTEGER NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL
);
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
END;
CREATE TABLE audit (
  event_id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL,
  call_id TEXT, at INTEGER NOT NULL, expires INTEGER NOT NULL, details TEXT NOT NULL
);
CREATE INDEX audit_expiry ON audit(expires);
CREATE TABLE backups (path TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE management (confirmation_id TEXT PRIMARY KEY, actor TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, fence TEXT NOT NULL);
CREATE TABLE admin_history (history_epoch TEXT PRIMARY KEY, actor TEXT NOT NULL, session_hash TEXT NOT NULL,
  generation TEXT NOT NULL, policy_digest TEXT NOT NULL, accept_until INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE admin_confirmations (confirmation_id TEXT PRIMARY KEY, history_epoch TEXT NOT NULL REFERENCES admin_history,
  request_id TEXT NOT NULL, operation_digest TEXT NOT NULL, summary TEXT NOT NULL, resource_digest TEXT NOT NULL, impact_json TEXT NOT NULL,
  state TEXT NOT NULL, expires INTEGER NOT NULL, UNIQUE(history_epoch,request_id));
CREATE TABLE admin_operations (history_epoch TEXT NOT NULL REFERENCES admin_history, request_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(history_epoch,request_id));
CREATE TABLE admin_pairings (pairing_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines,
  policy_ref TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL, issued INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pairing_claims (claim_id TEXT PRIMARY KEY, pairing_id TEXT NOT NULL REFERENCES admin_pairings ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines, secret_hash TEXT NOT NULL, user_code TEXT NOT NULL,
  status TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL,
  approved_by TEXT, native_fingerprint TEXT);
CREATE UNIQUE INDEX pairing_claims_active ON pairing_claims(pairing_id) WHERE status IN ('pending','approved');
`
