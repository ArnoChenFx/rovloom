/**
 * Connector 侧的追加：失败一律非致命（固定码、不写注册表），以及启动校验对追加来源仍严格
 * （reference 必须等于 kind_attempt，本地配置必须与注册表逐字相同）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appendNativeProviders } from '../../src/cli/provider-append.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import { readSetupJson, writeSetupJson } from '../../src/cli/setup-files.js'
import { providerSetupPath } from '../../src/cli/provider-control.js'
import { saveCredential } from '../../src/transport/credentials.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { silentConsole } from '../../src/cli/setup-console.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { CliSetup } from '../../src/cli/setup-runtime.js'
import { setupReference } from '../../src/cli/setup-targets.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { hash } from '../../src/wire/index.js'

const HERDR_SCHEMA = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')

function io() {
  const sink = { written: '' }
  const stream = {
    write(chunk: string) {
      sink.written += chunk
      return true
    }
  }
  return {
    io: {
      stdin: process.stdin,
      stdout: stream as never,
      stderr: stream as never,
      signal: new AbortController().signal,
      language: 'en' as const
    },
    sink
  }
}

function fixture(provider: 'herdr' | 'mixed') {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-append-connector-'))
  mkdirSync(join(root, 'managed'), { mode: 0o700 })
  for (const kind of ['herdr', 'luvus', 'herdr-core']) {
    mkdirSync(join(root, 'control', kind), { recursive: true, mode: 0o700 })
  }
  privateDirectory(root)
  const machine = 'm_synthetic'
  const attempt = '11111111-1111-1111-1111-111111111111'
  const reference = setupReference(attempt, 'herdr')
  const config = {
    ...configTemplate('connector'),
    state_dir: root,
    gateway_url: 'ws://127.0.0.1:9443',
    native: { provider }
  } as ConnectorConfig
  const local = {
    kind: 'herdr',
    config: { expected_source: { ...fixedHerdrSource(), schema_sha256: hash(HERDR_SCHEMA) } }
  }
  writeSetupJson(
    runtimeReference(root, 'providers'),
    { schema_version: 1, role: 'connector', providers: [{ reference, value: local }] },
    false,
    1_048_576
  )
  writeSetupJson(
    runtimeReference(root, 'pairing'),
    {
      schema_version: 1,
      attempt_id: attempt,
      machine_id: machine,
      gateway_url: config.gateway_url,
      phase: 'configured'
    },
    false,
    1_048_576
  )
  writeSetupJson(
    providerSetupPath(root, 'herdr'),
    {
      schema_version: 1,
      attempt_id: attempt,
      machine_id: machine,
      phase: 'prepared',
      settings: config.native,
      reference,
      local,
      remote: { kind: 'herdr', schema_bundle: HERDR_SCHEMA, config: {} }
    },
    false,
    1_048_576
  )
  // 设备凭据（追加与启动都要读它）；只在测试临时目录里。
  saveCredential(join(root, 'managed', 'device.json'), {
    machine_id: machine,
    recovery_generation: 'g_generation',
    credential: 'C'.repeat(48)
  })
  return { root, config, machine, attempt, reference, local }
}

test('追加失败非致命：本机准备失败只给固定码，不写注册表、不抛异常', async () => {
  const f = fixture('herdr')
  const { io: cliIo, sink } = io()
  try {
    // PATH 里没有 herdr：prepareSetupHerdr 会以固定码失败。
    const outcome = await appendNativeProviders({
      config: f.config,
      kinds: ['herdr'],
      credential: { machine_id: 'm_synthetic', recovery_generation: 'g', credential: 'X'.repeat(48) },
      console: silentConsole(cliIo),
      signal: cliIo.signal
    })
    assert.deepEqual(outcome.appended, [])
    assert.equal(outcome.failed.length, 1)
    assert.equal(outcome.failed[0]!.kind, 'herdr')
    assert.match(outcome.failed[0]!.code, /^[a-z][a-z0-9_]{0,63}$/u)
    // 注册表未被改写。
    const providers = (readSetupJson(runtimeReference(f.root, 'providers'), 1_048_576) as { providers: unknown[] })
      .providers
    assert.equal(providers.length, 1)
    assert.equal(sink.written, '')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('启动校验对追加来源仍严格：reference 与 attempt 对不上即拒绝', async () => {
  const f = fixture('herdr')
  try {
    // 把准备记录与注册表**一起**改成另一个 attempt 的引用（本地配置也同步改）：
    // 只靠「本地=注册表」是看不出来的，必须由 reference === kind_attempt 这条拦住。
    const other = '22222222-2222-2222-2222-222222222222'
    const path = providerSetupPath(f.root, 'herdr')
    const record = readSetupJson(path, 1_048_576) as Record<string, unknown>
    const local = record.local as { config: { config_ref: string } }
    const tamperedLocal = { ...local, config: { ...local.config, config_ref: 'herdr_' + other } }
    writeSetupJson(path, { ...record, reference: 'herdr_' + other, local: tamperedLocal }, true, 1_048_576)
    const providersPath = runtimeReference(f.root, 'providers')
    const providers = readSetupJson(providersPath, 1_048_576) as { providers: { reference: string; value: unknown }[] }
    writeSetupJson(
      providersPath,
      {
        ...providers,
        providers: [{ reference: 'herdr_' + other, value: tamperedLocal }]
      },
      true,
      1_048_576
    )
    const runtime = createProductionCliRuntime({
      connector: /** 门禁失败时绝不能调用工厂。 */ async () => {
        throw new Error('must_not_start')
      }
    })
    await assert.rejects(() => runtime.connector!(f.config), { code: 'configuration_required' })
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('mixed 设备也会追加缺的来源：factory 仍只收到已配对的两个', async () => {
  const f = fixture('mixed')
  try {
    // 把本机注册表补成 mixed 的旧设备（luvus + herdr），没有 pairing 之外的来源。
    const providersPath = runtimeReference(f.root, 'providers')
    const current = readSetupJson(providersPath, 1_048_576) as { providers: { reference: string; value: unknown }[] }
    const luvus = {
      reference: 'luvus_' + f.attempt,
      value: { kind: 'luvus', config: { expected_source: {} } }
    }
    writeSetupJson(providersPath, { ...current, providers: [luvus, ...current.providers] }, true, 1_048_576)
    writeSetupJson(providerSetupPath(f.root, 'luvus'), {
      schema_version: 1,
      attempt_id: f.attempt,
      machine_id: f.machine,
      phase: 'prepared',
      settings: f.config.native,
      reference: luvus.reference,
      local: luvus.value,
      remote: {}
    })
    const handed: string[][] = []
    const stop = new Error('synthetic_factory')
    const runtime = createProductionCliRuntime(
      {
        connector: async (_config, entries) => {
          handed.push(entries.map((entry) => (entry.value as { kind: string }).kind))
          throw stop
        }
      },
      // 没有 core 可追加：追加尝试必须失败但不影响启动（工厂仍然被调用）。
      {
        prepare: async (config: unknown) => config,
        appendProviders: async () => ({
          appended: [],
          failed: [{ kind: 'herdr-core', code: 'append_prepare_failed' }]
        })
      } as never
    )
    await assert.rejects(
      () => runtime.connector!(f.config),
      (error) => error === stop
    )
    assert.deepEqual(handed, [['luvus', 'herdr']])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

/** 本机假 Gateway：记录每个 POST，按脚本回应；只监听回环。 */
async function fakeGateway(
  respond: (body: Record<string, unknown>, count: number) => { status: number; json: unknown }
) {
  const requests: Record<string, unknown>[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push(body)
      const reply = respond(body, requests.length)
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    requests,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** 给 unpaired 的来源预置一份已准备的记录（重试路径：沿用自己的 attempt）。 */
function preparedRecord(f: ReturnType<typeof fixture>, kind: 'luvus' | 'herdr-core', attempt: string) {
  const reference = setupReference(attempt, kind)
  const local = { kind, config: { marker: kind + attempt.slice(0, 4) } }
  writeSetupJson(
    providerSetupPath(f.root, kind),
    {
      schema_version: 1,
      attempt_id: attempt,
      machine_id: f.machine,
      phase: 'prepared',
      settings: f.config.native,
      reference,
      local,
      remote: { kind, schema_bundle: 'bundle-' + kind }
    },
    false,
    1_048_576
  )
  return { reference, local }
}

const device = { machine_id: 'm_synthetic', recovery_generation: 'g_generation', credential: 'C'.repeat(48) }

test('同一次启动追加多个来源：共用一个 attempt 的只发一个请求，Gateway 确认后才写本机注册表', async () => {
  const f = fixture('mixed')
  const gateway = await fakeGateway(() => ({ status: 200, json: { state: 'appended', providers: [] } }))
  try {
    const shared = '33333333-3333-3333-3333-333333333333'
    const luvus = preparedRecord(f, 'luvus', shared)
    const core = preparedRecord(f, 'herdr-core', shared)
    const config = { ...f.config, gateway_url: 'ws://127.0.0.1:' + gateway.port } as ConnectorConfig
    const { io: cliIo } = io()
    const outcome = await appendNativeProviders({
      config,
      kinds: ['luvus', 'herdr-core'],
      credential: device,
      console: silentConsole(cliIo),
      signal: cliIo.signal
    })
    assert.deepEqual(outcome.failed, [])
    assert.deepEqual(outcome.appended, ['luvus', 'herdr-core'])
    // 只有一个 POST，带两个条目，顺序固定（luvus 在前），不含任何本机路径或本地配置。
    assert.equal(gateway.requests.length, 1)
    const installation = gateway.requests[0]!.installation as { installations: { reference: string; value: unknown }[] }
    assert.deepEqual(
      installation.installations.map((entry) => entry.reference),
      [luvus.reference, core.reference]
    )
    assert.equal(JSON.stringify(gateway.requests[0]).includes('marker'), false)
    const registry = readSetupJson(runtimeReference(f.root, 'providers'), 1_048_576) as {
      providers: { reference: string; value: unknown }[]
    }
    assert.deepEqual(
      registry.providers.map((entry) => entry.reference).sort(),
      [f.reference, luvus.reference, core.reference].sort()
    )
    assert.deepEqual(registry.providers.find((entry) => entry.reference === core.reference)!.value, core.local)
  } finally {
    await gateway.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('此前准备过但没登记成功的来源带着自己的旧 attempt，单独一组；一组失败不影响另一组', async () => {
  const f = fixture('mixed')
  const gateway = await fakeGateway((body) => {
    const refs = (
      (body.installation as { reference?: string }).reference
        ? [(body.installation as { reference: string }).reference]
        : []
    ).join()
    return refs.startsWith('luvus_')
      ? { status: 409, json: { error: 'provider_append_conflict' } }
      : { status: 200, json: { state: 'appended', providers: [] } }
  })
  try {
    const luvus = preparedRecord(f, 'luvus', '44444444-4444-4444-4444-444444444444')
    const core = preparedRecord(f, 'herdr-core', '55555555-5555-5555-5555-555555555555')
    const config = { ...f.config, gateway_url: 'ws://127.0.0.1:' + gateway.port } as ConnectorConfig
    const { io: cliIo } = io()
    const outcome = await appendNativeProviders({
      config,
      kinds: ['luvus', 'herdr-core'],
      credential: device,
      console: silentConsole(cliIo),
      signal: cliIo.signal
    })
    assert.equal(gateway.requests.length, 2)
    assert.deepEqual(outcome.appended, ['herdr-core'])
    assert.deepEqual(outcome.failed, [{ kind: 'luvus', code: 'provider_append_conflict' }])
    // 失败的那组不写本机注册表。
    const registry = readSetupJson(runtimeReference(f.root, 'providers'), 1_048_576) as {
      providers: { reference: string }[]
    }
    assert.deepEqual(registry.providers.map((entry) => entry.reference).sort(), [f.reference, core.reference].sort())
    void luvus
  } finally {
    await gateway.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('Gateway 正在重开 listener（连接被拒）时按幂等重试，不把这当作追加失败', async () => {
  const f = fixture('mixed')
  // 先占一个端口再释放，保证开头几次连接被拒；稍后在同一端口起假 Gateway。
  const probe = await fakeGateway(() => ({ status: 200, json: {} }))
  const port = probe.port
  await probe.close()
  try {
    const core = preparedRecord(f, 'herdr-core', '66666666-6666-6666-6666-666666666666')
    const config = { ...f.config, gateway_url: 'ws://127.0.0.1:' + port } as ConnectorConfig
    const { io: cliIo } = io()
    let late: Awaited<ReturnType<typeof fakeGateway>> | undefined
    const starting = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ state: 'appended', providers: [core.reference], replayed: true }))
        })
      })
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
      late = { requests: [], port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
    })()
    const outcome = await appendNativeProviders({
      config,
      kinds: ['herdr-core'],
      credential: device,
      console: silentConsole(cliIo),
      signal: cliIo.signal
    })
    await starting
    assert.deepEqual(outcome.failed, [])
    assert.deepEqual(outcome.appended, ['herdr-core'])
    await late?.close()
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('一直连不上：重试几次后固定码 append_network，本机注册表不变', async () => {
  const f = fixture('mixed')
  const probe = await fakeGateway(() => ({ status: 200, json: {} }))
  const port = probe.port
  await probe.close()
  try {
    preparedRecord(f, 'herdr-core', '77777777-7777-7777-7777-777777777777')
    const config = { ...f.config, gateway_url: 'ws://127.0.0.1:' + port } as ConnectorConfig
    const { io: cliIo } = io()
    const outcome = await appendNativeProviders({
      config,
      kinds: ['herdr-core'],
      credential: device,
      console: silentConsole(cliIo),
      signal: cliIo.signal
    })
    assert.deepEqual(outcome.failed, [{ kind: 'herdr-core', code: 'append_network' }])
    const registry = readSetupJson(runtimeReference(f.root, 'providers'), 1_048_576) as { providers: unknown[] }
    assert.equal(registry.providers.length, 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('上一次本机准备做到一半（initializing）：固定码拒绝，记录原样保留，不改写、不退役', async () => {
  const f = fixture('mixed')
  const gateway = await fakeGateway(() => ({ status: 200, json: { state: 'appended', providers: [] } }))
  try {
    const path = providerSetupPath(f.root, 'herdr-core')
    writeSetupJson(
      path,
      {
        schema_version: 1,
        attempt_id: '88888888-8888-8888-8888-888888888888',
        machine_id: f.machine,
        phase: 'initializing'
      },
      false,
      1_048_576
    )
    const before = readFileSync(path, 'utf8')
    const config = { ...f.config, gateway_url: 'ws://127.0.0.1:' + gateway.port } as ConnectorConfig
    const { io: cliIo } = io()
    const outcome = await appendNativeProviders({
      config,
      kinds: ['herdr-core'],
      credential: device,
      console: silentConsole(cliIo),
      signal: cliIo.signal
    })
    assert.deepEqual(outcome.failed, [{ kind: 'herdr-core', code: 'configuration_required' }])
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.equal(existsSync(join(f.root, 'retired')), false)
    assert.equal(gateway.requests.length, 0)
  } finally {
    await gateway.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('成功与失败的提示都是每个来源一行，只含 kind 与固定码（不含路径、凭据或异常文本）', async () => {
  const f = fixture('mixed')
  const gateway = await fakeGateway((body) => {
    const installation = body.installation as { installations?: { reference: string }[]; reference?: string }
    const refs = installation.installations?.map((entry) => entry.reference) ?? [installation.reference]
    return refs.some((ref) => ref?.startsWith('luvus_'))
      ? { status: 409, json: { error: 'provider_append_conflict' } }
      : { status: 200, json: { state: 'appended', providers: [] } }
  })
  try {
    preparedRecord(f, 'luvus', '99999999-9999-9999-9999-999999999999')
    preparedRecord(f, 'herdr-core', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    const config = { ...f.config, gateway_url: 'ws://127.0.0.1:' + gateway.port } as ConnectorConfig
    const { io: cliIo, sink } = io()
    const setup = new CliSetup()
    await setup.prepare(config, join(f.root, 'connector.json'), cliIo, undefined)
    await setup.appendProviders(config, ['luvus', 'herdr-core'])
    const lines = sink.written.trim().split('\n')
    assert.equal(lines.length, 2, sink.written)
    assert.match(
      lines.find((line) => line.startsWith('native_provider_appended: '))!,
      /^native_provider_appended: herdr-core /u
    )
    assert.match(
      lines.find((line) => line.startsWith('native_provider_append_failed: '))!,
      /^native_provider_append_failed: luvus provider_append_conflict;/u
    )
    assert.equal(sink.written.includes(f.root), false)
    assert.equal(sink.written.includes('C'.repeat(48)), false)
    setup.close()
  } finally {
    await gateway.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})
