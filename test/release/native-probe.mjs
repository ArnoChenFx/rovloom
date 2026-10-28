/** 单文件中的真实 schema 工厂验收：仅使用版本化离线 fixture，不建立设备或授权。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import schema from '../fixtures/luvus/0.14.3/linux/schema-bundle.json' with { type: 'file' }
import { compileBundle, createNativeValidator } from '../../src/connector/luvus/contract/index.ts'
import { createHash } from 'node:crypto'
import { unknownSchemaBundle } from '../native-contract/unknown-schema-fixture.ts'
import herdrSchema from '../fixtures/herdr/0.9.5/schema.json' with { type: 'file' }
import { compileHerdrSchemas, isCompiledHerdrSchemas } from '../../src/connector/herdr/compiler-api.ts'

const bytes = readFileSync(schema)
const identity = {
  binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
  schema_sha256: createHash('sha256').update(bytes).digest('hex'),
  revision: 'standalone-packaging-probe'
}
const compiled = await compileBundle(bytes, { identity })
assert(compiled.ok, JSON.stringify(compiled))
assert.equal(compiled.value.documents.length, 29)
const error = { id: 'packaging', error: { code: 'synthetic', message: 'synthetic', data: { preserved: true } } }
const checked = createNativeValidator(compiled.value).checkResponseShape(error)
assert(checked.ok, JSON.stringify(checked))
assert.deepEqual(checked.value.response, error)
// 未知原字节必须真实进入完整 Worker；坏输入后仍能接纳合法根，不能只证明固定资产可用。
const malformed = await compileBundle('{}', {
  identity: { ...identity, schema_sha256: createHash('sha256').update('{}').digest('hex') }
})
assert.equal(malformed.ok, false)
assert.equal(malformed.error.reason, 'invalid_schema')
const unknown = unknownSchemaBundle()
const unknownIdentity = { ...identity, schema_sha256: createHash('sha256').update(unknown).digest('hex') }
assert.notEqual(unknownIdentity.schema_sha256, identity.schema_sha256)
const unsupported = JSON.parse(unknown)
unsupported.documents[unsupported.request.$id].synthetic_future_keyword = true
const unsupportedBytes = JSON.stringify(unsupported)
const rejected = await compileBundle(unsupportedBytes, {
  identity: { ...identity, schema_sha256: createHash('sha256').update(unsupportedBytes).digest('hex') }
})
assert.equal(rejected.ok, false)
assert.equal(rejected.error.reason, 'unsupported_keyword')
const full = await compileBundle(unknown, { identity: unknownIdentity })
assert(full.ok, JSON.stringify(full))
assert.equal(full.value.documents.length, 9)
assert.deepEqual(full.value.identity, unknownIdentity)
const validator = createNativeValidator(full.value)
const unknownError = { id: 'unknown', error: { code: 'synthetic', message: '汉😀', data: { preserved: true } } }
const validated = validator.checkResponseShape(unknownError)
assert(validated.ok, JSON.stringify(validated))
assert.deepEqual(validated.value.response, unknownError)
assert.equal(
  validator.checkResponseShape({ ...unknownError, error: { ...unknownError.error, message: '汉😀a' } }).ok,
  false
)
assert.equal(
  validator.checkResponseShape({
    ...unknownError,
    error: { ...unknownError.error, data: { preserved: false } }
  }).ok,
  false
)
// 同一个可执行文件同时携带两种固定 Worker；Herdr 不经过 UHP 转写。
const herdr = await compileHerdrSchemas(readFileSync(herdrSchema))
assert(isCompiledHerdrSchemas(herdr))
assert(!isCompiledHerdrSchemas({ ...herdr }))
assert(herdr.request({ id: 'packaging', method: 'ping', params: {} }))
assert(!herdr.request({ id: 'packaging', method: 'unknown', params: {} }))
assert(herdr.response({ id: 'packaging', result: { type: 'pong', version: '0.9.5', protocol: 22 } }))
assert(herdr.response({ id: 'packaging', error: { code: 'synthetic', message: 'synthetic' } }))
assert(!herdr.response({ id: 'packaging', result: {} }))
// 未知 Herdr schema 也须在单文件的生产 Worker 中真实完整编译；小型合成根不替换官方资产探针。
const unknownHerdrBytes = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  protocol: 27,
  schema_version: 3,
  schemas: {
    request: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        method: { const: 'synthetic' },
        params: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 2, maxLength: 2 } },
          required: ['text'],
          additionalProperties: false
        }
      },
      required: ['id', 'method', 'params'],
      additionalProperties: false
    },
    success_response: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        result: {
          type: 'object',
          properties: { preserved: { const: { synthetic: true } }, count: { type: 'integer', format: 'uint32' } },
          required: ['preserved', 'count'],
          additionalProperties: false
        }
      },
      required: ['id', 'result'],
      additionalProperties: false
    },
    error_response: {
      type: 'object',
      properties: { id: { type: 'string' }, error: { type: 'object' } },
      required: ['id', 'error'],
      additionalProperties: false
    }
  }
})
const unknownHerdr = await compileHerdrSchemas(unknownHerdrBytes)
assert(isCompiledHerdrSchemas(unknownHerdr))
assert.equal(unknownHerdr.schema_sha256, createHash('sha256').update(unknownHerdrBytes).digest('hex'))
assert.equal(unknownHerdr.protocol, 27)
assert(unknownHerdr.request({ id: 'synthetic', method: 'synthetic', params: { text: '汉😀' } }))
assert(!unknownHerdr.request({ id: 'synthetic', method: 'synthetic', params: { text: '汉😀a' } }))
assert(unknownHerdr.response({ id: 'synthetic', result: { preserved: { synthetic: true }, count: 1 } }))
assert(!unknownHerdr.response({ id: 'synthetic', result: { preserved: { synthetic: false }, count: 1 } }))
assert(!unknownHerdr.response({ id: 'synthetic', result: { preserved: { synthetic: true }, count: -1 } }))
console.log(
  JSON.stringify({
    scope: 'native-contract-probe',
    documents: 29,
    errorDataPreserved: true,
    unknownSchemaWorker: {
      documents: 9,
      malformedRejected: true,
      unknownKeywordRejected: true,
      helpersValidated: true
    },
    herdr: {
      version: '0.9.5',
      originalRoots: true,
      compiledBrand: true,
      unknownSchemaWorker: true
    }
  })
)
