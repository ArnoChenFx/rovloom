/**
 * 迁移：v9 库就地升级到当前版本，数据不丢；中途失败整体回滚；更旧版本与未来版本仍拒绝。
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
  MIGRATION_FROM_VERSION,
  applyMigration,
  migrationRequired,
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

/** 用真实 v9 schema 建库并写入合成业务行，模拟一台正在使用的线上 Gateway。 */
function legacy(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(historic(9))
    db.prepare('INSERT INTO metadata VALUES(1,?,?,?,?)').run(
      MIGRATION_FROM_VERSION,
      'legacy_generation',
      'active',
      1_000
    )
    db.prepare(
      "INSERT INTO machines(machine_id,name,status,credential_hash,epoch,resource_revision,labels_json,credential_revision) VALUES('machine_legacy','legacy','online',?,'epoch_legacy',4,'[\"kept\"]',3)"
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

test('只有 v9 可以迁移到 v10，更旧版本与未来版本都拒绝', () => {
  assert.equal(MIGRATION_FROM_VERSION, 9)
  assert.equal(SCHEMA_VERSION, 10)
  // v9 需要迁移，当前版本不需要。
  assert.equal(migrationRequired(MIGRATION_FROM_VERSION), true)
  assert.equal(migrationRequired(SCHEMA_VERSION), false)
  // 更旧版本（含曾发布过的 v5-v8）与未来版本都不在迁移范围，仍按原语义拒绝。
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 999]) {
    assert.throws(
      /** 不能迁移的版本必须在任何写操作前拒绝。 */ () => migrationRequired(version),
      /unsupported_database_version/
    )
  }
})

test('v9 库就地升级到 v10，业务数据、原文与期限逐项保留', () => {
  const f = fixture()
  try {
    legacy(f.path)
    const store = new Store(f.path, () => 5_000, { backupDirectory: f.backups })
    try {
      assert.equal(store.generation(), 'legacy_generation')
      const machine = store.machine('machine_legacy')
      assert.equal(machine.name, 'legacy')
      // 启动会把在线设备标为离线，这是既有重启语义，不是迁移造成的。
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
      // 从未上报过平台的旧设备保持"未记录"，不编造平台。
      assert.equal(store.devicePlatform('machine_legacy'), null)
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
      // 用量账本由 v9 触发器维护，迁移不重算也不破坏它。
      assert.deepEqual(
        plain(check.prepare('SELECT content_bytes,result_bytes,reserved_bytes FROM storage_usage').get()!),
        { content_bytes: 30, result_bytes: 7, reserved_bytes: 0 }
      )
      // 迁移审计与业务审计共存，且只带版本、步骤数与副本文件名。
      const migrated = check.prepare("SELECT details FROM audit WHERE action='database_migrated'").all()
      assert.equal(migrated.length, 1)
      assert.deepEqual(JSON.parse(String(migrated[0]!.details)), {
        from: MIGRATION_FROM_VERSION,
        to: SCHEMA_VERSION,
        evidence: `migration-v${MIGRATION_FROM_VERSION}-5000.db`
      })
      assert.equal(check.prepare("SELECT COUNT(*) n FROM audit WHERE action='connected'").get()!.n, 1)
      // 新列存在且旧行为 NULL；既有列值不变。
      assert.equal(
        check.prepare('SELECT platform_json FROM machines WHERE machine_id=?').get('machine_legacy')!.platform_json,
        null
      )
      assert.equal(check.prepare('SELECT credential_revision FROM machines').get()!.credential_revision, 3)
      assert.equal(check.prepare('SELECT labels_json FROM machines').get()!.labels_json, '["kept"]')
    } finally {
      check.close()
    }
  } finally {
    f.close()
  }
})

test('迁移后的结构只比 v9 多出 platform_json 一列，其它对象不变', () => {
  const f = fixture()
  try {
    legacy(f.path)
    const before = describe(new DatabaseSync(f.path, { readOnly: true }))
    new Store(f.path, () => 5_000, { backupDirectory: f.backups }).close()
    const after = describe(new DatabaseSync(f.path, { readOnly: true }))
    // 索引与触发器集合必须完全一致：这一步只加列，不动任何引用结构。
    assert.deepEqual(after.indexes, before.indexes)
    assert.deepEqual(after.triggers, before.triggers)
    const added = after.tables.map(
      /** 逐表对比列定义，找出新增列。 */ (table) => {
        const original = before.tables.find(/** 只按表名匹配同一张表。 */ (entry) => entry.name === table.name)
        assert(original, table.name)
        return {
          name: table.name,
          added: table.columns.filter(
            /** 只保留原表没有的列名。 */ (column) => !original.columns.some((item) => item.name === column.name)
          ),
          removed: original.columns.filter(
            /** 只保留新表丢失的列名。 */ (column) => !table.columns.some((item) => item.name === column.name)
          )
        }
      }
    )
    assert.deepEqual(
      added.filter(/** 只看真正发生变化的表。 */ (entry) => entry.added.length || entry.removed.length),
      [
        {
          name: 'machines',
          added: [{ name: 'platform_json', type: 'TEXT', notnull: 0, dflt: null, pk: 0 }],
          removed: []
        }
      ]
    )
    // 迁移后的结构必须与全新库一致。
    const fresh = new DatabaseSync(':memory:')
    try {
      fresh.exec(SCHEMA)
      assert.deepEqual(after, describe(fresh))
    } finally {
      fresh.close()
    }
  } finally {
    f.close()
  }
})

