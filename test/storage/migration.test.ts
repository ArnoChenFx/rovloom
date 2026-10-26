/**
 * 迁移链：已发布旧库就地升级且数据不丢，中途失败整体回滚，未来版本仍拒绝。
 * 全部使用本地新建的临时库与显式 fixture schema，不接触任何真实用户状态。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { inspectStorage } from '../../src/storage/inspect.js'
import { SCHEMA, SCHEMA_VERSION } from '../../src/storage/schema.js'
import {
  MIGRATIONS,
  OLDEST_SUPPORTED_VERSION,
  applyMigrations,
  migrationPlan,
  migrationStatus,
  storedVersion
} from '../../src/storage/migration.js'
import { snapshotDirectory } from '../../src/storage/snapshot-directory.js'
import { management } from './helpers.js'

/** 读取已冻结的历史 schema 原文；这些字节代表真实发布过的版本，不能凭当前代码猜。 */
function historic(version: number): string {
  return readFileSync(new URL(`../fixtures/storage/schema-v${version}.sql`, import.meta.url), 'utf8')
}

/** node:sqlite 返回 null 原型行；转成普通对象后按字段逐项比较，不比较原型。 */
function plain<T extends object>(row: T): T {
  return { ...row }
}

/**
 * 把库结构投影成可比较的纯数据：表列定义、索引（含部分索引条件）与触发器。
 * 迁移允许重建表，因此只比较结构语义，不比较 DDL 文本或空白。
 */
function describe(db: DatabaseSync) {
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(
      /** 逐表读取列定义。 */ (row) => {
        const name = String(row.name)
        return {
          name,
          columns: db
            .prepare(`PRAGMA table_info(${name})`)
            .all()
            .map(
              /** 只保留结构字段，不比较内部列序号以外的细节。 */ (column) => ({
                name: String(column.name),
                type: String(column.type),
                notnull: Number(column.notnull),
                dflt: column.dflt_value === null ? null : String(column.dflt_value),
                pk: Number(column.pk)
              })
            )
        }
      }
    )
  const indexes = db
    .prepare(
      "SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map(
      /** 读取索引的唯一性、列顺序与部分条件。 */ (row) => {
        const name = String(row.name)
        const columns = db
          .prepare(`PRAGMA index_list(${String(row.tbl_name)})`)
          .all()
          .find(/** 找到同名索引项以取得唯一标记。 */ (entry) => entry.name === name)
        return {
          name,
          table: String(row.tbl_name),
          unique: Number(columns?.unique ?? 0),
          partial: Number(columns?.partial ?? 0),
          columns: db
            .prepare(`PRAGMA index_info(${name})`)
            .all()
            .map(/** 只保留被索引列名。 */ (entry) => String(entry.name))
        }
      }
    )
  const triggers = db
    .prepare("SELECT name,tbl_name FROM sqlite_schema WHERE type='trigger' ORDER BY name")
    .all()
    .map(/** 只保留触发器归属，正文由 usage 校验单独核对。 */ (row) => `${row.tbl_name}:${row.name}`)
  return { tables, indexes, triggers }
}

/** 建立私有临时状态目录，返回库路径与固定备份目录。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-migration-'))
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  return {
    root,
    state,
    path: join(state, 'gateway.db'),
    backups: state + '.backups',
    close: /** 只删除本用例新建的临时目录。 */ () => rmSync(root, { recursive: true, force: true })
  }
}

