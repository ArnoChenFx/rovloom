// 真实 Store/服务配合可控的传输观测时间，复现取样晚于请求入口导致的错误未来判定。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StoreGatewayService } from '../../src/mcp/store-service.js'
import type { GatewayTransportSnapshot } from '../../src/transport/observation.js'
import { storeFixture, target } from './store-fixture.js'

test('Luvus/Herdr 的 list/get 以取样后的 Store 时钟核对 readiness，真实未来/过期观测仍拒绝', async () => {
  const f = storeFixture()
  const routes = [target, { ...target, provider_id: 'herdr_a' }]
  f.setCaller({ id: 'alice' })
  let drift = 0
  const service = new StoreGatewayService({
    targets: f.targets,
    store: f.store,
    identities: f.identities,
    transportObservations: {
      snapshot(): GatewayTransportSnapshot {
        f.advance(1)
        const observed_at = f.store.clock() + drift
        return {
          observed_at,
          recovery_generation: f.store.generation(),
          transport: { verification: 'verified', source: 'gateway_transport', observed_at, value: 'available' },
          devices: [
            {
              machine_id: target.machine_id,
              connection: {
                verification: 'verified',
                source: 'gateway_transport',
                observed_at,
                value: { state: 'online', connection_epoch_ref: 'synthetic_epoch', last_heartbeat_at: observed_at }
              },
              authentication: {
                verification: 'verified',
                source: 'gateway_transport',
                observed_at,
                value: { state: 'authenticated', last_failure: null }
              },
              providers: routes.map((route) => ({
                provider_id: route.provider_id,
                binding_revision: 1,
                dispatch_ready: { verification: 'verified', source: 'gateway_transport', observed_at, value: true }
              }))
            }
          ]
        }
      }
    }
  })
  const context = { caller: { principal_id: 'alice' }, wait_signal: new AbortController().signal }
  const admin = { ...context, management_session_ref: 'admin_session' }
  try {
    for (const offset of [0, 1, -15000]) {
      drift = offset
      const expected = offset === 0 ? 'ready' : 'unverified'
      const list = await service.execute('providers_list', { machine_id: target.machine_id }, context)
      const managed = await service.management.execute('providers_list', { machine_id: target.machine_id }, admin)
      assert.deepEqual(
        list.data.items.map((row) => row.readiness),
        [expected, expected]
      )
      assert.deepEqual(
        managed.items.map((row) => row.readiness),
        [expected, expected]
      )
      for (const route of routes) {
        const args = { machine_id: route.machine_id, provider_id: route.provider_id }
        assert.equal((await service.execute('providers_get', args, context)).data.readiness, expected)
        assert.equal((await service.management.execute('providers_get', args, admin)).readiness, expected)
      }
    }
  } finally {
    service.close()
    f.close()
  }
})
