/** Real Router/Store/Wire and production admission with independent MCP token identities; native execution is synthetic. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Principal } from '../../src/router.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { writeSetupFile } from '../../src/cli/setup-files.js'
import { publishFirstCallers } from '../../src/cli/setup-publish.js'
import { createGatewayCaller, parseRegistry, digestToken, type CallerRegistry } from '../../src/cli/token-registry.js'
import { contractRef } from '../../src/wire/index.js'
import { fixture, until } from './helpers.js'
import { source as wireSource } from '../wire/helpers.js'
import { G } from '../native-contract/helpers.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { persistentBackend } from '../../src/integration/persistence.js'

test('Dashboard token dispatches with its own identity; stale caller revision refuses without writes and restored binding recovers', async () => {
  let current: Principal
  const f = fixture(
    { principal: () => current, retainOriginalRead: true },
    {},
    {
      connectorAdmission: true,
      adapter(_connection, _channel, services) {
        return createLuvusWireAdapter(
          persistentBackend(f.store, {
            ...services,
            currentPrincipal: () => current.id,
            policies: () => ({ caller: current.policy, local: f.local })
          })
        )
      }
    }
  )
  const root = mkdtempSync(join(tmpdir(), 'rovloom-token-dispatch-'))
  const path = join(root, 'callers.json')
  const resource = 'http://127.0.0.1:9/mcp'
  let source: ReturnType<typeof openCallerSource> | undefined
  try {
    const device = f.pair('dashboard_token_device')
    const client = f.connector(() => device.credential)
    const empty: CallerRegistry = {
      schema_version: 1,
      kind: 'mcp-caller-source',
      resource,
      local_policy: { revision: 'rovloom_unpaired', grants: [] },
      callers: []
    }
    const made = createGatewayCaller(empty, 'dashboard_client', Date.now() - 1000)
    writeSetupFile(path, JSON.stringify(made.registry))
    source = openCallerSource(path, resource)
    publishFirstCallers(
      path,
      resource,
      {
        principal_id: f.principal.id,
        policies: { caller: f.principal.policy, local: f.local }
      },
      {
        principal: f.principal,
        token_sha256: digestToken('a'.repeat(43)),
        issued_at: Date.now() - 1000,
        expires_at: Date.now() + 86_400_000
      }
    )
    const identity = await source.authentication.authenticate(
      new Request(resource, {
        headers: { authorization: 'Bearer ' + made.token }
      }),
      new AbortController().signal
    )
    assert.deepEqual(identity, { principal_id: 'dashboard_client' })
    current = source.identities.principal(identity!)!
    assert.notEqual(current.id, f.principal.id, 'Connector route keeps its independent local principal')
    await until(() => client.status().phase === 'ready')
    const create = () => {
      const contract = [...f.localBindings.values()][0]!
      const call = f.router.create(
        current,
        device.target,
        { method: 'task.add', params: { title: 'synthetic' } },
        {
          binding_revision: contract.binding_revision,
          contract_ref: contractRef({ ...wireSource, runtime_generation: G, classification_revision: 'review1' }),
          timeoutMs: 10_000
        }
      )
      f.gateway.dispatch(call.call_id)
      return call
    }
    const first = create()
    await until(() => f.router.get(current, first.call_id).state === 'responded')
    assert.equal(f.executions, 1)
    assert.throws(() => f.router.get(f.principal, first.call_id), 'result ownership remains per token')
    const result = f.router.saveResult(current, first.call_id)
    const page = f.router.readResult(current, result.result_id)
    assert.equal(JSON.parse(Buffer.from(page.data, 'base64').toString()).result.id, 'mock_task')
    assert.throws(() => f.router.readResult(f.principal, result.result_id), 'result handles retain their MCP owner')
    const stable = parseRegistry(JSON.parse(readFileSync(path, 'utf8')))
    writeSetupFile(path, JSON.stringify({ ...stable, gateway_policy: f.local }), true)
    current = source.identities.principal(identity!)!
    const refused = create()
    await until(() => f.router.get(current, refused.call_id).state === 'not_dispatched')
    assert.equal(f.executions, 1, 'stale caller policy never reaches the native executor')
    assert.equal(client.status().phase, 'ready')
    writeSetupFile(path, JSON.stringify(stable), true)
    current = source.identities.principal(identity!)!
    const recovered = create()
    await until(() => f.router.get(current, recovered.call_id).state === 'responded')
    assert.equal(f.executions, 2)
    assert.equal(client.status().phase, 'ready')
  } finally {
    source?.close()
    f.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
