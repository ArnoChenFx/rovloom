/**
 * 直接对设备监听上的追加端点构造请求：错凭据与「同 kind 已存在」都被拒，注册表不变。
 * 用 quickstart 提供的设备凭据与 Gateway 地址；不打印凭据。
 * 用法：GATEWAY_DEVICE_URL=... CONNECTOR_MANAGED=... bun e2e/provider-append-http.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const origin = process.env.GATEWAY_DEVICE_URL
const managed = process.env.CONNECTOR_MANAGED
assert(origin && managed, 'GATEWAY_DEVICE_URL and CONNECTOR_MANAGED are required')
const device = JSON.parse(readFileSync(join(managed, 'device.json'), 'utf8'))
const providers = JSON.parse(readFileSync(join(managed, 'providers.json'), 'utf8')).providers
const byKind = new Map(providers.map((entry) => [entry.value.kind, entry]))
// 已存在 kind（herdr）的 setup 记录里有它的 remote 清单。
const setup = JSON.parse(readFileSync(join(managed, '..', 'control', 'herdr', 'setup.json'), 'utf8'))

async function post(body) {
  const response = await fetch(new URL('/pairing/providers', origin), {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  })
  return { status: response.status, body: await response.json() }
}

try {
  const base = {
    machine_id: device.machine_id,
    recovery_generation: device.recovery_generation,
    credential: device.credential
  }
  // 1. 错凭据：同一个固定错误。
  const wrong = await post({
    ...base,
    credential: 'A'.repeat(43),
    installation: { reference: 'herdr_' + randomUUID(), value: setup.remote }
  })
  assert.equal(wrong.status, 403, JSON.stringify(wrong))
  assert.equal(wrong.body.error, 'provider_append_refused')
  // 2. 已存在 kind 的另一个引用：拒绝，注册表不变。
  const attempt = randomUUID()
  const reference = 'herdr_' + attempt
  const value = { ...setup.remote, config: { ...setup.remote.config, config_ref: reference } }
  const conflict = await post({ ...base, installation: { reference, value } })
  assert.equal(conflict.status, 409, JSON.stringify(conflict))
  assert.equal(conflict.body.error, 'provider_append_conflict')
  // 3. 注册表里没有多出 herdr 的第二条引用。
  const after = JSON.parse(readFileSync(join(managed, 'providers.json'), 'utf8')).providers
  assert.equal(after.length, providers.length)
  assert.equal(after.filter((entry) => entry.value.kind === 'herdr').length, 1)
  assert.equal(
    after.some((entry) => entry.reference === reference),
    false
  )
  console.log(
    JSON.stringify({
      ok: true,
      wrong_credential: wrong.body.error,
      existing_kind: conflict.body.error,
      registry_unchanged: true,
      kinds: [...byKind.keys()]
    })
  )
} finally {
  /* 无状态 */
}
