// 令牌注册表：纯函数操作、热读认证（吊销/续期/轮换/损坏恢复）与 CLI 子命令的端到端行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import type { GatewayConfig } from '../../src/cli/config.js'
import { handleTokenCommand } from '../../src/cli/token-command.js'
import { LIMITS } from '../../src/wire/index.js'
import {
  createCaller,
  digestToken,
  parseRegistry,
  renewCaller,
  revokeCaller,
  rotateCaller,
  setDeviceScope,
  setDiscardPermission,
  summarize
} from '../../src/cli/token-registry.js'
import type { CallerRegistry } from '../../src/cli/token-registry.js'

const DAY = 86_400_000
const resource = 'http://127.0.0.1:9/mcp'
const policy = { revision: 'p1', grants: [] }

function registry(token = 'a'.repeat(43), now = 1_000): CallerRegistry {
  return {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource,
    local_policy: { revision: 'local1', grants: [] },
    callers: [
      {
        principal: { id: 'owner', policy },
        token_sha256: digestToken(token),
        issued_at: now,
        expires_at: now + DAY
      }
    ]
  }
}

test('create clones policy from an existing principal and never repeats a principal', () => {
  const base = registry()
  const made = createCaller(base, 'worker', 'owner', 2_000, 7)
  assert.equal(made.registry.callers.length, 2)
  assert.deepEqual(made.registry.callers[1]!.principal.policy, policy)
  assert.equal(made.registry.callers[1]!.token_sha256, digestToken(made.token))
  assert.equal(made.expires_at, 2_000 + 7 * DAY)
  assert.match(made.token, /^[A-Za-z0-9_-]{43}$/)
  assert.throws(() => createCaller(made.registry, 'worker', 'owner', 2_000), /Rovloom command failed/)
  assert.throws(() => createCaller(base, 'worker', 'missing', 2_000), /Rovloom command failed/)
  assert.throws(() => createCaller(base, 'bad id', 'owner', 2_000), /Rovloom command failed/)
  assert.throws(() => createCaller(base, 'worker', 'owner', 2_000, 0), /Rovloom command failed/)
  assert.throws(() => createCaller(base, 'worker', 'owner', 2_000, 366), /Rovloom command failed/)
  parseRegistry(JSON.parse(JSON.stringify(made.registry)))
})

test('discard permission is explicit, strictly parsed and preserved by token operations', () => {
  const base = registry()
  assert.equal(parseRegistry(base).callers[0]!.principal.permissions, undefined)
  const allowed = setDiscardPermission(base, 'owner', true)
  parseRegistry(allowed)
  assert.equal(base.callers[0]!.principal.permissions, undefined)
  const cloned = createCaller(allowed, 'worker', 'owner', 2000).registry
  assert.deepEqual(cloned.callers[1]!.principal.permissions, { discard_response: true })
  cloned.callers[1]!.principal.permissions!.discard_response = false
  assert.equal(allowed.callers[0]!.principal.permissions!.discard_response, true)
  assert.deepEqual(renewCaller(allowed, 'owner', 2000).registry.callers[0]!.principal.permissions, {
    discard_response: true
  })
  assert.deepEqual(rotateCaller(allowed, 'owner', 2000).registry.callers[0]!.principal.permissions, {
    discard_response: true
  })
  assert.deepEqual(setDiscardPermission(allowed, 'owner', false).callers[0]!.principal.permissions, {
    discard_response: false
  })
  for (const permissions of [
    null,
    {},
    { discard_response: 'true' },
    { discard_response: 1 },
    { discard_response: true, admin: true }
  ]) {
    const changed = structuredClone(base)
    Object.assign(changed.callers[0]!.principal, { permissions })
    assert.throws(() => parseRegistry(changed))
  }
})

test('renew extends expiry without changing the token digest, even after expiry', () => {
  const base = registry()
  const renewed = renewCaller(base, 'owner', 5 * DAY, 3)
  assert.equal(renewed.registry.callers[0]!.token_sha256, base.callers[0]!.token_sha256)
  assert.equal(renewed.expires_at, 8 * DAY)
  assert.equal(summarize(renewed.registry, 5 * DAY)[0]!.status, 'active')
  assert.equal(summarize(base, 5 * DAY)[0]!.status, 'expired')
})

