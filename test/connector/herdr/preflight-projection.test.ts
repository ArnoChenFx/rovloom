// Herdr 登记前预检的参数拒绝必须投影为确定未派发（与 Luvus 预检一致）并留下无参数审计。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHerdrGatewayResources } from '../../../src/connector/herdr/provider.js'
import { fixedHerdrSource } from '../../../src/connector/herdr/review.js'
import { NativeRequestPreflightError } from '../../../src/runtime/request-preflight.js'
import { WireError } from '../../../src/wire/index.js'
import { Store } from '../../../src/store.js'
import { connected, management, options } from '../../storage/helpers.js'
import { privateHerdrTestRoot } from './private-root.js'
import { target } from '../../mcp/store-fixture.js'

// 与真实安装同构：官方 schema 文件 + 固定评审来源；本测试不启动任何原生进程。
async function herdrFixture() {
  const root = privateHerdrTestRoot('.herdr-preflight-')
  const schemaPath = join(root, 'schema.json')
  writeFileSync(schemaPath, readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url)), {
    mode: 0o600
  })
  const resource = await createHerdrGatewayResources({
    config: {
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'safe_ref',
      expected_source: fixedHerdrSource(),
      schema_path: schemaPath,
      peer_policy_revision: 'fixture_local'
    },
    now: () => 1_000_000
  })
  return {
    resource,
    async close() {
      await resource.release()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'Herdr 预检的参数拒绝抛 NativeRequestPreflightError，其它 codec 拒绝原样透传',
  /** 缺必填参数（workspace.get 无 workspace_id）与类型错误是登记前确定未派发的客户端错误。 */
  async () => {
    const f = await herdrFixture()
    try {
      const hosted = f.resource.providers[0]!
      const preflight = hosted.preflightRequest!
      for (const request of [
        { method: 'workspace.get', params: {} },
        { method: 'workspace.get', params: { workspace_id: 123 } },
        { method: 'workspace.close', params: {} },
        { method: 'agent.get', params: {} }
      ]) {
        assert.throws(
          () => preflight({ ...request, id: 'synthetic_native' }),
          (error: unknown) => {
            assert(error instanceof NativeRequestPreflightError)
            assert.equal(error.outcome, 'not_dispatched')
            return true
          },
          JSON.stringify(request) + ' 必须收敛为确定未派发的预检拒绝'
        )
      }
      // 参数齐全时预检通过，不抛错。
      preflight({ method: 'workspace.get', params: { workspace_id: 'w1' }, id: 'synthetic_native' })
      // 未评审方法不是参数错误，保持原 WireError 码（由上层按 provider_support_candidate 等既有路径处理）。
      assert.throws(
        () => preflight({ method: 'not.reviewed', params: {}, id: 'synthetic_native' }),
        (error: unknown) => {
          assert(error instanceof WireError)
          assert.notEqual(error.code, 'herdr_native_request_invalid' === error.code ? error.code : '')
          return true
        }
      )
    } finally {
      await f.close()
    }
  }
)

test(
  '预检拒绝回滚登记并在独立事务留下 native_preflight_rejected 审计，不带参数细节',
  /** 生产排查可区分"客户端参数错"与"请求未到达"；审计只含固定码，不落参数、目标或 schema 细节。 */
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-preflight-audit-'))
    const path = join(directory, 'db')
    const store = new Store(path, () => 1_000_000, { management })
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const device = connected(store)
      const call = store.createCall('alice', device.target, { method: 'pane.read' }, options({ timeoutMs: 1000 }))
      // 复用真实 admitCall 预检接缝：preflight 抛 NativeRequestPreflightError 时事务回滚并补审计。
      const failing = () => {
        throw new NativeRequestPreflightError()
      }
      assert.throws(
        () =>
          store.admitCall(
            'alice',
            device.target,
            { method: 'pane.read', params: { pane_id: 'w1:p1' } },
            { ...options(), timeoutMs: undefined, deadline: 1_600_000 } as Parameters<Store['admitCall']>[3],
            undefined,
            failing
          ),
        (error: unknown) => error instanceof NativeRequestPreflightError
      )
      // 登记回滚：没有新调用行；预检拒绝审计恰好一条且只含固定码。
      const calls = db.prepare('SELECT count(*) n FROM calls WHERE call_id!=?').get(call.call_id) as { n: number }
      assert.equal(calls.n, 0, '预检失败不登记调用')
      const events = db.prepare("SELECT actor, details FROM audit WHERE action='native_preflight_rejected'").all() as {
        actor: string
        details: string
      }[]
      assert.equal(events.length, 1)
      assert.equal(events[0]!.actor, 'alice')
      assert.deepEqual(JSON.parse(events[0]!.details), { code: 'native_request_invalid' })
    } finally {
      db.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
