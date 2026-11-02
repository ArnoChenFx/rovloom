/**
 * `terminal.wait` 省略 `timeout` 的默认值：Gateway 登记前补成显式 60（也是上限）。
 * 补值发生在 normalizeRequest，所以存档、去重键、Wire 帧、Gateway 期限与发给 core 的参数是同一个值；
 * 显式给了值（含 1、60、0.2）一字不动，null/0/负数/字符串/超限原样交给预检拒绝。
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
  HERDR_CORE_REQUEST_MAX_MS,
  HERDR_CORE_WAIT_MAX_SECONDS,
  herdrCoreRequestTimeout
} from '../../../src/connector/herdr-core/methods.js'
import { describeHerdrCoreParams } from '../../../src/connector/herdr-core/overlay.js'
import { createHerdrCoreGatewayResources } from '../../../src/connector/herdr-core/provider.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { hash } from '../../../src/wire/index.js'
import type { ContractSource, V2Target } from '../../../src/wire/types.js'
import type { NativeRequest } from '../../../src/contracts.js'

const OPENRPC = readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
const contract = compileHerdrCoreContract(OPENRPC)

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
  const root = mkdtempSync(join(tmpdir(), 'rovloom-hc-wait-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reference = schemaReference(root, source.schema_sha256)
  mkdirSync(dirname(reference), { mode: 0o700 })
  publishSchema(reference, OPENRPC)
  const resources = await createHerdrCoreGatewayResources({
    config: { version: 1, target, binding_revision: 1, config_ref: 'config-a', expected_source: source, schema_ref: reference },
    now: () => 1000,
    terminalExecution: () => true
  })
  t.after(() => void resources.release())
  const port = resources.providers[0]!
  return { port, resources }
}

/** 端口自己的规范化（Gateway 登记前调用）。 */
function normalize(port: { normalizeRequest?: (request: NativeRequest) => NativeRequest }, request: NativeRequest) {
  assert.equal(typeof port.normalizeRequest, 'function')
  return port.normalizeRequest!(request)
}

test('terminal.wait 省略 timeout 时补成 60；显式值一字不动', async (t) => {
  const { port } = await fixture(t)
  const omitted = normalize(port, { method: 'terminal.wait', params: { terminal: 't1' } })
  assert.deepEqual(omitted, { method: 'terminal.wait', params: { terminal: 't1', timeout: HERDR_CORE_WAIT_MAX_SECONDS } })
  // params 整体省略时也补：先补空对象，再补 timeout。
  assert.deepEqual(normalize(port, { method: 'terminal.wait' }), {
    method: 'terminal.wait',
    params: { timeout: HERDR_CORE_WAIT_MAX_SECONDS }
  })
  // 显式给出的值（1、60、0.2）原样保留。
  for (const timeout of [1, 60, 0.2]) {
    assert.deepEqual(normalize(port, { method: 'terminal.wait', params: { terminal: 't1', timeout } }), {
      method: 'terminal.wait',
      params: { terminal: 't1', timeout }
    })
  }
  // 其它形状原样交给预检：null/0/-1/'5'/61 都不改，由预检拒绝（码不变）。
  for (const timeout of [null, 0, -1, '5', 61]) {
    assert.deepEqual(normalize(port, { method: 'terminal.wait', params: { terminal: 't1', timeout } }), {
      method: 'terminal.wait',
      params: { terminal: 't1', timeout }
    })
  }
})

test('补值只针对 terminal.wait：其它方法的省略语义不变', async (t) => {
  const { port } = await fixture(t)
  const cases: NativeRequest[] = [
    { method: 'terminal.send', params: { terminal: 't1', text: 'x' } },
    { method: 'terminal.send', params: { terminal: 't1', text: 'x', wait: true } },
    { method: 'terminal.run', params: { argv: ['sh'] } },
    { method: 'terminal.run', params: { argv: ['sh'], wait: true } },
    { method: 'terminal.interrupt', params: { terminal: 't1' } },
    { method: 'machine.exec', params: { argv: ['true'], timeout: 5 } },
    { method: 'terminal.read', params: { terminal: 't1' } },
    { method: 'terminal.get', params: { terminal: 't1' } }
  ]
  for (const request of cases) {
    assert.deepEqual(normalize(port, request), request, request.method)
  }
  // 没有 params 的普通方法仍然只是补成 {}。
  assert.deepEqual(normalize(port, { method: 'server.status' }), { method: 'server.status', params: {} })
})

test('补值后的本地期限是本地上限（65000 ms），不再是 5 秒', async (t) => {
  const { port } = await fixture(t)
  // 没有补值时（旧行为）是 5000 ms：这条断言把默认值钉在 60。
  assert.equal(herdrCoreRequestTimeout('terminal.wait', { terminal: 't1' }), HERDR_CORE_REQUEST_MAX_MS)
  const normalized = normalize(port, { method: 'terminal.wait', params: { terminal: 't1' } })
  assert.equal(
    herdrCoreRequestTimeout('terminal.wait', normalized.params as Record<string, unknown>),
    HERDR_CORE_REQUEST_MAX_MS
  )
  assert.equal(HERDR_CORE_REQUEST_MAX_MS, (HERDR_CORE_WAIT_MAX_SECONDS + 5) * 1000)
  assert.equal(HERDR_CORE_REQUEST_MAX_MS, 65_000)
})

test('说明里写的是「省略时默认 60」，schema 带 default 且与常量一致', () => {
  const wait = describeHerdrCoreParams(contract, 'terminal.wait')
  const timeout = (wait.properties as Record<string, Record<string, unknown>>).timeout!
  assert.equal(timeout.default, HERDR_CORE_WAIT_MAX_SECONDS)
  assert.equal(timeout.maximum, HERDR_CORE_WAIT_MAX_SECONDS)
  assert.match(String(timeout.description), /default 60|defaults to 60/u)
  assert.doesNotMatch(String(timeout.description), /outcome_unknown/u)
})
