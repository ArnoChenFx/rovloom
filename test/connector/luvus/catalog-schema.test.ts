// 实际 Worker 编译与原生 validator 对照参数投影；原生来源是明确的离线 fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import { createLuvusCatalog } from '../../../src/connector/luvus/catalog.js'
import { compileBundle, createNativeValidator } from '../../../src/native-contract/index.js'
import { hash } from '../../../src/native-contract/json.js'
import { compiled, source, json, identity, unwrap, G } from '../../native-contract/helpers.js'
import type { CompiledContract } from '../../../src/native-contract/index.js'

function catalog(contract: CompiledContract = compiled) {
  const trusted = { ...source(), binding: { ...source().binding, contract: contract.identity } }
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = G
  return createLuvusCatalog(contract, capabilities, trusted, {
    now: () => 100,
    current: () => trusted,
    expires_at: 200
  })
}

test('五个原生条件分支返回闭包参数 schema，generic 保留缺口，原生文档注释可追溯且列表不膨胀', () => {
  const current = catalog()
  const bundle = json('schema-bundle.json')
  for (const method of ['pane.list', 'agent.prompt', 'agent.send', 'agent.wait', 'agent.keys']) {
    const description = current.describe(method)
    assert.equal(description.schema_status, 'conditional_branch')
    assert(description.params_schema)
    const notes = description.schema_annotations as { document_uri: string; pointer: string; text: string }[]
    const request = notes.find((note) => note.document_uri === bundle.request.$id && note.pointer === '#/$comment')!
    assert.equal(request.text, bundle.request.$comment)
    assert(request.text.includes('new working or blocked transition'))
    new Ajv2020({ strict: false }).compile(description.params_schema as AnySchema)
  }
  const generic = current.describe('workspace.list')
  assert.equal(generic.schema_status, 'generic_params_only')
  assert.equal(generic.params_schema, undefined)
  assert(generic.schema_annotations)
  for (const method of current.list({ limit: 100 }).methods) {
    assert.equal('params_schema' in method, false)
    assert.equal('schema_annotations' in method, false)
  }
  const changed = current.describe('agent.wait')
  ;(changed.params_schema as Record<string, unknown>).allOf = []
  assert.notDeepEqual(current.describe('agent.wait').params_schema, changed.params_schema)
})

test('跨文档与转义引用保留旁置约束、注释和 literal 值，独立参数 schema 与完整原生请求判定一致', async () => {
  const bundle = json('schema-bundle.json')
  const request = bundle.request
  request.$comment = 'native-root-note-from-this-installation'
  const extra = 'https://luvus.dev/protocol/uhp/v1/extra.schema.json'
  bundle.documents[extra] = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: extra,
    $defs: { 'name/with~escape': { type: 'string', minLength: 2, $comment: 'native-reference-note' } }
  }
  request.$defs.agentWaitParams.properties.pane = {
    $ref: 'extra.schema.json#/$defs/name~1with~0escape',
    minLength: 3,
    maxLength: 5
  }
  request.$defs.agentWaitParams.properties.literal = { const: { $ref: 'literal-value', $comment: 'literal-comment' } }
  request.$defs.agentWaitParams.$comment = 'native-params-note'
  request.$defs.agentWaitParams.$defs = { unused: { description: 'UNRELATED_PRIVATE_DEFINITION' } }
  bundle.documents[request.$id] = request
  const bytes = Buffer.from(JSON.stringify(bundle))
  const contract = unwrap(await compileBundle(bytes, { identity: { ...identity, schema_sha256: hash(bytes) } }))
  const description = catalog(contract).describe('agent.wait')
  const schema = description.params_schema!
  assert(JSON.stringify(schema).includes('native-reference-note'))
  assert(JSON.stringify(schema).includes('native-params-note'))
  assert(description.schema_annotations!.some((note) => note.text === request.$comment))
  assert(JSON.stringify(schema).includes('literal-value'))
  assert(!JSON.stringify(schema).includes('UNRELATED_PRIVATE_DEFINITION'))
  const projected = new Ajv2020({ strict: false }).compile(schema as AnySchema)
  assert(projected({ pane: 'abc', status: 'idle' }))
  const original = createNativeValidator(contract)
  for (const params of [
    { pane: 'abc', status: 'idle' },
    { pane: 'ab', status: 'idle' },
    { pane: 'abcdef', status: 'idle' },
    { pane: 'abc', statuses: ['idle'], literal: { $ref: 'literal-value', $comment: 'literal-comment' } },
    { pane: 'abc', status: 'idle', literal: { $ref: 'other' } },
    { pane: 'abc', status: 'idle', statuses: ['working'] }
  ]) {
    assert.equal(
      Boolean(projected(params)),
      original.checkRequestShape({ id: 'native', method: 'agent.wait', params }).ok
    )
  }
})

test('额外 envelope 条件无法准确投影时保持 schema 缺失，不丢掉条件冒称完整', async () => {
  const bundle = json('schema-bundle.json')
  const branch = bundle.request.allOf.find((value: any) => value.if.properties.method.const === 'agent.wait')
  branch.if.properties.params = { properties: { status: { const: 'working' } } }
  bundle.documents[bundle.request.$id] = bundle.request
  const bytes = Buffer.from(JSON.stringify(bundle))
  const contract = unwrap(await compileBundle(bytes, { identity: { ...identity, schema_sha256: hash(bytes) } }))
  const description = catalog(contract).describe('agent.wait')
  assert.equal(description.schema_status, 'conditional_branch')
  assert.equal(description.params_schema, undefined)
  assert(description.schema_annotations)
})