/** 用真实历史 schema 建库并写入合成业务行，模拟一台正在使用的旧版本 Gateway。 */
function legacy(path: string, version: number): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(historic(version))
    db.prepare('INSERT INTO metadata VALUES(1,?,?,?,?)').run(version, 'legacy_generation', 'active', 1_000)
    db.prepare(
      "INSERT INTO machines(machine_id,name,status,credential_hash,epoch,resource_revision,labels_json) VALUES('machine_legacy','legacy','online',?,'epoch_legacy',4,'[\"kept\"]')"
    ).run('a'.repeat(64))
    db.prepare("INSERT INTO providers VALUES('machine_legacy','provider_legacy','luvus','config_ref',2,1)").run()
    db.prepare(
      `INSERT INTO calls(call_id,principal,machine_id,provider_id,binding_revision,provider_kind,request_hash,key_digest,state,identity_json,target_json,method,mode,request_json,response,created,deadline,content_expires,metadata_expires,dedup_expires,content_status,response_hash,response_bytes,reserved)
       VALUES('call_legacy','alice','machine_legacy','provider_legacy',2,'luvus',?,NULL,'responded','{"kept":true}','{"machine_id":"machine_legacy"}','ping','strict','{"synthetic":1}','{"synthetic":2}',10,20,3_000_000,4_000_000,5_000_000,'available',?,7,0)`
    ).run('b'.repeat(64), 'c'.repeat(64))
    db.prepare("INSERT INTO results VALUES('result_legacy','call_legacy',7,?,6_000_000)").run('d'.repeat(64))
    db.prepare(
      "INSERT INTO audit VALUES('event_legacy','connected','local',NULL,10,1_000_000,'{\"machine_id\":\"machine_legacy\"}')"
    ).run()
  } finally {
    db.close()
  }
  chmodSync(path, 0o600)
}

test('迁移链覆盖每个已发布版本到当前版本，没有断档或重复步骤', () => {
  assert.equal(MIGRATIONS.length, SCHEMA_VERSION - OLDEST_SUPPORTED_VERSION)
  for (let version = OLDEST_SUPPORTED_VERSION; version < SCHEMA_VERSION; version++) {
    assert.deepEqual(
      migrationPlan(version).map((step) => step.from),
      Array.from({ length: SCHEMA_VERSION - version }, (_value, index) => version + index)
    )
  }
  assert.deepEqual(migrationPlan(SCHEMA_VERSION), [])
  assert.equal(migrationStatus(SCHEMA_VERSION).required, false)
  assert.equal(migrationStatus(OLDEST_SUPPORTED_VERSION).required, true)
  // 未发布的 v1-v4 与未来版本都不进入迁移，仍按原语义拒绝。
  for (const version of [1, 2, 3, 4, 999]) {
    assert.throws(
      /** 不能迁移的版本必须在任何写操作前拒绝。 */ () => migrationPlan(version),
      /unsupported_database_version/
    )
  }
})

test('每个已发布旧版本都能就地升级，业务数据、原文与期限逐项保留', { timeout: 60_000 }, () => {
  for (let version = OLDEST_SUPPORTED_VERSION; version < SCHEMA_VERSION; version++) {
    const f = fixture()
    try {
      legacy(f.path, version)
      const store = new Store(f.path, () => 5_000, { backupDirectory: f.backups })
      try {
        assert.equal(store.generation(), 'legacy_generation')
        const machine = store.machine('machine_legacy')
        assert.equal(machine.name, 'legacy')
        assert.equal(machine.status, 'offline')
        assert.deepEqual(store.provider('machine_legacy', 'provider_legacy'), {
          machine_id: 'machine_legacy',
          provider_id: 'provider_legacy',
          kind: 'luvus',
          config_ref: 'config_ref',
          binding_revision: 2,
          enabled: true
        })
        // 调用仍属原调用方且可用；原文与各层期限由下方只读核对逐项比对，迁移不改写它们。
        assert.equal(store.call('alice', 'call_legacy').method, 'ping')
      } finally {
        store.close()
      }
      const check = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(storedVersion(check), SCHEMA_VERSION)
        assert.deepEqual(
          check.prepare('SELECT call_id,request_json,response,content_status FROM calls').all().map(plain),
          [
            {
              call_id: 'call_legacy',
              request_json: '{"synthetic":1}',
              response: '{"synthetic":2}',
              content_status: 'available'
            }
          ]
        )
        assert.deepEqual(check.prepare('SELECT result_id,call_id,bytes FROM results').all().map(plain), [
          { result_id: 'result_legacy', call_id: 'call_legacy', bytes: 7 }
        ])
        // 用量账本按既有行重算：原文 15+15 字节、结果 7 字节。
        assert.deepEqual(
          plain(check.prepare('SELECT content_bytes,result_bytes,reserved_bytes FROM storage_usage').get()!),
          {
            content_bytes: 30,
            result_bytes: 7,
            reserved_bytes: 0
          }
        )
        // 迁移审计与业务审计共存，且只带版本与证据文件名。
        const migrated = check.prepare("SELECT details FROM audit WHERE action='database_migrated'").all()
        assert.equal(migrated.length, 1)
        assert.deepEqual(JSON.parse(String(migrated[0]!.details)), {
          from: version,
          to: SCHEMA_VERSION,
          steps: SCHEMA_VERSION - version,
          evidence: `migration-v${version}-5000.db`
        })
        assert.equal(check.prepare("SELECT COUNT(*) n FROM audit WHERE action='connected'").get()!.n, 1)
        // 新列在旧库上按声明存在，旧行保持"从未记录"，不编造平台。
        assert.equal(
          check.prepare('SELECT platform_json FROM machines WHERE machine_id=?').get('machine_legacy')!.platform_json,
          null
        )
        assert.equal(check.prepare('SELECT credential_revision FROM machines').get()!.credential_revision, 0)
        // 迁移后结构必须与全新库逐列、逐索引、逐触发器一致；DDL 文本可因重建而不同。
        const fresh = new DatabaseSync(':memory:')
        try {
          fresh.exec(SCHEMA)
          assert.deepEqual(describe(check), describe(fresh))
        } finally {
          fresh.close()
        }
      } finally {
        check.close()
      }
    } finally {
      f.close()
    }
  }
})

