// 新增 herdr-core 只追加 kind：旧绑定、旧契约来源与旧配置必须继续按原值解析。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_KINDS, validateContractSource, validateProvider } from '../../src/wire/index.js'
import type { ContractSource, ProviderBinding } from '../../src/wire/types.js'
import { configDocument, parseConfig, selectedNativeProviders } from '../../src/cli/config.js'
import type { ConnectorConfig } from '../../src/cli/config.js'

const binding = (kind: string): ProviderBinding => ({
  machine_id: 'machine-a',
  provider_id: 'provider-a',
  kind: kind as ProviderBinding['kind'],
  config_ref: 'config-a',
  binding_revision: 1,
  enabled: true
})

const luvusSource: ContractSource = {
  provider_kind: 'luvus',
  protocol_family: 'uhp',
  binary_version: '0.14.3',
  binary_sha256: 'a'.repeat(64),
  schema_sha256: 'b'.repeat(64),
  schema_origin: 'installed_cli',
  schema_command: 'luvus uhp schema',
  server_version: '0.14.3',
  native_protocol_version: '1',
  runtime_generation: 'generation-a',
  adapter_revision: 'adapter-a',
  classification_revision: 'classification-a',
  support_basis: 'live_catalog'
}

const herdrSource: ContractSource = {
  provider_kind: 'herdr',
  protocol_family: 'herdr-json',
  binary_version: '0.8.2',
  binary_sha256: 'c'.repeat(64),
  schema_sha256: 'd'.repeat(64),
  schema_origin: 'installed_cli',
  schema_command: 'herdr api schema --json',
  server_version: '0.8.2',
  native_protocol_version: '1',
  runtime_generation: null,
  adapter_revision: 'adapter-b',
  classification_revision: 'classification-b',
  support_basis: 'schema_and_version'
}

const coreSource: ContractSource = {
  provider_kind: 'herdr-core',
  protocol_family: 'herdr-core-jsonrpc',
  binary_version: '0.1.14',
  binary_sha256: 'e'.repeat(64),
  schema_sha256: 'f'.repeat(64),
  schema_origin: 'live_instance',
  schema_command: 'rpc.discover',
  server_version: '0.1.14',
  native_protocol_version: '1',
  runtime_generation: 'core-id-a',
  adapter_revision: 'adapter-c',
  classification_revision: 'classification-c',
  support_basis: 'schema_and_version'
}

test('kind 集合只追加：前两个仍是旧值，herdr-core 排在后面', () => {
  assert.deepEqual([...PROVIDER_KINDS], ['luvus', 'herdr', 'herdr-core'])
  assert.ok(Object.isFrozen(PROVIDER_KINDS))
})

test('旧绑定与旧契约来源按原值继续通过，herdr-core 需要自己的协议族', () => {
  for (const kind of ['luvus', 'herdr']) {
    assert.doesNotThrow(/** 旧值不能被新增 kind 改写。 */ () => validateProvider(binding(kind)))
  }
  assert.doesNotThrow(() => validateProvider(binding('herdr-core')))
  assert.throws(() => validateProvider(binding('herdr-core-2')), /invalid_enum/u)
  assert.doesNotThrow(() => validateContractSource(luvusSource))
  assert.doesNotThrow(() => validateContractSource(herdrSource))
  assert.doesNotThrow(() => validateContractSource(coreSource))
})

test('herdr-core 契约来源不能借用安装 CLI 自报或另一种协议族', () => {
  // 只改其中一项：协议族、schema 命令与来源必须三者同时属于 herdr-core。
  for (const delta of [
    { protocol_family: 'herdr-json' as const },
    { schema_command: 'herdr api schema --json' as const },
    { schema_origin: 'installed_cli' as const }
  ]) {
    assert.throws(() => validateContractSource({ ...coreSource, ...delta }), /contract_provider_mismatch/u)
  }
  // 旧 provider 也不能借用 herdr-core 的协议族。
  assert.throws(
    () => validateContractSource({ ...herdrSource, protocol_family: 'herdr-core-jsonrpc' }),
    /contract_provider_mismatch/u
  )
})

const connector = (native?: unknown): Record<string, unknown> => ({
  schema_version: 1,
  role: 'connector',
  data: { directory: '/srv/rovloom' },
  gateway: { url: '' },
  ...(native === undefined ? {} : { native })
})

test('旧配置的 provider 选择保持原义，herdr-core 需显式选择', () => {
  const parse = (native?: unknown) => parseConfig(connector(native), 'linux') as ConnectorConfig
  // 没有 native 段、只有 luvus/herdr、以及 mixed 都必须与新增 kind 之前完全一致。
  assert.deepEqual(selectedNativeProviders(parse()), ['luvus'])
  assert.deepEqual(selectedNativeProviders(parse({ provider: 'luvus' })), ['luvus'])
  assert.deepEqual(selectedNativeProviders(parse({ provider: 'herdr' })), ['herdr'])
  assert.deepEqual(selectedNativeProviders(parse({ provider: 'mixed' })), ['luvus', 'herdr'])
  assert.deepEqual(selectedNativeProviders(parse({ provider: 'herdr-core' })), ['herdr-core'])
  assert.throws(() => parse({ provider: 'herdr-core-2' }))
})

test('herdr-core 配置写出后仍能被同一解析器读回', () => {
  const parsed = parseConfig(connector({ provider: 'herdr-core' }), 'linux')
  assert.equal(parsed.role, 'connector')
  assert.deepEqual(parseConfig(configDocument(parsed), 'linux'), parsed)
})
