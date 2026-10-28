/** 离线执行官方验收脚本实际使用的异步工厂接缝，不启动官方二进制、会话或凭据引导。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compileOfficialSchema } from './official-ipc.mjs'
import { createNativeValidator } from '../../../src/connector/luvus/contract/index.ts'

test(
  'official IPC schema bootstrap awaits the real Worker factory and preserves a usable handle',
  /** 同一个导出函数由真实脚本和此测试调用，忘记 await 后的 Promise 不能冒充编译结果。 */ async () => {
    await assert.rejects(compileOfficialSchema(Buffer.from('{}')), /official_schema_compile_failed/u)
    const schema = readFileSync(new URL('../../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
    const compiled = await compileOfficialSchema(schema)
    assert.equal(compiled.ok, true)
    assert.equal(compiled.value.documents.length, 29)
    const response = {
      id: 'official-offline',
      error: { code: 'synthetic', message: 'synthetic', data: { preserved: true } }
    }
    const checked = createNativeValidator(compiled.value).checkResponseShape(response)
    assert(checked.ok)
    assert.deepEqual(checked.value.response, response)
  }
)
