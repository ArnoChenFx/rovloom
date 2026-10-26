/** 离线运维使用真实 SQLite、同一 writer 和本地 CLI；隔离文件不含任何用户凭据。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  openSync,
  ftruncateSync,
  closeSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Store } from '../../src/store.js'
import { configDocument, configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { runCli } from '../../src/cli/run.js'
import { connected, management, options } from '../storage/helpers.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { snapshotDirectory } from '../../src/storage/snapshot-directory.js'
import { SCHEMA_VERSION } from '../../src/storage/schema.js'

/** 构造分开的状态与备份目录，每个命令都经唯一产品 runCli 分派。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-storage-cli-'))
  const state = join(root, 'state')
  const backup = state + '.backups'
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(backup, { mode: 0o700 })
  const config = join(root, 'gateway.json')
  writeFileSync(
    config,
    JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: state } as GatewayConfig)),
    { mode: 0o600 }
  )
  return {
    root,
    state,
    backup,
    config,
    path: join(state, 'gateway.db'),
    /** 收集固定 JSON 结果，不装配角色或对外 listener。 */
    async run(...args: string[]) {
      const out = new PassThrough()
      const err = new PassThrough()
      let stdout = ''
      let stderr = ''
      out.on(
        'data',
        /** 只保留本用例输出。 */ (value) => {
          stdout += value.toString()
        }
      )
      err.on(
        'data',
        /** 固定诊断不能包含原始异常。 */ (value) => {
          stderr += value.toString()
        }
      )
      const code = await runCli(
        [...args, '--role', 'gateway', '--config', config, '--json'],
        {
          stdin: new PassThrough(),
          stdout: out,
          stderr: err,
          signal: new AbortController().signal
        },
        {}
      )
      assert.equal(stderr, '')
      return { code, data: JSON.parse(stdout), raw: stdout }
    },
    close: /** 只删除本用例的临时状态。 */ () => rmSync(root, { recursive: true, force: true })
  }
}

test('storage check and doctor preserve database bytes and reject missing state, live and unresolved owners', async () => {
  const f = fixture()
  try {
    assert.equal((await f.run('doctor')).data.code, 'storage_missing')
    assert.equal(existsSync(f.path), false)
    const store = new Store(f.path)
    assert.equal((await f.run('storage', 'check')).data.code, 'storage_writer_locked')
    assert.equal((await f.run('storage', 'resume')).data.code, 'storage_writer_locked')
    store.close()
    const before = readFileSync(f.path)
    const check = await f.run('storage', 'check')
    assert.equal(check.code, 0)
    assert.equal(check.data.schema, SCHEMA_VERSION)
    assert.equal(check.data.integrity, 'ok')
    assert.equal(check.data.read_only, true)
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(f.path + '.lock'), false)
    writeFileSync(f.path + '.lock', 'unresolved owner', { mode: 0o600 })
    assert.equal((await f.run('doctor')).data.code, 'storage_writer_locked')
    assert.equal((await f.run('storage', 'resume')).data.code, 'storage_writer_locked')
    assert.equal(readFileSync(f.path + '.lock', 'utf8'), 'unresolved owner')
    assert.deepEqual(readFileSync(f.path), before)
  } finally {
    f.close()
  }
})

test('resume remains degraded above quota, then succeeds through the original audited writer after space is freed', async () => {
  const f = fixture()
  try {
    const failed = new Store(f.path, Date.now, {
      management,
      fault: /** 原事务内模拟 I/O 失败，持久降级标记不能由 CLI 绕过。 */ () => {
        throw new Error('synthetic_io_failure')
      }
    })
    assert.throws(/** 失败事务不能发布设备创建成功。 */ () => failed.register('synthetic'), /storage_degraded/)
    failed.close()
    const initial = readFileSync(f.path)
    const degraded = await f.run('doctor')
    assert.equal(degraded.code, 3)
    assert.equal(degraded.data.mode, 'storage_degraded')
    assert.deepEqual(readFileSync(f.path), initial)
    const filler = join(f.state, 'synthetic-quota-fill')
    const fd = openSync(filler, 'wx', 0o600)
    try {
      ftruncateSync(fd, 512 * 1_048_576)
    } finally {
      closeSync(fd)
    }
    assert.equal((await f.run('storage', 'check')).data.quota, 'storage_exhausted')
    assert.equal((await f.run('storage', 'resume')).code, 3)
    assert.equal(existsSync(f.path + '.degraded'), true)
    rmSync(filler)
    const resumed = await f.run('storage', 'resume')
    assert.equal(resumed.code, 0, JSON.stringify(resumed.data))
    assert.equal(resumed.data.mode, 'active')
    assert.equal(existsSync(f.path + '.degraded'), false)
    assert.equal((await f.run('doctor')).code, 0)
    const db = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM management WHERE action='storage_resume' AND actor='local_storage_cli'")
          .get()!.n,
        1
      )
    } finally {
      db.close()
    }
  } finally {
    f.close()
  }
})

