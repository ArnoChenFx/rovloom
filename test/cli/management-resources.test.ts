import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagementResources } from '../../src/cli/management-resources.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { writeAdminFiles } from '../../src/cli/admin-command.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { runtimeReference, readRuntimeJson } from '../../src/cli/runtime-files.js'
import { parseRegistry, REGISTRY_MAX_BYTES } from '../../src/cli/token-registry.js'
import { writeSetupFile } from '../../src/cli/setup-files.js'
import { publishSetupCaller } from '../../src/cli/setup-publish.js'
import { LIMITS } from '../../src/wire/index.js'
import { options as callOptions } from '../storage/helpers.js'
import { context, setup, confirmed } from '../admin/write-helpers.js'

function owned() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-resource-crud-'))
  mkdirSync(join(root, 'managed'))
  const config = { ...configTemplate('gateway'), state_dir: root } as GatewayConfig
  writeAdminFiles(config, 'admin', Date.now())
  const f = setup(undefined, {
    management: () => ({ actor: 'test', confirmation_id: crypto.randomUUID() }),
    pairingClaimCustody: () => {}
  })
  let allowed = true
  const disconnected: string[] = []
  const resources = createManagementResources({
    config,
    store: f.store,
    authorize: () => allowed,
    disconnect: (machine) => {
      disconnected.push(machine)
    }
  })
  const execute = (operation: string, args = {}) =>
    resources.execute(operation, args, context(), new AbortController().signal) as any
  return {
    root,
    config,
    f,
    disconnected,
    resources,
    execute,
    deny() {
      allowed = false
    },
    close() {
      f.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('Dashboard tokens persist across reopen, authenticate, follow new devices and are revoked immediately', async () => {
  const o = owned()
  let caller: ReturnType<typeof openCallerSource> | undefined
  try {
    o.execute('tokens_create', { principal: 'claude', days: 365 })
    let list = o.execute('tokens_list')
    assert.equal(list.items.length, 1) // admin placeholder never exposed
    const token = list.items[0].token
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    const path = runtimeReference(o.root, 'mcp-callers')
    const registry = parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES))
    caller = openCallerSource(path, registry.resource)
    const request = new Request(registry.resource, { headers: { authorization: 'Bearer ' + token } })
    assert.deepEqual(await caller.authentication.authenticate(request, new AbortController().signal), {
      principal_id: 'claude'
    })
    publishSetupCaller(path, registry.resource, {
      principal: { id: 'first' },
      token_sha256: 'a'.repeat(64),
      issued_at: Date.now(),
      expires_at: Date.now() + 86400000
    })
    assert(!Object.hasOwn(caller.identities.principal({ principal_id: 'claude' })!, 'policy'))
    caller.close()
    caller = openCallerSource(path, registry.resource)
    assert.equal(o.execute('tokens_list').items.find((entry: any) => entry.principal === 'claude').token, token)
    o.execute('tokens_delete', { principal: 'claude' })
    assert.equal(await caller.authentication.authenticate(request, new AbortController().signal), null)
    assert.equal(caller.identities.principal({ principal_id: 'claude' }), null)
    list = o.execute('tokens_list')
    assert.equal(
      list.items.some((entry: any) => entry.principal === 'claude'),
      false
    )
    assert.throws(() => o.execute('tokens_delete', { principal: 'admin' }))
  } finally {
    caller?.close()
    o.close()
  }
})

test('Dashboard 范围和 token 创建只保存身份与设备范围，清理旧策略数据', () => {
  const o = owned()
  try {
    o.execute('tokens_create', { principal: 'reader' })
    const device = o.f.store.register('readonly-device')
    const path = runtimeReference(o.root, 'mcp-callers')
    o.execute('tokens_scope', { principal: 'reader', machine_ids: [device.machine_id] })
    o.execute('tokens_create', { principal: 'new_reader' })
    const stored = parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES))
    assert.equal(stored.schema_version, 2)
    assert.deepEqual(stored.callers.find((entry) => entry.principal.id === 'reader')!.device_scope, {
      mode: 'selected',
      machine_ids: [device.machine_id]
    })
    for (const entry of stored.callers) {
      assert.deepEqual(entry.principal, { id: entry.principal.id })
    }
    assert(!Object.hasOwn(stored, 'local_policy'))
    assert(!Object.hasOwn(stored, 'gateway_policy'))
  } finally {
    o.close()
  }
})

