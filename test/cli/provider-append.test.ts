/**
 * 追加登记端点：只读设备凭据认证、只能追加、重放幂等、失败限速与拒绝规则。
 * 用合成设备与真实 herdr 审核清单；不启动任何原生进程，也不连接网络。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { test } from 'node:test'
import { SimplePairingHttp } from '../../src/cli/simple-pairing.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import { readSetupJson } from '../../src/cli/setup-files.js'
import { setupReference, setupTarget } from '../../src/cli/setup-targets.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { hash } from '../../src/wire/index.js'
import { configTemplate } from '../../src/cli/config.js'
import type { GatewayConfig } from '../../src/cli/config.js'
import { randomUUID } from 'node:crypto'
import { HERDR_CORE_CLASSIFICATION_REVISION } from '../../src/connector/herdr-core/methods.js'

const HERDR_SCHEMA = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
const CORE_SCHEMA = readFileSync(new URL('../fixtures/herdr-core/openrpc-0.1.15.json', import.meta.url), 'utf8')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-append-'))
  mkdirSync(join(root, 'managed'), { mode: 0o700 })
  const state = openGatewayState({
    state_directory: root,
    changed() {},
    store: {
      management: (request) =>
        request.action === 'devices_revoke'
          ? { actor: 'test', confirmation_id: 'test' }
          : pairing.authorizeManagement(request)
    }
  })
  const config = { ...configTemplate('gateway'), state_dir: root } as GatewayConfig
  let reloads = 0
  const pairing = new SimplePairingHttp(state, config, () => {
    reloads++
  })
  return {
    root,
    state,
    http: pairing,
    /** setImmediate 里触发的 reload 次数（调用前先让出一轮事件循环）。 */
    async reloads() {
      await new Promise((resolve) => setImmediate(resolve))
      return reloads
    },
    /** 注册一台 pending 设备并直接签发凭据（不经过 /pairing，测试只用追加端点）。 */
    device() {
      const issued = pairing.codes.create()
      const machine = issued.code.split('.')[0]!
      const enrollment = state.store.issueEnrollment(machine, 600_000)
      const redeemed = state.store.redeem(enrollment)
      return {
        machine_id: machine,
        recovery_generation: state.store.generation(),
        credential: redeemed.credential
      }
    },
    async close() {
      await pairing.close()
      state.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 一份真实的 herdr 审核清单；attempt 可指定，用来构造「同 kind 另一个引用」。 */
function manifest(machine: string, attempt: string) {
  const reference = setupReference(attempt, 'herdr')
  return {
    reference,
    value: {
      kind: 'herdr',
      schema_bundle: HERDR_SCHEMA,
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
          schema_sha256: hash(HERDR_SCHEMA)
        }
      }
    }
  }
}

/** 一份真实的 herdr-core 审核清单（契约取自 0.1.15 的真实文档）；不启动 core。 */
function coreManifest(machine: string, attempt: string) {
  const reference = setupReference(attempt, 'herdr-core')
  return {
    reference,
    value: {
      kind: 'herdr-core',
      schema_bundle: CORE_SCHEMA,
      config: {
        version: 1,
        target: setupTarget(machine, 'herdr-core', { herdr_core: 'default' }),
        binding_revision: 1,
        config_ref: reference,
        expected_source: {
          provider_kind: 'herdr-core',
          protocol_family: 'herdr-core-jsonrpc',
          binary_version: '0.1.15',
          binary_sha256: 'e'.repeat(64),
          schema_sha256: hash(CORE_SCHEMA),
          schema_origin: 'live_instance',
          schema_command: 'rpc.discover',
          server_version: '0.1.15',
          native_protocol_version: '1',
          runtime_generation: null,
          adapter_revision: 'adapter-herdr-core-1',
          classification_revision: HERDR_CORE_CLASSIFICATION_REVISION,
          support_basis: 'schema_and_version'
        }
      }
    }
  }
}

function append(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1/pairing/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

function providers(f: ReturnType<typeof fixture>) {
  const value = readSetupJson(runtimeReference(f.root, 'providers'), 1_048_576)
  return value === undefined ? [] : (value as { providers: { reference: string }[] }).providers
}

test('设备凭据追加一个来源：注册表与 Store 都只有这一条，设备状态不变', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const before = f.state.store.machine(device.machine_id)
    const attempt = randomUUID()
    const response = await f.http.handle(append({ ...device, installation: manifest(device.machine_id, attempt) }))!
    assert.equal(response.status, 200)
    const body = (await response.json()) as { state: string; providers: string[] }
    assert.equal(body.state, 'appended')
    assert.deepEqual(body.providers, [setupReference(attempt, 'herdr')])
    assert.deepEqual(
      providers(f).map((entry) => entry.reference),
      [setupReference(attempt, 'herdr')]
    )
    const binding = f.state.store.provider(device.machine_id, 'herdr')
    assert.equal(binding?.config_ref, setupReference(attempt, 'herdr'))
    // 只读认证：没有 connect()，设备状态与追加前完全一致（connect() 会把它置为 online）。
    const after = f.state.store.machine(device.machine_id)
    assert.deepEqual(after, before)
    assert.notEqual(after.status, 'online')
  } finally {
    await f.close()
  }
})

