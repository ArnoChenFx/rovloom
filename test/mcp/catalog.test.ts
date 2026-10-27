// 验证实际Luvus目录按当前ACL/来源/epoch分页及即时撤权；不声称原生执行。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FacadeServiceError,
  StoreGatewayService,
  type ServiceContext,
  type GatewayCatalogSource
} from '../../src/mcp/index.js'
import { target } from './store-fixture.js'
import { catalogFixture, catalogMethods } from './catalog-fixture.js'
import { contractRef } from '../../src/wire/index.js'
import { secondTarget } from './store-fixture.js'

test('prompt 帮助只推荐当前完整目标可见的输出等待，授权新增与撤销即时生效', async () => {
  const f = catalogFixture()
  const route = { target, expected_binding_revision: 1 }
  const grant = (methods: string[]) => [{ target, methods, actions: ['read' as const] }]
  const setMethods = (caller: string[], local = caller) => {
    f.setCaller({
      id: 'alice',
      policy: {
        revision: 'caller_1',
        grants: [...grant(caller), { target: secondTarget, methods: ['wait.output'], actions: ['read'] }]
      }
    })
    f.setLocal({ revision: 'local_1', grants: grant(local) })
  }
  const describePrompt = async () => {
    const result = await f.service.execute('runtime_describe', { ...route, method: 'agent.prompt' }, context())
    return (result.data.parameter_help as { rules: string[] }).rules
  }
  try {
    setMethods(['agent.prompt'])
    assert((await describePrompt()).some((rule) => rule.includes('wait.output is not exposed for this target')))
    await assert.rejects(
      f.service.execute('runtime_describe', { ...route, method: 'wait.output' }, context()),
      new FacadeServiceError('not_found')
    )
    setMethods(['agent.prompt', 'wait.output'])
    const visible = await f.service.execute('runtime_discover', route, context())
    assert(visible.data.items.some((row) => row.method === 'wait.output'))
    const rules = await describePrompt()
    assert(!rules.some((rule) => rule.includes('wait.output is not exposed for this target')))
    assert(rules.some((rule) => rule.includes('runtime_discover') && rule.includes('prompt echo')))
    const wait = await f.service.execute('runtime_describe', { ...route, method: 'wait.output' }, context())
    assert.equal(wait.data.schema_status, 'generic_params_only')
    assert.equal(wait.data.params_schema, undefined)
    assert(
      (wait.data.parameter_help as { rules: string[] }).rules.some((rule) => rule.includes('existing marker can match'))
    )
    setMethods(['agent.prompt', 'wait.output'], ['agent.prompt'])
    assert((await describePrompt()).some((rule) => rule.includes('wait.output is not exposed for this target')))
  } finally {
    f.close()
  }
})

// 只构造合成受信caller；业务args没有principal/权限入口。
function context(): ServiceContext {
  return { caller: { principal_id: 'alice' }, wait_signal: new AbortController().signal }
}

test(
  '实际catalog按完整目标双端read过滤，授权后分页且描述不授予执行分类',
  /* 来源仅为人工fixture，native validator与catalog和Store查询均是真实模块。 */ async () => {
    const f = catalogFixture()
    try {
      const page = await f.service.execute(
        'runtime_discover',
        { target, expected_binding_revision: 1, limit: 2 },
        context()
      )
      assert.equal(page.data.items.length, 2)
      assert(page.data.next_cursor)
      for (const row of page.data.items) {
        assert(catalogMethods.includes(row.method as string))
        assert.equal(row.classification_status, 'not_evaluated')
        assert.equal(row.contract_ref, f.source().source.binding.contract_source_ref)
      }
      const next = await f.service.execute(
        'runtime_discover',
        { target, expected_binding_revision: 1, limit: 2, cursor: page.data.next_cursor },
        context()
      )
      assert.equal(next.data.items.length, 2)
      assert(
        !next.data.items.some(
          /* 确认授权后分页没有重复首段方法。 */ (row) =>
            page.data.items.some(/* 只比较公开方法名，不将游标offset当授权。 */ (first) => row.method === first.method)
        )
      )
      const described = await f.service.execute(
        'runtime_describe',
        { target, expected_binding_revision: 1, method: 'ping' },
        context()
      )
      assert.equal(described.data.method, 'ping')
      await assert.rejects(
        f.service.execute('runtime_describe', { target, expected_binding_revision: 1, method: 'task.next' }, context()),
        new FacadeServiceError('not_found')
      )
      const calls = f.resolutions()
      await assert.rejects(
        f.service.execute(
          'runtime_discover',
          { target: { ...target, profile: 'session', session: 'other' }, expected_binding_revision: 1 },
          context()
        ),
        new FacadeServiceError('not_found')
      )
      assert.equal(f.resolutions(), calls)
      f.setLocal({ revision: 'local_2', grants: [{ target, methods: ['ping'], actions: ['read'] }] })
      await assert.rejects(
        f.service.execute(
          'runtime_discover',
          { target, expected_binding_revision: 1, limit: 2, cursor: page.data.next_cursor },
          context()
        ),
        new FacadeServiceError('contract_unavailable')
      )
      const previous = f.source()
      f.setSource({
        ...previous,
        source: { ...previous.source, binding: { ...previous.source.binding, local_policy_revision: 'local_2' } }
      })
      await assert.rejects(
        f.service.execute(
          'runtime_discover',
          { target, expected_binding_revision: 1, limit: 2, cursor: page.data.next_cursor },
          context()
        ),
        new FacadeServiceError('invalid_cursor')
      )
      const filtered = await f.service.execute('runtime_discover', { target, expected_binding_revision: 1 }, context())
      assert.deepEqual(
        filtered.data.items.map(/* 双方交集只剩ping，caller其它read grant不能补充本地授权。 */ (row) => row.method),
        ['ping']
      )
    } finally {
      f.close()
    }
  }
)