test('Dashboard device scope is strictly validated, authorized and applied to the same registry', () => {
  const o = owned()
  try {
    o.execute('tokens_create', { principal: 'claude' })
    const device = o.f.store.register('scoped-device')
    const path = runtimeReference(o.root, 'mcp-callers')
    const read = () => parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES))
    // 设备候选与令牌列表来自同一次读取，按 machine_id 有界排序；未超上限时明确不截断。
    let list = o.execute('tokens_list')
    assert.equal(list.devices_total, o.f.store.resources().length)
    assert.equal(list.devices_truncated, false)
    assert(Array.isArray(list.devices))
    assert.deepEqual(
      list.devices.map(/* 公开字段只有稳定 ID 与名称。 */ (entry: any) => Object.keys(entry).sort()),
      [['machine_id', 'name']]
    )
    assert(list.devices.some((entry: any) => entry.machine_id === device.machine_id))
    // 缺省为全部设备。
    assert.deepEqual(list.items[0].device_scope, { mode: 'all' })
    const stamp = readFileSync(path)
    o.execute('tokens_scope', { principal: 'claude', machine_ids: [device.machine_id] })
    assert.deepEqual(read().callers.find((entry) => entry.principal.id === 'claude')!.device_scope, {
      mode: 'selected',
      machine_ids: [device.machine_id]
    })
    list = o.execute('tokens_list')
    assert.deepEqual(list.items[0].device_scope, { mode: 'selected', machine_ids: [device.machine_id] })
    // 空数组禁用所有设备，显式 all_devices 恢复全部设备。
    const narrowed = readFileSync(path)
    assert.notDeepEqual(narrowed, stamp)
    // 缺失或 null 不能隐式放开已收窄的范围；拒绝后注册表必须逐字节不变。
    for (const args of [{ principal: 'claude' }, { principal: 'claude', machine_ids: null }]) {
      assert.throws(() => o.execute('tokens_scope', args), /invalid_arguments/)
      assert.deepEqual(readFileSync(path), narrowed)
    }
    o.execute('tokens_scope', { principal: 'claude', machine_ids: [] })
    assert.deepEqual(read().callers.find((entry) => entry.principal.id === 'claude')!.device_scope, {
      mode: 'selected',
      machine_ids: []
    })
    o.execute('tokens_scope', { principal: 'claude', all_devices: true })
    assert.equal(read().callers.find((entry) => entry.principal.id === 'claude')!.device_scope, undefined)
    assert.deepEqual(o.execute('tokens_list').items[0].device_scope, { mode: 'all' })
    // 严格参数：未知字段、重复 ID、非字符串与超限全部 invalid_arguments，且文件字节不变。
    const before = readFileSync(path)
    for (const args of [
      { principal: 'claude' },
      { principal: 'claude', machine_ids: null },
      { principal: 'claude', all_devices: false },
      { principal: 'claude', all_devices: true, machine_ids: [] },
      { principal: 'claude', machine_ids: [device.machine_id, device.machine_id] },
      { principal: 'claude', machine_ids: [1] },
      { principal: 'claude', machine_ids: device.machine_id },
      { principal: 'claude', machine_ids: Array.from({ length: 257 }, (_, index) => 'm_' + index) },
      { principal: 'claude', machine_ids: [], days: 30 },
      { principal: 'ghost', machine_ids: [device.machine_id] },
      { machine_ids: [device.machine_id] }
    ]) {
      assert.throws(() => o.execute('tokens_scope', args), /invalid_arguments/)
    }
    assert.deepEqual(readFileSync(path), before)
    // 写后注册表字节代次推进：并发编辑检测依据 setupFileStamp 变化。
    const advanced = readFileSync(path)
    o.execute('tokens_scope', { principal: 'claude', machine_ids: [device.machine_id] })
    assert.notDeepEqual(readFileSync(path), advanced)
    // 授权失败不得写入。
    const guarded = readFileSync(path)
    o.deny()
    assert.throws(() => o.execute('tokens_scope', { principal: 'claude', machine_ids: [] }), /forbidden/)
    assert.deepEqual(readFileSync(path), guarded)
  } finally {
    o.close()
  }
})