test('迁移前在固定备份目录留下可回退的整库副本，并沿用既有配额与登记清理', { timeout: 60_000 }, () => {
  const f = fixture()
  try {
    legacy(f.path, OLDEST_SUPPORTED_VERSION)
    const before = new DatabaseSync(f.path, { readOnly: true })
    const expected = {
      machines: before.prepare('SELECT machine_id,name,status,credential_hash,epoch FROM machines').all().map(plain),
      providers: before.prepare('SELECT * FROM providers').all().map(plain),
      calls: before.prepare('SELECT call_id,request_json,response FROM calls').all().map(plain)
    }
    before.close()
    const store = new Store(f.path, () => 5_000, { backupDirectory: f.backups })
    store.close()
    // 副本是固定目录里的普通文件，且登记进 backups 表随原有七天/两份规则过期。
    const files = readdirSync(f.backups)
    assert.deepEqual(files, [`migration-v${OLDEST_SUPPORTED_VERSION}-5000.db`])
    const registered = new DatabaseSync(f.path, { readOnly: true })
    let evidence: string
    try {
      const rows = registered.prepare('SELECT path,created,expires FROM backups').all()
      assert.equal(rows.length, 1)
      evidence = String(rows[0]!.path)
      assert.equal(evidence, join(f.backups, files[0]!))
      assert.equal(rows[0]!.created, 5_000)
      assert.equal(Number(rows[0]!.expires) - 5_000, 7 * 86_400_000)
    } finally {
      registered.close()
    }
    // 副本必须仍是旧版本、旧数据，可直接打开作为回退依据。
    const snapshot = new DatabaseSync(evidence, { readOnly: true })
    try {
      assert.equal(storedVersion(snapshot), OLDEST_SUPPORTED_VERSION)
      assert.deepEqual(
        snapshot.prepare('SELECT machine_id,name,status,credential_hash,epoch FROM machines').all().map(plain),
        expected.machines
      )
      assert.deepEqual(snapshot.prepare('SELECT * FROM providers').all().map(plain), expected.providers)
      assert.deepEqual(
        snapshot.prepare('SELECT call_id,request_json,response FROM calls').all().map(plain),
        expected.calls
      )
    } finally {
      snapshot.close()
    }
  } finally {
    f.close()
  }
})

