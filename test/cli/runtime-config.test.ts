// 单文件配置与程序管理registry共用正式装配；旧runtime/ref输入不能改变运行参数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configTemplate, readRuntimeConfig } from '../../src/cli/index.js'
import { configDocument, parseConfig } from '../../src/cli/config.js'
import { createLuvusProductionSources } from '../../src/runtime/production-luvus.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.js'
import { hash } from '../../src/wire/index.js'

test(
  'single-file role config preserves actual native schema bytes in the managed provider registry',
  /** 合成安装资料走原 registry 与生产编译工厂；无 CA、凭据、native child 或模型调用。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-managed-discovery-'))
    let resources: Awaited<ReturnType<ReturnType<typeof createLuvusProductionSources>['gateway']>> | undefined
    try {
      mkdirSync(join(directory, 'managed'), { mode: 0o700 })
      const role = parseConfig(configDocument({ ...configTemplate('gateway'), state_dir: directory }))
      assert.equal(role.role, 'gateway')
      if (role.role !== 'gateway') {
        throw new Error('wrong fixture role')
      }
      const schema =
        readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8') + '\n'
      const value = {
        kind: 'luvus',
        authentication: 'remote_connector',
        binding: {
          machine_id: 'synthetic_machine',
          provider_id: 'synthetic_provider',
          kind: 'luvus',
          config_ref: 'synthetic_remote',
          binding_revision: 1,
          enabled: true
        },
        target: {
          machine_id: 'synthetic_machine',
          provider_id: 'synthetic_provider',
          profile: 'session',
          session: 'synthetic'
        },
        contract: {
          binary_version: 'synthetic-future-diagnostic',
          binary_sha256: 'd'.repeat(64),
          schema_sha256: hash(schema),
          adapter_revision: MANAGED_LUVUS_REVISION,
          classification_revision: MANAGED_LUVUS_CLASSIFICATION,
          schema_bundle: schema
        },
        peer_policy_revision: 'synthetic_policy'
      }
      writeFileSync(
        join(directory, 'managed', 'providers.json'),
        JSON.stringify({
          schema_version: 1,
          role: 'gateway',
          providers: [{ reference: 'synthetic_remote', value }]
        }),
        { mode: 0o600 }
      )
      const settings = readRuntimeConfig(role)
      assert.deepEqual(settings.providers, [{ reference: 'synthetic_remote', value }])
      resources = await createLuvusProductionSources().gateway(role, settings.providers)
      const provider = resources.providers[0]!
      assert('remote_luvus' in provider && provider.remote_luvus)
      assert.equal(provider.ready(), false)
      assert.doesNotThrow(
        /** 实际未知原字节完整编译后的请求结构可用，不代表拥有来源或派发许可。 */ () =>
          provider.preflightRequest!({ id: 'synthetic', method: 'pane.list', params: { all_tabs: true } })
      )
      assert.throws(
        /** 单文件装配不能使非法原生参数越过登记前校验。 */ () =>
          provider.preflightRequest!({ id: 'synthetic', method: 'agent.wait', params: { target: '1', until: 'idle' } }),
        { code: 'native_request_invalid' }
      )
      assert.throws(
        /** 原生设置仍不是公开角色 JSON 参数。 */ () =>
          parseConfig({ ...configDocument(role), native: value.contract }),
        { code: 'invalid_config' }
      )
    } finally {
      await resources?.release()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  'single user configuration supplies listeners without a runtime manifest',
  /* 只核对实际单文件解析和状态装配。 */ () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-managed-config-'))
    try {
      mkdirSync(join(directory, 'managed'), { mode: 0o700 })
      const config = { ...configTemplate('gateway'), state_dir: directory, device_port: 9333 }
      assert.equal(config.role, 'gateway')
      if (config.role !== 'gateway') {
        throw new Error('wrong fixture role')
      }
      writeFileSync(join(directory, 'runtime.json'), '{"secret":"SYNTHETIC_IGNORED_OLD_INPUT"}', { mode: 0o600 })
      const settings = readRuntimeConfig(config)
      assert.deepEqual(settings.device_listener, { hostname: '0.0.0.0', port: 9333 })
      assert.deepEqual(settings.providers, [])
      writeFileSync(
        join(directory, 'managed', 'providers.json'),
        JSON.stringify({
          schema_version: 1,
          role: 'gateway',
          providers: [{ reference: 'owned_provider', value: { kind: 'luvus' } }]
        }),
        { mode: 0o600 }
      )
      assert.deepEqual(readRuntimeConfig(config).providers, [{ reference: 'owned_provider', value: { kind: 'luvus' } }])
      writeFileSync(
        join(directory, 'managed', 'providers.json'),
        '{"schema_version":1,"role":"connector","providers":[]}',
        { mode: 0o600 }
      )
      assert.throws(/* 程序管理状态损坏必须拒绝。 */ () => readRuntimeConfig(config), { code: 'invalid_config' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
