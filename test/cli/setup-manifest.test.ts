// 用离线公开schema验证首次清单的权限和路径边界；合成source只验证Gateway声明，不替代真实native或模型验收。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hash } from '../../src/wire/index.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { setupProviderKinds, setupReference, setupTarget } from '../../src/cli/setup-targets.js'
import { publishSetupSchemas, reviewSetupManifest } from '../../src/cli/setup-manifest.js'
import type { SetupPlanFacts } from '../../src/cli/setup-targets.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { saveCredential } from '../../src/transport/credentials.js'
import { writeSetupJson } from '../../src/cli/setup-files.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/connector/luvus/host/native-source.js'

const plan: SetupPlanFacts = {
  attempt_id: 'synthetic_attempt',
  actor: 'synthetic_operator'
}

test('Luvus 配对清单只接受当前策略授权，不携带逐方法 raw 授权', async () => {
  const root = privateHerdrTestRoot('.setup-luvus-grant-')
  const grant = { target: setupTarget('synthetic_machine', 'luvus') }
  const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
  const reference = setupReference(plan.attempt_id)
  const value = {
    kind: 'luvus',
    authentication: 'remote_connector',
    target: grant.target,
    binding: {
      machine_id: 'synthetic_machine',
      provider_id: 'luvus',
      kind: 'luvus',
      config_ref: reference,
      binding_revision: 1,
      enabled: true
    },
    contract: {
      binary_version: 'synthetic_future',
      binary_sha256: 'f'.repeat(64),
      schema_sha256: hash(schema),
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      schema_bundle: schema
    }
  }
  try {
    // 旧记录里的逐方法 raw 授权字段会被丢弃，但不再参与任何授权判断。
    for (const remote of [value, { ...value, raw_grant: { principal_id: plan.actor, methods: ['pane.list'] } }]) {
      const reviewed = await reviewSetupManifest(
        { installations: [{ reference, value: remote }] },
        plan,
        'synthetic_machine',
        root,
        new AbortController().signal
      )
      assert.equal((reviewed.reviewed[0]!.value as { raw_grant?: unknown }).raw_grant, undefined)
      assert.deepEqual(reviewed.authorization, { principal_id: plan.actor })
    }
    const noGrant = await reviewSetupManifest(
      { installations: [{ reference, value }] },
      plan,
      'synthetic_machine',
      root,
      new AbortController().signal
    )
    assert.deepEqual(noGrant.authorization, { principal_id: plan.actor })
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 只制作设备的非秘密声明，binary摘要故意不对应任何官方发行版；Gateway仍须核验原字节及全部协议根。
function manifest() {
  const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
  return {
    installations: [
      {
        reference: setupReference(plan.attempt_id, 'herdr'),
        value: {
          kind: 'herdr',
          schema_bundle: raw,
          config: {
            version: 1,
            target: setupTarget('synthetic_machine', 'herdr'),
            binding_revision: 1,
            config_ref: setupReference(plan.attempt_id, 'herdr'),
            expected_source: {
              ...fixedHerdrSource(),
              binary_version: 'synthetic-future',
              server_version: 'synthetic-future',
              binary_sha256: 'f'.repeat(64),
              schema_sha256: hash(raw)
            }
          }
        }
      }
    ]
  }
}

test(
  '单来源与混合权限各自绑定完整Target，方法不做并集或provider/session笛卡尔展开',
  /* 检查调用者和本地相同修订下的精确路由，未知选择不能借隐式字符串转换进入授权。 */ () => {
    for (const value of [
      [],
      ['luvus', 'luvus'],
      ['herdr', 'luvus'],
      ['unknown'],
      [{ toString: /* 对象不得借转换自证来源kind。 */ () => 'luvus' }]
    ]) {
      assert.throws(/* 空、重复、逆序及对象均不是合法固定选择。 */ () => setupProviderKinds(value))
    }
    assert.notDeepEqual(setupTarget('synthetic_machine', 'luvus'), setupTarget('synthetic_machine', 'herdr'))
  }
)

test(
  'Herdr清单按实际schema编译接纳陌生binary/版本声明，Gateway固定本机路径且审阅前不写文件',
  /* 这只是待所有者批准的远端声明，不签发本机安装或进程来源。 */ async () => {
    const root = privateHerdrTestRoot('.setup-manifest-')
    try {
      const input = manifest()
      const result = await reviewSetupManifest(input, plan, 'synthetic_machine', root, new AbortController().signal)
      assert.deepEqual(result.kinds, ['herdr'])
      assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
      assert.equal(result.reviewed[0]!.label, 'synthetic-future')
      assert.equal(result.reviewed[0]!.binary_sha256, 'f'.repeat(64))
      assert.equal(result.reviewed[0]!.schema!.bytes.toString('utf8'), input.installations[0]!.value.schema_bundle)
      assert(result.reviewed[0]!.schema!.path.startsWith(root + '/managed/'))
      assert.deepEqual(readdirSync(root), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '清单拒绝设备路径、Connector字段、重复来源、换Target、改原字节和改变已批准选择',
  /* 全部拒绝发生在程序schema发布与Store provider定义之前。 */ async () => {
    const root = privateHerdrTestRoot('.setup-manifest-')
    try {
      const original = manifest()
      const invalid: unknown[] = [
        { installations: [] },
        { installations: [original.installations[0], original.installations[0]] }
      ]
      for (const change of [
        { schema_path: '/arbitrary/device/path' },
        { connector: {} },
        { target: setupTarget('another_machine', 'herdr') },
        { binding_revision: 2 }
      ]) {
        const row = structuredClone(original)
        Object.assign(row.installations[0]!.value.config, change)
        invalid.push(row)
      }
      const changedBytes = structuredClone(original)
      changedBytes.installations[0]!.value.schema_bundle += '\n'
      invalid.push(changedBytes)
      for (const value of invalid) {
        await assert.rejects(
          /* 不给错误配置另一条宽松接纳路径。 */ () =>
            reviewSetupManifest(value, plan, 'synthetic_machine', root, new AbortController().signal)
        )
      }
      await assert.rejects(
        /* native批准后选择不能因重新查询状态而改变。 */ () =>
          reviewSetupManifest(
            original,
            { ...plan, providers: ['luvus'] },
            'synthetic_machine',
            root,
            new AbortController().signal
          )
      )
      assert.deepEqual(readdirSync(root), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'Gateway只在明确发布阶段保存原schema字节，已存在不同内容不能被重入覆盖',
  /* 使用真实原有Herdr Gateway资源预检；不创建transport、身份或原生进程。 */ async () => {
    const root = privateHerdrTestRoot('.setup-manifest-')
    try {
      const result = await reviewSetupManifest(
        manifest(),
        plan,
        'synthetic_machine',
        root,
        new AbortController().signal
      )
      privateDirectory(join(root, 'managed'))
      await publishSetupSchemas(result.reviewed, new AbortController().signal)
      const schema = result.reviewed[0]!.schema!
      assert.deepEqual(readFileSync(schema.path), schema.bytes)
      const modified = Buffer.concat([schema.bytes, Buffer.from('\n')])
      writeFileSync(schema.path, modified)
      await assert.rejects(
        /* 相同计划也不能掩盖外部修改。 */ () => publishSetupSchemas(result.reviewed, new AbortController().signal)
      )
      assert.deepEqual(readFileSync(schema.path), modified)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'Herdr和混合已初始化配置的地址、选择和目录变化在任何工厂调用或秘密发送之前拒绝',
  /* 固定来源只会抛合成失败；基线越过同一前置检查也不能伪装native启动成功。 */ async () => {
    for (const provider of ['herdr', 'mixed'] as const) {
      const root = privateHerdrTestRoot('.setup-origin-')
      const managed = join(root, 'managed')
      privateDirectory(managed)
      const kinds = provider === 'mixed' ? ['luvus', 'herdr'] : ['herdr']
      const config: ConnectorConfig = {
        ...configTemplate('connector'),
        role: 'connector',
        state_dir: root,
        gateway_url: 'ws://127.0.0.1:9443',
        native: { provider }
      } as ConnectorConfig
      const credential = {
        machine_id: 'synthetic_machine',
        recovery_generation: 'synthetic_generation',
        credential: 'SYNTHETIC_UNUSED_DEVICE_CREDENTIAL'.padEnd(48, 'x')
      }
      saveCredential(join(managed, 'device.json'), credential)
      const providers = kinds.map(
        /* 合成条目只用于检验loader前置门禁，不构造实际来源。 */ (kind) => ({
          reference: kind + '_synthetic',
          value:
            kind === 'luvus'
              ? { kind, native: { root_record: join(root, 'control', 'luvus-root.json') } }
              : { kind, config: {} }
        })
      )
      writeSetupJson(join(managed, 'providers.json'), { schema_version: 1, role: 'connector', providers })
      writeSetupJson(join(managed, 'pairing.json'), {
        schema_version: 1,
        attempt_id: plan.attempt_id,
        machine_id: credential.machine_id,
        gateway_url: config.gateway_url,
        phase: 'configured'
      })
      for (const entry of providers) {
        writeSetupJson(join(managed, entry.value.kind === 'luvus' ? 'native-setup.json' : 'herdr-setup.json'), {
          schema_version: 1,
          attempt_id: plan.attempt_id,
          machine_id: credential.machine_id,
          phase: 'prepared',
          settings: config.native,
          reference: entry.reference,
          local: entry.value,
          remote: {}
        })
      }
      const original = new Error('synthetic_native_failure')
      let calls = 0
      const runtime = createProductionCliRuntime({
        connector: /* 计数器只能标记误越过门禁，绝不建立native或网络成功替身。 */ async () => {
          calls++
          throw original
        }
      })
      const before = readFileSync(join(managed, 'device.json'))
      try {
        for (const changed of [
          { ...config, gateway_url: 'ws://127.0.0.1:1' },
          { ...config, native: { ...config.native, runtime_bin_dirs: ['/other/bin'] } },
          { ...config, native: { provider: 'luvus' as const } }
        ]) {
          await assert.rejects(/* 坏业务配置不应先启动child或发送身份。 */ () => runtime.connector!(changed), {
            code: 'configuration_required'
          })
        }
        assert.equal(calls, 0)
        assert.deepEqual(readFileSync(join(managed, 'device.json')), before)
        await assert.rejects(
          /* 控制组证明原配置能越过前置检查，但仍只有负向工厂。 */ () => runtime.connector!(config),
          /* 原错误对象保留，不被诊断或取消替换。 */ (error) => error === original
        )
        assert.equal(calls, 1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'Luvus 配对把原始 schema 发布到 Gateway 自己的目录，不接受设备路径',
  /* 两台机器部署时设备路径在 Gateway 侧不存在：引用必须由 Gateway 自己选择并落盘。 */ async () => {
    const root = privateHerdrTestRoot('.setup-luvus-schema-')
    const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
    const reference = setupReference(plan.attempt_id)
    const target = setupTarget('synthetic_machine', 'luvus')
    const value = {
      kind: 'luvus',
      authentication: 'remote_connector',
      target,
      binding: {
        machine_id: 'synthetic_machine',
        provider_id: 'luvus',
        kind: 'luvus',
        config_ref: reference,
        binding_revision: 1,
        enabled: true
      },
      contract: {
        binary_version: 'synthetic_future',
        binary_sha256: 'f'.repeat(64),
        schema_sha256: hash(schema),
        adapter_revision: MANAGED_LUVUS_REVISION,
        classification_revision: MANAGED_LUVUS_CLASSIFICATION,
        schema_bundle: schema
      }
    }
    try {
      privateDirectory(join(root, 'managed'))
      const reviewed = await reviewSetupManifest(
        { installations: [{ reference, value }] },
        plan,
        'synthetic_machine',
        root,
        new AbortController().signal
      )
      const entry = reviewed.reviewed[0]!
      // 发布后的引用由 Gateway 自己选，且落在它自己的 managed 目录内。
      const published = (entry.value as { contract: { schema_ref?: string; schema_bundle?: string } }).contract
      assert.equal(published.schema_bundle, undefined)
      assert.equal(published.schema_ref, join(root, 'managed', `schema_${hash(schema)}.json`))
      await publishSetupSchemas(reviewed.reviewed, new AbortController().signal)
      assert.deepEqual(readFileSync(published.schema_ref!), Buffer.from(schema, 'utf8'))
      // 设备提交自己的路径不被接受：Gateway 不接受设备选择本机文件位置。
      const hostile = structuredClone(value) as unknown as { contract: Record<string, unknown> }
      hostile.contract.schema_ref = '/arbitrary/device/path/schema.json'
      await assert.rejects(
        /* 设备路径既不参与发布，也不被当作已发布证据。 */ () =>
          reviewSetupManifest(
            { installations: [{ reference, value: hostile }] },
            plan,
            'synthetic_machine',
            root,
            new AbortController().signal
          )
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
