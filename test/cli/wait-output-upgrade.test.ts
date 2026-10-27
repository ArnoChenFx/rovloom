// 用真实注册表热读取核对 token 不受旧方法清单限制；不创建原生进程，token 为本用例合成值。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleSetupAuthorization, allExposedMethods } from '../../src/cli/setup-policy.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { writeSetupFile } from '../../src/cli/setup-files.js'
import { digestToken } from '../../src/cli/token-registry.js'
import { allExposedConnectorMethods } from '../../src/cli/setup-connector-policy.js'

function legacy() {
  const authorization = simpleSetupAuthorization('legacy_machine', ['luvus', 'herdr'], { luvus: 'default' })
  for (const policy of [authorization.policies.caller, authorization.policies.local]) {
    policy.grants[0]!.methods = ['pane.list']
  }
  return authorization
}

test('同一个 token 使用全方法，旧方法限制失效且设备范围保持不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-wait-upgrade-'))
  const path = join(root, 'callers.json')
  const authorization = legacy()
  const token = 'a'.repeat(43)
  const resource = 'http://127.0.0.1:9444/mcp'
  const registry = {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource,
    local_policy: authorization.policies.local,
    gateway_policy: authorization.policies.caller,
    callers: [
      {
        principal: { id: 'test', policy: authorization.policies.caller },
        token_sha256: digestToken(token),
        issued_at: Date.now() - 1000,
        expires_at: Date.now() + 60000,
        device_scope: { mode: 'selected', machine_ids: ['legacy_machine'] }
      },
      {
        principal: { id: 'gateway_test', policy: authorization.policies.caller },
        scope: 'gateway',
        token_sha256: digestToken('b'.repeat(43)),
        issued_at: Date.now() - 1000,
        expires_at: Date.now() + 60000
      }
    ]
  }
  writeSetupFile(path, JSON.stringify(registry))
  const original = readFileSync(path)
  const source = openCallerSource(path, resource)
  try {
    const caller = source.authentication.authenticate(
      new Request(resource, { headers: { authorization: 'Bearer ' + token } }),
      new AbortController().signal
    )
    assert.deepEqual(caller, { principal_id: 'test' })
    for (const id of ['test', 'gateway_test']) {
      const current = source.identities.principal({ principal_id: id })!
      assert.deepEqual(current.policy.grants[0]!.methods, ['*'])
      assert.deepEqual(current.policy.grants[1], authorization.policies.caller.grants[1])
    }
    assert.deepEqual(
      source.identities.principal({ principal_id: 'test' })!.device_scope,
      registry.callers[0]!.device_scope
    )
    assert.deepEqual(source.localPolicies().grants[0]!.methods, ['*'])
    assert.deepEqual(readFileSync(path), original)
    registry.callers[0]!.principal.policy = structuredClone(authorization.policies.caller)
    registry.callers[0]!.principal.policy.grants[0]!.methods = ['pane.read']
    writeSetupFile(path, JSON.stringify(registry), true)
    assert.deepEqual(source.identities.principal({ principal_id: 'test' })!.policy.grants[0]!.methods, ['*'])
    registry.callers[0]!.principal.policy = { revision: 'old_per_token_policy', grants: [] }
    writeSetupFile(path, JSON.stringify(registry), true)
    assert.deepEqual(source.identities.principal({ principal_id: 'test' })!.policy.grants, [])
    assert.equal(source.identities.principal({ principal_id: 'test' })!.policy.revision, 'old_per_token_policy')
    // 绑定丢失不能借 local 的其它设备；普通 token 仍只使用自己的目标和动作边界。
    delete (registry as Partial<typeof registry>).gateway_policy
    registry.local_policy.grants.push({
      ...registry.local_policy.grants[0]!,
      target: { ...registry.local_policy.grants[0]!.target, machine_id: 'device_y' }
    })
    registry.callers[0]!.principal.policy = {
      revision: 'setup_caller_simple',
      grants: [{ ...authorization.policies.caller.grants[0]!, methods: ['pane.list'], actions: ['read'] }]
    }
    writeSetupFile(path, JSON.stringify(registry), true)
    const restricted = source.identities.principal({ principal_id: 'test' })!.policy
    assert.equal(restricted.grants.length, 1)
    assert.equal(restricted.grants[0]!.target.machine_id, 'legacy_machine')
    assert.deepEqual(restricted.grants[0]!.actions, ['read'])
    assert.deepEqual(source.identities.principal({ principal_id: 'gateway_test' })!.policy.grants, [])
  } finally {
    source.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Connector 的旧逐方法策略不再限制调用，原安装与目标不变', () => {
  const authorization = legacy()
  const entry = {
    reference: 'luvus_legacy',
    value: {
      kind: 'luvus',
      authentication: 'local_owner',
      principal_id: authorization.principal_id,
      peer_policy_revision: authorization.policies.local.revision,
      policies: authorization.policies,
      native: { mode: 'user', config: { fixture: 'unchanged' } }
    }
  }
  const original = structuredClone(entry)
  const result = allExposedConnectorMethods(entry)
  const value = result.value as typeof entry.value
  assert.deepEqual(value.policies.caller.grants[0]!.methods, ['*'])
  assert.deepEqual(value.policies.local.grants[0]!.methods, ['*'])
  assert.deepEqual(value.native, original.value.native)
  assert.deepEqual(entry, original)
  assert.deepEqual(allExposedConnectorMethods(result), result)
  const narrow = {
    revision: authorization.policies.caller.revision,
    grants: [
      {
        ...authorization.policies.caller.grants[0]!,
        methods: ['pane.read']
      }
    ]
  }
  assert.deepEqual(allExposedMethods(narrow).grants[0]!.methods, ['*'])
  const custom = { ...authorization.policies.caller, revision: 'custom_policy' }
  assert.deepEqual(allExposedMethods(custom).grants[0]!.methods, ['*'])
  const readonly = structuredClone(entry)
  readonly.value.policies.caller.grants[0]!.actions = ['read']
  readonly.value.policies.local.grants[0]!.actions = ['read']
  const runtime = allExposedConnectorMethods(readonly).value as typeof entry.value
  assert.deepEqual(runtime.policies.caller.grants[0]!.actions, ['read'])
  assert.deepEqual(runtime.policies.local.grants[0]!.actions, ['read'])
})
