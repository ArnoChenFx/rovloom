/** Herdr 生产来源的独立配置、双角色与 child 生命周期回归；合成子进程不提供任何原生身份或成功响应。 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createHerdrProductionSources,
  createHerdrChildOwner,
  assertHerdrProductionEndpointAbsent
} from '../../src/cli/production-herdr.js'
import { ProviderUnavailableError } from '../../src/cli/provider-unavailable.js'
import type { HerdrProductionOwnerConfig } from '../../src/cli/production-herdr.js'
import { CliError, configTemplate } from '../../src/cli/config.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { routeProductionSources } from '../../src/cli/product-sources.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'
import { checkProviderRequest } from '../runtime/provider-port-helpers.js'
import { contractRef } from '../../src/wire/index.js'

/** 真实私有路径和完整 pin 仅用于拒绝反例；假 binary 摘要不符，执行标记必须永远不存在。 */
function fixture() {
  const root = privateHerdrTestRoot('.cli-herdr-production-')
  for (const name of ['h', 'c', 's', 'a', 't', 'w', 'role', 'ledger']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  const schema = join(root, 'schema.json')
  copyFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), schema)
  chmodSync(schema, 0o600)
  const marker = join(root, 'untrusted-binary-executed')
  const binary = join(root, 'untrusted-binary')
  writeFileSync(binary, '#!/bin/sh\nprintf untrusted > "' + marker + '"\n', { mode: 0o700 })
  const target = {
    machine_id: 'machine_fixture',
    provider_id: 'herdr_fixture',
    profile: 'session' as const,
    session: 'owned'
  }
  const value: HerdrProductionOwnerConfig = {
    kind: 'herdr',
    native: { mode: 'managed' },
    config: {
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'herdr_fixture',
      expected_source: fixedHerdrSource(),
      schema_ref: schema,
      connector: {
        local: {
          target,
          binding_revision: 1,
          config_ref: 'herdr_fixture',
          binary,
          home: join(root, 'h'),
          config_home: join(root, 'c'),
          state_home: join(root, 's'),
          cache_home: join(root, 'a'),
          temporary_home: join(root, 't'),
          cwd: join(root, 'w')
        },
        principal_id: 'fixture_caller',
        claims: {
          path: join(root, 'ledger', 'claims.sqlite'),
          mode: 'open',
          ledger_id: 'fixture_claims',
          limits: { entries: 128, bytes: 1_048_576 }
        }
      }
    }
  }
  const template = configTemplate('connector')
  assert.equal(template.role, 'connector')
  if (template.role !== 'connector') {
    assert.fail('connector template required')
  }
  const config = {
    ...template,
    gateway_url: 'ws://127.0.0.1:9443',
    state_dir: join(root, 'role'),
    provider_config_refs: ['herdr_fixture']
  }
  return {
    root,
    value,
    config,
    schema,
    refs: /** 每次复制同一受保护配置；调用方更改 JSON 不应改变已经建立的来源。 */ () => [
      { reference: 'herdr_fixture', value: structuredClone(value) }
    ],
    close: /** 只删除本例未能启动 child 的自有目录，证明拒绝前没有执行不可信 binary。 */ () => {
      assert.equal(existsSync(marker), false)
      assert.equal(existsSync(join(root, 'c', '.rovloom-herdr-owned.owner.json')), false)
      assert.equal(existsSync(value.config.connector.claims.path), false)
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'actual Herdr installation identity and an existing endpoint preserve provider unavailability',
  /** 陌生原字节使用配置中的实际摘要，既有合成 socket 仍阻止 child/owner 创建且不被接管。 */ async () => {
    const f = fixture()
    try {
      const directory = join(f.value.config.connector.local.config_home, 'herdr', 'sessions', 'owned')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const socket = join(directory, 'herdr.sock')
      const bound = spawnSync('python3', [
        '-c',
        'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()',
        socket
      ])
      assert.equal(bound.status, 0)
      const before = lstatSync(socket, { bigint: true })
      writeFileSync(f.schema, Buffer.concat([readFileSync(f.schema), Buffer.from('\n')]))
      const value = structuredClone(f.value)
      value.config.expected_source.binary_version = 'synthetic-diagnostic'
      value.config.expected_source.binary_sha256 = createHash('sha256')
        .update(readFileSync(value.config.connector.local.binary))
        .digest('hex')
      value.config.expected_source.schema_sha256 = createHash('sha256').update(readFileSync(f.schema)).digest('hex')
      await assert.rejects(
        createHerdrProductionSources().connector!(f.config, [{ reference: 'herdr_fixture', value }]),
        /** 已核验陌生安装，但原不可用事实不能冒称 ready 或建立替代来源。 */ (error: unknown) => {
          assert(error instanceof ProviderUnavailableError)
          assert.deepEqual(error.provider.target, value.config.target)
          return true
        }
      )
      const after = lstatSync(socket, { bigint: true })
      assert.equal(after.dev, before.dev)
      assert.equal(after.ino, before.ino)
    } finally {
      f.close()
    }
  }
)

test(
  'Herdr 遗留拒连 socket 只声明该配置不可用，不删除端点、创建 owner 或尝试原生重启',
  /** Python 只绑定并关闭本例 Unix socket；没有 Herdr、模型、设备身份或用户 session。 */ () => {
    const f = fixture()
    try {
      const directory = join(f.value.config.connector.local.config_home, 'herdr', 'sessions', 'owned')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const socket = join(directory, 'herdr.sock')
      const bound = spawnSync('python3', [
        '-c',
        'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()',
        socket
      ])
      assert.equal(bound.status, 0)
      const before = lstatSync(socket, { bigint: true })
      assert(before.isSocket())
      assert.throws(
        /** 原生产 guard 只交付验证过的原配置，不创建可执行替代后端。 */ () =>
          assertHerdrProductionEndpointAbsent(f.value.config),
        /** 固定错误类型仅表示此配置不可用，不能据此接管或删除端点。 */ (error: unknown) => {
          assert(error instanceof ProviderUnavailableError)
          assert.deepEqual(error.provider.target, f.value.config.target)
          assert.equal(error.provider.binding.config_ref, 'herdr_fixture')
          return true
        }
      )
      const after = lstatSync(socket, { bigint: true })
      assert.equal(after.dev, before.dev)
      assert.equal(after.ino, before.ino)
    } finally {
      f.close()
    }
  }
)

test(
  'Herdr CLI loads the local Agent directory without opening terminal execution',
  /** 正式 factory 经过本地目录解析后继续拒绝假安装；外层与非法路径均不能成为替代配置。 */ async () => {
    const f = fixture()
    try {
      const source = createHerdrProductionSources()
      const local = {
        ...f.value.config.connector.local,
        agent_bin_dirs: [join(f.root, 'Agent Tools')],
        allow_terminal_execution: false
      }
      const value = { ...f.value, config: { ...f.value.config, connector: { ...f.value.config.connector, local } } }
      await assert.rejects(
        source.connector!(f.config, [{ reference: 'herdr_fixture', value }]),
        /herdr_binary_identity_changed/
      )
      await assert.rejects(
        source.connector!(f.config, [
          { reference: 'herdr_fixture', value: { ...value, agent_bin_dirs: local.agent_bin_dirs } }
        ]),
        { code: 'invalid_config' }
      )
      await assert.rejects(
        source.connector!(f.config, [
          {
            reference: 'herdr_fixture',
            value: {
              ...value,
              config: {
                ...value.config,
                connector: { ...value.config.connector, local: { ...local, agent_bin_dirs: ['relative/bin'] } }
              }
            }
          }
        ]),
        { code: 'invalid_config' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  'Connector 在任何文件或原生副作用前拒绝缺失、多引用、attach、别名与不完整政策',
  /** 只调用真实解析器，所有候选均在 schema/binary 读取前失败。 */ async () => {
    const f = fixture()
    try {
      const sources = createHerdrProductionSources()
      for (const refs of [
        [],
        [f.refs()[0]!, f.refs()[0]!],
        [{ reference: 'herdr_fixture', value: { kind: 'herdr' } }],
        [{ reference: 'other', value: f.value }],
        [{ reference: 'herdr_fixture', value: { ...f.value, native: { mode: 'attach' } } }],
        [{ reference: 'herdr_fixture', value: { ...f.value, arbitrary_module: 'SYNTHETIC_SECRET' } }]
      ]) {
        await assert.rejects(sources.connector!(f.config, refs), { code: 'invalid_config' })
      }
      let invoked = false
      const value = {
        /** getter 只用于拒绝探针；配置快照不得执行访问器来取得 provider kind。 */
        get kind() {
          invoked = true
          return 'herdr'
        }
      }
      await assert.rejects(sources.connector!(f.config, [{ reference: 'herdr_fixture', value }]), {
        code: 'invalid_config'
      })
      assert.equal(invoked, false)
    } finally {
      f.close()
    }
  }
)

test(
  '完整配置仍须通过真实 binary/schema，普通权限不能代替实际来源核验',
  /** 假binary可执行但摘要错误；普通文件权限不改变摘要与schema校验。 */ async () => {
    const f = fixture()
    try {
      const sources = createHerdrProductionSources()
      await assert.rejects(sources.connector!(f.config, f.refs()), { code: 'herdr_binary_identity_changed' })
      chmodSync(f.schema, 0o644)
      await assert.rejects(sources.connector!(f.config, f.refs()), { code: 'herdr_binary_identity_changed' })
      chmodSync(f.schema, 0o600)
      writeFileSync(f.schema, '{}')
      await assert.rejects(sources.connector!(f.config, f.refs()), { code: 'herdr_schema_unreviewed' })
    } finally {
      f.close()
    }
  }
)

test(
  'Gateway 原样保留完整 preflight 和中性资源，Connector 拒绝不会关闭另一角色资源',
  /** 真编译完整 schema；没有 child、peer 或凭据成功替身。 */ async () => {
    const f = fixture()
    const sources = createHerdrProductionSources()
    const authority = createManagementSessionAuthority({
      principal: /** 本例不建立 caller。 */ () => null,
      administrator: /** 本例不建立管理员。 */ () => null
    })
    let resource: Awaited<ReturnType<NonNullable<typeof sources.gateway>>> | undefined
    try {
      const template = configTemplate('gateway')
      if (template.role !== 'gateway') {
        assert.fail('gateway template required')
      }
      resource = await sources.gateway!(
        template,
        [{ reference: 'herdr_fixture', value: { kind: 'herdr', config: f.value.config } }],
        authority
      )
      assert.equal(resource.kind, 'provider')
      if (resource.kind !== 'provider') {
        assert.fail('neutral gateway required')
      }
      const provider = resource.providers[0]!
      assert.equal(typeof provider.admit, 'function')
      assert.throws(
        /** 缺 target/text 的 agent.prompt 在登记前收敛为确定未派发的公共预检码。 */ () =>
          checkProviderRequest(
            provider,
            { id: 'fixture_id', method: 'agent.prompt', params: {} },
            contractRef(fixedHerdrSource())
          ),
        { name: 'GatewayError', code: 'native_request_invalid' }
      )
      await assert.rejects(sources.connector!(f.config, f.refs()), { code: 'herdr_binary_identity_changed' })
      assert.equal(provider.ready(), true)
      await Promise.all([resource.release(), resource.release()])
      assert.throws(
        /** 已关闭的 Gateway 预检不能从同一 schema 文件恢复许可。 */ () =>
          checkProviderRequest(
            provider,
            { id: 'fixture_id', method: 'ping', params: {} },
            contractRef(fixedHerdrSource())
          ),
        /herdr_provider_closed/
      )
    } finally {
      await resource?.release()
      authority.close()
      f.close()
    }
  }
)

/** 只启动当前 Bun 的合成长驻 child，不运行 shell、Herdr、身份操作或模型。 */
async function syntheticChild(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--no-env-file', '-e', 'process.stdout.write("owned-ready\\n");setInterval(()=>{},1000)'],
    { env: {}, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  const [bytes] = await once(child.stdout!, 'data')
  assert.equal(String(bytes), 'owned-ready\n')
  return child
}

/** 测试故意拒绝信号后仍只清理自己原 child，等待实际 exit 后再销毁管道。 */
async function cleanupChild(child: ChildProcess, kill: ChildProcess['kill']): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    kill('SIGKILL')
    await exited
  }
  child.stdout?.destroy()
}

test(
  '直接 child 的 release 并发重入共享结果并等待真实退出',
  /** killed 不冒充退出；只观察原 ChildProcess 的事实。 */ async () => {
    const child = await syntheticChild()
    const kill = child.kill.bind(child)
    try {
      const owner = createHerdrChildOwner(child)
      const release = owner.release()
      assert.equal(owner.release(), release)
      await release
      assert.equal(owner.hasExited(), true)
      assert(child.exitCode !== null || child.signalCode !== null)
    } finally {
      await cleanupChild(child, kill)
    }
  }
)

test(
  'TERM 发送失败后仍对同一 child 尝试 KILL 并确认退出',
  /** 只注入首个信号失败；实际退出由真实 child 建立。 */ async () => {
    const child = await syntheticChild()
    const kill = child.kill.bind(child)
    const signals: unknown[] = []
    child.kill = /** TERM 失败不能被误认成 child 已停止。 */ (signal) => {
      signals.push(signal)
      return signal === 'SIGTERM' ? false : kill(signal)
    }
    try {
      const owner = createHerdrChildOwner(child)
      await owner.release()
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
      assert.equal(owner.hasExited(), true)
    } finally {
      await cleanupChild(child, kill)
    }
  }
)

test(
  '信号均失败保留关闭失败，迟到退出只更新观察不改判原 Promise',
  /** 已拥有但未确认退出的 child 不能被短等待伪造为释放成功。 */ async () => {
    const child = await syntheticChild()
    const kill = child.kill.bind(child)
    child.kill = /** 模拟实际无发送，生产关闭必须失败。 */ () => false
    try {
      const owner = createHerdrChildOwner(child, { grace_ms: 5, exit_ms: 10 })
      const release = owner.release()
      await assert.rejects(release, { code: 'herdr_production_child_signal_failed' })
      assert.equal(owner.hasExited(), false)
      await cleanupChild(child, kill)
      assert.equal(owner.hasExited(), true)
      assert.equal(owner.release(), release)
      await assert.rejects(owner.release(), { code: 'herdr_production_child_signal_failed' })
    } finally {
      await cleanupChild(child, kill)
    }
  }
)

test(
  '新来源兼容唯一 loader 的缺凭据前置校验，不读取CA也不得调用 provider',
  /** 程序管理状态只使用合成输入；不创建或签发设备凭据、不连接真实 Gateway。 */ async () => {
    const f = fixture()
    try {
      const managed = join(f.config.state_dir, 'managed')
      mkdirSync(managed, { mode: 0o700 })
      writeFileSync(
        join(managed, 'providers.json'),
        JSON.stringify({ schema_version: 1, role: 'connector', providers: f.refs() }),
        { mode: 0o600 }
      )
      const source = createHerdrProductionSources()
      let opened = 0
      const routed = routeProductionSources({
        herdr: {
          ...source,
          connector: /** 若进入则委托原真实 factory；本例必须在此前停止。 */ (...args) => {
            opened++
            return source.connector!(...args)
          }
        }
      })
      await assert.rejects(
        createProductionCliRuntime(routed).connector!(f.config),
        /** 固定错误不反射路径或任何合成秘密。 */ (error: unknown) =>
          error instanceof CliError && error.code === 'configuration_required'
      )
      assert.equal(opened, 0)
    } finally {
      f.close()
    }
  }
)