test('迁移中途失败整体回滚，库保持旧版本、旧数据且不登记半成品副本', { timeout: 60_000 }, () => {
  const f = fixture()
  try {
    legacy(f.path, OLDEST_SUPPORTED_VERSION)
    const before = new DatabaseSync(f.path, { readOnly: true })
    const originalCalls = before.prepare('SELECT * FROM calls').all().map(plain)
    const originalVersion = storedVersion(before)
    before.close()
    // 用真实步骤序列但在最后一步注入失败：模拟迁移链中途报错。
    const failing = MIGRATIONS.map(
      /** 只让最后一步失败，前面的步骤正常执行。 */ (step, index) =>
        index === MIGRATIONS.length - 1
          ? {
              from: step.from,
              apply(db: DatabaseSync): void {
                step.apply(db)
                throw new Error('synthetic_migration_failure')
              }
            }
          : step
    )
    const db = new DatabaseSync(f.path)
    try {
      db.exec('PRAGMA foreign_keys=OFF')
      db.exec('BEGIN IMMEDIATE')
      assert.throws(
        /** 迁移步骤抛错必须让调用方整体回滚，不能吞掉。 */ () => applyMigrations(db, failing),
        /synthetic_migration_failure/
      )
      db.exec('ROLLBACK')
    } finally {
      db.close()
    }
    const after = new DatabaseSync(f.path, { readOnly: true })
    try {
      // 版本、调用行与表集合都回到迁移前，没有半升级痕迹。
      assert.equal(storedVersion(after), originalVersion)
      assert.deepEqual(after.prepare('SELECT * FROM calls').all().map(plain), originalCalls)
      assert.equal(after.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='storage_usage'").get()!.n, 0)
      assert.equal(after.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='pairing_claims'").get()!.n, 0)
    } finally {
      after.close()
    }
    // 回滚后同一文件仍能被正常打开并完成迁移，说明失败没有留下无法恢复的状态。
    const store = new Store(f.path, () => 5_000, { backupDirectory: f.backups })
    try {
      assert.equal(store.generation(), 'legacy_generation')
      assert.equal(store.machine('machine_legacy').name, 'legacy')
    } finally {
      store.close()
    }
    const upgraded = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(storedVersion(upgraded), SCHEMA_VERSION)
    } finally {
      upgraded.close()
    }
    // 成功后只留本次迁移的一份副本，且已登记到 backups 表。
    assert.equal(readdirSync(f.backups).length, 1)
  } finally {
    f.close()
  }
})

test('外键约束未关闭时迁移拒绝执行，不重建引用表也不级联删除子表行', () => {
  const f = fixture()
  try {
    legacy(f.path, 6)
    const db = new DatabaseSync(f.path)
    try {
      db.exec('BEGIN IMMEDIATE')
      assert.throws(
        /** 重建 calls 前必须显式关闭约束，否则拒绝继续。 */ () => applyMigrations(db, migrationPlan(6)),
        /migration_constraints_enabled/
      )
      db.exec('ROLLBACK')
    } finally {
      db.close()
    }
    const check = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(storedVersion(check), 6)
      assert.equal(check.prepare('SELECT COUNT(*) n FROM results').get()!.n, 1)
    } finally {
      check.close()
    }
  } finally {
    f.close()
  }
})

test('未来版本仍拒绝启动并保持库文件字节不变，也不创建迁移副本', () => {
  const f = fixture()
  try {
    const db = new DatabaseSync(f.path)
    db.exec('CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(999)')
    db.close()
    chmodSync(f.path, 0o600)
    const before = readFileSync(f.path)
    assert.throws(/** 未来版本必须在任何写操作前拒绝。 */ () => new Store(f.path), /unsupported_database_version/)
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(snapshotDirectory(f.path)), false)
  } finally {
    f.close()
  }
})

test('未发布的旧版本仍拒绝启动且不写入库文件', () => {
  for (const version of [1, 2, 3, 4]) {
    const f = fixture()
    try {
      const db = new DatabaseSync(f.path)
      db.exec(`CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(${version})`)
      db.close()
      chmodSync(f.path, 0o600)
      const before = readFileSync(f.path)
      assert.throws(
        /** 从未发布的版本没有可核对的迁移来源，不能猜。 */ () => new Store(f.path),
        /unsupported_database_version/
      )
      assert.deepEqual(readFileSync(f.path), before)
    } finally {
      f.close()
    }
  }
})

test('离线只读检查只报告需要迁移，不写库、不创建备份目录', () => {
  const f = fixture()
  try {
    legacy(f.path, OLDEST_SUPPORTED_VERSION)
    const before = readFileSync(f.path)
    const report = inspectStorage(f.path)
    assert.equal(report.schema, SCHEMA_VERSION)
    assert.equal(report.schema_version, OLDEST_SUPPORTED_VERSION)
    assert.equal(report.migration_required, true)
    assert.equal(report.read_only, true)
    assert.equal(report.healthy, false)
    assert.equal(report.quota, 'not_checked')
    // 只读路径不改字节、不建目录、不留锁。
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(f.backups), false)
    assert.equal(existsSync(f.path + '.lock'), false)
  } finally {
    f.close()
  }
})

