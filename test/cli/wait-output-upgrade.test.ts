// 用真实注册表热读取核对旧默认授权升级；不创建原生进程，token 为本用例合成值。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  simpleSetupAuthorization,
  upgradeSetupLuvusMethods,
  upgradeSetupLuvusPolicy
} from '../../src/cli/setup-policy.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { writeSetupFile } from '../../src/cli/setup-files.js'
import { digestToken } from '../../src/cli/token-registry.js'
import { migrateSetupLuvusConnector } from '../../src/cli/setup-luvus-grant.js'

function legacy() {
  const authorization = simpleSetupAuthorization('legacy_machine', ['luvus', 'herdr'], { luvus: 'default' })
  for (const policy of [authorization.policies.caller, authorization.policies.local]) {
    policy.grants[0]!.methods = policy.grants[0]!.methods.filter((method) => method !== 'wait.output')
    assert.equal(policy.grants[0]!.methods.length, 35)
  }
  return authorization
}

test('同一个旧 test token 获得输出等待，有效升级不重写文件、不改变设备范围或 Herdr', () => {
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
      assert(current.policy.grants[0]!.methods.includes('wait.output'))
      assert.equal(current.policy.grants[0]!.methods.length, 36)
      assert.deepEqual(current.policy.grants[1], authorization.policies.caller.grants[1])
    }
    assert.deepEqual(
      source.identities.principal({ principal_id: 'test' })!.device_scope,
      registry.callers[0]!.device_scope
    )
    assert(source.localPolicies().grants[0]!.methods.includes('wait.output'))
    assert.deepEqual(readFileSync(path), original)
    registry.callers[0]!.principal.policy = structuredClone(authorization.policies.caller)
    registry.callers[0]!.principal.policy.grants[0]!.methods = ['pane.read']
    writeSetupFile(path, JSON.stringify(registry), true)
    assert.deepEqual(source.identities.principal({ principal_id: 'test' })!.policy.grants[0]!.methods, ['pane.read'])
  } finally {
    source.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Connector 双端默认预设升级，安装记录原文及自定义策略保持不变', () => {
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
  const result = migrateSetupLuvusConnector(entry)
  const value = result.value as typeof entry.value
  assert(value.policies.caller.grants[0]!.methods.includes('wait.output'))
  assert(value.policies.local.grants[0]!.methods.includes('wait.output'))
  assert.deepEqual(value.native, original.value.native)
  assert.deepEqual(entry, original)
  assert.deepEqual(migrateSetupLuvusConnector(result), result)
  const narrow = {
    revision: authorization.policies.caller.revision,
    grants: [
      {
        ...authorization.policies.caller.grants[0]!,
        methods: ['pane.read']
      }
    ]
  }
  assert.equal(upgradeSetupLuvusPolicy(narrow), narrow)
  const custom = { ...authorization.policies.caller, revision: 'custom_policy' }
  assert.equal(upgradeSetupLuvusPolicy(custom), custom)
  const methods = ['pane.read']
  assert.equal(upgradeSetupLuvusMethods(methods), methods)
})
