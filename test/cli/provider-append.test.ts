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

const HERDR_SCHEMA = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')

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
  const pairing = new SimplePairingHttp(state, config, () => {})
  return {
    root,
    state,
    http: pairing,
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
