/**
 * 登记前预检：被拒的调用必须在产生调用记录之前就给出固定路径/规则，并且与 Wire 编码阶段的拒绝**完全等价**。
 * 全部使用离线 fixture 与合成账本，不启动 core。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import {
  HERDR_CORE_CLASSIFICATION_REVISION,
  HERDR_CORE_SYNTHETIC_METHODS,
  reviewHerdrCoreParams
} from '../../../src/connector/herdr-core/methods.js'
import { createHerdrCoreGatewayResources } from '../../../src/connector/herdr-core/provider.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { NativeRequestPreflightError } from '../../../src/connector/preflight.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { contractRef, hash, object } from '../../../src/wire/index.js'
import type { ContractSource, V2Target } from '../../../src/wire/types.js'
import type { NativeRequest } from '../../../src/contracts.js'

const OPENRPC = readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))

const source: ContractSource = {
  provider_kind: 'herdr-core',
  protocol_family: 'herdr-core-jsonrpc',
  binary_version: '0.1.14',
  binary_sha256: 'a'.repeat(64),
  schema_sha256: hash(OPENRPC),
  schema_origin: 'live_instance',
  schema_command: 'rpc.discover',
  server_version: '0.1.14',
  native_protocol_version: '1',
  runtime_generation: '2ca46c83a83eea75c38e44cf83dbb35d',
  adapter_revision: 'adapter-herdr-core-1',
  classification_revision: HERDR_CORE_CLASSIFICATION_REVISION,
  support_basis: 'schema_and_version'
}

const target: V2Target = { machine_id: 'machine-a', provider_id: 'provider-a', profile: 'session', session: 'work' }

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-hc-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reference = schemaReference(root, source.schema_sha256)
  mkdirSync(dirname(reference), { mode: 0o700 })
  publishSchema(reference, OPENRPC)
  const resources = await createHerdrCoreGatewayResources({
    config: {
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'config-a',
      expected_source: source,
      schema_ref: reference
    },
    now: () => 1000,
    // 参数预检与终端开关是两道独立门禁：这里打开开关，只比较参数规则本身。
    terminalExecution: () => true
  })
  t.after(() => void resources.release())
  const port = resources.providers[0]!
  /** 只观察登记回调是否被调用；真正的 Store 事务在集成测试里覆盖。 */
  const admissions = { registered: 0 }
  function admit(request: NativeRequest) {
    return port.admit(
      request,
      { binding_revision: 1, contract_ref: contractRef(source), deadline: 2000 },
      (_options, check) => {
        check({ ...request, id: 'native-1' })
        // 只有预检通过、真正走到登记时才算一条调用记录。
        admissions.registered++
        return { created: true, call: { call_id: 'call-1' } } as never
      }
    )
  }
  return { port, resources, admissions, admit, reference }
}

test('省略 params 等同空对象：登记前规范成 params:{}', async (t) => {
  const { port } = await fixture(t)
  const normalize = port.normalizeRequest
  assert.equal(typeof normalize, 'function')
  // 省略：补成空对象，其它字段原样保留。
  assert.deepEqual(normalize!({ method: 'server.status' }), { method: 'server.status', params: {} })
  // 显式空对象、非对象与 null 都不改：形状交给预检判断，宿主不猜。
  assert.deepEqual(normalize!({ method: 'server.status', params: {} }), { method: 'server.status', params: {} })
  assert.deepEqual(normalize!({ method: 'server.status', params: null }), { method: 'server.status', params: null })
  assert.deepEqual(normalize!({ method: 'terminal.get', params: { terminal: 't1' } }), {
    method: 'terminal.get',
    params: { terminal: 't1' }
  })
})

