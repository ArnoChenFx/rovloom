// 使用真实Store与合成目录验证owner对象重用，不把目录fixture作为原生执行或官方契约证明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizedProviderCatalog } from '../../src/mcp/provider-catalog.js'
import type { ProviderCatalogSource } from '../../src/mcp/native-catalog.js'
import { storeFixture, target } from './store-fixture.js'

test(
  '中性目录复制已验证元数据，后续resolver修改旧对象不能替换契约、revision或期限',
  /* 首次返回A，复验时更新A但返回相同快照B；输出必须始终绑定已验证的B元数据。 */ () => {
    const f = storeFixture()
    try {
      const original = {
        target,
        local_provider: f.store.provider(target.machine_id, target.provider_id)!,
        contract_ref: 'a'.repeat(64),
        capability_revision: 'fixture_one',
        expires_at: f.store.clock() + 30_000,
        methods: [{ method: 'pane.read' }],
        describe: /* 只返回明确的目录fixture，不产生原生调用结果。 */ (method: string) => ({ method })
      }
      const first: ProviderCatalogSource = { ...original }
      const stable: ProviderCatalogSource = { ...original }
      let reads = 0
      const catalog = authorizedProviderCatalog({
        store: f.store,
        principal: f.current(),
        currentPrincipal: f.current,
        target,
        expected_binding_revision: 1,
        provider: {
          kind: 'provider',
          resolve: /* 模拟真实registry复用旧cache对象，再交付当前已验证快照。 */ () => {
            if (++reads === 1) {
              return first
            }
            Object.assign(first, {
              contract_ref: 'b'.repeat(64),
              capability_revision: 'changed',
              expires_at: f.store.clock() + 60_000
            })
            return stable
          }
        }
      })
      assert.equal(catalog.methods[0]!.contract_ref, original.contract_ref)
      assert.equal(catalog.scope.contract_ref, original.contract_ref)
      assert.equal(catalog.scope.capability_revision, original.capability_revision)
      assert.equal(catalog.expires_at, original.expires_at)
      assert.equal(catalog.describe('pane.read').contract_ref, original.contract_ref)
      assert(reads > 1)
    } finally {
      f.close()
    }
  }
)
