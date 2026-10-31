import { providerSetupPath } from '../../src/cli/provider-control.js'
// 配对的真实失败边界：错误秘密不消费、并发兑换不互相终结、关闭打断 body、重载保留交付结果。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { PassThrough } from 'node:stream'
import { openGatewayState } from '../../src/runtime/state.js'
import {
  configTemplate,
  configDocument,
  CliError,
  type GatewayConfig,
  type ConnectorConfig
} from '../../src/cli/config.js'
import { SimplePairingHttp, PairingReplayCache } from '../../src/cli/simple-pairing.js'
import { parseCommand, runCli, type CliPrepareOptions, type CliRuntime } from '../../src/cli/run.js'
import { joinConnector } from '../../src/cli/join-connector.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import { writeSetupJson } from '../../src/cli/setup-files.js'
import { setupReference, setupTarget } from '../../src/cli/setup-targets.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { hash } from '../../src/wire/index.js'
import { GatewaySchemaGc, SCHEMA_GC_GRACE } from '../../src/cli/gateway-schema-gc.js'
import { publishSchema, schemaReference } from '../../src/connector/schema-store.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-pairing-recovery-'))
  mkdirSync(join(root, 'managed'), { mode: 0o700 })
  let http: SimplePairingHttp
  const state = openGatewayState({
    state_directory: root,
    changed() {},
    store: { management: (request) => http.authorizeManagement(request) }
  })
  const config = { ...configTemplate('gateway'), state_dir: root } as GatewayConfig
  const replays = new PairingReplayCache()
  http = new SimplePairingHttp(state, config, () => {}, replays)
  return {
    root,
    config,
    state,
    get http() {
      return http
    },
    reopen() {
      http = new SimplePairingHttp(state, config, () => {}, replays)
    },
    async close() {
      await http.close()
      state.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function installation(code: string) {
  const [machine, attempt] = code.split('.') as [string, string, string]
  const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
  const reference = setupReference(attempt, 'herdr')
  return {
    installations: [
      {
        reference,
        value: {
          kind: 'herdr',
          schema_bundle: raw,
          config: {
            version: 1,
            target: setupTarget(machine, 'herdr'),
            binding_revision: 1,
            config_ref: reference,
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
function post(code: string, manifest: unknown = installation(code)) {
  return new Request('http://127.0.0.1/pairing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, installation: manifest })
  })
}
function io() {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signal: new AbortController().signal
  }
}

test('真实异步配对保护已发布但尚未提交的 schema，提交后由新 registry 接续保留', async () => {
  const f = fixture()
  const gc = new GatewaySchemaGc(f.config, { retained: () => [], busy: () => f.http.publishing })
  let pending: Promise<Response> | undefined
  try {
    const issued = f.http.codes.create()
    const manifest = installation(issued.code)
    const raw = Buffer.from(manifest.installations[0]!.value.schema_bundle)
    const path = schemaReference(f.root, hash(raw))
    publishSchema(path, raw)
    writeSetupJson(runtimeReference(f.root, 'schema-gc'), {
      version: 1,
      checked_at: Date.now(),
      candidates: [{ file: basename(path), unreferenced_at: Date.now() - SCHEMA_GC_GRACE - 1000 }]
    })
    pending = f.http.handle(post(issued.code, manifest))!
    for (let turns = 0; !f.http.publishing && turns < 100; turns++) {
      await pause(1)
    }
    assert.equal(f.http.publishing, true)
    assert.equal(existsSync(runtimeReference(f.root, 'providers')), false)
    assert.equal(gc.sweep(), false)
    assert(existsSync(path))
    assert.equal((await pending).status, 200)
    assert.equal(f.http.publishing, false)
    assert.equal(gc.sweep(), true)
    assert(existsSync(path))
  } finally {
    gc.close()
    await pending
    await f.close()
  }
})

test('错误秘密不推进码状态，正确秘密随后仍可配对', async () => {
  const f = fixture()
  try {
    const issued = f.http.codes.create()
    const parts = issued.code.split('.')
    parts[2] = 'x'.repeat(43)
    assert.equal((await f.http.handle(post(parts.join('.'), {}))!).status, 409)
    assert.equal(f.http.codes.list()[0]!.status, 'unused')
    assert.equal((await f.http.handle(post(issued.code))!).status, 200)
    assert.equal(f.http.codes.list()[0]!.status, 'used')
  } finally {
    await f.close()
  }
})

test('同一码并发只有一次兑换，不会把成功请求的码标成 failed', async () => {
  const f = fixture()
  try {
    const issued = f.http.codes.create()
    const results = await Promise.all([f.http.handle(post(issued.code))!, f.http.handle(post(issued.code))!])
    assert.equal(results.filter((response) => response.status === 200).length, 1)
    assert(results.every((response) => [200, 409, 503].includes(response.status)))
    assert.equal(f.http.codes.list()[0]!.status, 'used')
  } finally {
    await f.close()
  }
})

test('关闭可取消占满额度的未完成请求体，不等待对端补完字节', { timeout: 2000 }, async () => {
  const f = fixture()
  let cancelled = 0
  try {
    const pending = Array.from({ length: 16 }, () =>
      f.http.handle(
        new Request('http://127.0.0.1/pairing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: new ReadableStream({
            cancel() {
              cancelled++
            }
          })
        })
      )!
    )
    assert.equal((await f.http.handle(post('m.a.' + 's'.repeat(43), {}))!).status, 503)
    await f.http.close()
    assert.equal(cancelled, 16)
    for (const response of await Promise.all(pending)) {
      assert.equal(response.status, 409)
    }
  } finally {
    await f.close()
  }
})

test('客户端取消也会释放未完成请求体的配对额度', { timeout: 2000 }, async () => {
  const f = fixture()
  const stop = new AbortController()
  let cancelled = false
  try {
    const pending = f.http.handle(
      new Request('http://127.0.0.1/pairing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: stop.signal,
        body: new ReadableStream({
          cancel() {
            cancelled = true
          }
        })
      })
    )!
    stop.abort()
    assert.equal((await pending).status, 409)
    assert.equal(cancelled, true)
    const issued = f.http.codes.create()
    assert.equal((await f.http.handle(post(issued.code))!).status, 200)
  } finally {
    await f.close()
  }
})

test('重载 listener 后同码返回同一凭据，失效凭据不再交付', async () => {
  const f = fixture()
  try {
    const issued = f.http.codes.create()
    const first = await f.http.handle(post(issued.code))!
    assert.equal(first.status, 200)
    const paired = (await first.json()) as { credential: string; mcp: { token: string } }
    await f.http.close()
    f.reopen()
    const replay = await f.http.handle(post(issued.code))!
    assert.equal(replay.status, 200)
    assert.deepEqual(await replay.json(), {
      state: 'paired',
      machine_id: issued.entry.machine_id,
      recovery_generation: f.state.store.generation(),
      ...paired,
      replayed: true
    })
    f.state.store.denyDelivery(issued.entry.machine_id, f.state.store.credentialDigest(issued.entry.machine_id)!)
    assert.equal((await f.http.handle(post(issued.code))!).status, 409)
  } finally {
    await f.close()
  }
})

test('重放缓存按 Gateway 与恢复代次隔离，并在十分钟后过期', () => {
  let now = 0
  const cache = new PairingReplayCache(() => now)
  const applied = { machine_id: 'm_test', recovery_generation: 'g1', credential: 's'.repeat(43) }
  cache.set('/one', 'g1', 'code', applied)
  assert.equal(cache.get('/one', 'g1', 'code'), applied)
  assert.equal(cache.get('/two', 'g1', 'code'), undefined)
  assert.equal(cache.get('/one', 'g2', 'code'), undefined)
  now = 600_000
  assert.equal(cache.get('/one', 'g1', 'code'), undefined)
})

test('新配对参数支持前后两种 --config 顺序，仍拒绝重复或冲突参数', () => {
  const value = 'ws://127.0.0.1:9443#m.a.' + 's'.repeat(43)
  for (const [role, flags] of [
    ['connector', ['--join', value]],
    ['connector', ['--unpair']],
    ['gateway', ['--issue-code']]
  ] as const) {
    const path = join(tmpdir(), role + '.json')
    for (const args of [
      [role, ...flags, '--config', path],
      [role, '--config', path, ...flags]
    ]) {
      const parsed = parseCommand(args)
      assert('path' in parsed)
      assert.equal(parsed.path, path)
    }
  }
  for (const args of [
    ['connector', '--join', value, '--unpair'],
    ['connector', '--unpair', '--join', value],
    ['gateway', '--issue-code', '--issue-code'],
    ['connector', '--config'],
    ['connector', '--join', value, '--config', '/one', '--config', '/two']
  ]) {
    assert.throws(() => parseCommand(args), { code: 'invalid_arguments' })
  }
})

test('non-interactive 仍执行显式 join 和 issue-code，普通服务启动不隐式配对', async () => {
  for (const role of ['connector', 'gateway'] as const) {
    const home = mkdtempSync(join(tmpdir(), 'rovloom-pairing-cli-'))
    let options: CliPrepareOptions | undefined
    const runtime: CliRuntime = {
      prepare: async (_config, _path, _io, supplied) => {
        options = supplied
        throw new CliError('configuration_required')
      }
    }
    try {
      const args =
        role === 'connector'
          ? ['connector', '--join', 'ws://127.0.0.1:9443#m.a.' + 's'.repeat(43)]
          : ['gateway', '--issue-code']
      assert.equal(await runCli([...args, '--non-interactive'], io(), runtime, { home, platform: process.platform }), 2)
      assert(options)
      if (role === 'connector') {
        assert.equal(options.join, args[2])
      } else {
        assert.equal(options.issueCode, true)
      }
      options = undefined
      await runCli([role, '--non-interactive'], io(), runtime, { home, platform: process.platform })
      assert.equal(options, undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

for (const [sameCode, edited] of [
  [false, false],
  [true, false],
  // 同一码，但半成品固化的 native 设置与现在的配置不同：不续传，退役重来（配置文件本来就是给用户改的）。
  [true, true]
] as const) {
  const resumed = sameCode && !edited
  test(`首次 join 的原生半成品${resumed ? '可由同一码继续' : sameCode ? '遇到 native 设置已改则退役重来' : '换新码后退役'}，不必手动 unpair`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'rovloom-partial-join-'))
    // 末尾路径门禁在恢复处理之后阻止任何 native 启动，测试不读取或修改用户的原生会话。
    const root = join(home, 'state-directory-too-long-for-managed-luvus-native-start')
    mkdirSync(join(root, 'managed'), { recursive: true, mode: 0o700 })
    const config = {
      ...configTemplate('connector'),
      state_dir: root,
      gateway_url: 'ws://127.0.0.1:9',
      native: { luvus: { mode: 'managed' } }
    } as ConnectorConfig
    const path = join(home, 'connector.json')
    writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
    const old = {
      schema_version: 1,
      attempt_id: 'a_old',
      machine_id: 'm_old',
      phase: 'prepared',
      settings: edited ? { luvus: { mode: 'attach' } } : config.native,
      reference: setupReference('a_old'),
      local: {},
      remote: {}
    }
    writeSetupJson(runtimeReference(root, 'native-setup'), old)
    mkdirSync(join(root, 'n'))
    writeFileSync(join(root, 'n', 'fixture-data'), 'keep')
    try {
      const value = `ws://127.0.0.1:9#${sameCode ? 'm_old.a_old' : 'm_new.a_new'}.` + 's'.repeat(43)
      await assert.rejects(joinConnector(config, path, io(), value), { code: 'configuration_required' })
      assert.equal(existsSync(providerSetupPath(root, 'luvus')), resumed)
      assert.equal(existsSync(join(root, 'n', 'fixture-data')), resumed)
      const retired = join(root, 'retired')
      if (resumed) {
        assert.equal(existsSync(retired), false)
      } else {
        const [name] = readdirSync(retired)
        assert.equal(readFileSync(join(retired, name!, 'n', 'fixture-data'), 'utf8'), 'keep')
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}