test('backup is an explicitly redacted snapshot and never overwrites or writes into the state directory', async () => {
  const f = fixture()
  try {
    const source = new Store(f.path, Date.now, { management })
    const device = connected(source)
    const call = source.createCall(
      'alice',
      device.target,
      { method: 'ping', params: { private: 'synthetic-private-content' } },
      options()
    )
    source.dispatch('alice', call.call_id, device.epoch)
    source.close()
    const before = readFileSync(f.path)
    const bad = await f.run('storage', 'backup', '--output', join(f.state, 'snapshot.db'))
    assert.equal(bad.data.code, 'separate_backup_directory_required')
    assert.deepEqual(readFileSync(f.path), before)
    const alias = join(f.root, 'state-alias')
    symlinkSync(f.state, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(
      (await f.run('storage', 'backup', '--output', join(alias, 'snapshot.db'))).data.code,
      'separate_backup_directory_required'
    )
    assert.deepEqual(readFileSync(f.path), before)
    const output = join(f.backup, 'snapshot.db')
    const saved = await f.run('storage', 'backup', '--output', output)
    assert.equal(saved.code, 0)
    assert.equal(saved.data.kind, 'redacted_snapshot')
    assert.equal(saved.raw.includes(f.root), false)
    const db = new DatabaseSync(output, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT credential_hash FROM machines').get()!.credential_hash, null)
      assert.equal(db.prepare('SELECT enabled FROM providers').get()!.enabled, 0)
      const row = db.prepare('SELECT request_json,response,state FROM calls').get()!
      assert.equal(row.request_json, null)
      assert.equal(row.response, null)
      assert.equal(row.state, 'outcome_unknown')
    } finally {
      db.close()
    }
    const bytes = readFileSync(output)
    assert.equal((await f.run('storage', 'backup', '--output', output)).data.code, 'backup_exists')
    assert.deepEqual(readFileSync(output), bytes)
  } finally {
    f.close()
  }
})

test('malformed config, corrupt storage and invalid operations fail with bounded JSON without recreating state', async () => {
  const f = fixture()
  try {
    writeFileSync(f.config, '{private-invalid-config', { mode: 0o600 })
    assert.equal((await f.run('doctor')).data.code, 'invalid_config')
    assert.equal(existsSync(f.path), false)
    writeFileSync(
      f.config,
      JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: f.state } as GatewayConfig)),
      { mode: 0o600 }
    )
    writeFileSync(f.path, 'synthetic-private-corruption', { mode: 0o600 })
    const before = readFileSync(f.path)
    const result = await f.run('doctor')
    assert.equal(result.code, 3)
    assert.equal(result.data.code, 'storage_check_failed')
    assert.equal(result.raw.includes('private'), false)
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(f.path + '.lock'), false)
    assert.equal((await f.run('storage', 'sql', '--query', 'private')).data.code, 'invalid_arguments')
  } finally {
    f.close()
  }
})

