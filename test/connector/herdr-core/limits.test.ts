/**
 * 上限的说明与诊断：`runtime_describe` 的 timeout 描述/schema 上限与复核常量一致，
 * 超限被拒时 `parameter_help` 能读到上限（结构化 limits + 固定句子），且不含请求值。
 * 全部使用离线 fixture，不启动 core。
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
  HERDR_CORE_DOC_MAX_BYTES,
  HERDR_CORE_EDIT_MAX_BYTES,
  HERDR_CORE_EVENTS_MAX_LIMIT,
  HERDR_CORE_EVENTS_MAX_TIMEOUT_MS,
  HERDR_CORE_EXEC_MAX_SECONDS,
  HERDR_CORE_FILE_MAX_BASE64,
  HERDR_CORE_KEY_MAX_LENGTH,
  HERDR_CORE_KEYS_MAX,
  HERDR_CORE_LABELS_MAX,
  HERDR_CORE_LABEL_MAX_LENGTH,
  HERDR_CORE_PUT_MAX_BASE64,
  HERDR_CORE_READ_MAX_LINES,
  HERDR_CORE_RUN_MAX_ARGV,
  HERDR_CORE_RUN_MAX_ARGV_BYTES,
  HERDR_CORE_RUN_MAX_ENV,
  HERDR_CORE_RUN_MAX_LINE_BYTES,
  HERDR_CORE_SEND_MAX_BYTES,
  HERDR_CORE_WAIT_MAX_SECONDS
} from '../../../src/connector/herdr-core/methods.js'
import {
  describeHerdrCoreParams,
  HERDR_CORE_LIMITS,
  herdrCoreParameterHelp
} from '../../../src/connector/herdr-core/overlay.js'
import { createHerdrCoreGatewayResources } from '../../../src/connector/herdr-core/provider.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { NativeRequestPreflightError } from '../../../src/connector/preflight.js'
import { preflightHerdrCoreRequest } from '../../../src/connector/herdr-core/preflight.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { contractRef, hash } from '../../../src/wire/index.js'
import type { ContractSource, V2Target } from '../../../src/wire/types.js'

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
  const root = mkdtempSync(join(tmpdir(), 'rovloom-hc-limits-'))
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
    terminalExecution: () => true
  })
  t.after(() => void resources.release())
  const port = resources.providers[0]!
  function admit(request: { method: string; params?: unknown }) {
    return port.admit(
      request,
      { binding_revision: 1, contract_ref: contractRef(source), deadline: 2000 },
      (_options, check) => {
        check({ ...request, id: 'native-1' })
        return { created: true, call: { call_id: 'call-1' } } as never
      }
    )
  }
  return { resources, admit }
}

/** 从被拒的预检里取出 parameter_help。 */
function helpOf(admit: (request: { method: string; params?: unknown }) => unknown, method: string, params: unknown) {
  try {
    admit({ method, params })
  } catch (error) {
    assert.ok(error instanceof NativeRequestPreflightError)
    return error.parameterDiagnostic
  }
  assert.fail(`${method} should have been rejected`)
}

