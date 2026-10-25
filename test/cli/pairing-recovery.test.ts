// 配对的真实失败边界：错误秘密不消费、并发兑换不互相终结、关闭打断 body、重载保留交付结果。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { openGatewayState } from '../../src/runtime/index.js'
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
import { setupReference, setupTarget, simpleSetupAuthorization } from '../../src/cli/setup-policy.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { hash } from '../../src/wire/index.js'
import { writeAdminFiles } from '../../src/cli/admin-command.js'

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
    state,
    config,
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

test('旧 Gateway 的配对沿用原主体和谱系，保留旧设备与原 MCP 令牌', { timeout: 20_000 }, async () => {
  const f = fixture()
  try {
    const first = f.http.codes.create()
    assert.equal((await f.http.handle(post(first.code))!).status, 200)
    const lineage = first.entry.code_id
    const actor = 'operator_' + lineage
    const clientPath = runtimeReference(f.config.state_dir, 'mcp-client')
    const callersPath = runtimeReference(f.config.state_dir, 'mcp-callers')
    const providersPath = runtimeReference(f.config.state_dir, 'providers')
    const client = JSON.parse(readFileSync(clientPath, 'utf8'))
    const callers = JSON.parse(readFileSync(callersPath, 'utf8'))
    const providers = JSON.parse(readFileSync(providersPath, 'utf8'))
    // 0.6.0 的受保护记录形状：首台设备的 attempt 是后续设备共用的谱系，主体不是 simple 常量。
    client.principal_id = actor
    callers.local_policy.revision = 'setup_local_' + lineage
    callers.callers[0].principal.id = actor
    callers.callers[0].principal.policy.revision = 'setup_caller_' + lineage
    providers.providers[0].value.config.peer_policy_revision = 'setup_local_' + lineage
    for (const [path, value] of [
      [clientPath, client],
      [callersPath, callers],
      [providersPath, providers]
    ] as const) {
      writeSetupJson(path, value, true, 1_048_576)
    }
    const oldProvider = structuredClone(providers.providers[0])
    const oldCredential = f.state.store.credentialDigest(first.entry.machine_id)
    const oldToken = callers.callers[0].token_sha256
    const second = f.http.codes.create()
    const request = new Request('http://127.0.0.1/pairing/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: second.code })
    })
    const context = (await (await f.http.handle(request)!).json()) as { actor: string; lineage: string; state: string }
    assert.deepEqual(context, { state: 'pairing_context', actor, lineage })
    assert.equal(f.http.codes.list().find((entry) => entry.code_id === second.entry.code_id)?.status, 'unused')
    assert.equal(f.state.store.machine(second.entry.machine_id).status, 'pending')
    const manifest = installation(second.code)
    manifest.installations[0]!.value.config.peer_policy_revision = 'setup_local_' + context.lineage
    const response = await f.http.handle(post(second.code, manifest))!
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal(Object.hasOwn(await response.json(), 'mcp'), false)
    assert.deepEqual(JSON.parse(readFileSync(clientPath, 'utf8')), client)
    const updated = JSON.parse(readFileSync(callersPath, 'utf8'))
    assert.equal(updated.callers[0].token_sha256, oldToken)
    assert.equal(updated.callers[0].principal.id, actor)
    assert.equal(updated.local_policy.revision, 'setup_local_' + lineage)
    assert.equal(updated.callers[0].principal.policy.grants.length, 2)
    assert.deepEqual(JSON.parse(readFileSync(providersPath, 'utf8')).providers[0], oldProvider)
    assert.equal(f.state.store.credentialDigest(first.entry.machine_id), oldCredential)
  } finally {
    await f.close()
  }
})

test('配对上下文须验证秘密，查询不消费配对码，也不返回任何凭据', async () => {
  const f = fixture()
  try {
    const issued = f.http.codes.create()
    const parts = issued.code.split('.')
    parts[2] = 'x'.repeat(43)
    const request = (code: string) =>
      new Request('http://127.0.0.1/pairing/context', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      })
    assert.equal((await f.http.handle(request(parts.join('.')))!).status, 409)
    assert.equal(f.http.codes.list()[0]!.status, 'unused')
    const response = await f.http.handle(request(issued.code))!
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      state: 'pairing_context',
      actor: 'operator_simple_pairing',
      lineage: 'simple'
    })
    assert.equal(f.http.codes.list()[0]!.status, 'unused')
    assert.equal((await f.http.handle(post(issued.code))!).status, 200)
    assert.equal((await f.http.handle(request(issued.code))!).status, 200)
  } finally {
    await f.close()
  }
})

