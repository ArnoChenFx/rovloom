/** 验证静态生产来源的配置绑定、持久缺项与启动失败释放；合成 root 不冒充真实运行实例。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LuvusDispatchClaims } from '../../src/connector/luvus/index.js'
import type { LuvusLocalConfig } from '../../src/connector/luvus/index.js'
import { FIXED_LUVUS_SHA256, FIXED_LUVUS_SCHEMA_SHA256 } from '../../src/runtime/native-control.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.js'
import { createNativeRecord } from '../../src/runtime/native-record-files.js'
import { ownedPathStamp } from '../../src/runtime/native-process.js'
import { createLuvusProductionSources } from '../../src/runtime/production-luvus.js'
import type { LuvusProductionOwnerConfig } from '../../src/runtime/production-luvus.js'
import { boundedJson, hash } from '../../src/wire/index.js'

type MutableOwnerConfig = { -readonly [K in keyof LuvusProductionOwnerConfig]: LuvusProductionOwnerConfig[K] }

test(
  'production Gateway rejects mixed native source modes for one machine before attach or compile',
  /** 同一设备不能混合本机观察与远端快照模式，避免一个设备级能力错误覆盖另一个 provider。 */ async () => {
    const f = fixture()
    try {
      f.value.native = { ...f.value.native, mode: 'attach' }
      const remote = {
        kind: 'luvus',
        authentication: 'remote_connector',
        binding: {
          machine_id: f.config.target.machine_id,
          provider_id: 'remote_provider',
          kind: 'luvus',
          config_ref: 'remote',
          binding_revision: 1,
          enabled: true
        },
        target: { ...f.config.target, provider_id: 'remote_provider' },
        contract: {
          binary_version: '0.14.3',
          binary_sha256: FIXED_LUVUS_SHA256,
          schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
          adapter_revision: MANAGED_LUVUS_REVISION,
          classification_revision: MANAGED_LUVUS_CLASSIFICATION,
          schema_bundle: readFileSync(
            new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url),
            'utf8'
          )
        }
      }
      await assert.rejects(
        createLuvusProductionSources().gateway({ state_dir: f.state }, [
          ...f.refs(),
          { reference: 'remote', value: remote }
        ]),
        /production_machine_source_conflict/
      )
      assert.equal(existsSync(f.marker), false)
    } finally {
      f.close()
    }
  }
)

