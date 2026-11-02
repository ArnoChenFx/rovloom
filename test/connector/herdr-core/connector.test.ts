/**
 * Connector 附着执行端：假 core 提供真实 framed 连接，测试用同形来源绕过 /proc 核对，
 * 但仍走原 Wire 准入、审核参数/结果与发送墓碑。身份核对本身在最后一个用例里对真实 /proc 失败关闭。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { DISPATCH_CLAIMS_LOCK_FORMAT } from '../../../src/connector/claims.js'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import { HerdrCoreInstallation } from '../../../src/connector/herdr-core/installation.js'
import { currentProcessIdentity } from '../../../src/storage/process-identity.js'
import { startFakeCore } from './fake-core.js'
import { OPENRPC, source, fixture, attachment, connection, request } from './connector-harness.js'

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
