/**
 * 登记前预检的账本行为：被拒的调用不产生任何调用记录，只留一条固定码审计；
 * 省略 `params` 经端口规范化后与显式 `{}` 是同一个请求（去重键一致）。
 * 使用私有真实 SQLite 与合成 fixture，不启动 core。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { preflightHerdrCoreRequest } from '../../src/connector/herdr-core/preflight.js'
import { compileHerdrCoreContract } from '../../src/connector/herdr-core/schema.js'
import { NativeRequestPreflightError } from '../../src/connector/preflight.js'
import { publishSchema, schemaReference } from '../../src/connector/schema-store.js'
import { Store } from '../../src/store.js'
import { contractRef } from '../../src/wire/index.js'
import { connected, management } from './helpers.js'
import type { CallAdmissionOptions } from '../../src/storage/model.js'
import { hash } from '../../src/wire/index.js'

const OPENRPC = readFileSync(new URL('../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
const contract = compileHerdrCoreContract(OPENRPC)

/** 与生产 Gateway 相同的准入选项：绝对 deadline，没有相对 timeout。 */
function admission(extra: Partial<CallAdmissionOptions> = {}): CallAdmissionOptions {
  return { binding_revision: 1, contract_ref: contractRef(sourceFromFixture()), deadline: 900, ...extra }
}

/** 契约引用取自同一份审核文档；fixture 的 source 只需与登记时一致。 */
function sourceFromFixture() {
  return {
    provider_kind: 'herdr-core' as const,
    protocol_family: 'herdr-core-jsonrpc' as const,
    binary_version: '0.1.14',
    binary_sha256: 'a'.repeat(64),
    schema_sha256: hash(OPENRPC),
    schema_origin: 'live_instance' as const,
    schema_command: 'rpc.discover' as const,
    server_version: '0.1.14',
    native_protocol_version: '1',
    runtime_generation: '2ca46c83a83eea75c38e44cf83dbb35d',
    adapter_revision: 'adapter-herdr-core-1',
    classification_revision: 'herdr-core-tiers-2' as const,
    support_basis: 'schema_and_version' as const
  }
}

/** 与生产端口相同的规范化：省略 `params` 等同 `{}`。 */
function normalize(request: { method: string; params?: unknown }) {
  return request.params === undefined ? { ...request, params: {} } : request
}

function fixture(run: (store: Store, db: DatabaseSync) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-admit-preflight-'))
  // herdr-core 的 provider 只能登记在已发布的契约来源上，这里用同一份审核文档做 fixture。
  const reference = schemaReference(root, hash(OPENRPC))
  mkdirSync(dirname(reference), { mode: 0o700 })
  publishSchema(reference, OPENRPC)
  const store = new Store(join(root, 'db'), () => 100, { management, maintenanceIntervalMs: 60_000 })
  const db = new DatabaseSync(join(root, 'db'), { readOnly: true })
  try {
    const device = connected(store)
    store.defineProvider({
      machine_id: device.target.machine_id,
      provider_id: 'core',
      kind: 'herdr-core',
      config_ref: 'config-a',
      binding_revision: 1,
      enabled: true
    })
    run(store, db)
  } finally {
    db.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('预检拒绝不产生调用记录，只留固定码审计', () =>
  fixture((store, db) => {
    const machine_id = db.prepare('SELECT machine_id FROM machines').get()!.machine_id as string
    const target = { machine_id, provider_id: 'core', profile: 'session' as const, session: 'work' }
    const requests: { method: string; params?: unknown }[] = [
      { method: 'terminal.kill', params: { terminal: 'build', core_id: 'abcdef01', created_ms: 5 } },
      { method: 'terminal.kill', params: { terminal: 't1' } },
      { method: 'server.stop', params: {} }
    ]
    for (const request of requests) {
      assert.throws(
        () =>
          store.admitCall('alice', target, request as never, admission(), undefined, (canonical) =>
            preflightHerdrCoreRequest({
              contract,
              method: String(canonical.method),
              params: (canonical as { params?: unknown }).params
            })
          ),
        (error: unknown) => error instanceof NativeRequestPreflightError
      )
    }
    assert.equal(db.prepare('SELECT count(*) n FROM calls').get()!.n, 0)
    const audits = db.prepare("SELECT details FROM audit WHERE action='native_preflight_rejected'").all()
    assert.equal(audits.length, 3)
    for (const row of audits) {
      assert.equal(JSON.parse(String(row.details)).code, 'native_request_invalid')
      // 审计不含参数值。
      assert.equal(String(row.details).includes('build'), false)
    }
  }))

test('省略 params 规范化后与显式空对象是同一个请求（去重键一致）', () =>
  fixture((store, db) => {
    const machine_id = db.prepare('SELECT machine_id FROM machines').get()!.machine_id as string
    const target = { machine_id, provider_id: 'core', profile: 'session' as const, session: 'work' }
    const key = 'same-request'
    const first = store.admitCall(
      'alice',
      target,
      normalize({ method: 'server.status' }) as never,
      admission({ client_request_key: key }),
      undefined,
      (canonical) =>
        preflightHerdrCoreRequest({
          contract,
          method: String(canonical.method),
          params: (canonical as { params?: unknown }).params
        })
    )
    assert.equal(first.created, true)
    const second = store.admitCall(
      'alice',
      target,
      normalize({ method: 'server.status', params: {} }) as never,
      admission({ client_request_key: key }),
      undefined,
      (canonical) =>
        preflightHerdrCoreRequest({
          contract,
          method: String(canonical.method),
          params: (canonical as { params?: unknown }).params
        })
    )
    assert.equal(second.created, false)
    assert.equal(second.call.call_id, first.call.call_id)
    const row = db.prepare('SELECT request_json FROM calls').get()!
    assert.equal(JSON.parse(String(row.request_json)).params !== undefined, true)
  }))
