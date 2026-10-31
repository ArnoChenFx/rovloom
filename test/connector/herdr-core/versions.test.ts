/**
 * core 版本不设白名单：握手只核对协议代次与版本串形状；配对记录里的 classification_revision 标识
 * 本仓库的档位表，不随 core 版本变化。已有真实文档的版本（0.1.14、0.1.15）各自编译并校验真实输出样本。
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
  HERDR_CORE_CLASSIFICATION_REVISION,
  HERDR_CORE_METHODS,
  herdrCoreVersionShape
} from '../../../src/connector/herdr-core/methods.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { hash } from '../../../src/wire/index.js'
import type { ContractSource, V2Target } from '../../../src/wire/types.js'
import { startFakeCore } from './fake-core.js'

type Sample = { method: string; params: Record<string, unknown>; response: { result: unknown } }
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/herdr-core/${name}`, import.meta.url))
const WITH_FIXTURES = ['0.1.14', '0.1.15'] as const
const ACCEPTED = ['0.1.13', '0.1.14', '0.1.15', '0.1.16', '0.2.0', '1.0.0', '10.20.30', '0.1.15-rc1', '0.1.15+build.7']
const MALFORMED = [
  '',
  'constructor',
  '__proto__',
  'toString',
  '0.1.15 ',
  ' 0.1.15',
  'v0.1.15',
  '1.0',
  '1.2.3.4',
  'x'.repeat(100),
  '0.1.15-'
]

test('version shape is checked, never a number: odd values cannot enter a pairing record', () => {
  for (const version of ACCEPTED) {
    assert.equal(herdrCoreVersionShape(version), true, version)
  }
  for (const version of MALFORMED) {
    assert.equal(herdrCoreVersionShape(version), false, JSON.stringify(version))
  }
  for (const value of [undefined, null, 15, {}, ['0.1.15']]) {
    assert.equal(herdrCoreVersionShape(value), false)
  }
})

test('the handshake accepts any well-formed version and refuses a malformed one as a handshake failure', async () => {
  for (const version of ACCEPTED) {
    const core = await startFakeCore({ hello: { version } })
    try {
      const client = await openHerdrCoreClient(core.socket)
      assert.equal(client.hello.version, version)
      client.close()
    } finally {
      await core.close()
    }
  }
  for (const version of [...MALFORMED, 15, null]) {
    const core = await startFakeCore({ hello: { version } })
    try {
      await assert.rejects(
        openHerdrCoreClient(core.socket),
        /herdr_core_handshake_refused/u,
        `version ${String(version)}`
      )
    } finally {
      await core.close()
    }
  }
})

test('the protocol generation, not the version, decides compatibility', async () => {
  for (const generation of [0, 2, '1', null]) {
    const core = await startFakeCore({ hello: { generation } })
    try {
      await assert.rejects(
        openHerdrCoreClient(core.socket),
        /herdr_core_handshake_refused/u,
        `generation ${String(generation)}`
      )
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

test('a newer core that adds methods still compiles: unknown methods stay out of the contract', () => {
  const document = JSON.parse(fixture('openrpc-0.1.15.json').toString('utf8')) as Record<string, any>
  document.info.version = '0.2.0'
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

test('a pairing is accepted for any well-formed version and only with this repository’s classification revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-hc-versions-'))
  try {
    const openrpc = fixture('openrpc-0.1.15.json')
    const source = (binary_version: string, classification_revision: string | null): ContractSource => ({
      provider_kind: 'herdr-core',
      protocol_family: 'herdr-core-jsonrpc',
      binary_version,
      binary_sha256: 'a'.repeat(64),
      schema_sha256: hash(openrpc),
      schema_origin: 'live_instance',
      schema_command: 'rpc.discover',
      server_version: binary_version,
      native_protocol_version: '1',
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
    for (const version of ACCEPTED) {
      assert.doesNotThrow(
        () => parseHerdrCoreProviderRefConfig(config(source(version, HERDR_CORE_CLASSIFICATION_REVISION))),
        version
      )
    }
    // 修订号标识本仓库的档位表：别的值（含旧的 `<版本>@<提交>` 写法、空值）读取任何文件之前就拒绝。
    for (const revision of ['0.1.15@d028423', 'herdr-core-tiers-0', 'herdr-core-tiers-2', '', null]) {
      assert.throws(
        () => parseHerdrCoreProviderRefConfig(config(source('0.1.15', revision))),
        /herdr_core_contract_unreviewed|invalid_config|invalid_text/u,
        String(revision)
      )
    }
    // 版本串的怪值不能进入记录。
    for (const version of MALFORMED.filter((value) => value !== '')) {
      assert.throws(
        () => parseHerdrCoreProviderRefConfig(config(source(version, HERDR_CORE_CLASSIFICATION_REVISION))),
        /herdr_core_contract_unreviewed/u,
        version
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