test('device candidates past the scope limit are flagged instead of silently dropped', () => {
  const o = owned()
  try {
    // 上限 + 1 台设备：候选按 machine_id 有界排序交付，超出部分显式标记为截断。
    for (let index = 0; index < LIMITS.scope_machines + 1; index++) {
      o.f.store.register('overflow_' + String(index).padStart(3, '0'))
    }
    o.execute('tokens_create', { principal: 'claude' })
    const list = o.execute('tokens_list')
    assert.equal(list.devices.length, LIMITS.scope_machines)
    assert.equal(list.devices_total, o.f.store.resources().length)
    assert.equal(list.devices_truncated, true)
    assert.equal(list.devices_total, LIMITS.scope_machines + 1)
    // 排序稳定：候选前缀与 Store 排序一致，不随机丢设备。
    assert.deepEqual(
      list.devices.map(/* 只比对稳定 ID。 */ (entry: any) => entry.machine_id),
      o.f.store
        .resources()
        .slice(0, LIMITS.scope_machines)
        .map((entry) => entry.machine_id)
    )
    // 已被截断的设备仍可写入范围（CLI 或既有选择），只是不在候选里；写入按 machine_id 校验。
    const beyond = o.f.store.resources().at(-1)!.machine_id
    o.execute('tokens_scope', { principal: 'claude', machine_ids: [beyond] })
    assert.deepEqual(o.execute('tokens_list').items[0].device_scope, { mode: 'selected', machine_ids: [beyond] })
  } finally {
    o.close()
  }
})

test('legacy hash-only tokens remain valid, can be reissued, and malformed stored plaintext is rejected', () => {
  const o = owned()
  try {
    o.execute('tokens_create', { principal: 'legacy' })
    const path = runtimeReference(o.root, 'mcp-callers')
    const registry = structuredClone(parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES)))
    const entry = registry.callers.find((item) => item.principal.id === 'legacy')!
    delete entry.token
    writeSetupFile(path, JSON.stringify(registry), true)
    assert.equal(o.execute('tokens_list').items[0].token, null)
    o.execute('tokens_rotate', { principal: 'legacy' })
    const token = o.execute('tokens_list').items[0].token
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    entry.token = 'wrong'.repeat(9)
    assert.throws(() => parseRegistry(registry))
  } finally {
    o.close()
  }
})

test('device deletion removes bindings, rejects old credentials and permits pairing the same name again', () => {
  const o = owned()
  try {
    const device = o.f.store.register('home-server')
    const paired = o.f.store.redeem(o.f.store.issueEnrollment(device.machine_id))
    o.f.store.connect(device.machine_id, paired.credential)
    o.f.store.defineProvider({
      machine_id: device.machine_id,
      provider_id: 'luvus',
      kind: 'luvus',
      config_ref: 'owned',
      binding_revision: 1,
      enabled: true
    })
    const call = o.f.store.createCall(
      'alice',
      { machine_id: device.machine_id, provider_id: 'luvus', profile: 'session', session: 'test' },
      { method: 'ping' },
      callOptions()
    )
    const events: { kind: string }[] = []
    o.f.store.subscribeInvalidation((event) => events.push(event))
    const path = runtimeReference(o.root, 'providers')
    writeSetupFile(
      path,
      JSON.stringify({
        schema_version: 1,
        role: 'gateway',
        providers: [
          { reference: 'owned', value: {} },
          { reference: 'other', value: {} }
        ]
      })
    )
    o.execute('devices_delete', { machine_id: device.machine_id })
    assert.equal(o.f.store.resources().length, 0)
    assert.throws(() => o.f.store.call('alice', call.call_id))
    assert(events.some((event) => event.kind === 'fence' || event.kind === 'device_fence'))
    assert.throws(() => o.f.store.connect(device.machine_id, paired.credential))
    assert.equal(o.f.store.provider(device.machine_id, 'luvus'), undefined)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).providers, [{ reference: 'other', value: {} }])
    assert.deepEqual(o.disconnected, [device.machine_id])
    assert.notEqual(o.f.store.register('home-server').machine_id, device.machine_id)
  } finally {
    o.close()
  }
})

