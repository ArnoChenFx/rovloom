/** 真实旧 SQLite 账本与文件中断现场：验证布局迁移保留去重、身份及原始 schema。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DispatchClaims } from '../../src/connector/claims.js'
import { migrateConnectorControls, providerControl, providerSetupPath } from '../../src/cli/provider-control.js'
import { hash } from '../../src/wire/index.js'
import type { AttemptBinding } from '../../src/wire/types.js'

function fixture() {
  const directory = mkdtempSync(join(process.cwd(), '.control-migration-'))
  for (const path of ['managed', 'control', 'hr/control']) {
    mkdirSync(join(directory, path), { recursive: true, mode: 0o700 })
  }
  const binding: AttemptBinding = {
    machine_id: 'm1',
    recovery_generation: 'g1',
    connection_epoch: 'e1',
    call_id: 'c1',
    attempt_id: 'a1',
    native_request_id: 'n1',
    provider_kind: 'luvus',
    binding_revision: 1,
    contract_ref: 'a'.repeat(64),
    target: { machine_id: 'm1', provider_id: 'luvus', profile: 'session', session: 'default' },
    registration: { deadline: 500 }
  }
  const old = join(directory, 'control/luvus-claims.db')
  const options = { ledger_id: 'original', limits: { entries: 16, bytes: 262_144 }, now: () => 100 }
  const claims = new DispatchClaims({ ...options, path: old, mode: 'create' })
  claims.claim(binding, 1000)
  claims.close()
  const rawSchema = '{ "raw": true }\n'
  const luvus = { root_record: join(directory, 'control/luvus-root.json'), claims: old, schema_bundle: rawSchema }
  const herdr = {
    claims: join(directory, 'hr/control/claims.db'),
    schema_path: join(directory, 'managed/old-herdr.json')
  }
  for (const [name, value] of [
    ['native-setup', { local: luvus }],
    ['herdr-setup', { local: herdr }],
    ['providers', { providers: [luvus, herdr] }]
  ] as const) {
    writeFileSync(join(directory, 'managed', name + '.json'), JSON.stringify(value), { mode: 0o600 })
  }
  writeFileSync(join(directory, 'managed/device.json'), 'original-device-secret', { mode: 0o600 })
  writeFileSync(join(directory, 'control/luvus-root.json'), 'original-root-identity', { mode: 0o600 })
  writeFileSync(join(directory, 'hr/control/claims.db'), 'herdr-original-ledger', { mode: 0o600 })
  return {
    directory,
    old,
    options,
    binding,
    rawSchema,
    close: () => rmSync(directory, { recursive: true, force: true })
  }
}

test('旧控制记录和 SQLite 搬迁后保留字节、凭据、原 schema 和已 claim attempt，重复启动幂等', () => {
  const f = fixture()
  try {
    const digest = hash(readFileSync(f.old))
    migrateConnectorControls(f.directory)
    const path = join(providerControl(f.directory, 'luvus'), 'claims.db')
    assert.equal(hash(readFileSync(path)), digest)
    assert.equal(readFileSync(join(f.directory, 'managed/device.json'), 'utf8'), 'original-device-secret')
    const setup = JSON.parse(readFileSync(providerSetupPath(f.directory, 'luvus'), 'utf8'))
    assert.equal(setup.local.root_record, join(providerControl(f.directory, 'luvus'), 'root.json'))
    assert.equal(setup.local.schema_bundle, f.rawSchema)
    assert.equal(setup.local.claims, path)
    const reopened = new DispatchClaims({ ...f.options, path, mode: 'open' })
    try {
      assert.throws(() => reopened.claim(f.binding, 1000), /dispatch_already_claimed/)
    } finally {
      reopened.close()
    }
    migrateConnectorControls(f.directory)
    assert.equal(existsSync(f.old), false)
    assert.equal(existsSync(join(f.directory, 'managed/control-migration.json')), false)
  } finally {
    f.close()
  }
})

test('跨 provider 搬迁中断后从 journal 继续，已移动文件和未改写配置不会要求重新配对', () => {
  const f = fixture()
  try {
    const blocker = providerControl(f.directory, 'herdr')
    writeFileSync(blocker, 'block-directory', { mode: 0o600 })
    assert.throws(() => migrateConnectorControls(f.directory))
    assert(existsSync(providerSetupPath(f.directory, 'luvus')))
    assert(existsSync(join(f.directory, 'managed/control-migration.json')))
    rmSync(blocker)
    migrateConnectorControls(f.directory)
    const providers = JSON.parse(readFileSync(join(f.directory, 'managed/providers.json'), 'utf8'))
    assert.equal(providers.providers[0].claims, join(providerControl(f.directory, 'luvus'), 'claims.db'))
    assert.equal(providers.providers[1].claims, join(providerControl(f.directory, 'herdr'), 'claims.db'))
    assert(existsSync(providerSetupPath(f.directory, 'herdr')))
  } finally {
    f.close()
  }
})

test('有活跃账本持有者时在发布 journal 和移动任何控制文件之前拒绝迁移', () => {
  const f = fixture()
  const active = new DispatchClaims({ ...f.options, path: f.old, mode: 'open' })
  try {
    assert.throws(
      () => migrateConnectorControls(f.directory),
      (error: unknown) => (error as { code?: string }).code === 'configuration_required'
    )
    assert(existsSync(f.old))
    assert.equal(existsSync(providerSetupPath(f.directory, 'luvus')), false)
    assert.equal(existsSync(join(f.directory, 'managed/control-migration.json')), false)
  } finally {
    active.close()
    f.close()
  }
})