test('没有设备且 providers 文件为空时，保留 admin 与 claim 初始化身份完成配对', { timeout: 20_000 }, async () => {
  const f = fixture()
  try {
    writeAdminFiles(f.config, 'admin', Date.now())
    const first = f.http.codes.create()
    assert.equal((await f.http.handle(post(first.code))!).status, 200)
    const lineage = 'claim_' + first.entry.code_id
    const actor = 'caller_' + lineage
    const clientPath = runtimeReference(f.config.state_dir, 'mcp-client')
    const registryPath = runtimeReference(f.config.state_dir, 'mcp-callers')
    const providersPath = runtimeReference(f.config.state_dir, 'providers')
    const client = JSON.parse(readFileSync(clientPath, 'utf8'))
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
    client.principal_id = actor
    client.attempt_id = lineage
    registry.local_policy.revision = 'setup_local_' + lineage
    const caller = registry.callers.find(
      (entry: { principal: { id: string } }) => entry.principal.id === 'operator_simple_pairing'
    )!
    const admin = structuredClone(
      registry.callers.find((entry: { principal: { id: string } }) => entry.principal.id === 'admin')
    )
    caller.principal.id = actor
    caller.principal.policy.revision = 'setup_caller_' + lineage
    writeSetupJson(clientPath, client, true)
    writeSetupJson(registryPath, registry, true)
    f.state.store.deleteDevice(first.entry.machine_id, 'fixture_cleanup')
    writeSetupJson(providersPath, { schema_version: 1, role: 'gateway', providers: [] }, true)
    assert.equal(f.state.store.resources().length, 0)
    const next = f.http.codes.create()
    const manifest = installation(next.code)
    manifest.installations[0]!.value.config.peer_policy_revision = 'setup_local_' + lineage
    const result = await f.http.handle(post(next.code, manifest))!
    assert.equal(result.status, 200, JSON.stringify(await result.clone().json()))
    assert.deepEqual(JSON.parse(readFileSync(clientPath, 'utf8')), client)
    const updated = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.equal(
      updated.callers.find((entry: { principal: { id: string } }) => entry.principal.id === actor).token_sha256,
      caller.token_sha256
    )
    assert.deepEqual(
      updated.callers.find((entry: { principal: { id: string } }) => entry.principal.id === 'admin'),
      admin
    )
  } finally {
    await f.close()
  }
})

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
            peer_policy_revision: 'setup_local_simple',
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

for (const legacyEndpoint of [false, true]) {
  test(`join 显示有界 HTTP 原因且不反射秘密，${legacyEndpoint ? '兼容旧服务端无上下文端点' : '先验证上下文'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-join-errors-'))
    mkdirSync(join(root, 'managed'), { mode: 0o700 })
    let reason = 'pairing_conflict'
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/pairing/context') {
        response.statusCode = legacyEndpoint ? 403 : 200
        response.end(
          legacyEndpoint
            ? undefined
            : JSON.stringify({ state: 'pairing_context', actor: 'operator_simple_pairing', lineage: 'simple' })
        )
      } else {
        response.statusCode = 409
        response.end(JSON.stringify({ error: reason }))
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address === 'object')
    const config = {
      ...configTemplate('connector'),
      state_dir: root,
      gateway_url: `ws://127.0.0.1:${address.port}`,
      native: { provider: 'herdr' }
    } as ConnectorConfig
    const path = join(root, 'connector.json')
    writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
    writeSetupJson(runtimeReference(root, 'herdr-setup'), {
      schema_version: 1,
      attempt_id: 'a_test',
      machine_id: 'm_test',
      phase: 'prepared',
      settings: config.native,
      reference: setupReference('a_test', 'herdr'),
      local: { policies: simpleSetupAuthorization('m_test', ['herdr']).policies },
      remote: {}
    })
    try {
      for (const supplied of ['pairing_conflict', 'secret-value\nBearer test-secret']) {
        reason = supplied
        const streams = io()
        let output = ''
        streams.stderr.on('data', (chunk) => {
          output += chunk.toString()
        })
        await assert.rejects(
          joinConnector(config, path, streams, config.gateway_url + '#m_test.a_test.' + 's'.repeat(43)),
          { code: 'configuration_required' }
        )
        assert(
          output.includes(
            'pairing_http_error status=409 reason=' +
              (supplied === 'pairing_conflict' ? 'pairing_conflict' : 'unavailable')
          )
        )
        assert(!output.includes('test-secret'))
        assert(!output.includes('secret-value'))
        assert.equal(existsSync(runtimeReference(root, 'device')), false)
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      rmSync(root, { recursive: true, force: true })
    }
  })
}

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

for (const sameCode of [false, true]) {
  test(`首次 join 的原生半成品可${sameCode ? '由同一码继续' : '换新码后退役'}，不必手动 unpair`, async () => {
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
      settings: config.native,
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
      assert.equal(existsSync(runtimeReference(root, 'native-setup')), sameCode)
      assert.equal(existsSync(join(root, 'n', 'fixture-data')), sameCode)
      const retired = join(root, 'retired')
      if (sameCode) {
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
