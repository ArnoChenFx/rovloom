// 使用真实Store与合成目录验证owner对象重用，不把目录fixture作为原生执行或官方契约证明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizedCatalog } from '../../src/mcp/catalog.js'
import type { ProviderCatalogSource } from '../../src/mcp/catalog.js'
import { FacadeServiceError } from '../../src/mcp/types.js'
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
      const catalog = authorizedCatalog({
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

test(
  '公共目录门禁不解释 provider 方法规则，只按 provider 自报摘要拒绝同次查询内的来源变化',
  /* 合成目录完全中性：没有 Luvus 名称、方法分类或参数规则，门禁仍要复核摘要与期限。 */ () => {
    const f = storeFixture()
    try {
      const base = {
        target,
        local_provider: f.store.provider(target.machine_id, target.provider_id)!,
        contract_ref: 'a'.repeat(64),
        capability_revision: 'fixture_one',
        expires_at: f.store.clock() + 30_000,
        digest: 'digest_one',
        methods: [{ method: 'anything.at.all' }],
        describe: /* 中性目录描述只回显方法名，不合成帮助或约束。 */ (method: string) => ({ method })
      }
      let reads = 0
      const options = {
        store: f.store,
        principal: f.current(),
        currentPrincipal: f.current,
        target,
        expected_binding_revision: 1
      }
      // 摘要稳定时目录可用；未验证契约时元数据保持 unavailable，不为未知版本填默认值。
      const stable = authorizedCatalog({
        ...options,
        provider: { kind: 'provider', resolve: () => base }
      })
      assert.equal(stable.methods[0]!.method, 'anything.at.all')
      assert.deepEqual(stable.metadata, {
        native_version: null,
        schema_status: 'unavailable',
        schema_sha256: null
      })
      assert.equal(stable.describe('anything.at.all').method, 'anything.at.all')
      // provider 在初始扫描后改变自报摘要：整次查询必须拒绝，不能交付混用两种事实的目录。
      assert.throws(
        () =>
          authorizedCatalog({
            ...options,
            provider: {
              kind: 'provider',
              resolve: () => (++reads === 1 ? base : { ...base, digest: 'digest_two' })
            }
          }),
        new FacadeServiceError('contract_unavailable')
      )
    } finally {
      f.close()
    }
  }
)

test('公开 subset_revision 随可见方法集变化，契约引用保持原生身份且排序不影响修订', () => {
  const f = storeFixture()
  try {
    let methods = [{ method: 'pane.read' }]
    const resolve = () => ({
      target,
      local_provider: f.store.provider(target.machine_id, target.provider_id)!,
      contract_ref: 'a'.repeat(64),
      capability_revision: 'unchanged_native_revision',
      expires_at: f.store.clock() + 30_000,
      methods,
      describe: (method: string) => ({ method })
    })
    const view = () =>
      authorizedCatalog({
        store: f.store,
        principal: f.current(),
        currentPrincipal: f.current,
        target,
        expected_binding_revision: 1,
        terminalExecutionState: () => false,
        provider: { kind: 'provider', resolve }
      })
    const first = view()
    methods = [{ method: 'pane.read' }, { method: 'wait.output' }]
    const second = view()
    assert.equal(first.scope.contract_ref, second.scope.contract_ref)
    assert.notEqual(first.subset_revision, second.subset_revision)
    assert.equal(second.describe('wait.output').subset_revision, second.subset_revision)
    assert(second.methods.every((method) => !Object.hasOwn(method, 'subset_revision')))
    methods.reverse()
    assert.equal(view().subset_revision, second.subset_revision)
    methods.push({ method: 'pane.run' })
    assert.equal(view().subset_revision, second.subset_revision)
  } finally {
    f.close()
  }
})
