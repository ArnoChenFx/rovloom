// --unpair 与 join 自动重置：本地配对状态（含 managed 原生根）整体退役到 retired/，地址清空/换写，可从零重新配对。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { DISPATCH_CLAIMS_LOCK_FORMAT } from '../../src/connector/claims.js'
import { currentProcessIdentity } from '../../src/storage/process-identity.js'
import { configDocument, configTemplate, parseCommand, type ConnectorConfig } from '../../src/cli/index.js'
import { readConfig } from '../../src/cli/config.js'
import { handleConnectorUnpair, retirePairingState } from '../../src/cli/unpair.js'
import { CliSetup } from '../../src/cli/setup-runtime.js'

const secret = 's'.repeat(43)
const OTHER_CODE = 'ws://127.0.0.1:9#m_next.01234567-0123-4123-8123-012345678912.' + secret
const NEW_GATEWAY_CODE = 'ws://127.0.0.1:10#m_new.01234567-0123-4123-8123-012345678913.' + secret

function io() {
  let err = ''
  const stderr = new PassThrough()
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString()
  })
  return {
    value: { stdin: new PassThrough(), stdout: new PassThrough(), stderr, signal: new AbortController().signal },
    text: () => err
  }
}

/** 一台"已配对"的 Connector：凭据、providers、配对记录、原生根与账本俱在。 */
function pairedWorkspace(gatewayUrl: string) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-unpair-'))
  const path = join(root, 'connector.json')
  const config = { ...configTemplate('connector'), state_dir: root, gateway_url: gatewayUrl } as ConnectorConfig
  writeFileSync(path, JSON.stringify(configDocument(config), null, 2) + '\n', { mode: 0o600 })
  const managed = join(root, 'managed')
  mkdirSync(managed, { recursive: true })
  writeFileSync(
    join(managed, 'device.json'),
    JSON.stringify({ machine_id: 'm_other', recovery_generation: 'g1', credential: secret })
  )
  writeFileSync(
    join(managed, 'pairing.json'),
    JSON.stringify({
      schema_version: 1,
      attempt_id: 'a1',
      machine_id: 'm_other',
      gateway_url: gatewayUrl,
      phase: 'configured'
    })
  )
  writeFileSync(
    join(managed, 'providers.json'),
    JSON.stringify({ schema_version: 1, role: 'connector', providers: [] })
  )
  // managed 原生根：control（root 记录 + 账本）与隔离状态根 n/，重新配对要求它们回到空白。
  mkdirSync(join(root, 'control'), { recursive: true })
  writeFileSync(join(root, 'control', 'luvus-root.json'), '{"root_id":"r1"}')
  mkdirSync(join(root, 'n', 'deep'), { recursive: true })
  writeFileSync(join(root, 'n', 'deep', 'session.db'), 'data')
  return { root, path, config }
}

function retiredRoots(root: string): string[] {
  const retired = join(root, 'retired')
  return existsSync(retired) ? readdirSync(retired) : []
}