test('五个 timeout 的说明与 schema 上限都来自复核常量', async (t) => {
  const { resources } = await fixture(t)
  const cases: [string, number][] = [
    ['terminal.send', HERDR_CORE_WAIT_MAX_SECONDS],
    ['terminal.wait', HERDR_CORE_WAIT_MAX_SECONDS],
    ['terminal.interrupt', HERDR_CORE_WAIT_MAX_SECONDS],
    ['terminal.run', HERDR_CORE_WAIT_MAX_SECONDS],
    ['machine.exec', HERDR_CORE_EXEC_MAX_SECONDS]
  ]
  for (const [method, cap] of cases) {
    const schema = describeHerdrCoreParams(contract, method)
    const timeout = (schema.properties as Record<string, Record<string, unknown>>).timeout!
    assert.equal(timeout.maximum, cap, method)
    // 描述里写实际规则与上限，不写 core 的 180/600。
    const description = String(timeout.description)
    assert.match(description, new RegExp(`at most ${cap}`, 'u'), method)
    assert.doesNotMatch(description, /180|600/u, method)
    // describe 交付的也是覆盖后的副本。
    const described = resources.catalog.resolve(target, { id: 'alice' })!.describe(method)
    const params = described.params_schema as { properties: Record<string, Record<string, unknown>> }
    assert.equal(params.properties.timeout!.maximum, cap, method)
  }
  // interrupt 的下界是 0，其它是「大于 0」。
  const interrupt = (
    describeHerdrCoreParams(contract, 'terminal.interrupt').properties as Record<string, Record<string, unknown>>
  ).timeout!
  assert.equal(interrupt.minimum, 0)
  const send = (
    describeHerdrCoreParams(contract, 'terminal.send').properties as Record<string, Record<string, unknown>>
  ).timeout!
  assert.equal(send.exclusiveMinimum, 0)
  // 描述副本不改变实际校验：编译后的审核 schema 仍由 contract 决定。
  assert.equal(
    (contract.paramsSchema('terminal.send').properties as Record<string, Record<string, unknown>>).timeout!.maximum,
    undefined
  )
})

test('超限被拒时 parameter_help 能读到上限（结构化 limits + 固定句子）', async (t) => {
  const { admit } = await fixture(t)
  const diagnostic = helpOf(admit, 'terminal.send', {
    terminal: 't1',
    text: 'x',
    wait: true,
    timeout: HERDR_CORE_WAIT_MAX_SECONDS + 1
  })
  assert.deepEqual(diagnostic?.issues, [{ path: '/timeout', rule: 'range' }])
  const help = diagnostic?.parameter_help as { limits?: Record<string, { max: number; unit: string }>; rules: string[] }
  assert.equal(help.limits?.timeout?.max, HERDR_CORE_WAIT_MAX_SECONDS)
  assert.equal(help.limits?.timeout?.unit, 'seconds')
  assert.ok(help.rules.some((line) => line.includes(`at most ${HERDR_CORE_WAIT_MAX_SECONDS}`)))
  // 不含请求值。
  assert.equal(JSON.stringify(diagnostic).includes('"x"'), false)
})