test('配对认领接受新增的 herdr-core kind，旧 luvus/herdr 不变', async () => {
  const o = owned()
  try {
    const intent = {
      action: 'pairing_create' as const,
      target: { name: 'core-device', labels: [], policy_ref: 'fixture_policy' }
    }
    const c = await confirmed(o.f.service, intent, 0)
    const receipt = await o.f.service.execute('pairings_create', { ...c.write, ...intent.target }, context())
    const claim = o.f.store.startPairingClaim(receipt.machine_id, receipt.pairing_id, 'a'.repeat(64), 'ABCD1234')
    o.f.store.approvePairingClaim(claim.claim_id, claim.user_code, 'test')
    o.f.store.completePairingClaim(claim.claim_id)
    const binding = {
      machine_id: receipt.machine_id,
      provider_id: 'herdr-core',
      kind: 'herdr-core' as const,
      config_ref: 'herdr-core_' + claim.claim_id,
      binding_revision: 1,
      enabled: true
    }
    const activated = o.f.store.activatePairingProviders(claim.claim_id, 'b'.repeat(64), [binding])
    assert.equal(activated.status, 'activated')
    assert.deepEqual(o.f.store.provider(receipt.machine_id, 'herdr-core'), binding)
    // 旧 kind 的绑定形状不受影响。
    assert.deepEqual(o.f.store.activatePairingProviders(claim.claim_id, 'b'.repeat(64), [binding]).status, 'activated')
    assert.throws(
      () =>
        o.f.store.activatePairingProviders(claim.claim_id, 'b'.repeat(64), [{ ...binding, kind: 'unknown' as never }]),
      /invalid_pairing_claim|invalid_provider_binding|invalid_enum/u
    )
  } finally {
    o.close()
  }
})

test('pairing deletion stops pending claims and preserves completed devices', async () => {
  const o = owned()
  try {
    for (const stage of ['pending', 'approved', 'delivered', 'activated']) {
      const intent = {
        action: 'pairing_create' as const,
        target: { name: stage, labels: [], policy_ref: 'fixture_policy' }
      }
      const c = await confirmed(o.f.service, intent, 0)
      const receipt = await o.f.service.execute('pairings_create', { ...c.write, ...intent.target }, context())
      const claim = o.f.store.startPairingClaim(receipt.machine_id, receipt.pairing_id, 'a'.repeat(64), 'ABCD1234')
      let credential: string | undefined
      if (stage !== 'pending') {
        const approved = o.f.store.approvePairingClaim(claim.claim_id, claim.user_code, 'test')
        credential = approved.credential
        if (stage !== 'approved') {
          o.f.store.completePairingClaim(claim.claim_id)
        }
        if (stage === 'activated') {
          o.f.store.activatePairingClaim(claim.claim_id, 'b'.repeat(64))
        }
      }
      assert(o.execute('pairings_list').items.some((entry: any) => entry.pairing_id === receipt.pairing_id))
      const before = o.disconnected.length
      o.execute('pairings_delete', { pairing_id: receipt.pairing_id })
      assert.equal(o.disconnected.length, before + (stage === 'approved' || stage === 'delivered' ? 1 : 0))
      assert.equal(o.f.store.pairingApplication(receipt.pairing_id), undefined)
      assert.throws(() => o.f.store.pairingClaim(claim.claim_id))
      assert(o.f.store.machine(receipt.machine_id))
      if (credential && stage === 'activated') {
        assert(o.f.store.connect(receipt.machine_id, credential))
      } else if (credential) {
        assert.throws(() => o.f.store.connect(receipt.machine_id, credential!))
      }
    }
  } finally {
    o.close()
  }
})

test('resource HTTP routes reuse authentication, CSRF and full administrator checks', async () => {
  const o = owned()
  const origin = 'http://127.0.0.1:42201'
  const h = createManagementHandler({
    origin,
    service: o.f.service,
    resources: o.resources,
    authenticate: async (req) => (req.headers.get('cookie') === 'valid' ? context() : null),
    verifyCsrf: async (req) => req.headers.get('x-rovloom-csrf') === 'valid'
  })
  const request = (headers = {}) =>
    new Request(origin + '/admin/v1/resources/tokens_list', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:42201',
        origin,
        cookie: 'valid',
        'x-rovloom-csrf': 'valid',
        'content-type': 'application/json',
        ...headers
      },
      body: '{}'
    })
  try {
    assert.equal((await h.fetch(request())).status, 200)
    assert.equal((await h.fetch(request({ cookie: '' }))).status, 401)
    assert.equal((await h.fetch(request({ 'x-rovloom-csrf': 'invalid' }))).status, 403)
    assert.equal(
      (await h.fetch(request({ origin: 'http://other.invalid', 'sec-fetch-site': 'cross-site' }))).status,
      403
    )
    o.deny()
    assert.equal((await h.fetch(request())).status, 403)
  } finally {
    h.stop()
    o.close()
  }
})
