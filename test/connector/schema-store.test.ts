/** 两端共用的原始 schema 落盘约定：内容寻址、原子发布、摘要核验与旧布局读取。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishSchema, readSchema, schemaFileName, schemaReference } from '../../src/connector/schema-store.js'
import { hash } from '../../src/wire/index.js'

const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url))

/** 每个用例独占一个私有目录；不读取用户状态。 */
function root() {
  const directory = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.schema-store-')
  )
  return {
    directory,
    managed: join(directory, 'managed'),
    close: () => rmSync(directory, { recursive: true, force: true })
  }
}

test('内容寻址发布保留原始字节并拒绝不同字节占用同一摘要', () => {
  const f = root()
  try {
    mkdirSync(f.managed, { mode: 0o700 })
    const digest = hash(raw)
    const path = schemaReference(f.directory, digest)
    assert.equal(path, join(f.managed, schemaFileName(digest)))
    assert.equal(schemaFileName(digest), 'schema_' + digest + '.json')

    publishSchema(path, raw)
    // 逐字节相同：原始字节没有被解析后重新序列化。
    assert.deepEqual(readFileSync(path), raw)
    assert.deepEqual(readSchema(path, digest, 'unexpected'), raw)
    // 同一摘要重复发布是幂等的，不会重写或改变字节。
    publishSchema(path, raw)
    assert.deepEqual(readFileSync(path), raw)

    // 摘要冲突必须拒绝，绝不覆盖已有证据。
    const other = Buffer.from('{}')
    assert.throws(() => publishSchema(path, other), /schema_reference_mismatch/)
  } finally {
    f.close()
  }
})

test('读取按声明摘要核验，摘要或空文件不符时使用调用方自己的固定错误码', () => {
  const f = root()
  try {
    mkdirSync(f.managed, { mode: 0o700 })
    const digest = hash(raw)
    const path = schemaReference(f.directory, digest)
    publishSchema(path, raw)
    // 声明摘要与实际字节不符：抛出调用方指定的公开错误码。
    assert.throws(() => readSchema(path, 'a'.repeat(64), 'herdr_schema_unreviewed'), /herdr_schema_unreviewed/)
    // 原位改写后重新核验同样拒绝。
    writeFileSync(path, Buffer.concat([raw, Buffer.from('\n')]))
    assert.throws(() => readSchema(path, digest, 'herdr_schema_unreviewed'), /herdr_schema_unreviewed/)
    // 空文件是独立的固定诊断，不是摘要不符。
    writeFileSync(path, Buffer.alloc(0))
    assert.throws(
      () => readSchema(path, digest, 'herdr_schema_unreviewed', 'herdr_provider_file_invalid'),
      /herdr_provider_file_invalid/
    )
  } finally {
    f.close()
  }
})

test('引用名必须与摘要一致，非法摘要与跨目录引用都拒绝', () => {
  const f = root()
  try {
    mkdirSync(f.managed, { mode: 0o700 })
    assert.throws(() => schemaFileName('not-a-digest'), /schema_digest_invalid/)
    const digest = hash(raw)
    // 目标文件名必须等于该字节的摘要，否则拒绝而不是写到别处。
    assert.throws(() => publishSchema(join(f.managed, 'schema.json'), raw), /schema_reference_mismatch/)
    assert.equal(existsSync(join(f.managed, 'schema.json')), false)
    // 合法引用只在发布时创建，读取前缺失仍由共享私有读取器报告。
    assert.throws(() => readSchema(schemaReference(f.directory, digest), digest, 'unexpected'))
  } finally {
    f.close()
  }
})
