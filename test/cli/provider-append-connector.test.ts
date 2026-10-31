/**
 * Connector 侧的追加：失败一律非致命（固定码、不写注册表），以及启动校验对追加来源仍严格
 * （reference 必须等于 kind_attempt，本地配置必须与注册表逐字相同）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
