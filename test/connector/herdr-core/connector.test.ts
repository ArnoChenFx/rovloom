/**
 * Connector 附着执行端：假 core 提供真实 framed 连接，测试用同形来源绕过 /proc 核对，
 * 但仍走原 Wire 准入、审核参数/结果与发送墓碑。身份核对本身在最后一个用例里对真实 /proc 失败关闭。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { HERDR_CORE_CLASSIFICATION_REVISION } from '../../../src/connector/herdr-core/methods.js'
import { DISPATCH_CLAIMS_LOCK_FORMAT } from '../../../src/connector/claims.js'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { herdrCorePinnedEndpoint } from '../../../src/connector/herdr-core/identity.js'
import type { HerdrCoreAttachment } from '../../../src/connector/herdr-core/installation.js'
import { HerdrCoreInstallation } from '../../../src/connector/herdr-core/installation.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { boundedJson, contractRef, hash } from '../../../src/wire/index.js'
import type { Connection } from '../../../src/transport/index.js'
import type { AttemptBinding, ContractSource, JsonObject, V2Target } from '../../../src/wire/types.js'
import { currentProcessIdentity } from '../../../src/storage/process-identity.js'
import { privateHerdrTestRoot } from '../herdr/private-root.js'
import { startFakeCore } from './fake-core.js'

const OPENRPC = readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
const DOCUMENT = boundedJson(JSON.parse(OPENRPC.toString('utf8')))
const CONTRACT = compileHerdrCoreContract(DOCUMENT)

const target: V2Target & { profile: 'session' } = {
  machine_id: 'm1',
  provider_id: 'herdr-core',
  profile: 'session',
  session: 'test'
}
const source: ContractSource = Object.freeze({
  provider_kind: 'herdr-core',
  protocol_family: 'herdr-core-jsonrpc',
  binary_version: '0.1.14',
  binary_sha256: 'a'.repeat(64),
  schema_sha256: hash(DOCUMENT),
  schema_origin: 'live_instance',
  schema_command: 'rpc.discover',
  server_version: '0.1.14',
  native_protocol_version: '1',
  runtime_generation: null,
  adapter_revision: 'adapter-herdr-core-1',
  classification_revision: HERDR_CORE_CLASSIFICATION_REVISION,
  support_basis: 'schema_and_version'
})
const reference = contractRef(source)

/** 只在 0700 临时目录里建立可读的 schema 文件与配置。 */
function fixture(core: Awaited<ReturnType<typeof startFakeCore>>) {
  const root = privateHerdrTestRoot('rovloom-hc-connector-')
  const schemaPath = schemaReference(root, source.schema_sha256)
  mkdirSync(dirname(schemaPath), { recursive: true, mode: 0o700 })
  publishSchema(schemaPath, Buffer.from(DOCUMENT, 'utf8'))
  const config = {
    version: 1 as const,
    target,
    binding_revision: 1,
    config_ref: 'herdr-core_ref',
    expected_source: source,
    schema_ref: schemaPath,
    connector: {
      session: 'test',
      endpoint: { runtime_dir: core.directory },
      principal_id: 'principal_a',
      claims: {
        path: join(root, 'claims.db'),
        mode: 'create' as const,
        ledger_id: 'claim_ledger',
        limits: { entries: 16, bytes: 1_048_576 }
      }
    }
  }
  return { root, config }
}

/** 真实连接 + 真实契约，只省略 /proc 身份核对；生产路径仍使用 HerdrCoreInstallation。 */
async function attachment(core: Awaited<ReturnType<typeof startFakeCore>>): Promise<HerdrCoreAttachment> {
  const client = await openHerdrCoreClient(core.socket)
  const record = Object.freeze({
    wire: Object.freeze({ source, support_status: 'validated' as const }),
    contract: CONTRACT
  })
  return Object.freeze({
    record: () => record,
    client: () => client,
    ensure: /** 测试来源始终可用：真实重新附着在 installation 的用例里覆盖。 */ async () => {},
    invalidate: () => {},
    status: () => ({ state: 'attached' as const, core_id: client.hello.core.id, attempts: 0, last_error: null }),
    assert: () => {},
    source: /** 只承认本测试的完整目标与契约摘要。 */ (binding: AttemptBinding) =>
      binding.provider_kind === 'herdr-core' &&
      boundedJson(binding.target) === boundedJson(target) &&
      binding.contract_ref === reference,
    endpoint: () => herdrCorePinnedEndpoint({ runtime_dir: core.directory }, 'test'),
    close: () => client.close()
  })
}