test('每个上限：刚好等于上限通过，上限 + 1 被拒且能读到数值', async (t) => {
  const { admit } = await fixture(t)
  const cases: {
    method: string
    ok: Record<string, unknown>
    over: Record<string, unknown>
    path: string
    field: string
    max: number
  }[] = [
    {
      method: 'terminal.send',
      ok: { terminal: 't1', text: 'x'.repeat(HERDR_CORE_SEND_MAX_BYTES) },
      over: { terminal: 't1', text: 'x'.repeat(HERDR_CORE_SEND_MAX_BYTES + 1) },
      path: '/text',
      field: 'text',
      max: HERDR_CORE_SEND_MAX_BYTES
    },
    {
      method: 'terminal.read',
      ok: { terminal: 't1', lines: HERDR_CORE_READ_MAX_LINES },
      over: { terminal: 't1', lines: HERDR_CORE_READ_MAX_LINES + 1 },
      path: '/lines',
      field: 'lines',
      max: HERDR_CORE_READ_MAX_LINES
    },
    {
      method: 'terminal.keys',
      ok: { terminal: 't1', keys: Array.from({ length: HERDR_CORE_KEYS_MAX }, () => 'enter') },
      over: { terminal: 't1', keys: Array.from({ length: HERDR_CORE_KEYS_MAX + 1 }, () => 'enter') },
      path: '/params',
      field: 'keys',
      max: HERDR_CORE_KEYS_MAX
    },
    {
      method: 'terminal.keys',
      ok: { terminal: 't1', keys: ['a'.repeat(HERDR_CORE_KEY_MAX_LENGTH)] },
      over: { terminal: 't1', keys: ['a'.repeat(HERDR_CORE_KEY_MAX_LENGTH + 1)] },
      path: '/params',
      field: 'key',
      max: HERDR_CORE_KEY_MAX_LENGTH
    },
    {
      method: 'terminal.label',
      ok: {
        terminal: 't1',
        labels: Object.fromEntries(Array.from({ length: HERDR_CORE_LABELS_MAX }, (_, index) => [`k${index}`, 'v']))
      },
      over: {
        terminal: 't1',
        labels: Object.fromEntries(Array.from({ length: HERDR_CORE_LABELS_MAX + 1 }, (_, index) => [`k${index}`, 'v']))
      },
      path: '/params',
      field: 'labels',
      max: HERDR_CORE_LABELS_MAX
    },
    {
      method: 'terminal.put',
      ok: { terminal: 't1', data: 'A'.repeat(HERDR_CORE_PUT_MAX_BASE64), name: 'a.png' },
      over: { terminal: 't1', data: 'A'.repeat(HERDR_CORE_PUT_MAX_BASE64 + 1), name: 'a.png' },
      path: '/data',
      field: 'data',
      max: HERDR_CORE_PUT_MAX_BASE64
    },
    {
      method: 'file.write',
      ok: { path: '/tmp/x', data: 'A'.repeat(HERDR_CORE_FILE_MAX_BASE64) },
      over: { path: '/tmp/x', data: 'A'.repeat(HERDR_CORE_FILE_MAX_BASE64 + 1) },
      path: '/data',
      field: 'data',
      max: HERDR_CORE_FILE_MAX_BASE64
    },
    {
      method: 'file.edit',
      ok: { path: '/tmp/x', edits: Array.from({ length: 1 }, () => ({ old: 'a', new: 'b' })) },
      over: {
        path: '/tmp/x',
        edits: Array.from({ length: 2 }, () => ({ old: 'a'.repeat(HERDR_CORE_EDIT_MAX_BYTES), new: '' }))
      },
      path: '/params',
      field: 'edits_bytes',
      max: HERDR_CORE_EDIT_MAX_BYTES
    },
    {
      method: 'doc.set',
      ok: { name: 'ok', value: 'a'.repeat(HERDR_CORE_DOC_MAX_BYTES - 2), version: 0 },
      over: { name: 'ok', value: 'a'.repeat(HERDR_CORE_DOC_MAX_BYTES), version: 0 },
      path: '/params',
      field: 'value',
      max: HERDR_CORE_DOC_MAX_BYTES
    },
    {
      method: 'machine.exec',
      ok: { argv: ['true'], timeout: HERDR_CORE_EXEC_MAX_SECONDS },
      over: { argv: ['true'], timeout: HERDR_CORE_EXEC_MAX_SECONDS + 1 },
      path: '/timeout',
      field: 'timeout',
      max: HERDR_CORE_EXEC_MAX_SECONDS
    },
    {
      method: 'terminal.run',
      ok: { argv: Array.from({ length: HERDR_CORE_RUN_MAX_ARGV }, () => 'a') },
      over: { argv: Array.from({ length: HERDR_CORE_RUN_MAX_ARGV + 1 }, () => 'a') },
      path: '/params',
      field: 'argv',
      max: HERDR_CORE_RUN_MAX_ARGV
    },
    {
      method: 'terminal.run',
      ok: { line: 'a'.repeat(HERDR_CORE_RUN_MAX_LINE_BYTES) },
      over: { line: 'a'.repeat(HERDR_CORE_RUN_MAX_LINE_BYTES + 1) },
      path: '/params',
      field: 'line',
      max: HERDR_CORE_RUN_MAX_LINE_BYTES
    }
  ]
  for (const item of cases) {
    assert.doesNotThrow(() => admit({ method: item.method, params: item.ok }), `${item.method} at the limit`)
    const diagnostic = helpOf(admit, item.method, item.over)
    assert.ok((diagnostic?.issues ?? []).length > 0, `${item.method} over the limit: ${JSON.stringify(diagnostic)}`)
    const help = diagnostic?.parameter_help as { limits?: Record<string, { max: number }>; rules: string[] }
    assert.equal(help.limits?.[item.field]?.max, item.max, `${item.method} ${item.field}`)
    assert.ok(
      help.rules.some((line) => line.includes(String(item.max))),
      `${item.method} rules should mention ${item.max}: ${JSON.stringify(help.rules)}`
    )
  }
  // argv 的总字节上限也有句子与数值。
  const argvBytes = helpOf(admit, 'terminal.run', {
    argv: Array.from({ length: 2 }, () => 'a'.repeat(HERDR_CORE_RUN_MAX_ARGV_BYTES))
  })
  const help = argvBytes?.parameter_help as { limits?: Record<string, { max: number }> }
  assert.equal(help.limits?.argv_bytes?.max, HERDR_CORE_RUN_MAX_ARGV_BYTES)
  // env 条数。
  assert.equal(HERDR_CORE_LIMITS['machine.exec']!.env!.max ?? 0, HERDR_CORE_RUN_MAX_ENV)
  // 标签值长度。
  assert.equal(HERDR_CORE_LIMITS['terminal.label']!.label!.max, HERDR_CORE_LABEL_MAX_LENGTH)
})