test('rotate replaces the digest; the old digest survives only through the bounded grace period', () => {
  const base = registry()
  const hard = rotateCaller(base, 'owner', 2_000)
  assert.equal(hard.registry.callers[0]!.previous, undefined)
  assert.notEqual(hard.registry.callers[0]!.token_sha256, base.callers[0]!.token_sha256)
  const soft = rotateCaller(base, 'owner', 2_000, { graceMinutes: 10 })
  assert.deepEqual(soft.registry.callers[0]!.previous, {
    token_sha256: base.callers[0]!.token_sha256,
    expires_at: 2_000 + 600_000
  })
  assert.equal(summarize(soft.registry, 2_001)[0]!.rotating, true)
  assert.equal(summarize(soft.registry, 2_000 + 600_000)[0]!.rotating, false)
  assert.throws(() => rotateCaller(base, 'owner', 2_000, { graceMinutes: 1441 }), /Rovloom command failed/)
  parseRegistry(JSON.parse(JSON.stringify(soft.registry)))
})

test('revoke removes the principal; unknown principals are rejected', () => {
  const base = registry()
  assert.equal(revokeCaller(base, 'owner').callers.length, 0)
  assert.throws(() => revokeCaller(base, 'nobody'), /Rovloom command failed/)
})

test('parseRegistry rejects duplicate digests, extra fields and a mismatched resource', () => {
  const base = registry()
  assert.throws(() => parseRegistry({ ...base, extra: 1 }))
  assert.throws(() => parseRegistry(base, resource + '/other'))
  const twin = { ...base.callers[0]!, principal: { id: 'twin', policy } }
  assert.throws(() => parseRegistry({ ...base, callers: [base.callers[0], twin] }))
  assert.throws(() =>
    parseRegistry({
      ...base,
      callers: [{ ...base.callers[0], previous: { token_sha256: base.callers[0]!.token_sha256, expires_at: 1 } }]
    })
  )
})

test('device scope defaults to today’s visibility, validates selected lists and survives token operations', () => {
  const base = registry()
  // 缺省：不收窄，摘要投影为 all。
  assert.equal(base.callers[0]!.device_scope, undefined)
  assert.deepEqual(summarize(base, 1_000)[0]!.device_scope, { mode: 'all' })
  parseRegistry(base)

  const narrowed = setDeviceScope(base, 'owner', ['m_one', 'm_two'])
  parseRegistry(narrowed)
  assert.deepEqual(narrowed.callers[0]!.device_scope, { mode: 'selected', machine_ids: ['m_one', 'm_two'] })
  assert.deepEqual(summarize(narrowed, 1_000)[0]!.device_scope, { mode: 'selected', machine_ids: ['m_one', 'm_two'] })
  // 不修改策略修订：范围是可见性过滤器，不是权限授予。
  assert.equal(narrowed.callers[0]!.principal.policy.revision, base.callers[0]!.principal.policy.revision)
  assert.equal(narrowed.callers[0]!.token_sha256, base.callers[0]!.token_sha256)

  // 清除必须显式传 null；删除字段后回到缺省语义。
  const cleared = setDeviceScope(narrowed, 'owner', null)
  assert.equal(cleared.callers[0]!.device_scope, undefined)
  assert.deepEqual(summarize(cleared, 1_000)[0]!.device_scope, { mode: 'all' })

  const none = setDeviceScope(base, 'owner', [])
  assert.deepEqual(parseRegistry(none).callers[0]!.device_scope, { mode: 'selected', machine_ids: [] })
  // 重复、非法 ID 与超限全部拒绝。
  for (const ids of [
    ['m_one', 'm_one'],
    ['m one'],
    [''],
    ['m'.repeat(129)],
    Array.from({ length: LIMITS.scope_machines + 1 }, (_, index) => 'm_' + index),
    'm_one' as unknown as string[]
  ]) {
    assert.throws(() => setDeviceScope(base, 'owner', ids as string[]), /Rovloom command failed/)
  }
  assert.throws(() => setDeviceScope(base, 'ghost', ['m_one']), /Rovloom command failed/)
  // 上限内允许。
  parseRegistry(
    setDeviceScope(
      base,
      'owner',
      Array.from({ length: LIMITS.scope_machines }, (_, i) => 'm_' + i)
    )
  )

  // --like 克隆范围，续期/轮换原样保留。
  const cloned = createCaller(narrowed, 'worker', 'owner', 2_000).registry
  assert.deepEqual(cloned.callers[1]!.device_scope, { mode: 'selected', machine_ids: ['m_one', 'm_two'] })
  assert.deepEqual(renewCaller(narrowed, 'owner', 2_000).registry.callers[0]!.device_scope, {
    mode: 'selected',
    machine_ids: ['m_one', 'm_two']
  })
  assert.deepEqual(rotateCaller(narrowed, 'owner', 2_000).registry.callers[0]!.device_scope, {
    mode: 'selected',
    machine_ids: ['m_one', 'm_two']
  })
  // 管理页令牌同样可作为纯过滤器收窄；范围不影响管理员授权（Administrator.grants）。
  const gateway: CallerRegistry = {
    ...base,
    callers: [{ ...base.callers[0]!, scope: 'gateway' }]
  }
  const scopedGateway = setDeviceScope(gateway, 'owner', ['m_one'])
  parseRegistry(scopedGateway)
  assert.deepEqual(scopedGateway.callers[0]!.device_scope, { mode: 'selected', machine_ids: ['m_one'] })
  assert.equal(scopedGateway.callers[0]!.scope, 'gateway')

  // 严格解析：未知字段、错误 mode、空列表、重复、非法形状一律拒绝。
  for (const device_scope of [
    null,
    {},
    { mode: 'all' },
    { mode: 'selected' },
    { mode: 'selected', machine_ids: ['m_one', 'm_one'] },
    { mode: 'selected', machine_ids: ['m one'] },
    { mode: 'selected', machine_ids: ['m_one'], extra: 1 },
    { mode: 'selected', machine_ids: Array.from({ length: LIMITS.scope_machines + 1 }, (_, i) => 'm_' + i) }
  ]) {
    const changed = structuredClone(base)
    Object.assign(changed.callers[0]!, { device_scope })
    assert.throws(() => parseRegistry(changed))
  }
})