function connection(): Connection {
  return {
    machine_id: 'm1',
    recovery_generation: 'recovery_1',
    connection_epoch: 'epoch_1',
    authenticated: true,
    active: true,
    negotiated: { major: 2, minor: 0, capabilities: ['rpc'] }
  } as Connection
}

/** 构造与 Gateway 编码结果同形的原始请求；Connector 的准入与 Wire codec 仍完整校验。 */
function request(method: string, params: JsonObject, id = '1', deadline = Date.now() + 60_000): string {
  return boundedJson({
    protocol_major: 2,
    protocol_minor: 0,
    message_id: 'message_' + id,
    machine_id: 'm1',
    recovery_generation: 'recovery_1',
    connection_epoch: 'epoch_1',
    type: 'request',
    payload: {
      attempt: {
        call_id: 'call_' + id,
        attempt_id: 'attempt_' + id,
        native_request_id: 'native_' + id,
        target,
        provider_kind: 'herdr-core',
        binding_revision: 1,
        contract_ref: reference,
        registration: { deadline }
      },
      expected_binding_revision: 1,
      native_request: { method, params },
      validation: 'strict'
    }
  })
}

test('Connector 只通过已审核的 5 个读取执行原生调用', async () => {
  const core = await startFakeCore({ discover: JSON.parse(OPENRPC.toString('utf8')) })
  const { root, config } = fixture(core)
  const attached = await attachment(core)
  const resources = await createHerdrCoreConnectorResources({
    config,
    now: Date.now,
    open: async () => attached
  })
  try {
    const session = resources.session(connection())
    let index = 0
    for (const [method, params] of [
      ['server.status', {}],
      ['terminal.list', {}],
      ['terminal.get', { terminal: 't1' }],
      ['terminal.read', { terminal: 't1', lines: 0 }],
      ['terminal.wait', { terminal: 't1', timeout: 0.2 }]
    ] as const) {
      index += 1
      const raw = request(method, params, String(index))
      // 与 transport 相同顺序：先由 session adapter 准入，再交给执行端。
      session.adapter.decode(raw, 'gateway_to_connector')
      const result = await session.executeWire(raw, new AbortController().signal)
      assert.equal(result.binding.call_id, 'call_' + index)
      assert.equal(typeof result.native_response, 'object')
    }
    assert.deepEqual(core.requests, [
      'server.status',
      'terminal.list',
      'terminal.get',
      'terminal.read',
      'terminal.wait'
    ])
    assert.equal(session.readiness().providers[0]?.native_ready, true)
    session.close()
  } finally {
    await resources.release()
    await core.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// 崩溃恢复依赖进程身份证据：Linux（/proc）与 macOS（libproc）有，Windows 另有 e2e。
const unixHost = process.platform === 'linux' || process.platform === 'darwin'

/** 退出后的真实子进程提供「PID 曾存在且已死」的身份。 */
async function deadProcess() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const identity = currentProcessIdentity(child.pid!)
  await once(child, 'close')
  return identity ?? { pid: child.pid!, start: '1' }
}

test(
  'Connector 被强杀后残留的 claim 账本锁：持有者已死则接管并正常启动，其余一律保持 fail-closed',
  { skip: !unixHost },
  async () => {
    const dead = await deadProcess()
    type Outcome = 'fresh' | 'recovered' | 'refused'
    const attempt = async (
      lock: string | undefined
    ): Promise<{ outcome: Outcome; recovered: number; lockKept: boolean }> => {
      const core = await startFakeCore({ discover: JSON.parse(OPENRPC.toString('utf8')) })
      const { root, config } = fixture(core)
      const lockPath = config.connector.claims.path + '.lock'
      if (lock !== undefined) {
        writeFileSync(lockPath, lock, { mode: 0o600 })
      }
      let recovered = 0
      const attached = await attachment(core)
      try {
        const resources = await createHerdrCoreConnectorResources({
          config,
          now: Date.now,
          open: async () => attached,
          claims_lock_recovered: () => {
            recovered += 1
          }
        })
        // 启动成功时锁由本进程持有：释放后消失，说明确实（重新）取得了账本。
        assert.equal(existsSync(lockPath), true)
        await resources.release()
        assert.equal(existsSync(lockPath), false)
        return { outcome: recovered > 0 ? 'recovered' : 'fresh', recovered, lockKept: false }
      } catch (error) {
        assert.equal((error as { code?: string }).code, 'claim_storage_unavailable', String(error))
        attached.close()
        return { outcome: 'refused', recovered, lockKept: existsSync(lockPath) }
      } finally {
        await core.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
    // 没有残留锁：照常启动，不报告接管。
    assert.deepEqual(await attempt(undefined), { outcome: 'fresh', recovered: 0, lockKept: false })
    // 持有者已死：接管并启动，恰好报告一次。
    assert.deepEqual(await attempt(JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: dead })), {
      outcome: 'recovered',
      recovered: 1,
      lockKept: false
    })
    // 持有者还活着、空锁、坏内容、旧格式：保持拒绝，锁原样保留、不报告接管。
    for (const lock of [
      JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: currentProcessIdentity() }),
      '',
      'not json',
      JSON.stringify({ format: 'other', process: dead })
    ]) {
      assert.deepEqual(await attempt(lock), { outcome: 'refused', recovered: 0, lockKept: true }, lock)
    }
  }
)

