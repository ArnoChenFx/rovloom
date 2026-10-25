/** Gateway token identities share the paired caller policy, never the local policy's revision or grants. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { simpleSetupAuthorization } from '../../src/cli/setup-policy.js'
import { mergeSetupCallers, publishFirstCallers } from '../../src/cli/setup-publish.js'
import { writeSetupFile } from '../../src/cli/setup-files.js'
import {
  createCaller,
  createGatewayCaller,
  digestToken,
  parseRegistry,
  revokeCaller,
  type CallerRegistry
} from '../../src/cli/token-registry.js'

const resource = 'http://127.0.0.1:9/mcp'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-gateway-policy-'))
  const path = join(root, 'callers.json')
  const empty: CallerRegistry = {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource,
    local_policy: { revision: 'rovloom_unpaired', grants: [] },
    callers: []
  }
  const made = createGatewayCaller(empty, 'before_pairing', Date.now() - 1000)
  writeSetupFile(path, JSON.stringify(made.registry))
  const source = openCallerSource(path, resource)
  const authorization = simpleSetupAuthorization('first_machine', ['herdr'])
  const pair = () =>
    publishFirstCallers(path, resource, authorization, {
      principal: { id: authorization.principal_id, policy: authorization.policies.caller },
      token_sha256: digestToken('a'.repeat(43)),
      issued_at: Date.now() - 1000,
      expires_at: Date.now() + 86_400_000
    })
  return {
    path,
    source,
    authorization,
    pair,
    read: () => parseRegistry(JSON.parse(readFileSync(path, 'utf8'))),
    write: (value: CallerRegistry) => writeSetupFile(path, JSON.stringify(value), true),
    principal: (id = 'before_pairing') => source.identities.principal({ principal_id: id })!,
    close() {
      source.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('tokens issued before and after pairing follow caller grants, retain their identities and survive pairing-token revocation', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.principal().policy.grants, [])
    // Deliberately keep caller grants narrower than local grants: copying local grants would widen authority.
    f.authorization.policies.caller.grants[0]!.methods = ['ping']
    f.pair()
    assert.equal(f.principal().id, 'before_pairing')
    assert.deepEqual(f.principal().policy, f.authorization.policies.caller)
    assert.notDeepEqual(f.principal().policy, f.source.localPolicies())
    const after = createGatewayCaller(f.read(), 'after_pairing', Date.now() - 1000)
    assert.deepEqual(after.registry.callers.at(-1)!.principal.policy, f.authorization.policies.caller)
    const cloned = createCaller(after.registry, 'cloned', 'after_pairing', Date.now() - 1000)
    f.write(revokeCaller(cloned.registry, f.authorization.principal_id))
    for (const id of ['before_pairing', 'after_pairing', 'cloned']) {
      assert.equal(f.principal(id).id, id)
      assert.deepEqual(f.principal(id).policy, f.authorization.policies.caller)
    }
    const added = simpleSetupAuthorization('second_machine', ['herdr'])
    mergeSetupCallers(f.path, resource, added)
    for (const id of ['before_pairing', 'after_pairing', 'cloned']) {
      assert.deepEqual(f.principal(id).policy.grants, [
        ...f.authorization.policies.caller.grants,
        ...added.policies.caller.grants
      ])
    }
    // Returned policies cannot mutate the cached authority.
    f.principal().policy.grants.length = 0
    assert.equal(f.principal().policy.grants.length, 2)
    f.write(revokeCaller(f.read(), 'before_pairing'))
    assert.equal(f.source.identities.principal({ principal_id: 'before_pairing' }), null)
    assert(f.principal('after_pairing'))
  } finally {
    f.close()
  }
})

test('legacy simple-pairing registries recover the authoritative caller policy without changing tokens or identity', () => {
  const f = fixture()
  try {
    f.pair()
    const legacy = structuredClone(f.read())
    delete legacy.gateway_policy
    const entry = legacy.callers.find((item) => item.scope === 'gateway')!
    entry.principal.policy = structuredClone(legacy.local_policy) // 0.6.3 Dashboard snapshot
    f.write(legacy)
    const original = readFileSync(f.path)
    assert.equal(f.principal().id, 'before_pairing')
    assert.deepEqual(f.principal().policy, f.authorization.policies.caller)
    assert.deepEqual(readFileSync(f.path), original, 'hot reads never rewrite a user registry')
    const migrated = f.read()
    assert.deepEqual(migrated.gateway_policy, f.authorization.policies.caller)
    f.write(revokeCaller(migrated, f.authorization.principal_id))
    assert.deepEqual(f.principal().policy, f.authorization.policies.caller)
  } finally {
    f.close()
  }
})

test('missing caller binding fails closed instead of borrowing local authority; explicit bindings are validated even without callers', () => {
  const f = fixture()
  try {
    f.pair()
    const unbound = revokeCaller(f.read(), f.authorization.principal_id)
    delete unbound.gateway_policy
    f.write(unbound)
    assert.deepEqual(f.principal().policy.grants, [])
    for (const gateway_policy of [
      null,
      {},
      { revision: 'caller', grants: 'all' },
      { revision: 'caller', grants: [], extra: true }
    ]) {
      assert.throws(() => parseRegistry({ ...unbound, callers: [], gateway_policy }))
    }
  } finally {
    f.close()
  }
})

test('joining rejects a different caller binding without changing registry bytes', () => {
  const f = fixture()
  try {
    f.pair()
    const original = readFileSync(f.path)
    const added = simpleSetupAuthorization('second_machine', ['herdr'])
    added.policies.caller.revision = 'unrelated_caller'
    assert.throws(() => mergeSetupCallers(f.path, resource, added))
    assert.deepEqual(readFileSync(f.path), original)
  } finally {
    f.close()
  }
})
