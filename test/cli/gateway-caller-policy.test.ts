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
  setDeviceScope,
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

test('加入新设备只追加新目标授权，不回溯扩大已批准的旧目标方法集', () => {
  const f = fixture()
  try {
    // 已配对现场：首台设备的授权是升级前的旧方法集，模拟上一版本持久化的策略。
    const legacy = simpleSetupAuthorization('first_machine', ['herdr'])
    legacy.policies.caller.grants[0]!.methods = ['title.add']
    legacy.policies.local.grants[0]!.methods = ['title.add']
    publishFirstCallers(f.path, resource, legacy, {
      principal: { id: legacy.principal_id, policy: legacy.policies.caller },
      token_sha256: digestToken('b'.repeat(43)),
      issued_at: Date.now() - 1000,
      expires_at: Date.now() + 86_400_000
    })
    const added = simpleSetupAuthorization('second_machine', ['herdr'])
    mergeSetupCallers(f.path, resource, added)
    const grants = f.source.localPolicies().grants
    assert.equal(grants.length, 2)
    // 旧目标保持原方法集：程序新增方法不会因为另一台设备配对被追认给已批准设备。
    assert.deepEqual(grants[0], legacy.policies.local.grants[0])
    assert.deepEqual(grants[1], added.policies.local.grants[0])
    // 同一目标换一个方法集属于改写已批准权限，必须拒绝并保持文件不变。
    const original = readFileSync(f.path)
    const wider = simpleSetupAuthorization('second_machine', ['herdr'])
    wider.policies.local.grants[0]!.methods = [...wider.policies.local.grants[0]!.methods, 'title.remove']
    wider.policies.caller.grants[0]!.methods = [...wider.policies.caller.grants[0]!.methods, 'title.remove']
    assert.throws(() => mergeSetupCallers(f.path, resource, wider), { code: 'configuration_required' })
    assert.deepEqual(readFileSync(f.path), original)
  } finally {
    f.close()
  }
})

test('device scope is hot-reloaded per request, survives pairing merges and fails closed on a bad registry', () => {
  const f = fixture()
  try {
    f.pair()
    const machine = f.authorization.policies.caller.grants[0]!.target.machine_id
    // 配对后的设备令牌（非管理页 gateway 令牌）才参与设备范围。
    const principal = f.authorization.principal_id
    // 缺省不收窄。
    assert.equal(f.principal(principal).device_scope, undefined)
    // 热改注册表：下一次请求立即看到新范围，不需要重启。
    f.write(setDeviceScope(f.read(), principal, [machine]))
    assert.deepEqual(f.principal(principal).device_scope, { mode: 'selected', machine_ids: [machine] })
    // 加入新设备只改策略，范围原样保留（不因为授权扩大而放宽可见性）。
    mergeSetupCallers(f.path, resource, simpleSetupAuthorization('second_machine', ['herdr']))
    assert.deepEqual(f.principal(principal).device_scope, { mode: 'selected', machine_ids: [machine] })
    // --like 克隆也带上范围。
    const cloned = createCaller(f.read(), 'cloned_scoped', principal, Date.now() - 1000).registry
    f.write(cloned)
    assert.deepEqual(f.read().callers.find((entry) => entry.principal.id === 'cloned_scoped')!.device_scope, {
      mode: 'selected',
      machine_ids: [machine]
    })
    // 坏配置整体拒绝并保持库文件字节不变：范围字段不会被静默忽略。
    const original = readFileSync(f.path)
    const broken = structuredClone(f.read())
    Object.assign(
      broken.callers.find(/* 目标设备令牌。 */ (entry) => entry.principal.id === principal)!,
      { device_scope: { mode: 'selected', machine_ids: [] } }
    )
    writeSetupFile(f.path, JSON.stringify(broken), true)
    const badBytes = readFileSync(f.path)
    assert.equal(f.source.identities.principal({ principal_id: principal }), null)
    assert.equal(authenticate(f.source, 'a'.repeat(43)), null)
    // 修复后下一次读取恢复，且写入路径继续拒绝空范围而不改动字节。
    writeSetupFile(f.path, JSON.stringify(parseRegistry(JSON.parse(original.toString()))), true)
    assert.equal(f.principal(principal).id, principal)
    const restored = readFileSync(f.path)
    assert.throws(() => setDeviceScope(parseRegistry(JSON.parse(restored.toString())), principal, []))
    assert.deepEqual(readFileSync(f.path), restored)
    assert.notDeepEqual(badBytes, restored)
  } finally {
    f.close()
  }
})

function authenticate(source: ReturnType<typeof openCallerSource>, token: string) {
  return source.authentication.authenticate(
    new Request(resource, { headers: { authorization: `Bearer ${token}` } }),
    new AbortController().signal
  )
}