test(
  '能力内容或期限在同次查询中改变时拒绝，即使来源revision没有更新',
  /* 合成registry故意返回不一致快照，验证目录不会用旧view忽略更严格在线预算。 */ async () => {
    const f = catalogFixture()
    const good = f.source()
    const capabilities = structuredClone(good.record.capabilities) as { result: { limits: { frame_bytes: number } } }
    capabilities.result.limits.frame_bytes--
    try {
      for (const changed of [
        { ...good, expires_at: good.expires_at + 1 },
        { ...good, record: { ...good.record, capabilities } }
      ]) {
        let reads = 0
        const service = new StoreGatewayService({
          store: f.store,
          identities: f.identities,
          localPolicies: f.localPolicies,
          catalog: {
            resolve: /* 首次返回有效来源，随后模拟未更新revision的外部registry变化。 */ () =>
              ++reads === 1 ? good : changed
          }
        })
        await assert.rejects(
          service.execute('runtime_discover', { target, expected_binding_revision: 1 }, context()),
          new FacadeServiceError('contract_unavailable')
        )
      }
    } finally {
      f.close()
    }
  }
)

test(
  '目录逐次拒绝错来源/binding/epoch/代次/过期能力，拒绝不触发原生调用',
  /* 遍历独立fence，恢复同一合成来源后再验证下一条件，没有真实peer或凭据操作。 */ async () => {
    const f = catalogFixture()
    const good = f.source()
    const reject = /* 只更换受信测试registry，要求业务请求保持失败关闭。 */ async (
      next: GatewayCatalogSource | undefined
    ) => {
      f.setSource(next)
      await assert.rejects(f.service.execute('runtime_discover', { target, expected_binding_revision: 1 }, context()))
    }
    try {
      await reject(undefined)
      await reject({ ...good, source: { ...good.source, source_verified: false } })
      await reject({ ...good, local_provider: { ...good.local_provider, config_ref: 'other_config' } })
      for (const change of [
        { provider_id: 'other' },
        { connection_epoch: 'old' },
        { recovery_generation: 'old' },
        { binding_revision: 2 },
        { capability_revision: 'other' },
        { classification_revision: 'other' }
      ]) {
        await reject({ ...good, source: { ...good.source, binding: { ...good.source.binding, ...change } } })
      }
      f.setSource(good)
      await assert.rejects(
        f.service.execute('runtime_discover', { target, expected_binding_revision: 2 }, context()),
        new FacadeServiceError('binding_revision_conflict')
      )
      f.advance(30_001)
      await assert.rejects(
        f.service.execute('runtime_discover', { target, expected_binding_revision: 1 }, context()),
        new FacadeServiceError('contract_unavailable')
      )
    } finally {
      f.close()
    }
  }
)

test(
  '目录拒绝与实际编译契约不一致的Wire binary/schema来源摘要',
  /* 同步更新自报contract_ref仍不能把另一安装来源挂到现有opaque编译句柄。 */ async () => {
    for (const field of ['binary_sha256', 'schema_sha256'] as const) {
      const f = catalogFixture()
      try {
        const good = f.source()
        const origin = { ...good.record.wire.source, [field]: 'a'.repeat(64) }
        f.setSource({
          ...good,
          record: { ...good.record, wire: { ...good.record.wire, source: origin } },
          source: { ...good.source, binding: { ...good.source.binding, contract_source_ref: contractRef(origin) } }
        })
        await assert.rejects(
          f.service.execute('runtime_discover', { target, expected_binding_revision: 1 }, context()),
          new FacadeServiceError('contract_unavailable')
        )
      } finally {
        f.close()
      }
    }
  }
)

test(
  '最终来源回调撤销身份/本地政策或使能力过期后，发现与描述均不返回旧目录',
  /* 先测正常查询的最后一次registry读取，再在该处同步变更可信宿主状态。 */ async () => {
    for (const name of ['runtime_discover', 'runtime_describe'] as const) {
      const baseline = catalogFixture()
      let lastRead: number
      try {
        if (name === 'runtime_discover') {
          await baseline.service.execute(name, { target, expected_binding_revision: 1 }, context())
        } else {
          await baseline.service.execute(name, { target, expected_binding_revision: 1, method: 'ping' }, context())
        }
        lastRead = baseline.resolutions()
      } finally {
        baseline.close()
      }
      for (const change of ['principal', 'local', 'expiry'] as const) {
        const f = catalogFixture()
        const good = f.source()
        let reads = 0
        const service = new StoreGatewayService({
          store: f.store,
          identities: f.identities,
          localPolicies: f.localPolicies,
          catalog: {
            resolve: /* 在最后一次读取中改变宿主事实，不能由返回的旧source掩盖撤销。 */ () => {
              if (++reads === lastRead) {
                if (change === 'principal') {
                  f.setCaller(null)
                }
                if (change === 'local') {
                  f.setLocal({ revision: 'revoked', grants: [] })
                }
                if (change === 'expiry') {
                  f.advance(30_001)
                }
              }
              return good
            }
          }
        })
        try {
          await assert.rejects(
            name === 'runtime_discover'
              ? service.execute(name, { target, expected_binding_revision: 1 }, context())
              : service.execute(name, { target, expected_binding_revision: 1, method: 'ping' }, context()),
            new FacadeServiceError(change === 'principal' ? 'unauthenticated' : 'contract_unavailable')
          )
        } finally {
          f.close()
        }
      }
    }
  }
)
