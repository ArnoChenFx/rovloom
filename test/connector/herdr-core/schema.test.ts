/** 用 0.1.14 的真实 OpenRPC 文档与真实输出样本核对审核 schema；不启动 core。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { NativeRequestPreflightError } from '../../../src/connector/preflight.js'
import { ProviderAdapterError } from '../../../src/connector/provider-error.js'
import { herdrCoreContractIdentity, compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { reviewHerdrCoreParams } from '../../../src/connector/herdr-core/methods.js'

const OPENRPC = readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
const DOCUMENT = OPENRPC
const SAMPLES = JSON.parse(
  readFileSync(new URL('../../fixtures/herdr-core/samples-0.1.14.json', import.meta.url), 'utf8')
) as { samples: { method: string; params: Record<string, unknown>; response: { result: unknown } }[] }

test('the published 0.1.14 document compiles with reviewed roots only', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  assert.equal(contract.version, '0.1.14')
  assert.equal(contract.methods.length, 32)
  // 参数根由本仓库拼出：只列声明参数且禁止多余字段。
  const params = contract.paramsSchema('terminal.read')
  assert.equal(params.additionalProperties, false)
  assert.deepEqual(params.required, ['terminal'])
})

test('contract identity ignores the version string but follows the contract content', () => {
  const document = JSON.parse(DOCUMENT.toString('utf8')) as Record<string, unknown>
  const before = herdrCoreContractIdentity(document)
  ;(document.info as Record<string, unknown>).version = '9.9.9'
  assert.equal(herdrCoreContractIdentity(document), before)
  ;(document.methods as Record<string, unknown>[])[0]!.description = 'changed'
  assert.notEqual(herdrCoreContractIdentity(document), before)
})

test('every real 0.1.14 sample validates against the reviewed schemas', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  assert.ok(SAMPLES.samples.length >= 5)
  for (const sample of SAMPLES.samples) {
    contract.validateParams(sample.method, sample.params)
    contract.validateResult(sample.method, sample.response.result)
  }
})

test('upstream ListResult requires machines although core omits it: reviewed copy relaxes only that field', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  const schema = contract.resultSchema('terminal.list') as { $ref: string }
  assert.equal(schema.$ref, 'urn:rovloom:herdr-core:schema#/$defs/ListResult')
  const list = SAMPLES.samples.find((sample) => sample.method === 'terminal.list')
  assert.ok(list && !Object.hasOwn(list.response.result as object, 'machines'))
  contract.validateResult('terminal.list', list.response.result)
})

test('results are strict: an undeclared field is a protocol mismatch, not ignored', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  const status = SAMPLES.samples.find((sample) => sample.method === 'server.status')!
  const mutated = { ...(status.response.result as Record<string, unknown>), telemetry: 'on' }
  assert.throws(
    () => contract.validateResult('server.status', mutated),
    (error: unknown) => error instanceof ProviderAdapterError && error.code === 'herdr_core_result_invalid'
  )
})

test('uint8 keeps the native bound while safe integers stay accepted', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  const sample = SAMPLES.samples.find((entry) => entry.method === 'terminal.get')!
  const terminal = structuredClone(sample.response.result) as Record<string, unknown>
  terminal.status = { state: 'working', progress: 255 }
  contract.validateResult('terminal.get', terminal)
  terminal.status = { state: 'working', progress: 256 }
  assert.throws(
    () => contract.validateResult('terminal.get', terminal),
    (error: unknown) => error instanceof ProviderAdapterError && error.code === 'herdr_core_result_invalid'
  )
})

test('screen=inexact after a core crash passes through unchanged', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  const sample = SAMPLES.samples.find((entry) => entry.method === 'terminal.get')!
  const terminal = structuredClone(sample.response.result) as Record<string, unknown>
  terminal.screen = 'inexact'
  const validated = contract.validateResult('terminal.get', terminal)
  // 不把 inexact 改写成 exact，也不当作完整历史。
  assert.equal(validated.screen, 'inexact')
})

test('numbers beyond the safe integer range are refused before schema validation', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  assert.throws(
    () =>
      contract.validateResult('terminal.wait', {
        terminal: 't1',
        ended: false,
        reason: 'timeout',
        turn: 2 ** 53,
        children: []
      }),
    // 有界序列化先拒绝精度损失；两条路径都不接受该值。
    /invalid_integer|herdr_core_result_invalid/u
  )
})

test('blocked parameters are refused before any schema or native call', () => {
  // caller 无认证；on 会把请求转发到远端；lines>0 会让 core 滚动取历史。
  assert.throws(
    () => reviewHerdrCoreParams('terminal.get', { caller: 't2', terminal: 't1' }),
    /herdr_core_param_blocked/u
  )
  // 读历史已开放（≤1000 行），超过上限仍然拒绝。
  assert.doesNotThrow(() => reviewHerdrCoreParams('terminal.read', { terminal: 't1', lines: 5 }))
  assert.throws(
    () => reviewHerdrCoreParams('terminal.read', { terminal: 't1', lines: 1001 }),
    /herdr_core_read_history_exceeds_limit/u
  )
  assert.throws(
    () => reviewHerdrCoreParams('terminal.wait', { terminal: 't1', timeout: 61 }),
    /herdr_core_timeout_exceeds_limit/u
  )
  assert.throws(
    () => reviewHerdrCoreParams('terminal.wait', { terminal: 't1', timeout: 0 }),
    /herdr_core_timeout_invalid/u
  )
  // 其余宿主级方法仍不在开放集合里；terminal.run 已开放，但 parent/caller 一律拒绝。
  assert.throws(() => reviewHerdrCoreParams('machine.list', {}), /herdr_core_method_unavailable/u)
  // machine.exec 必须显式给 timeout；宿主级已经开放。
  assert.throws(() => reviewHerdrCoreParams('machine.exec', { argv: ['sh'] }), /herdr_core_timeout_invalid/u)
  // parent 现在开放，但必须带调用方认定的 parent_created_ms；其它方法仍不接受 parent。
  assert.throws(
    () => reviewHerdrCoreParams('terminal.run', { argv: ['sh'], parent: 't1' }),
    /herdr_core_terminal_fence_required/u
  )
  assert.throws(
    () =>
      reviewHerdrCoreParams('terminal.send', {
        terminal: 't1',
        core_id: 'a'.repeat(16),
        created_ms: 1,
        parent: 't1',
        text: 'x'
      }),
    /herdr_core_param_blocked/u
  )
  assert.throws(
    () => reviewHerdrCoreParams('terminal.send', { terminal: 't1', text: 'x' }),
    /herdr_core_terminal_fence_required/u
  )
  // 本期开放集合内的读取不需要额外开关。
  assert.doesNotThrow(() => reviewHerdrCoreParams('terminal.read', { terminal: 't1', lines: 0 }))
})

test('params diagnostics name a path and a closed rule only', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  try {
    contract.validateParams('terminal.get', { terminal: 5 })
    assert.fail('expected refusal')
  } catch (error) {
    assert.ok(error instanceof NativeRequestPreflightError)
    assert.deepEqual(error.parameterDiagnostic, { issues: [{ path: '/terminal', rule: 'invalid_value' }] })
  }
  try {
    contract.validateParams('server.status', { extra: 1 })
    assert.fail('expected refusal')
  } catch (error) {
    assert.ok(error instanceof NativeRequestPreflightError)
    assert.deepEqual(error.parameterDiagnostic?.issues, [{ path: '/', rule: 'invalid_value' }])
  }
})

test('core 的方法与参数说明保留为注释，超限与控制字符拒绝而不是截断', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  const send = contract.paramsSchema('terminal.send') as {
    properties: Record<string, { description?: string }>
  }
  // core 自己写的说明随参数 schema 交付，控制端才知道 `if`/`timeout` 的语义。
  assert.match(send.properties.if?.description ?? '', /status is exactly this/u)
  assert.match(contract.methodDescription('terminal.send') ?? '', /Paste text and press Enter/u)
  // 没有说明的字段不补造；方法说明来自 core 原文。
  const keys = contract.paramsSchema('terminal.keys') as { properties: Record<string, { description?: string }> }
  assert.equal(keys.properties.caller?.description, undefined)
  assert.match(contract.methodDescription('templates.list') ?? '', /Templates by name and description/u)
  // 说明是注释，不参与校验：多给未知字段仍然拒绝。
  assert.throws(() => contract.validateParams('terminal.send', { terminal: 't1', text: 'x', extra: 1 }))

  const document = JSON.parse(OPENRPC.toString('utf8'))
  const method = document.methods.find((entry: { name: string }) => entry.name === 'terminal.send')
  method.params.find((param: { name: string }) => param.name === 'text').schema.description = 'x'.repeat(2048)
  assert.throws(() => compileHerdrCoreContract(JSON.stringify(document)), /herdr_core_schema_text_invalid/u)

  const control = JSON.parse(OPENRPC.toString('utf8'))
  const withControl = control.methods.find((entry: { name: string }) => entry.name === 'terminal.send')
  withControl.params.find((param: { name: string }) => param.name === 'text').schema.description = 'bell\u0007'
  assert.throws(() => compileHerdrCoreContract(JSON.stringify(control)), /herdr_core_schema_text_invalid/u)

  const huge = JSON.parse(OPENRPC.toString('utf8'))
  for (const entry of huge.methods) {
    for (const param of entry.params ?? []) {
      param.schema.description = 'y'.repeat(1024)
    }
  }
  for (const schema of Object.values(huge.components.schemas) as {
    properties?: Record<string, { description?: string }>
  }[]) {
    for (const property of Object.values(schema.properties ?? {})) {
      // 布尔 schema（true/false）没有属性可写，跳过。
      if (typeof property === 'object' && property !== null) {
        property.description = 'y'.repeat(1024)
      }
    }
  }
  assert.throws(() => compileHerdrCoreContract(JSON.stringify(huge)), /herdr_core_schema_text_too_large/u)
})

test('describe 的参数 schema 没有悬空 $ref，被拒绝的参数不出现在属性里', () => {
  const contract = compileHerdrCoreContract(DOCUMENT)
  const methods = contract.methods
  /** 收集所有 $ref，任何一个都必须能在同一份输出里解析（本仓库就地展开）。 */
  const refs = (value: unknown, found: string[] = []): string[] => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        refs(entry, found)
      }
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key === '$ref' && typeof entry === 'string') {
          found.push(entry)
        } else {
          refs(entry, found)
        }
      }
    }
    return found
  }
  for (const method of methods) {
    const schema = contract.paramsSchema(method)
    assert.deepEqual(refs(schema), [], `${method} has dangling $ref`)
    const properties = (schema as { properties: Record<string, unknown> }).properties
    for (const blocked of ['caller', 'on', 'core', 'calls_you', 'die_with_parent', 'children_of']) {
      assert.equal(Object.hasOwn(properties, blocked), false, `${method} exposes ${blocked}`)
    }
  }
  // 允许值直接可见：send 的 if、wait 的 children。
  const send = contract.paramsSchema('terminal.send') as {
    properties: { if: { anyOf?: { enum?: string[] }[] } }
  }
  assert.deepEqual(send.properties.if.anyOf?.[0]?.enum, ['idle', 'working'])
  const wait = contract.paramsSchema('terminal.wait') as {
    properties: { children: { anyOf?: { enum?: string[] }[] } }
  }
  assert.deepEqual(wait.properties.children.anyOf?.[0]?.enum, ['any', 'all'])
})