test('宿主级方法与 blocked 参数在 Wire 与原生请求之前被拒绝', async () => {
  const core = await startFakeCore({ discover: JSON.parse(OPENRPC.toString('utf8')) })
  const { root, config } = fixture(core)
  const attached = await attachment(core)
  const resources = await createHerdrCoreConnectorResources({
    config,
    now: Date.now,
    open: async () => attached
  })
  try {
    const session = resources.session(connection())
    for (const [method, params] of [
      // 控制档已开放、栅栏字段可省略；这里被拒是因为 `machine/t7` 走远端路由、no_parent 只收 true、caller 一律拒绝。
      ['terminal.send', { terminal: 'machine/t1', text: 'x' }],
      ['terminal.keys', { terminal: 't1', core_id: 'zz', keys: ['Enter'] }],
      ['terminal.run', { argv: ['sh', '-c', 'id'], no_parent: false }],
      ['terminal.get', { terminal: 't1', caller: 't2' }]
    ] as const) {
      const raw = request(method, params)
      assert.throws(() => session.adapter.decode(raw, 'gateway_to_connector'))
    }
    assert.deepEqual(core.requests, [])
    session.close()
  } finally {
    await resources.release()
    await core.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('真实 /proc 事实不匹配时附着失败关闭，而不是照自报值放行', async () => {
  const core = await startFakeCore({ discover: JSON.parse(OPENRPC.toString('utf8')) })
  try {
    await assert.rejects(
      HerdrCoreInstallation.open({
        config: { session: 'test', endpoint: { runtime_dir: core.directory } },
        expected: source
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'herdr_core_peer_argv_untrusted'
    )
  } finally {
    await core.close()
  }
})

test('契约摘要不属于本次审核时在编译与身份核对之前拒绝', async () => {
  const core = await startFakeCore({ discover: JSON.parse(OPENRPC.toString('utf8')) })
  try {
    await assert.rejects(
      HerdrCoreInstallation.open({
        config: { session: 'test', endpoint: { runtime_dir: core.directory } },
        expected: { ...source, schema_sha256: 'b'.repeat(64) }
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'herdr_core_schema_unreviewed'
    )
  } finally {
    await core.close()
  }
})
