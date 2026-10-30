// 工厂路由用明确失败探针验证，所有业务成功仍须真实provider；不替代窗口或模型回复验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeProductionSources, createProductSources } from '../../src/cli/product-sources.js'
import type { ProductionCliSources, ProductionProviderReference } from '../../src/cli/production.js'
import { configTemplate } from '../../src/cli/config.js'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'

test(
  '静态kind路由保留真实工厂this/配置/authority，未知kind在打开任何工厂前拒绝',
  /* 两个factory均只抛出固定fixture错误，不提供原生成功结果。 */ async () => {
    const gateway = configTemplate('gateway')
    const connector = configTemplate('connector')
    if (gateway.role !== 'gateway' || connector.role !== 'connector') {
      assert.fail('role template mismatch')
    }
    const authority = createManagementSessionAuthority({
      principal: /* 本例从不建立身份或cookie。 */ () => null,
      administrator: /* 空管理来源不授予任何权限。 */ () => null
    })
    const calls: string[] = []
    const stop = new Error('factory_probe_only')
    const owners: Partial<Record<'luvus' | 'herdr', ProductionCliSources>> = {}
    let selected: readonly ProductionProviderReference[]
    for (const kind of ['luvus', 'herdr'] as const) {
      owners[kind] = {
        // 这里只验证单次委托后立即失败，不提供可启动成功的业务替身。
        async gateway(config, refs, actual) {
          assert.equal(this, owners[kind])
          assert.equal(config, gateway)
          assert.equal(refs, selected)
          assert.equal(actual, authority)
          calls.push(kind + ':gateway')
          throw stop
        },
        // Connector同样只探测参数与this绑定，不返回虚构session。
        async connector(config, refs) {
          assert.equal(this, owners[kind])
          assert.equal(config, connector)
          assert.equal(refs, selected)
          calls.push(kind + ':connector')
          throw stop
        }
      }
    }
    const routed = routeProductionSources(owners)
    try {
      for (const kind of ['luvus', 'herdr'] as const) {
        selected = [{ reference: kind + '_one', value: { kind } }]
        await assert.rejects(
          /* 路由只调用选中工厂一次，不重试其失败。 */ () => routed.gateway!(gateway, selected, authority),
          stop
        )
        await assert.rejects(
          /* 原Connector工厂独立持有资源，Gateway回调不能被借用。 */ () => routed.connector!(connector, selected),
          stop
        )
      }
      assert.deepEqual(calls, ['luvus:gateway', 'luvus:connector', 'herdr:gateway', 'herdr:connector'])
      for (const references of [[{ reference: 'bad', value: { kind: 'SYNTHETIC_SECRET_DO_NOT_PRINT' } }], []]) {
        await assert.rejects(
          /* 拒绝先于任何工厂副作用；空Connector同样没有可启动的provider。 */ () =>
            routed.connector!(connector, references)
        )
      }
      assert.equal(calls.length, 4)
    } finally {
      authority.close()
    }
  }
)

test(
  '默认静态Luvus工厂实际校验原生配置，缺字段拒绝而非空resolver成功',
  /* 直接消费runtime公开真实factory，不注入native/backend成功stub或访问用户root。 */ async () => {
    const connector = configTemplate('connector')
    if (connector.role !== 'connector') {
      assert.fail('connector template mismatch')
    }
    await assert.rejects(
      /* 缺真实原生描述时保留owner的确定配置错误。 */ () =>
        createProductSources().connector!(connector, [{ reference: 'invalid_luvus', value: { kind: 'luvus' } }]),
      { code: 'production_reference_invalid' }
    )
  }
)

