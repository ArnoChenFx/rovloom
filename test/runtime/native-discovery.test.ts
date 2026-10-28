/** 用合成安装、未知原字节和离线原生契约验证按协议/能力接纳；不启动用户会话或调用模型。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { attachExistingLuvus } from '../../src/connector/luvus/host/native-attach.js'
import { discoverLuvusInstallation, readLuvusVersion } from '../../src/connector/luvus/host/native-control.js'
import { initializeManagedLuvusRoot } from '../../src/connector/luvus/host/native-root.js'
import { observedLuvusContract, MANAGED_LUVUS_REVISION } from '../../src/connector/luvus/host/native-source.js'
import { compileBundle, createNativeValidator } from '../../src/connector/luvus/contract/index.js'
import type { LuvusLocalConfig } from '../../src/connector/luvus/types.js'
import { unknownSchemaBundle } from '../connector/luvus/contract/unknown-schema-fixture.js'
import { validateProviderSnapshot } from '../../src/wire/index.js'
import { providerIsolationFixture } from '../transport/provider-isolation-helpers.js'
import { until } from '../transport/helpers.js'
import { G } from '../connector/luvus/contract/helpers.js'

/** 为被测安装生成原字节摘要，与任何内嵌发行版摘要无关。 */
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 合成私有目录只含无害 CLI 脚本与测试 schema，清理由本测试负责。 */
function fixture() {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.native-discovery-')
  )
  for (const name of ['home', 'home/config', 'home/data', 'home/cache', 'home/runtime', 'state', 'cwd', 'control']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  const schema =
    readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8') + '\n'
  writeFileSync(join(root, 'schema.json'), schema, { mode: 0o600 })
  const binary = join(root, 'synthetic-luvus')
  const source = `#!/bin/sh
case "$*" in
--version) printf 'luvus synthetic-future-version\\n' ;;
'--session synthetic uhp schema') /bin/cat '${root.replaceAll("'", "'\\''")}/schema.json' ;;
'--session synthetic session list --json') printf '{"sessions":[]}\\n' ;;
*) exit 99 ;;
esac
`
  writeFileSync(binary, source, { mode: 0o500 })
  const config: LuvusLocalConfig = {
    target: {
      machine_id: 'synthetic-machine',
      provider_id: 'synthetic-provider',
      profile: 'session',
      session: 'synthetic'
    },
    binding_revision: 1,
    config_ref: 'synthetic-config',
    binary,
    binary_sha256: hash(source),
    state_root: join(root, 'state'),
    home: join(root, 'home'),
    cwd: join(root, 'cwd'),
    transport: 'ipc',
    allow_terminal_execution: false
  }
  return { root, schema, config }
}