test('迁移前在固定备份目录留下可回退的 v9 整库副本，并沿用既有配额与登记清理', () => {
  const f = fixture()
  try {
    legacy(f.path)
    const before = new DatabaseSync(f.path, { readOnly: true })
    const expected = {
      machines: before.prepare('SELECT machine_id,name,status,credential_hash,epoch FROM machines').all().map(plain),
      providers: before.prepare('SELECT * FROM providers').all().map(plain),
      calls: before.prepare('SELECT call_id,request_json,response FROM calls').all().map(plain)
    }
    before.close()
    new Store(f.path, () => 5_000, { backupDirectory: f.backups }).close()
    // 副本是固定目录里的普通文件，且登记进 backups 表随原有七天/两份规则过期。
    const files = readdirSync(f.backups)
    assert.deepEqual(files, [`migration-v${MIGRATION_FROM_VERSION}-5000.db`])
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
    // 副本必须仍是 v9、旧数据，可直接打开作为回退依据。
    const snapshot = new DatabaseSync(evidence, { readOnly: true })
    try {
      assert.equal(storedVersion(snapshot), MIGRATION_FROM_VERSION)
      assert.deepEqual(
        snapshot.prepare('SELECT machine_id,name,status,credential_hash,epoch FROM machines').all().map(plain),
        expected.machines
      )
      assert.deepEqual(snapshot.prepare('SELECT * FROM providers').all().map(plain), expected.providers)
      assert.deepEqual(
        snapshot.prepare('SELECT call_id,request_json,response FROM calls').all().map(plain),
        expected.calls
      )
      // 副本里还没有新列，说明它确实是迁移前状态。
      assert.equal(
        snapshot.prepare("SELECT COUNT(*) n FROM pragma_table_info('machines') WHERE name='platform_json'").get()!.n,
        0
      )
    } finally {
      snapshot.close()
    }
  } finally {
    f.close()
  }
})

test('迁移中途失败整体回滚，库保持 v9 与旧数据且不登记半成品副本', () => {
  const f = fixture()
  try {
    legacy(f.path)
    const before = new DatabaseSync(f.path, { readOnly: true })
    const originalCalls = before.prepare('SELECT * FROM calls').all().map(plain)
    before.close()
    // 在真实迁移之后追加一次失败，模拟迁移中途出错。
    const db = new DatabaseSync(f.path)
    try {
      db.exec('BEGIN IMMEDIATE')
      assert.throws(
        /** 迁移失败必须让调用方整体回滚，不能吞掉。 */ () => {
          applyMigration(db)
          throw new Error('synthetic_migration_failure')
        },
        /synthetic_migration_failure/
      )
      db.exec('ROLLBACK')
    } finally {
      db.close()
    }
    const after = new DatabaseSync(f.path, { readOnly: true })
    try {
      // 版本、调用行与列集合都回到迁移前，没有半升级痕迹。
      assert.equal(storedVersion(after), MIGRATION_FROM_VERSION)
      assert.deepEqual(after.prepare('SELECT * FROM calls').all().map(plain), originalCalls)
      assert.equal(
        after.prepare("SELECT COUNT(*) n FROM pragma_table_info('machines') WHERE name='platform_json'").get()!.n,
        0
      )
    } finally {
      after.close()
    }
    // 回滚后同一文件仍能被正常打开并完成迁移。
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
    // 成功后只留本次迁移的一份副本。
    assert.equal(readdirSync(f.backups).length, 1)
  } finally {
    f.close()
  }
})

test('Store 迁移中途失败时清理未登记的副本，库保持 v9 与旧数据', () => {
  const f = fixture()
  try {
    legacy(f.path)
    // 已存在同名副本时迁移在写库前失败：用来验证失败路径不留未登记产物。
    mkdirSync(f.backups, { mode: 0o700 })
    const collision = join(f.backups, `migration-v${MIGRATION_FROM_VERSION}-5000.db`)
    openSync(collision, 'wx', 0o600)
    closeSync(openSync(collision, 'r'))
    assert.throws(
      /** 副本已存在时必须在任何写入前拒绝，不能覆盖既有证据。 */ () =>
        new Store(f.path, () => 5_000, {
          backupDirectory: f.backups
        }),
      /backup_exists/
    )
    const check = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(storedVersion(check), MIGRATION_FROM_VERSION)
      assert.equal(
        check.prepare("SELECT COUNT(*) n FROM pragma_table_info('machines') WHERE name='platform_json'").get()!.n,
        0
      )
      assert.deepEqual(check.prepare('SELECT machine_id,name FROM machines').all().map(plain), [
        { machine_id: 'machine_legacy', name: 'legacy' }
      ])
      assert.equal(check.prepare('PRAGMA quick_check(1)').get()!.quick_check, 'ok')
    } finally {
      check.close()
    }
    // 既有副本原样保留，本次没有额外产物。
    assert.deepEqual(readdirSync(f.backups), [`migration-v${MIGRATION_FROM_VERSION}-5000.db`])
  } finally {
    f.close()
  }
})