function authenticate(source: ReturnType<typeof openCallerSource>, token: string) {
  return source.authentication.authenticate(
    new Request(resource, { headers: { authorization: `Bearer ${token}` } }),
    new AbortController().signal
  )
}

test('caller source re-reads the registry: revoke, renew, rotate and recovery apply without restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-tokens-'))
  const path = join(root, 'callers.json')
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  try {
    const token = 'a'.repeat(43)
    const now = Date.now()
    const base = registry(token, now - 1000)
    write(base)
    const source = openCallerSource(path, resource)
    assert.deepEqual(authenticate(source, token), { principal_id: 'owner' })
    assert.deepEqual(source.identities.principal({ principal_id: 'owner' })?.id, 'owner')

    // 轮换带重叠期：新旧令牌都可用；无重叠期时旧令牌立即失效。
    const soft = rotateCaller(base, 'owner', now, { graceMinutes: 10 })
    write(soft.registry)
    assert.deepEqual(authenticate(source, soft.token), { principal_id: 'owner' })
    assert.deepEqual(authenticate(source, token), { principal_id: 'owner' })
    const hard = rotateCaller(soft.registry, 'owner', now)
    write(hard.registry)
    assert.equal(authenticate(source, token), null)
    assert.equal(authenticate(source, soft.token), null)
    assert.deepEqual(authenticate(source, hard.token), { principal_id: 'owner' })

    // 过期的重叠期内的旧令牌不再有效。
    const lapsed = {
      ...hard.registry,
      callers: [{ ...hard.registry.callers[0]!, previous: { token_sha256: digestToken(token), expires_at: now - 1 } }]
    }
    write(lapsed)
    assert.equal(authenticate(source, token), null)

    // 已建立身份的独立权限也热生效，不改变令牌或有效期。
    write(setDiscardPermission(hard.registry, 'owner', true))
    assert.deepEqual(source.identities.principal({ principal_id: 'owner' })?.permissions, { discard_response: true })
    write(setDiscardPermission(hard.registry, 'owner', false))
    assert.deepEqual(source.identities.principal({ principal_id: 'owner' })?.permissions, { discard_response: false })

    // 吊销：令牌与已建立会话的主体查询同时失效；恢复文件后无需重启即恢复。
    write(revokeCaller(hard.registry, 'owner'))
    assert.equal(authenticate(source, hard.token), null)
    assert.equal(source.identities.principal({ principal_id: 'owner' }), null)
    write(hard.registry)
    assert.deepEqual(authenticate(source, hard.token), { principal_id: 'owner' })

    // 到期后续期：同一令牌重新有效。
    const expired = { ...hard.registry, callers: [{ ...hard.registry.callers[0]!, issued_at: 1, expires_at: now - 1 }] }
    write(expired)
    assert.equal(authenticate(source, hard.token), null)
    write(renewCaller(expired, 'owner', now, 30).registry)
    assert.deepEqual(authenticate(source, hard.token), { principal_id: 'owner' })

    // 损坏文件：本次拒绝（fail closed），修复后下一次读取恢复。
    writeFileSync(path, '{not json', { mode: 0o600 })
    assert.equal(authenticate(source, hard.token), null)
    assert.equal(source.identities.principal({ principal_id: 'owner' }), null)
    write(hard.registry)
    assert.deepEqual(authenticate(source, hard.token), { principal_id: 'owner' })
    source.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function sink() {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', /* 收集输出。 */ (chunk: Buffer) => chunks.push(chunk))
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

test('token CLI manages the registry file and the local client credential end to end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-token-cli-'))
  try {
    const state = join(root, 'gateway')
    mkdirSync(join(state, 'managed'), { recursive: true, mode: 0o700 })
    const config = { ...configTemplate('gateway'), state_dir: state } as GatewayConfig
    const configPath = join(root, 'gateway.json')
    writeFileSync(configPath, JSON.stringify(configDocument(config)), { mode: 0o600 })
    const callers = join(state, 'managed', 'mcp-callers.json')
    const client = join(state, 'managed', 'mcp-client.json')
    const original = 'b'.repeat(43)
    const now = Date.now()
    writeFileSync(callers, JSON.stringify(registry(original, now - 1000)), { mode: 0o600 })
    writeFileSync(
      client,
      JSON.stringify({
        schema_version: 1,
        kind: 'mcp-client-credential',
        attempt_id: 'attempt1',
        resource,
        principal_id: 'owner',
        token: original,
        issued_at: now - 1000,
        expires_at: now + DAY
      }),
      { mode: 0o600 }
    )
    const run = async (...args: string[]) => {
      const out = sink()
      const err = sink()
      const code = await handleTokenCommand(['token', ...args, '--config', configPath], {
        stdout: out.stream,
        stderr: err.stream
      })
      return { code, out: out.text(), err: err.text() }
    }
    const stored = () => JSON.parse(readFileSync(callers, 'utf8')) as CallerRegistry

    let result = await run('list')
    assert.equal(result.code, 0)
    assert.match(result.out, /^owner\tactive\t[^\t]+\t-\tall$/m)

    result = await run('create', '--principal', 'worker', '--like', 'owner', '--ttl-days', '7')
    assert.equal(result.code, 0)
    const workerToken = result.out.trim()
    assert.match(workerToken, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(stored().callers[1]!.token_sha256, digestToken(workerToken))
    assert.equal(stored().callers[1]!.token, workerToken)

    result = await run('rotate', '--principal', 'owner', '--grace-minutes', '5')
    assert.equal(result.code, 0)
    const rotated = result.out.trim()
    assert.equal(stored().callers[0]!.token_sha256, digestToken(rotated))
    assert.equal(stored().callers[0]!.previous?.token_sha256, digestToken(original))
    // 本机客户端凭据文件同步到新令牌，已配置的本地客户端无需手工更新。
    assert.equal(JSON.parse(readFileSync(client, 'utf8')).token, rotated)

    result = await run('renew', '--principal', 'owner', '--ttl-days', '90')
    assert.equal(result.code, 0)
    assert.equal(result.out, '')
    assert(stored().callers[0]!.expires_at > Date.now() + 80 * DAY)
    assert.equal(JSON.parse(readFileSync(client, 'utf8')).token, rotated)
    assert(JSON.parse(readFileSync(client, 'utf8')).expires_at > Date.now() + 80 * DAY)

    const beforePermissions = stored().callers[0]!
    result = await run('permissions', '--principal', 'owner', '--discard-response', 'true')
    assert.equal(result.code, 0)
    assert.equal(result.out, '')
    assert.deepEqual(stored().callers[0]!.principal.permissions, { discard_response: true })
    assert.equal(stored().callers[0]!.token_sha256, beforePermissions.token_sha256)
    assert.equal(stored().callers[0]!.expires_at, beforePermissions.expires_at)
    result = await run('permissions', '--principal', 'owner', '--discard-response', 'false')
    assert.equal(result.code, 0)
    assert.deepEqual(stored().callers[0]!.principal.permissions, { discard_response: false })

    // 设备范围：收窄、列表列、清除；注册表字节在不合法请求后保持不变。
    result = await run('scope', '--principal', 'owner', '--devices', 'm_one,m_two')
    assert.equal(result.code, 0)
    assert.equal(result.err, 'device scope owner selected(2)\n')
    assert.deepEqual(stored().callers[0]!.device_scope, { mode: 'selected', machine_ids: ['m_one', 'm_two'] })
    const beforeBadScope = readFileSync(callers)
    for (const bad of [
      ['scope', '--principal', 'owner', '--devices', ''],
      ['scope', '--principal', 'owner', '--devices', 'm_one,,m_two'],
      ['scope', '--principal', 'owner', '--devices', 'm_one,m_one'],
      ['scope', '--principal', 'owner'],
      ['scope', '--principal', 'owner', '--all-devices', 'yes'],
      ['scope', '--principal', 'owner', '--devices', 'm_one', '--all-devices', 'true'],
      ['scope', '--principal', 'ghost', '--devices', 'm_one'],
      ['scope', '--principal', 'owner', '--devices', 'm_one', '--ttl-days', '30']
    ]) {
      result = await run(...bad)
      assert.equal(result.code, 2, bad.join(' '))
      assert.equal(result.err, 'invalid_arguments\n')
    }
    assert.deepEqual(readFileSync(callers), beforeBadScope)
    result = await run('list')
    assert.match(result.out, /^owner\tactive\t[^\t]+\t[^\t]+\tselected\(2\)$/m)
    result = await run('scope', '--principal', 'owner', '--no-devices', 'true')
    assert.equal(result.code, 0)
    assert.deepEqual(stored().callers[0]!.device_scope, { mode: 'selected', machine_ids: [] })
    result = await run('scope', '--principal', 'owner', '--all-devices', 'true')
    assert.equal(result.code, 0)
    assert.equal(result.err, 'device scope owner all\n')
    assert.equal(stored().callers[0]!.device_scope, undefined)

    result = await run('revoke', '--principal', 'worker')
    assert.equal(result.code, 0)
    assert.deepEqual(
      stored().callers.map(/* 只剩 owner。 */ (entry) => entry.principal.id),
      ['owner']
    )

    for (const bad of [
      ['create', '--principal', 'x'],
      ['create', '--principal', 'x', '--like', 'missing'],
      ['renew', '--principal', 'ghost'],
      ['revoke'],
      ['list', '--principal', 'owner'],
      ['rotate', '--principal', 'owner', '--ttl-days', '0'],
      ['permissions', '--principal', 'owner'],
      ['permissions', '--principal', 'owner', '--discard-response', 'yes'],
      ['permissions', '--principal', 'ghost', '--discard-response', 'true'],
      ['permissions', '--principal', 'owner', '--discard-response', 'true', '--ttl-days', '30'],
      ['renew', '--principal', 'owner', '--discard-response', 'true'],
      ['nonsense']
    ]) {
      result = await run(...bad)
      assert.equal(result.code, 2, bad.join(' '))
      assert.equal(result.err, 'invalid_arguments\n')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('caller source accepts proxy URLs without external address settings; Bearer and local registry binding remain required', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-proxy-auth-'))
  try {
    const path = join(root, 'callers.json')
    const token = 'c'.repeat(43)
    const base = registry(token, Date.now() - 1000)
    writeFileSync(path, JSON.stringify(base), { mode: 0o600 })
    const source = openCallerSource(path, resource)
    const call = (url: string, proof = token) =>
      source.authentication.authenticate(
        new Request(url, { headers: { authorization: `Bearer ${proof}` } }),
        new AbortController().signal
      )
    try {
      for (const url of [resource, 'http://public.example/mcp', 'https://other.example:8443/mcp']) {
        assert.deepEqual(call(url), { principal_id: 'owner' })
        assert.equal(call(url, 'wrong'.repeat(9)), null)
      }
      for (const url of ['http://public.example/other', 'http://public.example/mcp?x=1']) {
        assert.equal(call(url), null)
      }
      writeFileSync(path, JSON.stringify(revokeCaller(base, 'owner')))
      assert.equal(call('https://public.example/mcp'), null)
      assert.throws(() => openCallerSource(path, resource + '/other'))
    } finally {
      source.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