test('--unpair 把配对状态与原生根整体退役到 retired/，清空地址且幂等', async () => {
  const w = pairedWorkspace('ws://127.0.0.1:9')
  const out = io()
  try {
    const code = await handleConnectorUnpair(w.path, out.value)
    assert.equal(code, 0)
    assert.match(out.text(), /unpair_completed/)
    assert.match(out.text(), /retired/)
    // 配对文件与原生根都已搬走，原位置不留残迹。
    assert.equal(existsSync(join(w.root, 'managed', 'device.json')), false)
    assert.equal(existsSync(join(w.root, 'control')), false)
    assert.equal(existsSync(join(w.root, 'n')), false)
    assert.equal(retiredRoots(w.root).length, 1)
    const retired = join(w.root, 'retired', retiredRoots(w.root)[0]!)
    assert.equal(existsSync(join(retired, 'managed', 'device.json')), true)
    assert.equal(existsSync(join(retired, 'managed', 'pairing.json')), true)
    assert.equal(existsSync(join(retired, 'control', 'luvus-root.json')), true)
    assert.equal(existsSync(join(retired, 'n', 'deep', 'session.db')), true)
    // managed 实例的数据在退役目录里完整保留，可人工恢复。
    assert.equal(readFileSync(join(retired, 'n', 'deep', 'session.db'), 'utf8'), 'data')
    // 配置里的 Gateway 地址被清空。
    assert.equal((readConfig(w.path) as { gateway_url: string }).gateway_url, '')
    // 幂等：没有可退役状态时仍然成功。
    const again = io()
    assert.equal(await handleConnectorUnpair(w.path, again.value), 0)
    assert.match(again.text(), /unpair_completed/)
    assert.equal(retiredRoots(w.root).length, 1)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('--join 换 Gateway：旧状态自动退役、地址换写，无需先手工清理', async () => {
  const w = pairedWorkspace('ws://127.0.0.1:9')
  const setup = new CliSetup()
  const out = io()
  try {
    // 新 Gateway 的码：地址不同且机器身份不同；原生发现/网络在本机必然失败，断言的是重置与换写本身。
    await assert.rejects(setup.prepare(w.config, w.path, out.value, { join: NEW_GATEWAY_CODE }))
    // 旧凭据与旧原生根内容已退役；control 可能已被新的（失败的）配对尝试重建为空目录。
    assert.equal(existsSync(join(w.root, 'managed', 'device.json')), false)
    assert.equal(existsSync(join(w.root, 'control', 'luvus-root.json')), false)
    assert.equal(retiredRoots(w.root).length, 1)
    const retired = join(w.root, 'retired', retiredRoots(w.root)[0]!)
    assert.equal(existsSync(join(retired, 'managed', 'device.json')), true)
    assert.equal(existsSync(join(retired, 'control', 'luvus', 'root.json')), true)
    assert.equal(existsSync(join(retired, 'n', 'deep', 'session.db')), true)
    assert.equal((readConfig(w.path) as { gateway_url: string }).gateway_url, 'ws://127.0.0.1:10')
    assert.match(out.text(), /Joining a different Gateway|正在加入另一台 Gateway/)
  } finally {
    setup.close()
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('--join 同一 Gateway 换码：同样退役旧状态（managed 根回到空白才能重新初始化）', async () => {
  const w = pairedWorkspace('ws://127.0.0.1:9')
  const setup = new CliSetup()
  const out = io()
  try {
    await assert.rejects(setup.prepare(w.config, w.path, out.value, { join: OTHER_CODE }))
    assert.equal(existsSync(join(w.root, 'managed', 'device.json')), false)
    assert.equal(existsSync(join(w.root, 'control', 'luvus-root.json')), false)
    assert.equal(existsSync(join(w.root, 'n')), false)
    assert.equal(retiredRoots(w.root).length, 1)
    const retired = join(w.root, 'retired', retiredRoots(w.root)[0]!)
    assert.equal(existsSync(join(retired, 'n', 'deep', 'session.db')), true)
    // 地址相同不换写。
    assert.equal((readConfig(w.path) as { gateway_url: string }).gateway_url, 'ws://127.0.0.1:9')
  } finally {
    setup.close()
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('--join 某个 provider 没准备好：输出里点名是哪一个，而不是只有笼统的固定错误码', async () => {
  const w = pairedWorkspace('ws://127.0.0.1:9')
  // 只选 herdr-core：本机没有可附着的 core，准备必然失败；提示必须点名它，用户才知道该装好 core 还是改选 provider。
  const config = { ...w.config, native: { provider: 'herdr-core' as const } } as ConnectorConfig
  writeFileSync(w.path, JSON.stringify(configDocument(config), null, 2) + '\n', { mode: 0o600 })
  const setup = new CliSetup()
  const out = io()
  try {
    await assert.rejects(setup.prepare(config, w.path, out.value, { join: OTHER_CODE }))
    assert.match(out.text(), /setup_failed: could not prepare herdr-core\./u)
    // 点名那一行只含 provider 名，不带路径或异常内容（另一行「已退役到 <路径>」是既有提示）。
    const named = out
      .text()
      .split('\n')
      .find((line) => line.startsWith('setup_failed:'))!
    assert.doesNotMatch(named, /\/|Error|at /u)
  } finally {
    setup.close()
    rmSync(w.root, { recursive: true, force: true })
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

for (const lock of [
  'control/luvus/claims.db.lock',
  'control/herdr/claims.db.lock',
  'control/herdr-core/claims.db.lock'
]) {
  test(
    '退役配对状态前先确认 Connector 没在运行：' + lock + ' 有活着的持有者就拒绝，持有者已死则继续',
    { skip: !unixHost },
    async () => {
      const w = pairedWorkspace('ws://127.0.0.1:9')
      try {
        const path = join(w.root, lock)
        mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
        const config = readConfig(w.path) as ConnectorConfig
        // 当前进程就是「仍在运行的 Connector」。
        writeFileSync(
          path,
          JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: currentProcessIdentity() }),
          {
            mode: 0o600
          }
        )
        assert.throws(() => retirePairingState(config, { assertOwner() {} } as never), {
          code: 'configuration_required'
        })
        // 拒绝时什么都没动。
        assert.equal(existsSync(join(w.root, 'managed', 'device.json')), true)
        assert.equal(retiredRoots(w.root).length, 0)
        // 持有者已死（崩溃留下的锁）：允许所有者显式重置。
        writeFileSync(path, JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: await deadProcess() }), {
          mode: 0o600
        })
        assert.ok(retirePairingState(config, { assertOwner() {} } as never))
        assert.equal(existsSync(join(w.root, 'managed', 'device.json')), false)
      } finally {
        rmSync(w.root, { recursive: true, force: true })
      }
    }
  )
}

test('--join 同码重复执行：已配对状态原样保留，不退役', async () => {
  const w = pairedWorkspace('ws://127.0.0.1:9')
  const setup = new CliSetup()
  // 配对记录指向 m_other；同码 = 同一 Gateway 同一机器 → 视为已配对，直接返回。
  const sameMachineCode = 'ws://127.0.0.1:9#m_other.01234567-0123-4123-8123-012345678912.' + secret
  try {
    const result = await setup.prepare(w.config, w.path, io().value, { join: sameMachineCode })
    assert.equal(result, w.config)
    assert.equal(existsSync(join(w.root, 'managed', 'device.json')), true)
    assert.equal(retiredRoots(w.root).length, 0)
  } finally {
    setup.close()
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('CLI 解析：connector --unpair 可用且可与 --non-interactive 合用；错误归属仍明确', () => {
  const command = parseCommand(['connector', '--unpair'])
  assert.equal(command.action, 'connector')
  assert.equal('unpair' in command && command.unpair, true)
  const unattended = parseCommand(['connector', '--unpair', '--non-interactive'])
  assert.equal('unpair' in unattended && unattended.unpair, true)
  assert.equal('nonInteractive' in unattended && unattended.nonInteractive, true)
  assert.throws(() => parseCommand(['connector', '--unpair', 'extra']), { code: 'invalid_arguments' })
  assert.throws(() => parseCommand(['gateway', '--unpair']), { code: 'invalid_arguments' })
})

test('退役携带内容寻址 schema 与清单，中断重试继续同一批次且保留未知文件', () => {
  const w = pairedWorkspace('ws://127.0.0.1:9')
  try {
    const name = 'schema_' + 'a'.repeat(64) + '.json'
    const raw = '{ "keep": true }\n'
    writeFileSync(join(w.root, 'managed', name), raw, { mode: 0o600 })
    writeFileSync(join(w.root, 'managed', 'user-owned.json'), 'keep', { mode: 0o600 })
    // journal 发布前退出只会遗留程序自己的暂存文件，也必须随批次保留。
    writeFileSync(join(w.root, 'managed/control-migration-0.json'), '{"old":true}', { mode: 0o600 })
    const config = readConfig(w.path) as ConnectorConfig
    const retired = retirePairingState(config, { assertOwner() {} } as never)!
    assert.equal(readFileSync(join(retired, 'managed', name), 'utf8'), raw)
    assert.equal(existsSync(join(w.root, 'managed', name)), false)
    assert.equal(existsSync(join(w.root, 'managed/control-migration-0.json')), false)
    assert.equal(readFileSync(join(retired, 'managed/control-migration-0.json'), 'utf8'), '{"old":true}')
    assert(JSON.parse(readFileSync(join(retired, 'manifest.json'), 'utf8')).files.includes(name))
    // 模拟删除 journal 前进程退出：部分 source 已在同一批次，恢复不能新建另一批次。
    const batch = basename(retired)
    writeFileSync(
      join(w.root, 'managed/retirement.json'),
      JSON.stringify({ batch, files: [name, 'device.json'], directories: ['control'] }),
      { mode: 0o600 }
    )
    assert.equal(retirePairingState(config, { assertOwner() {} } as never), retired)
    assert.equal(existsSync(join(w.root, 'managed/retirement.json')), false)
    assert.equal(readFileSync(join(w.root, 'managed/user-owned.json'), 'utf8'), 'keep')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})
