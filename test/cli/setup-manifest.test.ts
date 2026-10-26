// 用离线公开schema验证首次清单的权限和路径边界；合成source只验证Gateway声明，不替代真实native或模型验收。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hash } from '../../src/wire/index.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { selectedSetupPolicies, setupProviderKinds, setupReference, setupTarget } from '../../src/cli/setup-policy.js'
import { publishSetupSchemas, reviewSetupManifest } from '../../src/cli/setup-manifest.js'
import type { SetupPlanFacts } from '../../src/cli/setup-policy.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { saveCredential } from '../../src/transport/credentials.js'
import { writeSetupJson } from '../../src/cli/setup-files.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.js'

const plan: SetupPlanFacts = {
  attempt_id: 'synthetic_attempt',
  actor: 'synthetic_operator'
}

test('Luvus 配对清单兼容旧主体授权与新策略授权，拒绝额外方法或错误授权范围', async () => {
  const root = privateHerdrTestRoot('.setup-luvus-grant-')
  const authorization = selectedSetupPolicies(plan, 'synthetic_machine', ['luvus'])
  const grant = authorization.policies.caller.grants[0]!
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
    peer_policy_revision: authorization.policies.local.revision,
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
    for (const methods of [grant.methods, grant.methods.filter((method) => method !== 'wait.output')]) {
      for (const subject of [
        { principal_id: authorization.principal_id },
        { caller_policy_revision: authorization.policies.caller.revision }
      ]) {
        const remote = { ...value, raw_grant: { ...subject, methods } }
        const reviewed = await reviewSetupManifest(
          { installations: [{ reference, value: remote }] },
          plan,
          'synthetic_machine',
          root,
          new AbortController().signal
        )
        assert.deepEqual(reviewed.reviewed[0]!.value, remote)
        assert.deepEqual(reviewed.authorization.policies.caller.grants[0]!.methods, methods)
        assert.deepEqual(reviewed.authorization.policies.local.grants[0]!.methods, methods)
      }
    }
    for (const raw_grant of [
      { principal_id: 'other', methods: grant.methods },
      { caller_policy_revision: 'other', methods: grant.methods },
      {
        caller_policy_revision: authorization.policies.caller.revision,
        methods: [...grant.methods, 'uhp.token.create']
      },
      { caller_policy_revision: authorization.policies.caller.revision, methods: ['workspace.rename'] }
    ]) {
      await assert.rejects(
        reviewSetupManifest(
          { installations: [{ reference, value: { ...value, raw_grant } }] },
          plan,
          'synthetic_machine',
          root,
          new AbortController().signal
        )
      )
    }
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
            peer_policy_revision: 'setup_local_' + plan.attempt_id,
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
    const selected = selectedSetupPolicies(plan, 'synthetic_machine', ['luvus', 'herdr'])
    const [luvus, herdr] = selected.policies.caller.grants
    assert.deepEqual(luvus!.target, setupTarget('synthetic_machine', 'luvus'))
    assert.deepEqual(herdr!.target, setupTarget('synthetic_machine', 'herdr'))
    assert(luvus!.methods.includes('pane.status'))
    assert(!herdr!.methods.includes('pane.status'))
    assert(herdr!.methods.includes('workspace.move_block'))
    assert(!luvus!.methods.includes('workspace.move_block'))
    assert.deepEqual(selected.policies.local.grants, selected.policies.caller.grants)
    assert.equal(selectedSetupPolicies(plan, 'synthetic_machine', ['herdr']).policies.caller.grants.length, 1)
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
