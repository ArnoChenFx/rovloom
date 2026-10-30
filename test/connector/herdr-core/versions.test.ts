/**
 * 已审核的 core 版本集合：每个版本用自己的真实 OpenRPC 文档与真实输出样本核对；
 * 握手、配对配置与分类修订只认集合里的版本，其余（旧版、新版、原型键）一律明确拒绝。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { parseHerdrCoreProviderRefConfig } from '../../../src/connector/herdr-core/provider.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import {
  HERDR_CORE_METHODS,
  HERDR_CORE_REVIEWED_VERSIONS,
  herdrCoreClassificationRevision,
  herdrCoreReviewedCommit
} from '../../../src/connector/herdr-core/methods.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { hash } from '../../../src/wire/index.js'
import type { ContractSource, V2Target } from '../../../src/wire/types.js'
import { startFakeCore } from './fake-core.js'

type Sample = { method: string; params: Record<string, unknown>; response: { result: unknown } }
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/herdr-core/${name}`, import.meta.url))
const REVIEWED = ['0.1.14', '0.1.15'] as const
const UNREVIEWED = ['0.1.13', '0.1.16', '0.2.0', '0.1.15-rc1', '0.1.15 ', '', 'constructor', '__proto__', 'toString']

test('the reviewed set is exactly the versions with a real contract fixture, each with its release commit', () => {
  assert.deepEqual(Object.keys(HERDR_CORE_REVIEWED_VERSIONS), [...REVIEWED])
  assert.equal(herdrCoreReviewedCommit('0.1.14'), '29e6d37')
  assert.equal(herdrCoreReviewedCommit('0.1.15'), 'd028423')
  assert.equal(herdrCoreClassificationRevision('0.1.15'), '0.1.15@d028423')
  for (const version of UNREVIEWED) {
    assert.equal(herdrCoreReviewedCommit(version), undefined, version)
    assert.equal(herdrCoreClassificationRevision(version), undefined, version)
  }
  for (const value of [undefined, null, 15, {}, ['0.1.15']]) {
    assert.equal(herdrCoreReviewedCommit(value), undefined)
  }
})

test('0.1.15 differs from 0.1.14 only in the version string and one installed_by description', () => {
  const before = JSON.parse(fixture('openrpc-0.1.14.json').toString('utf8')) as Record<string, any>
  const after = JSON.parse(fixture('openrpc-0.1.15.json').toString('utf8')) as Record<string, any>
  assert.equal(before.info.version, '0.1.14')
  assert.equal(after.info.version, '0.1.15')
  const installedBy = (document: Record<string, any>) =>
    document.components.schemas.StatusResult.properties.installed_by as Record<string, unknown>
  assert.notEqual(installedBy(before).description, installedBy(after).description)
  // 把这两处抹平后必须逐字相同：多出任何别的差异，本审核结论就不再成立，要重新核对。
  for (const document of [before, after]) {
    document.info.version = 'x'
    delete installedBy(document).description
  }
  assert.deepEqual(after, before)
})

for (const version of REVIEWED) {
  const openrpc = fixture(`openrpc-${version}.json`)
  const samples = JSON.parse(fixture(`samples-${version}.json`).toString('utf8')) as { samples: Sample[] }

  test(`the published ${version} document compiles and every method has a reviewed tier`, () => {
    const contract = compileHerdrCoreContract(openrpc)
    assert.equal(contract.version, version)
    assert.equal(contract.methods.length, 32)
    assert.deepEqual([...contract.methods].sort(), Object.keys(HERDR_CORE_METHODS).sort())
  })

  test(`every real ${version} sample validates against the reviewed schemas`, () => {
    const contract = compileHerdrCoreContract(openrpc)
    assert.ok(samples.samples.length >= 7)
    for (const sample of samples.samples) {
      contract.validateParams(sample.method, sample.params)
      contract.validateResult(sample.method, sample.response.result)
    }
  })

  test(`the handshake accepts ${version}`, async () => {
    const core = await startFakeCore({ hello: { version } })
    try {
      const client = await openHerdrCoreClient(core.socket)
      assert.equal(client.hello.version, version)
      client.close()
    } finally {
      await core.close()
    }
  })

  test(`a ${version} pairing is accepted only with its own classification revision`, () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-hc-versions-'))
    try {
      const source: ContractSource = {
        provider_kind: 'herdr-core',
        protocol_family: 'herdr-core-jsonrpc',
        binary_version: version,
        binary_sha256: 'a'.repeat(64),
        schema_sha256: hash(openrpc),
        schema_origin: 'live_instance',
        schema_command: 'rpc.discover',
        server_version: version,
        native_protocol_version: '1',
        runtime_generation: null,
        adapter_revision: 'adapter-herdr-core-1',
        classification_revision: `${version}@${herdrCoreReviewedCommit(version)}`,
        support_basis: 'schema_and_version'
      }
      const reference = schemaReference(root, source.schema_sha256)
      mkdirSync(dirname(reference), { mode: 0o700 })
      publishSchema(reference, openrpc)
      const target: V2Target = {
        machine_id: 'machine-a',
        provider_id: 'provider-a',
        profile: 'session',
        session: 'work'
      }
      const config = (expected_source: ContractSource) => ({
        version: 1,
        target,
        binding_revision: 1,
        config_ref: 'config-a',
        expected_source,
        schema_ref: reference
      })
      assert.doesNotThrow(() => parseHerdrCoreProviderRefConfig(config(source)))
      const other = REVIEWED.find((candidate) => candidate !== version)!
      // 版本与提交必须成对：张冠李戴、未审核的版本号都在读取任何文件之前就拒绝。
      for (const classification_revision of [
        `${version}@${herdrCoreReviewedCommit(other)}`,
        `${other}@${herdrCoreReviewedCommit(version)}`,
        `${version}@`,
        version
      ]) {
        assert.throws(
          () => parseHerdrCoreProviderRefConfig(config({ ...source, classification_revision })),
          /herdr_core_contract_unreviewed/u,
          classification_revision
        )
      }
      for (const binary_version of ['0.1.16', '0.1.13', 'constructor']) {
        assert.throws(
          () =>
            parseHerdrCoreProviderRefConfig(
              config({ ...source, binary_version, classification_revision: `${binary_version}@d028423` })
            ),
          /herdr_core_contract_unreviewed/u,
          binary_version
        )
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('the handshake refuses every unreviewed version with its own code', async () => {
  for (const version of UNREVIEWED) {
    const core = await startFakeCore({ hello: { version } })
    try {
      await assert.rejects(openHerdrCoreClient(core.socket), /herdr_core_version_unreviewed/u, `version ${version}`)
    } finally {
      await core.close()
    }
  }
})