test('每个下界：表里写的 min / exclusiveMin 与真实复核一致（刚好在下界通过，低于下界被拒）', async (t) => {
  const { admit } = await fixture(t)
  const cases: {
    label: string
    method: string
    ok: Record<string, unknown>
    below: Record<string, unknown>
    limit: { method: string; field: string; kind: 'min' | 'exclusiveMin'; value: number }
  }[] = [
    {
      label: 'interrupt.timeout >= 0',
      method: 'terminal.interrupt',
      ok: { terminal: 't1', timeout: 0 },
      below: { terminal: 't1', timeout: -1 },
      limit: { method: 'terminal.interrupt', field: 'timeout', kind: 'min', value: 0 }
    },
    {
      label: 'wait.timeout > 0',
      method: 'terminal.wait',
      ok: { terminal: 't1', timeout: 0.5 },
      below: { terminal: 't1', timeout: 0 },
      limit: { method: 'terminal.wait', field: 'timeout', kind: 'exclusiveMin', value: 0 }
    },
    {
      label: 'send.timeout > 0',
      method: 'terminal.send',
      ok: { terminal: 't1', text: 'x', wait: true, timeout: 0.5 },
      below: { terminal: 't1', text: 'x', wait: true, timeout: 0 },
      limit: { method: 'terminal.send', field: 'timeout', kind: 'exclusiveMin', value: 0 }
    },
    {
      label: 'exec.timeout > 0',
      method: 'machine.exec',
      ok: { argv: ['true'], timeout: 0.5 },
      below: { argv: ['true'], timeout: 0 },
      limit: { method: 'machine.exec', field: 'timeout', kind: 'exclusiveMin', value: 0 }
    },
    {
      label: 'events.limit >= 1',
      method: 'terminal.events',
      ok: { limit: 1 },
      below: { limit: 0 },
      limit: { method: 'terminal.events', field: 'limit', kind: 'min', value: 1 }
    },
    {
      label: 'events.timeout_ms >= 1',
      method: 'terminal.events',
      ok: { timeout_ms: 1 },
      below: { timeout_ms: 0 },
      limit: { method: 'terminal.events', field: 'timeout_ms', kind: 'min', value: 1 }
    },
    {
      label: 'keys count >= 1',
      method: 'terminal.keys',
      ok: { terminal: 't1', keys: ['enter'] },
      below: { terminal: 't1', keys: [] },
      limit: { method: 'terminal.keys', field: 'keys', kind: 'min', value: 1 }
    },
    {
      label: 'edits count >= 1',
      method: 'file.edit',
      ok: { path: '/tmp/x', edits: [{ old: 'a', new: 'b' }] },
      below: { path: '/tmp/x', edits: [] },
      limit: { method: 'file.edit', field: 'edits', kind: 'min', value: 1 }
    }
  ]
  for (const item of cases) {
    // 表里写的下界就是测试断言的下界：表与复核任何一边改了都会红。
    const entry = HERDR_CORE_LIMITS[item.limit.method]![item.limit.field]!
    assert.equal(entry[item.limit.kind], item.limit.value, `${item.label}: table`)
    assert.doesNotThrow(() => admit({ method: item.method, params: item.ok }), `${item.label}: at the bound`)
    const diagnostic = helpOf(admit, item.method, item.below)
    assert.ok((diagnostic?.issues ?? []).length > 0, `${item.label}: below the bound should be rejected`)
  }
})