test(
  'actual capability discovery composes with provider isolation without restoring a fenced source',
  /** 合成安装走真实发现/编译，原 Wire/Store 负责隔离；执行和身份仍是无生产效力 fixture。 */ async () => {
    const f = fixture()
    let w: ReturnType<typeof providerIsolationFixture> | undefined
    try {
      const discovered = await discoverLuvusInstallation(f.config, {
        revision: MANAGED_LUVUS_REVISION,
        signal: new AbortController().signal
      })
      const frame = JSON.parse(
        readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
      )
      frame.result.session = 'synthetic'
      frame.result.server_generation = G
      frame.result.method_contracts.find(
        /** 兼容诊断扩展仍保留在实际快照。 */ (row: any) => row.method === 'agent.prompt'
      ).future_diagnostic = 'optional'
      const observed = observedLuvusContract(
        discovered.config,
        discovered.compiled,
        { frame, result: frame.result },
        discovered.binaryVersion
      )
      assert.equal(observed.wire.source.server_version, null)
      assert.equal(observed.wire.source.binary_sha256, hash(readFileSync(f.config.binary)))
      w = providerIsolationFixture(observed)
      const active = w
      const client = active.connect()
      await until(
        /** 两个实际发现快照均经原 codec 和 provider 路由接纳。 */ () => {
          const providers = active.f.gateway.status().devices[0]?.providers ?? []
          return (
            client.status().phase === 'ready' &&
            providers.length === 2 &&
            providers.every(/** 各来源独立 ready。 */ (provider) => provider.ready)
          )
        }
      )
      const epoch = client.status().connection_epoch
      const failed = active.f.call(active.targets[0]!)
      const healthy = active.f.call(active.targets[1]!)
      active.f.gateway.dispatch(failed.call_id)
      active.f.gateway.dispatch(healthy.call_id)
      await until(
        /** 原调用均已进入真实持久 accepted 状态。 */ () =>
          [failed, healthy].every(
            /** 按各自原调用读取账本。 */ (call) =>
              active.f.store.call(active.f.principal.id, call.call_id).state === 'connector_accepted'
          )
      )
      active.state.changed.add(active.targets[0]!.provider_id)
      await until(
        /** 同 epoch 替换发现结果只撤回该来源，原调用收敛 unknown。 */ () =>
          active.f.store.call(active.f.principal.id, failed.call_id).state === 'outcome_unknown'
      )
      assert.equal(active.work.get(failed.call_id)!.signal.aborted, true)
      assert.equal(active.work.get(healthy.call_id)!.signal.aborted, false)
      active.state.changed.delete(active.targets[0]!.provider_id)
      active.work.get(failed.call_id)!.finish()
      active.work.get(healthy.call_id)!.finish()
      await until(
        /** 健康调用仍用原 permit 完成响应及结果读取绑定。 */ () =>
          active.f.store.call(active.f.principal.id, healthy.call_id).state === 'responded'
      )
      assert.equal(active.f.store.call(active.f.principal.id, healthy.call_id).state, 'responded')
      assert.equal(active.f.gateway.resolveOriginalRead(failed.call_id), undefined)
      assert.equal(active.f.store.call(active.f.principal.id, failed.call_id).state, 'outcome_unknown')
      assert.equal(active.f.gateway.status().connections, 1)
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(client.status().reconnects, 0)
      const blocked = active.f.call(active.targets[0]!)
      assert.throws(
        /** 广告恢复不能复活原 epoch 的失效配置。 */ () => active.f.gateway.dispatch(blocked.call_id),
        /provider_not_ready/
      )
      assert.equal(active.state.executions.length, 2)
    } finally {
      w?.stop()
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  'Luvus accepts an actual installation hash and retains an unfamiliar version for diagnostics',
  /** 只执行合成版本、schema 和空列表命令；不存在可接管或启动的原生会话。 */ async () => {
    const f = fixture()
    try {
      assert.equal(await readLuvusVersion(f.config, new AbortController().signal), 'synthetic-future-version')
      const root = await initializeManagedLuvusRoot({
        record_path: join(f.root, 'control', 'root.json'),
        config: f.config
      })
      assert.equal(root.config.binary_sha256, hash(readFileSync(f.config.binary)))
      assert.equal(root.config.allow_terminal_execution, false)
      root.close()
      // 已越过安装/版本/schema 接纳，按实际空列表报告目标不可用，未启动 native server。
      await assert.rejects(attachExistingLuvus(f.config), { code: 'native_session_unavailable' })
      const declared = { ...f.config, binary_sha256: '0'.repeat(64) }
      const discovered = await discoverLuvusInstallation(declared, {
        revision: MANAGED_LUVUS_REVISION,
        signal: new AbortController().signal
      })
      assert.equal(discovered.config.binary_sha256, f.config.binary_sha256)
      assert.equal(discovered.config.allow_terminal_execution, false)
      const frame = JSON.parse(
        readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
      )
      frame.result.session = 'synthetic'
      const observed = observedLuvusContract(
        discovered.config,
        discovered.compiled,
        { frame, result: frame.result },
        'synthetic-future-version'
      )
      assert.equal(observed.wire.source.binary_version, 'synthetic-future-version')
      assert.equal(observed.wire.source.server_version, null)
      assert.equal(observed.wire.source.schema_sha256, hash(f.schema))
      const snapshot = {
        binding: {
          machine_id: f.config.target.machine_id,
          provider_id: f.config.target.provider_id,
          kind: 'luvus',
          config_ref: f.config.config_ref,
          binding_revision: f.config.binding_revision,
          enabled: true
        },
        target: f.config.target,
        source: observed.wire.source,
        capabilities: observed.capabilities,
        capability_revision: observed.capability_revision
      }
      assert.doesNotThrow(/** 缺少诊断版本不妨碍真实自动发现结果进入 Wire。 */ () => validateProviderSnapshot(snapshot))
      for (const field of ['native_protocol_version', 'runtime_generation', 'classification_revision']) {
        assert.throws(
          /** 必需协议、运行代次与分类事实仍不能省略。 */ () =>
            validateProviderSnapshot({ ...snapshot, source: { ...snapshot.source, [field]: null } }),
          /provider_snapshot_source_invalid/
        )
      }
      assert.throws(
        /** 快照目标必须继续绑定同一台机器。 */ () =>
          validateProviderSnapshot({ ...snapshot, target: { ...snapshot.target, machine_id: 'other-machine' } }),
        /provider_snapshot_binding_mismatch/
      )
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  'Luvus compiles an unknown RPC schema without optional terminal, event or access interfaces',
  /** 未命中资产的合成契约必须真实编译完整根，仍检查请求/响应约束。 */ async () => {
    const bundle = JSON.parse(unknownSchemaBundle())
    bundle.protocol.minor = 9
    for (const name of ['terminal', 'event', 'event_catalog', 'access']) {
      delete bundle[name]
    }
    for (const key of Object.keys(bundle.documents)) {
      if (!key.endsWith('/request.schema.json') && !key.endsWith('/response.schema.json')) {
        delete bundle.documents[key]
      }
    }
    const bytes = JSON.stringify(bundle)
    const result = await compileBundle(bytes, {
      identity: { binary_sha256: 'd'.repeat(64), schema_sha256: hash(bytes), revision: 'synthetic' }
    })
    assert(result.ok, JSON.stringify(result))
    const validator = createNativeValidator(result.value)
    assert(
      validator.checkResponseShape({
        id: 'synthetic',
        error: { code: 'synthetic', message: '😀a', data: { preserved: true } }
      }).ok
    )
    assert(
      !validator.checkResponseShape({
        id: 'synthetic',
        error: { code: 'synthetic', message: 'a', data: { preserved: true } }
      }).ok
    )
  }
)

test(
  'Luvus keeps RPC capabilities usable without terminal metadata and still enforces the general frame limit',
  /** 仅合成协议数据进入真实校验器；省略可选终端接口不解除普通 RPC 限额。 */ async () => {
    const bundle = JSON.parse(unknownSchemaBundle())
    bundle.response.properties = { id: { type: 'string' }, result: { type: 'object' } }
    bundle.response.required = ['id', 'result']
    bundle.documents[bundle.response.$id] = bundle.response
    const bytes = JSON.stringify(bundle)
    const compiled = await compileBundle(bytes, {
      identity: { binary_sha256: 'd'.repeat(64), schema_sha256: hash(bytes), revision: 'synthetic' }
    })
    assert(compiled.ok)
    const validator = createNativeValidator(compiled.value)
    const target = { machine_id: 'synthetic', profile: 'session' as const, session: 'synthetic' }
    const caps = {
      id: 'synthetic',
      result: {
        type: 'uhp_capabilities',
        protocol: { name: 'luvus-uhp', major: 1, minor: 0 },
        session: 'synthetic',
        server_generation: 'synthetic',
        methods: ['synthetic.packaging'],
        method_contracts: [{ method: 'synthetic.packaging', access: 'read', scope: 'workspace', idempotent: true }],
        limits: { frame_bytes: 256 }
      }
    }
    const source = {
      authenticated: true,
      source_verified: true,
      binding: {
        kind: 'luvus' as const,
        provider_id: 'synthetic',
        binding_revision: 1,
        contract_source_ref: 'synthetic',
        target,
        server_generation: 'synthetic',
        connection_epoch: 'synthetic',
        recovery_generation: 'synthetic',
        capability_revision: 'synthetic',
        classification_revision: 'synthetic',
        contract: compiled.value.identity
      }
    }
    const view = validator.bindCapabilities(caps, source)
    assert(view.ok, JSON.stringify(view))
    assert(validator.checkRequest(view.value, { id: 'synthetic', method: 'synthetic.packaging', params: {} }).ok)
    assert(
      !validator.checkRequest(view.value, {
        id: 'synthetic',
        method: 'synthetic.packaging',
        params: { text: 'x'.repeat(300) }
      }).ok
    )
    caps.result.limits.frame_bytes = 0
    assert(!validator.checkCapabilitiesShape(caps, { target, server_generation: 'synthetic' }).ok)
  }
)

test(
  'Luvus version-command absence or a slow diagnostic does not block compatible interfaces',
  /** 仅执行本例拥有的无害退出/sleep 进程；父信号取消仍须原样失败。 */ async () => {
    const f = fixture()
    try {
      for (const program of ['#!/bin/sh\nexit 2\n', '#!/bin/sh\nexec /bin/sleep 5\n']) {
        chmodSync(f.config.binary, 0o700)
        writeFileSync(f.config.binary, program)
        chmodSync(f.config.binary, 0o500)
        const config = { ...f.config, binary_sha256: hash(program) }
        assert.equal(await readLuvusVersion(config, new AbortController().signal), 'unavailable')
      }
      const signal = new AbortController()
      signal.abort('cancelled')
      const config = { ...f.config, binary_sha256: hash(readFileSync(f.config.binary)) }
      await assert.rejects(readLuvusVersion(config, signal.signal), { code: 'native_cancelled' })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)
