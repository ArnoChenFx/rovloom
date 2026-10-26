
CREATE TABLE metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
  generation TEXT NOT NULL, mode TEXT NOT NULL, clock INTEGER NOT NULL
);
CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, credential_hash TEXT, epoch TEXT, needs_confirmation INTEGER NOT NULL DEFAULT 0,
  resource_revision INTEGER NOT NULL DEFAULT 1 CHECK(resource_revision>0 AND resource_revision<9007199254740991), labels_json TEXT NOT NULL DEFAULT '[]',
  credential_revision INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE results (
  result_id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE REFERENCES calls ON DELETE CASCADE,
  bytes INTEGER NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL
);
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
  status TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE UNIQUE INDEX pairing_claims_active ON pairing_claims(pairing_id) WHERE status IN ('pending','approved');