test('离线只读检查对未来版本明确拒绝，且不写库', () => {
  const f = fixture()
  try {
    const db = new DatabaseSync(f.path)
    db.exec("CREATE TABLE metadata(version INTEGER,mode TEXT); INSERT INTO metadata VALUES(999,'active')")
    db.close()
    chmodSync(f.path, 0o600)
    const before = readFileSync(f.path)
    assert.throws(
      /** 只读检查也不能替未来版本做任何迁移。 */ () => inspectStorage(f.path),
      /unsupported_database_version/
    )
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(f.path + '.lock'), false)
  } finally {
    f.close()
  }
})

test('当前版本的库不触发迁移，不产生副本也不改版本', () => {
  const f = fixture()
  try {
    new Store(f.path, Date.now, { management }).close()
    const before = readFileSync(f.path)
    const store = new Store(f.path, Date.now, { management, backupDirectory: f.backups })
    store.close()
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(f.backups), false)
    const check = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(check.prepare("SELECT COUNT(*) n FROM audit WHERE action='database_migrated'").get()!.n, 0)
    } finally {
      check.close()
    }
  } finally {
    f.close()
  }
})

test('既有备份占用已超预算时迁移在写副本前拒绝，库保持旧版本与旧字节', { timeout: 60_000 }, () => {
  const f = fixture()
  try {
    legacy(f.path, OLDEST_SUPPORTED_VERSION)
    mkdirSync(f.backups, { mode: 0o700 })
    // 备份目录里已有一份超出原备份预算的产物，本次迁移不得再写第二份。
    const filler = join(f.backups, 'synthetic-backup-quota-fill')
    const fd = openSync(filler, 'wx', 0o600)
    try {
      ftruncateSync(fd, 200 * 1_048_576)
    } finally {
      closeSync(fd)
    }
    const before = readFileSync(f.path)
    assert.throws(
      /** 超预算时必须在产生任何副本前失败，且库不被迁移。 */ () =>
        new Store(f.path, () => 5_000, {
          backupDirectory: f.backups
        }),
      /backup_quota|storage_exhausted/
    )
    assert.deepEqual(readFileSync(f.path), before)
    const check = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(storedVersion(check), OLDEST_SUPPORTED_VERSION)
    } finally {
      check.close()
    }
    // 目录里只有原来的填充文件，没有本次迁移产物。
    assert.deepEqual(readdirSync(f.backups), ['synthetic-backup-quota-fill'])
  } finally {
    f.close()
  }
})

test('Store 迁移在中途失败时清理未登记的副本，库保持旧版本与旧数据', { timeout: 60_000 }, () => {
  const f = fixture()
  try {
    // v5 库缺少 history 表：v6→v7 步骤会因此失败，且失败点在副本已写入之后。
    const db = new DatabaseSync(f.path)
    try {
      db.exec(historic(5).replace(/CREATE TABLE history \([\s\S]*?\);/, ''))
      db.prepare("INSERT INTO metadata VALUES(1,5,'legacy_generation','active',1000)").run()
      db.prepare("INSERT INTO machines(machine_id,name,status) VALUES('machine_legacy','legacy','offline')").run()
    } finally {
      db.close()
    }
    chmodSync(f.path, 0o600)
    assert.throws(
      /** 迁移链中途失败必须整体失败，而不是留下半升级库。 */ () =>
        new Store(f.path, () => 5_000, {
          backupDirectory: f.backups
        })
    )
    // 回滚保证逻辑内容回到迁移前：版本、数据与表集合不变。
    // 失败写入事务会让 SQLite 保留更大的文件（含空闲页），因此这里核对内容而不是字节。
    const check = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(storedVersion(check), 5)
      assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='storage_usage'").get()!.n, 0)
      assert.deepEqual(check.prepare('SELECT machine_id,name,status FROM machines').all().map(plain), [
        { machine_id: 'machine_legacy', name: 'legacy', status: 'offline' }
      ])
      assert.equal(check.prepare('PRAGMA quick_check(1)').get()!.quick_check, 'ok')
    } finally {
      check.close()
    }
    // 本次未登记的副本已被清理，不留下可被误认为成功迁移的文件。
    assert.deepEqual(existsSync(f.backups) ? readdirSync(f.backups) : [], [])
  } finally {
    f.close()
  }
})
