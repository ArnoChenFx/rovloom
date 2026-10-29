/** 描述的审核 schema 与实际参数检查对照；UTF-8 字节限制使用已标注的扩展。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import { luvusReviewedParams } from '../../../src/connector/luvus/reviewed-params.js'
import { validateLuvusOperationParams } from '../../../src/connector/luvus/operations.js'

test('wait.output 的审核参数 schema 覆盖真实 u32、UTF-8 字节、NUL 和秒数边界', () => {
  const schema = luvusReviewedParams('wait.output')!
  const ajv = new Ajv2020({ strict: false })
  ajv.addKeyword({
    keyword: 'x-maxUtf8Bytes',
    schemaType: 'number',
    type: 'string',
    validate: (maximum: number, text: string) => Buffer.byteLength(text) <= maximum
  })
  const check = ajv.compile(schema as AnySchema)
  for (const params of [
    { pane: '1', match: 'ok' },
    { pane: '4294967295', match: 'ok', timeout_s: 0.5 },
    { pane: '4294967296', match: 'ok' },
    { pane: '9999999999', match: 'ok' },
    { pane: '0', match: 'ok' },
    { pane: '01', match: 'ok' },
    { pane: 1, match: 'ok' },
    { pane: '1', match: '' },
    { pane: '1', match: 'a'.repeat(4096) },
    { pane: '1', match: 'a'.repeat(4097) },
    { pane: '1', match: '你'.repeat(1365) },
    { pane: '1', match: '你'.repeat(1366) },
    { pane: '1', match: '🌍'.repeat(1024) },
    { pane: '1', match: '🌍'.repeat(1025) },
    { pane: '1', match: '\0' },
    { pane: '1', match: 'ok', timeout_s: 0 },
    { pane: '1', match: 'ok', timeout_s: 3600 },
    { pane: '1', match: 'ok', timeout_s: -1 },
    { pane: '1', match: 'ok', timeout_s: 3600.1 },
    { pane: '1', match: 'ok', unexpected: true },
    { match: 'ok' }
  ]) {
    let accepted = true
    try {
      validateLuvusOperationParams('wait.output', params)
    } catch {
      accepted = false
    }
    assert.equal(Boolean(check(params)), accepted)
  }
  assert.equal(luvusReviewedParams('unknown'), undefined)
  schema.required = []
  assert.deepEqual(luvusReviewedParams('wait.output')!.required, ['pane', 'match'])
})