test('缺参数、终端名、缺栅栏、null 栅栏都在登记前被拒，且带固定路径与规则', async (t) => {
  const { admit, admissions } = await fixture(t)
  const cases: { method: string; params: Record<string, unknown>; path: string; rule: string }[] = [
    // 控制档的终端必须是裸地址；名字会被 label 改写，machine/t7 属于远端路由。
    {
      method: 'terminal.kill',
      params: { terminal: 'build', core_id: 'abcdef01', created_ms: 5 },
      path: '/terminal',
      rule: 'pattern'
    },
    // 完全没有 terminal 是缺字段，不是格式问题：用户实际踩到的就是这种被误判成别的原因的情形。
    { method: 'terminal.kill', params: { core_id: 'abcdef01', created_ms: 5 }, path: '/terminal', rule: 'required' },
    { method: 'terminal.keys', params: {}, path: '/terminal', rule: 'required' },
    { method: 'terminal.kill', params: { terminal: 't1' }, path: '/core_id', rule: 'required' },
    { method: 'terminal.kill', params: { terminal: 't1', core_id: 'abcdef01' }, path: '/created_ms', rule: 'required' },
    {
      method: 'terminal.kill',
      params: { terminal: 't1', core_id: 'abcdef01', created_ms: null },
      path: '/created_ms',
      rule: 'invalid_value'
    },
    // 被屏蔽的参数不出现在 schema 里，预检也要说清是哪一个。
    { method: 'terminal.get', params: { terminal: 't1', caller: 'x' }, path: '/caller', rule: 'invalid_value' },
    // core 生命周期只接受 core_id 栅栏。
    { method: 'server.stop', params: {}, path: '/core_id', rule: 'required' },
    // 必填参数由 Ajv 报，路径是参数名本身。
    {
      method: 'terminal.send',
      params: { terminal: 't1', core_id: 'abcdef01', created_ms: 5 },
      path: '/text',
      rule: 'required'
    }
  ]
  for (const item of cases) {
    assert.throws(
      () => admit({ method: item.method, params: item.params }),
      (error: unknown) => {
        assert.ok(error instanceof NativeRequestPreflightError, item.method)
        assert.equal(error.code, 'native_request_invalid')
        const issues = error.parameterDiagnostic?.issues ?? []
        assert.ok(
          issues.some((issue) => issue.path === item.path && issue.rule === item.rule),
          `${item.method} ${JSON.stringify(item.params)} → ${JSON.stringify(issues)}`
        )
        // 诊断不含请求值。
        assert.ok(!JSON.stringify(error.parameterDiagnostic).includes('build'))
        return true
      }
    )
  }
  // 预检拒绝发生在登记之前：没有任何调用被登记。
  assert.equal(admissions.registered, 0)
})

test('合法请求照常登记，未被预检放宽', async (t) => {
  const { admit, admissions } = await fixture(t)
  assert.doesNotThrow(() => admit({ method: 'server.status' }))
  assert.doesNotThrow(() => admit({ method: 'terminal.get', params: { terminal: 't1' } }))
  assert.equal(admissions.registered, 2)
})

test('预检与 Wire 编码的拒绝集合完全一致（差分）', async (t) => {
  const { resources, admit } = await fixture(t)
  const contract = compileHerdrCoreContract(OPENRPC)
  // 每个方法 × 一组变异参数：缺字段、错类型、null、名字代替地址、屏蔽参数、超长文本、多余字段。
  const variants: ((params: Record<string, unknown>) => Record<string, unknown>)[] = [
    () => ({}),
    (params) => ({ ...params, terminal: 'build' }),
    (params) => ({ ...params, terminal: 'machine/t1' }),
    (params) => ({ ...params, core_id: '' }),
    (params) => ({ ...params, core_id: 'zzzz' }),
    (params) => ({ ...params, created_ms: -1 }),
    (params) => ({ ...params, created_ms: null }),
    (params) => ({ ...params, created_ms: 1.5 }),
    (params) => ({ ...params, caller: 'x' }),
    (params) => ({ ...params, on: 'other' }),
    (params) => ({ ...params, parent: 't1' }),
    (params) => ({ ...params, unknown_field: 1 }),
    (params) => ({ ...params, text: 'x'.repeat(70_000) }),
    (params) => ({ ...params, lines: 100_000 }),
    (params) => ({ ...params, timeout: 0 }),
    (params) => ({ ...params, timeout: 9999 }),
    (params) => ({ ...params, keys: [] }),
    (params) => ({ ...params, force: true }),
    (params) => ({ ...params, keep: 'yes' }),
    (params) => ({ ...params, name: '../etc/passwd' })
  ]
  const base: Record<string, Record<string, unknown>> = {
    'server.status': {},
    'terminal.get': { terminal: 't1' },
    'terminal.list': {},
    'templates.list': {}
  }
  const methods = resources.describe().methods.map((entry) => entry.method)
  let rejected = 0
  for (const method of methods) {
    const seed = base[method] ?? { terminal: 't1', core_id: 'abcdef01', created_ms: 5 }
    for (const variant of variants) {
      const params = variant(seed)
      // 预检：admit 是否拒绝。
      let preflightError: unknown
      try {
        admit({ method, params })
      } catch (error) {
        preflightError = error
      }
      // Wire 编码：同一套顺序——参数形状、逐方法复核、审核 schema（自有方法不在 core 契约里）。
      let wireError: unknown
      try {
        const checked = object(params)
        reviewHerdrCoreParams(method, checked)
        if (!HERDR_CORE_SYNTHETIC_METHODS.includes(method)) {
          contract.validateParams(method, checked)
        }
      } catch (error) {
        wireError = error
      }
      assert.equal(
        preflightError !== undefined,
        wireError !== undefined,
        `${method} ${JSON.stringify(params)}: preflight=${String(preflightError)} wire=${String(wireError)}`
      )
      if (preflightError !== undefined) {
        assert.ok(
          preflightError instanceof NativeRequestPreflightError,
          `${method} ${JSON.stringify(params)}: 统一成预检错误 → ${String(preflightError)}`
        )
        rejected++
      }
    }
  }
  // 差分矩阵至少覆盖到一批真实拒绝，避免空跑。
  assert.ok(rejected > 50, `rejected=${rejected}`)
})