/** 建立真实受保护目录与合成 root 记录；假 binary 的真实摘要不符，必须在任何 child 启动前拒绝。 */
function fixture(agentDirectory?: string) {
  const directory = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.production-luvus-')
  )
  const home = join(directory, 'home')
  const native = join(directory, 'native')
  const cwd = join(directory, 'project')
  const control = join(directory, 'control')
  const state = join(directory, 'connector')
  const directories = [
    native,
    home,
    cwd,
    ...['config', 'data', 'cache', 'runtime'].map(
      /** 与真实 root 相同的固定 XDG 私有目录。 */ (name) => join(home, name)
    )
  ]
  for (const path of [...directories.slice(0, 3), control, state, ...directories.slice(3)]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const binary = join(directory, 'untrusted-binary')
  const marker = join(directory, 'binary-ran')
  writeFileSync(binary, '#!/bin/sh\nprintf untrusted > "' + marker + '"\n', { mode: 0o500 })
  const config: LuvusLocalConfig = {
    target: { machine_id: 'machine1', provider_id: 'provider1', profile: 'session', session: 'session1' },
    binding_revision: 1,
    config_ref: 'config1',
    binary,
    binary_sha256: FIXED_LUVUS_SHA256,
    state_root: native,
    home,
    cwd,
    transport: 'ipc',
    ...(agentDirectory === undefined ? {} : { agent_bin_dirs: [agentDirectory], allow_terminal_execution: false })
  }
  const record = join(control, 'root.json')
  createNativeRecord(record, {
    format: 'rovloom-luvus-root-v1',
    root_id: 'root1',
    root_revision: 1,
    config,
    config_digest: createHash('sha256').update(boundedJson(config)).digest('hex'),
    custody_policy: { scopes: ['read'], methods: ['automation.list'], max_token_ttl_s: 60 },
    roots: directories.map(
      /** 只记录实际文件系统身份，不自造 PID、peer 或运行中来源。 */ (path) => [path, ownedPathStamp(path, 'directory')]
    ),
    created_at: Date.now()
  })
  const value: MutableOwnerConfig = {
    kind: 'luvus',
    authentication: 'local_owner',
    native: { mode: 'managed', root_record: record, expected_root_id: 'root1', expected_root_revision: 1 },
    principal_id: 'caller1',
    storage_mode: 'create'
  }
  return {
    directory,
    config,
    record,
    state,
    marker,
    value,
    reference: 'config1',
    /** 每次传独立已解析 JSON；工厂不能向其中注入 token、PID 或刷新原截止。 */
    refs() {
      return [{ reference: 'config1', value: structuredClone(value) }]
    },
    /** 只清本测试自有且未成功启动 child 的目录，不清未知 native 或用户数据。 */
    close() {
      assert.equal(existsSync(marker), false)
      assert.equal(existsSync(record + '.owner.lock'), false)
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

test(
  'CLI Luvus source loads the Agent directory only from its protected root config',
  /** 正式 provider 配置链接纳 root 内字段并继续执行原 binary 校验；假安装始终不能启动。 */ async () => {
    const f = fixture('/home/synthetic/Agent Tools/bin')
    try {
      await assert.rejects(
        createLuvusProductionSources().connector({ state_dir: f.state }, f.refs()),
        /binary_identity_changed/
      )
      assert.equal(f.config.allow_terminal_execution, false)
      const supplied = f.refs()[0]!
      await assert.rejects(
        createLuvusProductionSources().connector({ state_dir: f.state }, [
          { ...supplied, value: { ...supplied.value, agent_bin_dirs: ['/rpc/override'] } }
        ]),
        /production_reference_invalid/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'CLI Luvus root rejects a noncanonical Agent directory before any native execution',
  /** 路径先通过同一本地 pin 校验，不由伪造 root 摘要或外层 ref 扩大配置。 */ async () => {
    const f = fixture('relative/bin')
    try {
      await assert.rejects(
        createLuvusProductionSources().connector({ state_dir: f.state }, f.refs()),
        /agent_bin_dirs_invalid/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'production Gateway supports no local providers and shares its idempotent release result',
  /** 空引用不会启动、发现或猜测本机 session。 */ async () => {
    const resource = await createLuvusProductionSources().gateway({ state_dir: '/unused' }, [])
    assert.deepEqual(resource.providers, [])
    const first = resource.release()
    assert.equal(resource.release(), first)
    await first
  }
)

for (const value of [
  { kind: 'herdr' },
  { kind: 'luvus', authentication: 'delegated' },
  { kind: 'luvus', authentication: 'local_owner', native: { mode: 'managed' } }
]) {
  test(
    'production sources reject incomplete or unsupported owner references before resource acquisition ' +
      JSON.stringify(value),
    /** 配置 JSON 不能建立真实 Owner，也不能回退到开发 provider。 */ async () => {
      const refs = [{ reference: 'config1', value }]
      await assert.rejects(
        createLuvusProductionSources().connector({ state_dir: '/unused' }, refs),
        /production_reference_invalid/
      )
    }
  )
}

test(
  'production Connector requires exactly one explicit reference and snapshots without executing getters',
  /** 空列表、多 provider 和 getter 都不能被当作默认实例选择。 */ async () => {
    const sources = createLuvusProductionSources()
    await assert.rejects(sources.connector({ state_dir: '/unused' }, []), /production_reference_count_invalid/)
    await assert.rejects(
      sources.connector({ state_dir: '/unused' }, [
        { reference: 'one', value: {} },
        { reference: 'two', value: {} }
      ]),
      /production_reference_count_invalid/
    )
    let invoked = false
    const value = {
      /** 受保护 JSON 边界必须直接拒绝 accessor，不能读取它来得到伪造来源。 */
      get kind() {
        invoked = true
        return 'luvus'
      }
    }
    await assert.rejects(
      sources.connector({ state_dir: '/unused' }, [{ reference: 'config1', value }]),
      /production_reference_invalid/
    )
    assert.equal(invoked, false)
  }
)

test(
  'production reference modes, fixed storage choice and complete policies fail before opening a root',
  /** Gateway 不得再次启动 managed native；Connector 不得把 attach 当作自己拥有的 child。 */ async () => {
    const f = fixture()
    try {
      const sources = createLuvusProductionSources()
      await assert.rejects(sources.gateway({ state_dir: f.state }, f.refs()), /production_reference_invalid/)
      f.value.native = { ...f.value.native, mode: 'attach' }
      await assert.rejects(sources.connector({ state_dir: f.state }, f.refs()), /production_reference_invalid/)
      f.value.native = { ...f.value.native, mode: 'managed' }
      const incomplete = f.refs()
      delete (incomplete[0]!.value as unknown as Record<string, unknown>).storage_mode
      await assert.rejects(sources.connector({ state_dir: f.state }, incomplete), /production_reference_invalid/)
      assert.equal(existsSync(join(f.state, 'luvus-claims.db')), false)
    } finally {
      f.close()
    }
  }
)

test(
  'production binding config_ref and expected root identity cannot alias a different protected record',
  /** 合成 root 只证明配置文件身份；错误引用必须早于任何持久数据库和 native 启动。 */ async () => {
    const f = fixture()
    try {
      const sources = createLuvusProductionSources()
      const aliased = [{ reference: 'other_reference', value: f.value }]
      await assert.rejects(sources.connector({ state_dir: f.state }, aliased), /production_config_ref_mismatch/)
      f.value.native = { ...f.value.native, expected_root_id: 'other_root' }
      await assert.rejects(sources.connector({ state_dir: f.state }, f.refs()), /native_root_record_invalid/)
      assert.equal(existsSync(join(f.state, 'luvus-claims.db')), false)
    } finally {
      f.close()
    }
  }
)

test(
  'production open refuses missing claims without silently creating a replacement ledger',
  /** 正常启动丢库不能通过新空墓碑库继续执行。 */ async () => {
    const f = fixture()
    try {
      const refs = f.refs()
      refs[0]!.value = { ...refs[0]!.value, storage_mode: 'open' }
      await assert.rejects(
        createLuvusProductionSources().connector({ state_dir: f.state }, refs),
        /claim_ledger_missing/
      )
      assert.equal(existsSync(join(f.state, 'luvus-claims.db')), false)
      assert.equal(existsSync(join(f.state, 'luvus-claims.db.lock')), false)
    } finally {
      f.close()
    }
  }
)

test(
  'production startup rejects actual wrong binary bytes and releases the persistent lock without deleting facts',
  /** 使用真实持久实现和真实安装校验，绝不把模拟 native 成功当成生产来源。 */ async () => {
    const f = fixture()
    try {
      await assert.rejects(
        createLuvusProductionSources().connector({ state_dir: f.state }, f.refs()),
        /binary_identity_changed/
      )
      for (const name of ['luvus-claims.db']) {
        assert.equal(existsSync(join(f.state, name)), true)
        assert.equal(existsSync(join(f.state, name + '.lock')), false)
      }
      const ledgerId = hash(boundedJson(['config1', 'root1', 1, f.config.target]))
      const claims = new LuvusDispatchClaims({
        path: join(f.state, 'luvus-claims.db'),
        mode: 'open',
        ledger_id: ledgerId,
        limits: { entries: 1024, bytes: 4_194_304 },
        now: Date.now
      })
      claims.close()
    } finally {
      f.close()
    }
  }
)
