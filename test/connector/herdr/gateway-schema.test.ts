// Gateway从普通文件加载实际schema字节并保留编译快照；只用公开离线fixture，不建立身份或原生会话。
import assert from 'node:assert/strict'
import { phaseTiming } from '../../support/phase-timing.js'
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHerdrGatewayResources } from '../../../src/connector/herdr/provider.js'
import { raw, source } from './helpers.js'

// 临时根及schema均归本例拥有，路径使用真实系统表示。
function schemaFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-gateway-schema-'))
  const schema = join(root, 'schema.json')
  writeFileSync(schema, raw, { mode: 0o600 })
  return {
    root,
    schema,
    config: {
      version: 1,
      target: { machine_id: 'owned-machine', provider_id: 'herdr', profile: 'session', session: 'owned' },
      binding_revision: 1,
      config_ref: 'owned-herdr',
      expected_source: source,
      schema_path: schema
    }
  }
}

test(
  'Gateway schema沿用普通权限和文件链接，读取不改变现有对象',
  { timeout: 60_000 },
  /* 六平台均使用正式编译和读取入口。 */ async () => {
    const f = schemaFixture()
    try {
      if (process.platform !== 'win32') {
        chmodSync(f.schema, 0o644)
        chmodSync(f.root, 0o755)
      }
      const modes = [statSync(f.root).mode, statSync(f.schema).mode]
      const hard = join(f.root, 'hard.json')
      linkSync(f.schema, hard)
      const alias = join(f.root, 'alias')
      symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const paths = [f.schema, hard, join(alias, 'schema.json')]
      if (process.platform !== 'win32') {
        const link = join(f.root, 'linked.json')
        symlinkSync(f.schema, link)
        paths.push(link)
      }
      for (const schema_path of paths) {
        const resources = await phaseTiming('herdr.gateway.compile', () =>
          createHerdrGatewayResources({ config: { ...f.config, schema_path } })
        )
        try {
          assert.equal(resources.describe().source_basis, 'configured_connector_contract')
          assert.equal(resources.providers[0]!.ready!(), true)
        } finally {
          await resources.release()
        }
      }
      assert.deepEqual([statSync(f.root).mode, statSync(f.schema).mode], modes)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  'Gateway schema仍拒绝目录、空文件、超限及摘要错误的实际字节',
  /* 正常文件权限不能替代内容、类型与预算校验。 */ async () => {
    const f = schemaFixture()
    try {
      await assert.rejects(
        createHerdrGatewayResources({ config: { ...f.config, schema_path: f.root } }),
        /invalid_storage_file/
      )
      truncateSync(f.schema, 0)
      await assert.rejects(createHerdrGatewayResources({ config: f.config }), /herdr_provider_file_invalid/)
      truncateSync(f.schema, 16_777_217)
      await assert.rejects(createHerdrGatewayResources({ config: f.config }), /invalid_storage_file/)
      writeFileSync(f.schema, '{}')
      await assert.rejects(createHerdrGatewayResources({ config: f.config }), /herdr_schema_unreviewed/)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  'Gateway编译使用已读取的schema快照，后续文件更新在显式重载时校验',
  { timeout: 15_000 },
  /* 文件变化不改写已核对的内存字节或远端契约来源。 */ async () => {
    const f = schemaFixture()
    let resources: Awaited<ReturnType<typeof createHerdrGatewayResources>> | undefined
    try {
      const pending = createHerdrGatewayResources({ config: f.config })
      const replacement = join(f.root, 'replacement.json')
      writeFileSync(replacement, Buffer.concat([raw, Buffer.from(' ')]))
      renameSync(replacement, f.schema)
      resources = await pending
      assert.equal(resources.providers[0]!.ready!(), true)
      assert.equal(resources.describe().source_basis, 'configured_connector_contract')
      await assert.rejects(createHerdrGatewayResources({ config: f.config }), /herdr_schema_unreviewed/)
      await resources.release()
      assert.throws(resources.providers[0]!.ready!, /herdr_provider_closed/)
    } finally {
      await resources?.release()
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)