test('Connector doctor reports incomplete configuration without opening native or creating state', async () => {
  const f = fixture()
  try {
    writeFileSync(f.config, JSON.stringify(configDocument({ ...configTemplate('connector'), state_dir: f.state })), {
      mode: 0o600
    })
    const out = new PassThrough()
    const err = new PassThrough()
    let text = ''
    out.on(
      'data',
      /** 只接收无秘密的诊断对象。 */ (value) => {
        text += value.toString()
      }
    )
    err.resume()
    const result = await runCli(
      ['doctor', '--role', 'connector', '--config', f.config, '--json'],
      {
        stdin: new PassThrough(),
        stdout: out,
        stderr: err,
        signal: new AbortController().signal
      },
      {}
    )
    assert.equal(result, 3)
    assert.deepEqual(JSON.parse(text), {
      ok: false,
      role: 'connector',
      config: 'valid',
      configured: false,
      managed_providers: 0,
      credential_present: false,
      native_checked: false
    })
    assert.equal(existsSync(join(f.state, 'managed')), false)
    assert.equal(existsSync(f.path), false)
  } finally {
    f.close()
  }
})

test('CLI snapshots expire through the normal production Gateway writer after seven days without blocking business cleanup', async () => {
  const f = fixture()
  const unrelated = join(f.root, 'unrelated.db')
  try {
    const source = new Store(f.path, Date.now, { management })
    const device = connected(source)
    const call = source.createCall('alice', device.target, { method: 'ping', params: {} }, options())
    source.close()
    const output = join(f.backup, 'snapshot.db')
    assert.equal((await f.run('storage', 'backup', '--output', output)).code, 0)
    writeFileSync(unrelated, 'outside_the_managed_boundary', { mode: 0o600 })
    let expiry: number
    const before = new DatabaseSync(f.path, { readOnly: true })
    try {
      const row = before.prepare('SELECT created,expires FROM backups').get()!
      expiry = Number(row.expires)
      assert.equal(expiry - Number(row.created), 7 * 86_400_000)
    } finally {
      before.close()
    }
    // 与正式生产装配相同的 openGatewayState；仅时钟推进，不通过 CLI 注入清理目录。
    const running = openGatewayState({ state_directory: f.state, now: () => expiry + 1, changed() {} })
    try {
      running.store.expire()
      assert.equal(existsSync(output), false)
      assert.equal(readFileSync(unrelated, 'utf8'), 'outside_the_managed_boundary')
    } finally {
      running.close()
    }
    const after = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(after.prepare('SELECT count(*) n FROM backups').get()!.n, 0)
      assert.equal(
        after.prepare('SELECT request_json FROM calls WHERE call_id=?').get(call.call_id)!.request_json,
        null
      )
    } finally {
      after.close()
    }
  } finally {
    f.close()
  }
})

test('backup rejects arbitrary directories and fixed-directory symlinks before publishing a snapshot', async () => {
  const f = fixture()
  try {
    new Store(f.path).close()
    const other = join(f.root, 'unmanaged')
    mkdirSync(other, { mode: 0o700 })
    assert.equal(
      (await f.run('storage', 'backup', '--output', join(other, 'snapshot.db'))).data.code,
      'managed_backup_directory_required'
    )
    assert.equal(existsSync(join(other, 'snapshot.db')), false)
    rmSync(f.backup, { recursive: true })
    symlinkSync(other, f.backup, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(
      (await f.run('storage', 'backup', '--output', join(f.backup, 'snapshot.db'))).data.code,
      'invalid_backup_directory'
    )
    assert.equal(existsSync(join(other, 'snapshot.db')), false)
    assert.equal(snapshotDirectory(f.path), f.backup)
  } finally {
    f.close()
  }
})

test('backup reclaims expired snapshot registrations before enforcing the two-snapshot limit', async () => {
  const f = fixture()
  try {
    new Store(f.path).close()
    for (const name of ['first', 'second']) {
      assert.equal((await f.run('storage', 'backup', '--output', join(f.backup, name + '.db'))).code, 0)
    }
    const old = new DatabaseSync(f.path)
    try {
      old.prepare('UPDATE backups SET expires=?').run(Date.now() - 1)
    } finally {
      old.close()
    }
    assert.equal((await f.run('storage', 'backup', '--output', join(f.backup, 'third.db'))).code, 0)
    assert.equal(existsSync(join(f.backup, 'first.db')), false)
    assert.equal(existsSync(join(f.backup, 'second.db')), false)
  } finally {
    f.close()
  }
})

test('read-only storage check includes the fixed snapshot directory in the original backup quota', async () => {
  const f = fixture()
  try {
    new Store(f.path).close()
    const filler = join(f.backup, 'synthetic-backup-quota-fill')
    const fd = openSync(filler, 'wx', 0o600)
    try {
      ftruncateSync(fd, 129 * 1_048_576)
    } finally {
      closeSync(fd)
    }
    const before = readFileSync(f.path)
    const check = await f.run('storage', 'check')
    assert.equal(check.code, 3)
    assert.equal(check.data.quota, 'backup_quota')
    assert.deepEqual(readFileSync(f.path), before)
  } finally {
    f.close()
  }
})

test('removing the fixed snapshot directory does not poison normal Gateway expiry or recreate the directory', async () => {
  const f = fixture()
  try {
    new Store(f.path).close()
    assert.equal((await f.run('storage', 'backup', '--output', join(f.backup, 'snapshot.db'))).code, 0)
    const before = new DatabaseSync(f.path, { readOnly: true })
    const expiry = Number(before.prepare('SELECT expires FROM backups').get()!.expires)
    before.close()
    rmSync(f.backup, { recursive: true })
    const running = openGatewayState({ state_directory: f.state, now: () => expiry + 1, changed() {} })
    try {
      running.store.expire()
      assert.equal(existsSync(f.backup), false)
    } finally {
      running.close()
    }
    const after = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(after.prepare('SELECT count(*) n FROM backups').get()!.n, 0)
    } finally {
      after.close()
    }
  } finally {
    f.close()
  }
})