test('同 reference 同内容重放幂等，同 kind 另一个引用被拒且注册表不变', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const attempt = randomUUID()
    const installation = manifest(device.machine_id, attempt)
    assert.equal((await f.http.handle(append({ ...device, installation }))!).status, 200)
    const replay = await f.http.handle(append({ ...device, installation }))!
    assert.equal(replay.status, 200)
    assert.equal(((await replay.json()) as { replayed?: boolean }).replayed, true)
    assert.equal(providers(f).length, 1)
    // 同 kind 的新引用：拒绝，且注册表不变。
    const conflict = await f.http.handle(
      append({ ...device, installation: manifest(device.machine_id, randomUUID()) })
    )!
    assert.equal(conflict.status, 409)
    assert.equal(((await conflict.json()) as { error: string }).error, 'provider_append_conflict')
    assert.equal(providers(f).length, 1)
    assert.equal(f.state.store.provider(device.machine_id, 'herdr')?.config_ref, setupReference(attempt, 'herdr'))
  } finally {
    await f.close()
  }
})

test('认证只认设备凭据：错凭据、错代次、撤销设备都返回同一个固定错误', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const installation = manifest(device.machine_id, randomUUID())
    const wrong = await f.http.handle(append({ ...device, credential: 'A'.repeat(43), installation }))!
    assert.equal(wrong.status, 403)
    assert.equal(((await wrong.json()) as { error: string }).error, 'provider_append_refused')
    const stale = await f.http.handle(append({ ...device, recovery_generation: 'gen_other', installation }))!
    assert.equal(stale.status, 403)
    assert.equal(((await stale.json()) as { error: string }).error, 'provider_append_refused')
    // 撤销后同一个凭据也不能追加。
    f.state.store.revoke(device.machine_id)
    const revoked = await f.http.handle(append({ ...device, installation }))!
    assert.equal(revoked.status, 403)
    assert.equal(((await revoked.json()) as { error: string }).error, 'provider_append_refused')
    assert.equal(providers(f).length, 0)
    assert.equal(f.state.store.provider(device.machine_id, 'herdr'), undefined)
  } finally {
    await f.close()
  }
})

test('Origin、体积与并发拒绝规则与 /pairing 相同', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const withOrigin = append(
      { ...device, installation: manifest(device.machine_id, randomUUID()) },
      { origin: 'http://evil' }
    )
    const originResponse = await f.http.handle(withOrigin)!
    assert.equal(originResponse.status, 403)
    assert.equal(((await originResponse.json()) as { error: string }).error, 'setup_request_refused')
    // 超过 1 MiB：拒绝，注册表不变。
    const big = append({
      ...device,
      installation: { reference: 'herdr_' + randomUUID(), value: { blob: 'x'.repeat(2 * 1024 * 1024) } }
    })
    assert.equal((await f.http.handle(big)!).status, 409)
    assert.equal(providers(f).length, 0)
    // 非 JSON content-type 与 GET 也拒绝。
    const wrongType = new Request('http://127.0.0.1/pairing/providers', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    })
    assert.equal((await f.http.handle(wrongType)!).status, 403)
    assert.equal((await f.http.handle(new Request('http://127.0.0.1/pairing/providers'))!).status, 403)
  } finally {
    await f.close()
  }
})

test('失败限速：60 秒内 20 次失败后返回固定码', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const installation = manifest(device.machine_id, randomUUID())
    const bad = { ...device, credential: 'B'.repeat(43), installation }
    for (let index = 0; index < 20; index++) {
      assert.equal((await f.http.handle(append(bad))!).status, 403)
    }
    const limited = await f.http.handle(append(bad))!
    assert.equal(limited.status, 429)
    assert.equal(((await limited.json()) as { error: string }).error, 'provider_append_busy')
    // 限速是全局的：即使凭据正确也先被限速拒绝。
    assert.equal((await f.http.handle(append({ ...device, installation }))!).status, 429)
  } finally {
    await f.close()
  }
})