test('一句话里带两个数的上限句子：两个数都必须来自常量', () => {
  const sentence = (method: string, ...numbers: number[]) => {
    const help = herdrCoreParameterHelp(contract, method) as { rules: string[] }
    return help.rules.some((line) => numbers.every((value) => line.includes(String(value))))
  }
  // keys：条数与单键长度在同一句里。
  assert.ok(sentence('terminal.keys', HERDR_CORE_KEYS_MAX, HERDR_CORE_KEY_MAX_LENGTH), 'keys')
  // labels：条数与值长度。
  assert.ok(sentence('terminal.label', HERDR_CORE_LABELS_MAX, HERDR_CORE_LABEL_MAX_LENGTH), 'labels')
  // argv：条数与总字节。
  assert.ok(sentence('terminal.run', HERDR_CORE_RUN_MAX_ARGV, HERDR_CORE_RUN_MAX_ARGV_BYTES), 'argv')
})

test('没有上限的方法不带 timeout 的上限说明', async (t) => {
  const { admit, resources } = await fixture(t)
  for (const method of ['server.status', 'terminal.get', 'terminal.list', 'templates.list', 'terminal.kill']) {
    const help = herdrCoreParameterHelp(contract, method) as { limits?: unknown; rules: string[] }
    assert.equal(help.limits, undefined, method)
    assert.equal(
      help.rules.some((line) => line.includes('timeout')),
      false,
      method
    )
    const described = resources.catalog.resolve(target, { id: 'alice' })!.describe(method)
    assert.equal(JSON.stringify(described.params_schema).includes('maximum'), false, method)
  }
  // 被拒绝的普通参数里也不该冒出 timeout 的上限（caller 是审核表里一律拒绝的参数）。
  const diagnostic = helpOf(admit, 'terminal.get', { terminal: 't1', caller: 'x' })
  const help = diagnostic?.parameter_help as { limits?: unknown; rules: string[] }
  assert.equal(help.limits, undefined)
  assert.equal(
    help.rules.some((line) => line.includes('timeout')),
    false
  )
})

test('长轮询（自有方法）也交付 limit/timeout_ms 的上限', () => {
  const help = herdrCoreParameterHelp(contract, 'terminal.events') as {
    limits?: Record<string, { max: number }>
    rules: string[]
  }
  assert.equal(help.limits?.limit?.max, HERDR_CORE_EVENTS_MAX_LIMIT)
  assert.equal(help.limits?.timeout_ms?.max, HERDR_CORE_EVENTS_MAX_TIMEOUT_MS)
  assert.ok(help.rules.some((line) => line.includes(String(HERDR_CORE_EVENTS_MAX_TIMEOUT_MS))))
  // 超限仍然按长轮询自己的规则拒绝。
  assert.throws(
    () =>
      preflightHerdrCoreRequest({
        contract,
        method: 'terminal.events',
        params: { timeout_ms: HERDR_CORE_EVENTS_MAX_TIMEOUT_MS + 1 }
      }),
    (error: unknown) => error instanceof NativeRequestPreflightError
  )
})