test(
  '默认Herdr双角色路由消费精确owner封套，缺配置在读取schema前拒绝',
  /** 缺配置反例必须进入已注册的真实解析器；不提供安装或会话成功stub。 */ async () => {
    const gateway = configTemplate('gateway')
    const connector = configTemplate('connector')
    if (gateway.role !== 'gateway' || connector.role !== 'connector') {
      assert.fail('role template required')
    }
    const authority = createManagementSessionAuthority({
      principal: /** 本例从不建立身份或cookie。 */ () => null,
      administrator: /** 空管理来源不授予任何权限。 */ () => null
    })
    try {
      await assert.rejects(
        createProductSources().gateway!(gateway, [{ reference: 'herdr_one', value: { kind: 'herdr' } }], authority),
        { code: 'invalid_config' }
      )
      await assert.rejects(
        createProductSources().connector!(connector, [{ reference: 'herdr_one', value: { kind: 'herdr' } }]),
        { code: 'invalid_config' }
      )
    } finally {
      authority.close()
    }
  }
)

test('herdr-core 走自己的静态工厂；本阶段没有 Connector 执行端口', async () => {
  const gateway = configTemplate('gateway')
  if (gateway.role !== 'gateway') {
    assert.fail('role template mismatch')
  }
  const authority = createManagementSessionAuthority({
    principal: /** 本例从不建立身份或 cookie。 */ () => null,
    administrator: /** 空管理来源不授予任何权限。 */ () => null
  })
  const calls: string[] = []
  const stop = new Error('factory_probe_only')
  const owners: Partial<Record<'luvus' | 'herdr' | 'herdr-core', ProductionCliSources>> = {
    'herdr-core': {
      async gateway(_config, refs) {
        assert.equal(this, owners['herdr-core'])
        assert.equal(refs, selected)
        calls.push('herdr-core:gateway')
        throw stop
      }
    }
  }
  const selected: readonly ProductionProviderReference[] = [{ reference: 'core_one', value: { kind: 'herdr-core' } }]
  const routed = routeProductionSources(owners)
  await assert.rejects(
    /** 路由只调用选中的 herdr-core 工厂一次。 */ () => routed.gateway!(gateway, selected, authority),
    stop
  )
  // 没有 Connector 执行端口时明确 backend_unavailable，而不是交付一个空转会话。
  await assert.rejects(
    () => routed.connector!(configTemplate('connector') as never, selected),
    /Rovloom command failed/u
  )
  assert.deepEqual(calls, ['herdr-core:gateway'])
})

test('混合 Gateway 里 herdr-core 引用按设备分组，不会被丢掉', async () => {
  const gateway = configTemplate('gateway')
  if (gateway.role !== 'gateway') {
    assert.fail('role template mismatch')
  }
  const authority = createManagementSessionAuthority({
    principal: /** 本例从不建立身份或 cookie。 */ () => null,
    administrator: /** 空管理来源不授予任何权限。 */ () => null
  })
  const stop = new Error('factory_probe_only')
  let coreReferences: readonly ProductionProviderReference[] | undefined
  const owners: Partial<Record<'luvus' | 'herdr' | 'herdr-core', ProductionCliSources>> = {
    luvus: {
      // 最小可识别的原生资源：足以让组合层继续到 herdr-core 分组。
      async gateway() {
        return { providers: [], release: async () => {} } as never
      }
    },
    'herdr-core': {
      async gateway(_config, refs) {
        coreReferences = refs
        throw stop
      }
    }
  }
  const routed = routeProductionSources(owners)
  const references: readonly ProductionProviderReference[] = [
    { reference: 'luvus_one', value: { kind: 'luvus' } },
    { reference: 'core_one', value: { kind: 'herdr-core' } }
  ]
  await assert.rejects(
    /** 分组顺序固定：luvus 先交付，herdr-core 再被调用并停止本例。 */ () =>
      routed.gateway!(gateway, references, authority),
    stop
  )
  // 每台设备各一份引用：herdr-core 只收到自己那一条，没有被混合分组吞掉。
  assert.deepEqual(coreReferences, [{ reference: 'core_one', value: { kind: 'herdr-core' } }])
})