test('注册表里已有 Herdr 形状的条目时，另一台设备仍能追加（条目的 target 在 config 下，不是顶层）', async () => {
  const f = fixture()
  try {
    const first = f.device()
    const second = f.device()
    assert.equal(
      (await f.http.handle(append({ ...first, installation: manifest(first.machine_id, randomUUID()) }))!).status,
      200
    )
    // 修复前这里是 409 invalid_frame：同 kind 检查对每个注册表条目取顶层 target，Herdr 条目没有。
    const response = await f.http.handle(
      append({ ...second, installation: manifest(second.machine_id, randomUUID()) })
    )!
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal(providers(f).length, 2)
    assert.ok(f.state.store.provider(first.machine_id, 'herdr'))
    assert.ok(f.state.store.provider(second.machine_id, 'herdr'))
  } finally {
    await f.close()
  }
})

test('一次请求追加多个来源：一次审核、一次登记、只 reload 一次；重放幂等且不再 reload', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const attempt = randomUUID()
    const installation = {
      installations: [manifest(device.machine_id, attempt), coreManifest(device.machine_id, attempt)]
    }
    const response = await f.http.handle(append({ ...device, installation }))!
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const body = (await response.json()) as { providers: string[]; replayed?: boolean }
    assert.deepEqual(body.providers, [setupReference(attempt, 'herdr'), setupReference(attempt, 'herdr-core')])
    assert.equal(body.replayed, undefined)
    assert.equal(providers(f).length, 2)
    assert.ok(f.state.store.provider(device.machine_id, 'herdr'))
    assert.ok(f.state.store.provider(device.machine_id, 'herdr-core'))
    assert.equal(await f.reloads(), 1)
    // 同一批重放：幂等，不再登记、不再 reload。
    const replay = await f.http.handle(append({ ...device, installation }))!
    assert.equal(replay.status, 200)
    assert.equal(((await replay.json()) as { replayed?: boolean }).replayed, true)
    assert.equal(providers(f).length, 2)
    assert.equal(await f.reloads(), 1)
  } finally {
    await f.close()
  }
})

test('批量里有一条冲突就整批拒绝：其余条目也不登记', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const first = randomUUID()
    assert.equal(
      (await f.http.handle(append({ ...device, installation: manifest(device.machine_id, first) }))!).status,
      200
    )
    const attempt = randomUUID()
    // herdr 已经以另一个引用存在；herdr-core 是新的——整批必须被拒，herdr-core 也不能留下。
    const response = await f.http.handle(
      append({
        ...device,
        installation: {
          installations: [manifest(device.machine_id, attempt), coreManifest(device.machine_id, attempt)]
        }
      })
    )!
    assert.equal(response.status, 409)
    assert.equal(((await response.json()) as { error: string }).error, 'provider_append_conflict')
    assert.equal(providers(f).length, 1)
    assert.equal(f.state.store.provider(device.machine_id, 'herdr-core'), undefined)
    // 一批里的 attempt 不一致同样拒绝。
    const mixed = await f.http.handle(
      append({
        ...device,
        installation: {
          installations: [manifest(device.machine_id, randomUUID()), coreManifest(device.machine_id, randomUUID())]
        }
      })
    )!
    assert.equal(mixed.status, 409)
    assert.equal(providers(f).length, 1)
  } finally {
    await f.close()
  }
})

test('崩溃半成品收敛：注册表已写、Store 没登记时，同引用重试成功而不是永远冲突', async () => {
  const f = fixture()
  try {
    const device = f.device()
    const installation = manifest(device.machine_id, randomUUID())
    const store = f.state.store as unknown as { defineProvider: (binding: unknown) => unknown }
    const original = store.defineProvider.bind(store)
    // 注册表合并之后、defineProvider 之前“崩溃”。
    store.defineProvider = () => {
      throw new Error('simulated crash')
    }
    const crashed = await f.http.handle(append({ ...device, installation }))!
    assert.equal(crashed.status, 409)
    assert.equal(providers(f).length, 1)
    assert.equal(f.state.store.provider(device.machine_id, 'herdr'), undefined)
    store.defineProvider = original
    const retried = await f.http.handle(append({ ...device, installation }))!
    assert.equal(retried.status, 200, JSON.stringify(await retried.clone().json()))
    assert.equal(providers(f).length, 1)
    assert.ok(f.state.store.provider(device.machine_id, 'herdr'))
    // 同 kind 的另一个引用仍被拒。
    const other = await f.http.handle(append({ ...device, installation: manifest(device.machine_id, randomUUID()) }))!
    assert.equal(other.status, 409)
  } finally {
    await f.close()
  }
})
