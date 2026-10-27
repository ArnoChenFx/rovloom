import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { emptyCallerRegistry } from '../../src/cli/admin-command.js'
import {
  createCaller,
  createGatewayCaller,
  digestToken,
  parseRegistry,
  setDeviceScope
} from '../../src/cli/token-registry.js'
import { writeSetupFile } from '../../src/cli/setup-files.js'

const resource = 'http://127.0.0.1:9444/mcp'
const token = 'a'.repeat(43)
function legacy() {
  return {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource,
    local_policy: {
      revision: 'different',
      grants: [
        {
          target: { machine_id: 'device_y', provider_id: 'luvus', profile: 'session', session: 'default' },
          methods: ['*'],
          actions: ['dispatch']
        }
      ]
    },
    callers: [
      {
        principal: {
          id: 'test',
          policy: {
            revision: 'old',
            grants: [
              {
                target: { machine_id: 'device_x', provider_id: 'luvus', profile: 'session', session: 'default' },
                methods: ['pane.list'],
                actions: ['read']
              }
            ]
          }
        },
        token_sha256: digestToken(token),
        issued_at: Date.now() - 1000,
        expires_at: Date.now() + 60000
      }
    ]
  }
}

test('旧 token 只迁移原设备边界，不借 local 扩权，也不保留方法/动作策略', () => {
  const migrated = parseRegistry(legacy(), resource)
  assert.equal(migrated.schema_version, 2)
  assert.deepEqual(migrated.callers[0]!.principal, { id: 'test' })
  assert.deepEqual(migrated.callers[0]!.device_scope, { mode: 'selected', machine_ids: ['device_x'] })
  assert.equal(migrated.callers[0]!.token_sha256, digestToken(token))
  assert(!Object.hasOwn(migrated, 'local_policy'))
  assert(!Object.hasOwn(migrated, 'gateway_policy'))
  const clone = createCaller(migrated, 'clone', 'test', Date.now()).registry.callers.at(-1)!
  assert.deepEqual(clone.device_scope, migrated.callers[0]!.device_scope)
  assert.deepEqual(clone.principal, { id: 'clone' })
})

test('已有显式设备范围优先，修改范围与新建 token 都不重新生成授权策略', () => {
  const old = {
    ...legacy(),
    callers: legacy().callers.map((entry) => ({
      ...entry,
      device_scope: { mode: 'selected', machine_ids: ['device_y'] }
    }))
  }
  const migrated = parseRegistry(old)
  assert.deepEqual(migrated.callers[0]!.device_scope, { mode: 'selected', machine_ids: ['device_y'] })
  const narrowed = setDeviceScope(migrated, 'test', [])
  assert.deepEqual(narrowed.callers[0]!.device_scope, { mode: 'selected', machine_ids: [] })
  const created = createGatewayCaller(emptyCallerRegistry(resource), 'new', Date.now()).registry
  assert.equal(created.schema_version, 2)
  assert.deepEqual(created.callers[0]!.principal, { id: 'new' })
  assert(!Object.hasOwn(created.callers[0]!, 'scope'))
  assert(!JSON.stringify(created).includes('policy'))
})

test('热读旧文件仅返回身份与设备范围，不写盘、不调用旧策略或 raw 授权', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-device-access-'))
  const path = join(root, 'callers.json')
  writeSetupFile(path, JSON.stringify(legacy()))
  const bytes = readFileSync(path)
  const source = openCallerSource(path, resource)
  try {
    assert.deepEqual(
      source.authentication.authenticate(
        new Request(resource, { headers: { authorization: 'Bearer ' + token } }),
        new AbortController().signal
      ),
      { principal_id: 'test' }
    )
    assert.deepEqual(source.identities.principal({ principal_id: 'test' }), {
      id: 'test',
      device_scope: { mode: 'selected', machine_ids: ['device_x'] }
    })
    assert(!Object.hasOwn(source, 'localPolicies'))
    assert.deepEqual(readFileSync(path), bytes)
  } finally {
    source.close()
    rmSync(root, { recursive: true, force: true })
  }
})
