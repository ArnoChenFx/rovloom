// 真实Herdr工厂的动态目录期限穿过MCP描述和分页；身份/Store种子为合成fixture，不执行native。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHerdrGatewayResources } from '../../src/connector/herdr/provider.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { authorizedProviderCatalog } from '../../src/mcp/provider-catalog.js'
import { FacadeServiceError, RuntimeGatewayService } from '../../src/mcp/index.js'
import type { ProviderCatalogProvider } from '../../src/mcp/native-catalog.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'
import { target } from './store-fixture.js'
import { projectionFixture } from './runtime-service-fixture.js'

test(
  '真实Herdr resolver跨时钟描述和分页仍保持稳定身份，旧观察期限与授权漂移继续拒绝',
  /** 使用官方schema及真实Worker/目录；只包装时钟推进和明确的撤权反例，不提供执行替身。 */ async () => {
    const root = privateHerdrTestRoot('.herdr-mcp-catalog-')
    const f = projectionFixture({
      mutateSeed: /** 仅在writer关闭的fixture阶段设置Herdr绑定；派发stub不会被本例调用。 */ (db) => {
        db.prepare('UPDATE providers SET kind=? WHERE machine_id=? AND provider_id=?').run(
          'herdr',
          target.machine_id,
          target.provider_id
        )
      }
    })
    let resource: Awaited<ReturnType<typeof createHerdrGatewayResources>> | undefined
    let service: RuntimeGatewayService | undefined
    try {
      const schemaPath = join(root, 'schema.json')
      writeFileSync(schemaPath, readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url)), {
        mode: 0o600
      })
      resource = await createHerdrGatewayResources({
        config: {
          version: 1,
          target,
          binding_revision: 1,
          config_ref: 'safe_ref',
          expected_source: fixedHerdrSource(),
          schema_path: schemaPath,
          peer_policy_revision: 'fixture_local'
        },
        now: /** 与MCP共用单调fixture时钟，实际resolver每次形成now+5000的新观察视图。 */ () => f.store.clock()
      })
      const owner = resource
      const methods = owner
        .describe()
        .methods.slice(0, 3)
        .map(/** 精确使用真实Herdr schema中的三个方法，不猜测或扩大授权集合。 */ (entry) => entry.method)
      assert.equal(methods.length, 3)
      const grants = [{ target, methods: [...methods, 'agent.prompt'], actions: ['read' as const] }]
      f.setCaller({ id: 'alice', policy: { revision: 'caller_catalog', grants } })
      f.setLocal({ revision: 'local_catalog', grants })
      let resolutions = 0
      const provider: ProviderCatalogProvider = {
        kind: 'provider',
        resolve: /** 每次resolve跨毫秒，并委托真实owner产生不同expires_at。 */ (route, principal) => {
          resolutions++
          f.advance(1)
          return owner.catalog.resolve(route, principal)
        }
      }
      const options = {
        store: f.store,
        principal: f.current(),
        currentPrincipal: f.current,
        localPolicies: f.localPolicies,
        target,
        expected_binding_revision: 1,
        provider
      }
      const catalog = authorizedProviderCatalog(options)
      assert.equal(catalog.describe(methods[0]!).method, methods[0])
      assert(resolutions >= 4)
      service = new RuntimeGatewayService({
        runtime: f.runtime,
        identities: f.identities,
        localPolicies: f.localPolicies,
        catalog: provider
      })
      const context = { caller: { principal_id: 'alice' }, wait_signal: new AbortController().signal }
      const providerMetadata = (
        await service.execute(
          'providers_get',
          {
            machine_id: target.machine_id,
            provider_id: target.provider_id
          },
          context
        )
      ).data
      assert.equal(providerMetadata.native_version, '0.9.5')
      assert.equal(providerMetadata.schema_status, 'validated')
      assert.equal(providerMetadata.schema_sha256, fixedHerdrSource().schema_sha256)
      const described = (
        await service.execute(
          'runtime_describe',
          {
            target,
            expected_binding_revision: 1,
            method: 'agent.prompt'
          },
          context
        )
      ).data
      const original = owner
        .describe()
        .methods.find(/** 取同一真实owner的完整原生描述，不重写schema。 */ (entry) => entry.method === 'agent.prompt')!
      assert.deepEqual(described.params_schema, original.params_schema)
      const first = await service.execute(
        'runtime_discover',
        { target, expected_binding_revision: 1, limit: 1 },
        context
      )
      assert(first.data.next_cursor)
      assert(
        first.data.items.every(
          /** discover仅摘要，完整schema只在describe交付。 */ (entry) => !Object.hasOwn(entry, 'params_schema')
        )
      )
      f.advance(100)
      const second = await service.execute(
        'runtime_discover',
        {
          target,
          expected_binding_revision: 1,
          limit: 1,
          cursor: first.data.next_cursor
        },
        context
      )
      assert.equal(second.data.items.length, 1)
      assert.notEqual(second.data.items[0]!.method, first.data.items[0]!.method)
      assert(second.data.next_cursor)
      f.advance(4900)
      await assert.rejects(
        service.execute(
          'runtime_discover',
          {
            target,
            expected_binding_revision: 1,
            limit: 1,
            cursor: second.data.next_cursor
          },
          context
        ),
        new FacadeServiceError('invalid_cursor')
      )
      for (const drift of [
        'contract',
        'revision',
        'binding',
        'methods',
        'expired',
        'describe_expiry',
        'revoke'
      ] as const) {
        let reads = 0
        const checked = /** 每次从真实resolver获取当前值，再只注入该反例的漂移。 */ () =>
          authorizedProviderCatalog({
            ...options,
            provider: {
              kind: 'provider',
              /** 每次委托真实Herdr resolver，反例只变更该次返回的公开元数据。 */
              resolve(route, principal) {
                const source = provider.resolve(route, principal)!
                reads++
                if (drift === 'expired') {
                  return { ...source, expires_at: f.store.clock() }
                }
                if (reads > 1 && drift === 'contract') {
                  return { ...source, contract_ref: 'b'.repeat(64) }
                }
                if (reads > 1 && drift === 'revision') {
                  return { ...source, capability_revision: 'changed' }
                }
                if (reads > 1 && drift === 'binding') {
                  return { ...source, local_provider: { ...source.local_provider, binding_revision: 2 } }
                }
                if (reads > 1 && drift === 'methods') {
                  return { ...source, methods: source.methods.slice(1) }
                }
                return {
                  ...source,
                  describe: /** 原描述完成后模拟耗尽原观察期限或同步撤权，fresh resolve不能掩盖。 */ (method) => {
                    const description = source.describe(method)
                    if (drift === 'describe_expiry') {
                      f.advance(5001)
                    }
                    if (drift === 'revoke') {
                      f.setLocal({ revision: 'revoked', grants: [] })
                    }
                    return description
                  }
                }
              }
            }
          }).describe(methods[0]!)
        assert.throws(checked, new FacadeServiceError('contract_unavailable'))
      }
    } finally {
      service?.close()
      await resource?.release()
      f.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
