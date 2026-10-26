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
import { publishFirstCallers } from '../../src/cli/setup-publish.js'
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
    const authorization = {
      principal_id: 'first',
      policies: { caller: { revision: 'caller', grants: [] }, local: { revision: 'local', grants: [] } }
    }
    publishFirstCallers(path, registry.resource, authorization, {
      principal: { id: 'first', policy: authorization.policies.caller },
      token_sha256: 'a'.repeat(64),
      issued_at: Date.now(),
      expires_at: Date.now() + 86400000
    })
    assert.equal(caller.identities.principal({ principal_id: 'claude' })!.policy.revision, 'caller')
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
          o.f.store.activatePairingClaim(claim.claim_id, 'test-fingerprint')
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