test('既有备份占用已超预算时迁移在写副本前拒绝，库保持 v9', () => {
  const f = fixture()
  try {
    legacy(f.path)
    mkdirSync(f.backups, { mode: 0o700 })
    // 备份目录里已有一份超出原备份预算的产物，本次迁移不得再写第二份。
    const filler = join(f.backups, 'synthetic-backup-quota-fill')
    const fd = openSync(filler, 'wx', 0o600)
    try {
      ftruncateSync(fd, 200 * 1_048_576)
    } finally {
      closeSync(fd)
    }
    assert.throws(
      /** 超预算时必须在产生任何副本前失败，且库不被迁移。 */ () =>
        new Store(f.path, () => 5_000, {
          backupDirectory: f.backups
        }),
      /backup_quota|storage_exhausted/
    )
    const check = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(storedVersion(check), MIGRATION_FROM_VERSION)
    } finally {
      check.close()
    }
    // 目录里只有原来的填充文件，没有本次迁移产物。
    assert.deepEqual(readdirSync(f.backups), ['synthetic-backup-quota-fill'])
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

test('比 v9 更旧的版本仍拒绝启动且不写入库文件', () => {
  // v5-v8 都曾发布过，但不在本次迁移范围：一律拒绝，不猜测来源。
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const f = fixture()
    try {
      const db = new DatabaseSync(f.path)
      db.exec(`CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(${version})`)
      db.close()
      chmodSync(f.path, 0o600)
      const before = readFileSync(f.path)
      assert.throws(/** 超出迁移范围的版本不能猜。 */ () => new Store(f.path), /unsupported_database_version/)
      assert.deepEqual(readFileSync(f.path), before)
    } finally {
      f.close()
    }
  }
})

test('离线只读检查只报告需要迁移，不写库、不创建备份目录', () => {
  const f = fixture()
  try {
    legacy(f.path)
    const before = readFileSync(f.path)
    const report = inspectStorage(f.path)
    assert.equal(report.schema, SCHEMA_VERSION)
    assert.equal(report.schema_version, MIGRATION_FROM_VERSION)
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

/**
 * 把库结构投影成可比较的纯数据：表列定义、索引（含部分索引条件）与触发器。
 * 迁移只加列，因此只比较结构语义，不比较 DDL 文本或空白。
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
              /** 只保留结构字段。 */ (column) => ({
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
    .prepare("SELECT name,tbl_name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(
      /** 读取索引的唯一性、列顺序与部分条件。 */ (row) => {
        const name = String(row.name)
        const listed = db
          .prepare(`PRAGMA index_list(${String(row.tbl_name)})`)
          .all()
          .find(/** 找到同名索引项以取得唯一标记。 */ (entry) => entry.name === name)
        return {
          name,
          table: String(row.tbl_name),
          unique: Number(listed?.unique ?? 0),
          partial: Number(listed?.partial ?? 0),
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

test('迁移事务内失败时 backups 登记行一并回滚，不占用备份配额', () => {
  const f = fixture()
  try {
    legacy(f.path)
    // 删掉 audit 表让迁移事务里的 database_migrated 审计写入抛错：
    // 此时副本已写入、迁移已执行，失败点落在 COMMIT 之前。
    const broken = new DatabaseSync(f.path)
    try {
      broken.exec('DROP TABLE audit')
    } finally {
      broken.close()
    }
    assert.throws(
      /** 审计写入失败必须让整个迁移事务回滚。 */ () =>
        new Store(f.path, () => 5_000, {
          backupDirectory: f.backups
        })
    )
    const check = new DatabaseSync(f.path, { readOnly: true })
    try {
      // 版本与结构都回到 v9：没有 platform_json 列。
      assert.equal(storedVersion(check), MIGRATION_FROM_VERSION)
      assert.equal(
        check.prepare("SELECT COUNT(*) n FROM pragma_table_info('machines') WHERE name='platform_json'").get()!.n,
        0
      )
      // 登记行随事务回滚消失，不会永久占用备份数量配额。
      assert.equal(check.prepare('SELECT COUNT(*) n FROM backups').get()!.n, 0)
    } finally {
      check.close()
    }
    // 本次产物已被清理，目录里没有残留副本。
    assert.deepEqual(existsSync(f.backups) ? readdirSync(f.backups) : [], [])
    // 修好触发失败的条件后，同一文件仍能正常打开并完成迁移。
    const repaired = new DatabaseSync(f.path)
    try {
      repaired.exec(
        'CREATE TABLE audit (event_id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL, call_id TEXT, at INTEGER NOT NULL, expires INTEGER NOT NULL, details TEXT NOT NULL)'
      )
      repaired.exec('CREATE INDEX audit_expiry ON audit(expires)')
    } finally {
      repaired.close()
    }
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
      assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM backups').get()!.n, 1)
    } finally {
      upgraded.close()
    }
  } finally {
    f.close()
  }
})