test('storage check reports a pending migration read-only, then the upgraded database is current', async () => {
  const f = fixture()
  try {
    // 用真实 v9 schema 建库，模拟一台仍在使用当前线上版本的 Gateway。
    const legacy = new DatabaseSync(f.path)
    try {
      legacy.exec(readFileSync(new URL('../fixtures/storage/schema-v9.sql', import.meta.url), 'utf8'))
      legacy.prepare("INSERT INTO metadata VALUES(1,9,'legacy_generation','active',1000)").run()
      legacy
        .prepare(
          "INSERT INTO machines(machine_id,name,status,credential_hash) VALUES('machine_old','old','offline',NULL)"
        )
        .run()
    } finally {
      legacy.close()
    }
    chmodSync(f.path, 0o600)
    const before = readFileSync(f.path)
    const pending = await f.run('storage', 'check')
    // 只读检查不迁移、不建副本目录，并明确报告需要迁移。
    assert.equal(pending.code, 3)
    assert.equal(pending.data.schema, SCHEMA_VERSION)
    assert.equal(pending.data.schema_version, 9)
    assert.equal(pending.data.migration_required, true)
    assert.equal(pending.data.read_only, true)
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(f.backup), true)
    assert.deepEqual(readdirSync(f.backup), [])
    // 真正启动一次 Gateway 后才升级，之后检查回到当前版本且健康。
    new Store(f.path, Date.now, { management }).close()
    const current = await f.run('storage', 'check')
    assert.equal(current.code, 0)
    assert.equal(current.data.schema_version, SCHEMA_VERSION)
    assert.equal(current.data.migration_required, false)
    assert.equal(current.data.healthy, true)
    const upgraded = new DatabaseSync(f.path, { readOnly: true })
    try {
      assert.equal(upgraded.prepare('SELECT name FROM machines WHERE machine_id=?').get('machine_old')!.name, 'old')
    } finally {
      upgraded.close()
    }
  } finally {
    f.close()
  }
})

test('storage check still rejects a future version and leaves the file byte-identical', async () => {
  const f = fixture()
  try {
    const db = new DatabaseSync(f.path)
    db.exec(
      'CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,version INTEGER,mode TEXT,generation TEXT,clock INTEGER)'
    )
    db.exec("INSERT INTO metadata VALUES(1,999,'active','future',1)")
    db.close()
    chmodSync(f.path, 0o600)
    const before = readFileSync(f.path)
    const check = await f.run('storage', 'check')
    assert.equal(check.code, 3)
    assert.equal(check.data.code, 'unsupported_database_version')
    assert.deepEqual(readFileSync(f.path), before)
    assert.equal(existsSync(f.backup), true)
    assert.deepEqual(readdirSync(f.backup), [])
  } finally {
    f.close()
  }
})
