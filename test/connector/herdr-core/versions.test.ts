/**
 * core 的版本号与协议代次都不设限制：握手只确认这是 framed 的 herdr-core 并原样记录二者；配对记录里的
 * classification_revision 标识本仓库的档位表，不随 core 版本变化。已有真实文档的版本（0.1.14、0.1.15）
 * 各自编译并校验真实输出样本；兼容性由契约编译（表内方法齐全）与逐方法严格校验判定。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { parseHerdrCoreProviderRefConfig } from '../../../src/connector/herdr-core/provider.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { HERDR_CORE_CLASSIFICATION_REVISION, HERDR_CORE_METHODS } from '../../../src/connector/herdr-core/methods.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { hash } from '../../../src/wire/index.js'
import type { ContractSource, V2Target } from '../../../src/wire/types.js'
import { startFakeCore } from './fake-core.js'

type Sample = { method: string; params: Record<string, unknown>; response: { result: unknown } }
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/herdr-core/${name}`, import.meta.url))
const WITH_FIXTURES = ['0.1.14', '0.1.15'] as const
// 任何字符串都接受，包括不是语义版本的（latest、带后缀、原型键）：版本号不是准入条件。
const VERSIONS = [
  '0.1.13',
  '0.1.14',
  '0.1.15',
  '0.1.16',
  '0.2.0',
  '1.0.0',
  '10.20.30',
  '0.1.15-rc1',
  'latest',
  'v0.1.15',
  'constructor',
  '__proto__'
]

test('the handshake accepts any version string and records it as is', async () => {
  for (const version of VERSIONS) {
    const core = await startFakeCore({ hello: { version } })
    try {
      const client = await openHerdrCoreClient(core.socket)
      assert.equal(client.hello.version, version)
      client.close()
    } finally {
      await core.close()
    }
  }
})

test('the handshake accepts any protocol generation and records it as is', async () => {
  for (const generation of [0, 1, 2, 7, 99]) {
    const core = await startFakeCore({ hello: { generation } })
    try {
      const client = await openHerdrCoreClient(core.socket)
      assert.equal(client.hello.generation, generation)
      client.close()
    } finally {
      await core.close()
    }
  }
})

test('a hello that is not shaped like a herdr-core hello is still refused (that is not a version limit)', async () => {
  for (const hello of [
    { version: 15 },
    { version: null },
    { generation: '1' },
    { generation: null },
    { generation: 1.5 },
    { framed: false }
  ]) {
    const core = await startFakeCore({ hello })
    try {
      await assert.rejects(openHerdrCoreClient(core.socket), /herdr_core_handshake_refused/u, JSON.stringify(hello))
    } finally {
      await core.close()
    }
  }
})

for (const version of WITH_FIXTURES) {
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
}

test('a newer core that adds methods or a newer OpenRPC revision still compiles: unknown methods stay out', () => {
  const document = JSON.parse(fixture('openrpc-0.1.15.json').toString('utf8')) as Record<string, any>
  document.info.version = '0.2.0'
  document.openrpc = '1.4.0'
  document.methods.push({
    name: 'terminal.fork',
    paramStructure: 'by-name',
    params: [],
    result: { name: 'r', schema: {} }
  })
  const contract = compileHerdrCoreContract(JSON.stringify(document))
  assert.equal(contract.version, '0.2.0')
  assert.equal(contract.methods.includes('terminal.fork'), false)
  assert.equal(Object.hasOwn(HERDR_CORE_METHODS, 'terminal.fork'), false)
})

test('a newer core that drops a reviewed method is refused instead of silently losing it', () => {
  const document = JSON.parse(fixture('openrpc-0.1.15.json').toString('utf8')) as Record<string, any>
  document.info.version = '0.2.0'
  document.methods = document.methods.filter((method: { name: string }) => method.name !== 'terminal.read')
  assert.throws(() => compileHerdrCoreContract(JSON.stringify(document)), /herdr_core_schema_method_missing/u)
})

test('a pairing is accepted for any version and protocol generation, and only with this repository’s classification revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-hc-versions-'))
  try {
    const openrpc = fixture('openrpc-0.1.15.json')
    const source = (
      binary_version: string,
      native_protocol_version: string,
      classification_revision: string | null
    ): ContractSource => ({
      provider_kind: 'herdr-core',
      protocol_family: 'herdr-core-jsonrpc',
      binary_version,
      binary_sha256: 'a'.repeat(64),
      schema_sha256: hash(openrpc),
      schema_origin: 'live_instance',
      schema_command: 'rpc.discover',
      server_version: binary_version,
      native_protocol_version,
      runtime_generation: null,
      adapter_revision: 'adapter-herdr-core-1',
      classification_revision,
      support_basis: 'schema_and_version'
    })
    const reference = schemaReference(root, hash(openrpc))
    mkdirSync(dirname(reference), { mode: 0o700 })
    publishSchema(reference, openrpc)
    const target: V2Target = { machine_id: 'machine-a', provider_id: 'provider-a', profile: 'session', session: 'work' }
    const config = (expected_source: ContractSource) => ({
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'config-a',
      expected_source,
      schema_ref: reference
    })
    for (const version of VERSIONS) {
      for (const generation of ['0', '1', '2']) {
        assert.doesNotThrow(
          () =>
            parseHerdrCoreProviderRefConfig(config(source(version, generation, HERDR_CORE_CLASSIFICATION_REVISION))),
          `${version}/${generation}`
        )
      }
    }
    // 修订号标识本仓库的档位表与参数规则：别的值（含旧的 `<版本>@<提交>` 写法、空值）在读取任何文件之前就拒绝。
    // `-1`/`-2` 是已配对设备写下的旧值，仍在封闭集合里；更旧/未知/空值仍然拒绝。
    for (const revision of ['herdr-core-tiers-1', 'herdr-core-tiers-2', HERDR_CORE_CLASSIFICATION_REVISION]) {
      assert.doesNotThrow(() => parseHerdrCoreProviderRefConfig(config(source('0.1.15', '1', revision))), revision)
    }
    for (const revision of ['0.1.15@d028423', 'herdr-core-tiers-0', 'herdr-core-tiers-9', '', null]) {
      assert.throws(
        () => parseHerdrCoreProviderRefConfig(config(source('0.1.15', '1', revision))),
        /herdr_core_contract_unreviewed|invalid_config|invalid_text/u,
        String(revision)
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
