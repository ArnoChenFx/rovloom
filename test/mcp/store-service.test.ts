// 验证真实Store/Router接线的当前授权、分页、内容隔离和清理事务；历史/native内容只来自明确人工fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Router } from '../../src/router.js'
import { Store } from '../../src/store.js'
import {
  FacadeServiceError,
  StoreGatewayService,
  type AdminContext,
  type ManagementArguments,
  type ManagementOperation,
  type ServiceContext
} from '../../src/mcp/index.js'
import { secondTarget, storeFixture, syntheticCredential, syntheticSecret, target } from './store-fixture.js'
import { clockWrites } from '../storage/clock-write-helpers.js'

// 生成受信宿主context，既不来自MCP参数，也不携带设备凭据或管理员会话。
function context(principal = 'alice', signal = new AbortController().signal): ServiceContext {
  return { caller: { principal_id: principal }, wait_signal: signal }
}
// 为独立管理接口注入合成已认证会话，仍须由同一身份服务每次复验。
function adminContext(): AdminContext {
  return { ...context(), management_session_ref: 'admin_session' }
}
// 检查固定公共拒绝代码，拒绝把任意异常文本当作符合预期的失败。
function code(expected: string) {
  return /* 严格匹配受控服务异常和代码，不接纳SQLite路径或其它异常。 */ (error: unknown) =>
    error instanceof FacadeServiceError && error.code === expected
}

test(
  'call_get 读取不写持久时钟，后续回退仍被拒绝',
  /** 在真实文件库上计数实际 UPDATE，并从第二连接确认高水位没有取消或延迟持久化。 */ async () => {
    const f = storeFixture()
    const inspect = new DatabaseSync(f.path, { readOnly: true })
    try {
      f.advance(1)
      const measured = clockWrites(
        f.store,
        /** 无等待读取的首轮同步完成 Store 门禁，返回的 Promise 仍由测试等待。 */ () =>
          f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())
      )
      assert.equal((await measured.result).data.state, 'responded')
      assert.equal(measured.updates, 0)
      assert.notEqual(inspect.prepare('SELECT clock FROM metadata').get()!.clock, 1_000_001)
      f.advance(-1)
      await assert.rejects(
        f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context()),
        code('storage_degraded')
      )
    } finally {
      inspect.close()
      f.close()
    }
  }
)

for (const change of ['clock', 'owner'] as const) {
  test(
    'call_get 短等下一轮重新核验 ' + change,
    /** 第二轮身份读取时交错改变真实存储事实，不能跨轮沿用入口的时钟或归属快照。 */ async () => {
      const f = storeFixture()
      f.store.connect('machine_a', syntheticCredential)
      const call = new Router(f.store).create(
        f.current(),
        target,
        { method: 'pane.read' },
        { binding_revision: 1, contract_ref: 'a'.repeat(64) }
      )
      let snapshots = 0
      const service = new StoreGatewayService({
        targets: f.targets,
        store: f.store,
        identities: {
          ...f.identities,
          /** 第三次身份快照是等待后的第二轮，之后仍由原 Store/Router 完成实际拒绝。 */ principal(caller) {
            const value = f.identities.principal(caller)
            if (++snapshots === 3) {
              if (change === 'clock') {
                f.advance(-1)
              } else {
                const update = new DatabaseSync(f.path)
                try {
                  update.prepare("UPDATE calls SET principal='bob' WHERE call_id=?").run(call.call_id)
                } finally {
                  update.close()
                }
              }
            }
            return value
          }
        }
      })
      try {
        await assert.rejects(
          service.execute('runtime_call_get', { call_id: call.call_id, wait_ms: 5000 }, context()),
          code(change === 'clock' ? 'storage_degraded' : 'not_found')
        )
        assert.equal(snapshots, 3)
      } finally {
        f.close()
      }
    }
  )
}

test(
  '真实Store设备/provider查询按双方同一tuple过滤，未知及跨实例目标不泄露',
  /* 分别撤销本地read和尝试相似目标，确认元数据不会继承其它授权。 */ async () => {
    const f = storeFixture()
    try {
      const devices = await f.service.execute('machines_list', {}, context())
      assert.deepEqual(
        devices.data.items.map(/* 只比较公开设备ID及授权集合。 */ (item) => item.machine_id),
        ['machine_a', 'machine_b']
      )
      assert.equal((await f.service.execute('machines_get', { name: 'alpha' }, context())).data.link, 'unverified')
      assert.equal(
        (await f.service.execute('providers_get', { machine_id: 'machine_a', provider_id: 'luvus_a' }, context())).data
          .readiness,
        'unverified'
      )
      assert.equal(
        (await f.service.execute('providers_get', { machine_id: 'machine_a', provider_id: 'herdr_a' }, context())).data
          .kind,
        'herdr'
      )
      f.setCaller({ id: 'alice', device_scope: { mode: 'selected', machine_ids: ['machine_b'] } })
      assert.deepEqual(
        (await f.service.execute('machines_list', {}, context())).data.items.map(
          /* 当前政策只保留第二个完整目标。 */ (item) => item.machine_id
        ),
        ['machine_b']
      )
      await assert.rejects(f.service.execute('machines_get', { name: 'alpha' }, context()), code('not_found'))
      f.setCaller({ id: 'alice', device_scope: { mode: 'selected', machine_ids: [] } })
      assert.deepEqual((await f.service.execute('machines_list', {}, context())).data.items, [])
    } finally {
      f.close()
    }
  }
)

test(
  '令牌设备范围在枚举面收窄可见设备，越界设备与按名称查询一律 not_found',
  /* 同一策略下两个设备：收窄后只留一台，且不提供设备存在性探测入口。 */ async () => {
    const f = storeFixture()
    try {
      const wide = await f.service.execute('machines_list', {}, context())
      assert.deepEqual(
        wide.data.items.map(/* 缺省范围保持现状。 */ (item) => item.machine_id),
        ['machine_a', 'machine_b']
      )
      f.setCaller({ ...f.current(), device_scope: { mode: 'selected', machine_ids: ['machine_a'] } })
      const narrowed = await f.service.execute('machines_list', {}, context())
      assert.deepEqual(
        narrowed.data.items.map(/* 只保留范围内的设备。 */ (item) => item.machine_id),
        ['machine_a']
      )
      assert.equal(
        (await f.service.execute('machines_get', { machine_id: 'machine_a' }, context())).data.machine_id,
        'machine_a'
      )
      // 越界设备与其名称查询都与「未授权」逐字一致。
      await assert.rejects(f.service.execute('machines_get', { machine_id: 'machine_b' }, context()), code('not_found'))
      await assert.rejects(f.service.execute('machines_get', { name: 'beta' }, context()), code('not_found'))
      assert.deepEqual(
        (await f.service.execute('providers_list', { machine_id: 'machine_a' }, context())).data.items.map(
          /* 范围内的 provider 仍可见。 */ (item) => item.provider_id
        ),
        ['herdr_a', 'luvus_a']
      )
      await assert.rejects(
        f.service.execute('providers_list', { machine_id: 'machine_b' }, context()),
        code('not_found')
      )
      await assert.rejects(
        f.service.execute('providers_get', { machine_id: 'machine_b', provider_id: 'luvus_b' }, context()),
        code('not_found')
      )
      // 范围也约束目录：越界 tuple 直接 not_found。
      await assert.rejects(
        f.service.execute('runtime_discover', { target: secondTarget, expected_binding_revision: 1 }, context()),
        code('not_found')
      )
      f.setCaller({ ...f.current(), device_scope: { mode: 'selected', machine_ids: [] } })
      assert.deepEqual((await f.service.execute('machines_list', {}, context())).data.items, [])
      await assert.rejects(f.service.execute('machines_get', { machine_id: 'machine_a' }, context()), code('not_found'))
      // 恢复全部设备后回到今天的行为（删除字段，不留 undefined）。
      const { device_scope: _cleared, ...unscoped } = f.current()
      f.setCaller(unscoped)
      assert.deepEqual(
        (await f.service.execute('machines_list', {}, context())).data.items.map(
          /* 范围清除即不再过滤。 */ (item) => item.machine_id
        ),
        ['machine_a', 'machine_b']
      )
      // 身份来源交付变形的范围时拒绝，而不是放宽。
      for (const device_scope of [
        { mode: 'all' },
        { mode: 'selected', machine_ids: ['machine_a', 'machine_a'] },
        { mode: 'selected', machine_ids: ['bad id'] }
      ]) {
        f.setCaller({ ...f.current(), device_scope: device_scope as never })
        await assert.rejects(f.service.execute('machines_list', {}, context()), code('unauthenticated'))
      }
    } finally {
      f.close()
    }
  }
)

test(
  '真实授权分页游标绑定身份、查询、limit、当前政策和期限，不接受offset自报',
  /* 使用同一数据库跨页，再改变查询和政策验证旧游标失效。 */ async () => {
    const f = storeFixture()
    try {
      const first = await f.service.execute('machines_list', { limit: 1 }, context())
      assert.equal(first.data.items.length, 1)
      assert(first.data.next_cursor)
      const second = await f.service.execute('machines_list', { limit: 1, cursor: first.data.next_cursor }, context())
      assert.equal(second.data.items[0]?.machine_id, 'machine_b')
      await assert.rejects(
        f.service.execute('machines_list', { limit: 2, cursor: first.data.next_cursor }, context()),
        code('invalid_cursor')
      )
      await assert.rejects(f.service.execute('machines_list', { cursor: '1' }, context()), code('invalid_cursor'))
      f.setCaller({ id: 'alice', device_scope: { mode: 'selected', machine_ids: ['machine_a'] } })
      await assert.rejects(
        f.service.execute('machines_list', { limit: 1, cursor: first.data.next_cursor }, context()),
        code('invalid_cursor')
      )
      f.setCaller({ id: 'alice' })
      f.advance(30_001)
      await assert.rejects(
        f.service.execute('machines_list', { limit: 1, cursor: first.data.next_cursor }, context()),
        code('invalid_cursor')
      )
    } finally {
      f.close()
    }
  }
)

test(
  '调用元数据来自实际Store且不交付正文；discard受归属与设备范围保护',
  /* 用实际清理事务验证授权失败不删、成功后正文和句柄均消失且审计记录实际principal。 */ async () => {
    const f = storeFixture()
    try {
      assert(f.store.call('alice', 'call_fixture').response?.includes(syntheticSecret))
      const view = await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())
      assert.equal(view.data.state, 'responded')
      assert.equal(view.data.contract_ref, null)
      assert.equal(view.data.content_delivery, 'unavailable')
      assert(!JSON.stringify(view).includes(syntheticSecret))
      f.setCaller({ id: 'bob' })
      await assert.rejects(
        f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context('bob')),
        code('not_found')
      )
      f.setCaller({ id: 'alice' })
      f.setCaller({ id: 'alice', device_scope: { mode: 'selected', machine_ids: [] } })
      await assert.rejects(
        f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context()),
        code('forbidden')
      )
      assert(f.store.call('alice', 'call_fixture').response)
      f.setCaller({ id: 'alice' })
      assert.equal(
        (await f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context())).data
          .content_status,
        'discarded'
      )
      assert.equal(f.store.call('alice', 'call_fixture').response, null)
      f.store.close()
      const inspect = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(
          inspect.prepare('SELECT request_json FROM calls WHERE call_id=?').get('call_fixture')!.request_json,
          null
        )
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM results').get()!.n, 0)
        assert.equal(inspect.prepare("SELECT actor FROM audit WHERE action='discard_response'").get()!.actor, 'alice')
      } finally {
        inspect.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  '真实Router登记的短等及时响应撤权和AbortSignal，等待不改变账本或派发',
  /* 合成固定hash只用于隔离Store身份，不进行凭据签发、配对或真实连接。 */ async () => {
    const f = storeFixture()
    try {
      f.store.connect('machine_a', syntheticCredential)
      const router = new Router(f.store)
      const call = router.create(
        f.current(),
        target,
        { method: 'pane.read' },
        { binding_revision: 1, contract_ref: 'a'.repeat(64) }
      )
      const stop = new AbortController()
      const waiting = f.service.execute(
        'runtime_call_get',
        { call_id: call.call_id, wait_ms: 5000 },
        context('alice', stop.signal)
      )
      stop.abort()
      await assert.rejects(waiting, code('unavailable'))
      assert.equal(f.store.call('alice', call.call_id).state, 'created')
      const revoked = f.service.execute('runtime_call_get', { call_id: call.call_id, wait_ms: 5000 }, context())
      f.setCaller({ id: 'alice', device_scope: { mode: 'selected', machine_ids: [] } })
      await assert.rejects(revoked, code('forbidden'))
      assert.equal(f.store.call('alice', call.call_id).state, 'created')
      const device = await f.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext())
      assert.equal(device.persisted_state, 'online')
      assert.equal(device.connection.verification, 'unverified')
    } finally {
      f.close()
    }
  }
)

test(
  '未接线的原生/资源关闭/管理写入明确失败，不创建调用、不清理内容、不签发凭据',
  /* 对真实Store调用所有缺后端动作，验证拒绝没有数据库副作用。 */ async () => {
    const f = storeFixture()
    try {
      const raw = {
        target,
        expected_binding_revision: 1,
        contract_ref: 'a'.repeat(64),
        deadline: 1_020_000,
        native_request: { method: 'pane.read' }
      }
      await assert.rejects(f.service.execute('runtime_call', raw, context()), code('backend_unavailable'))
      await assert.rejects(
        f.service.execute('runtime_discover', { target, expected_binding_revision: 1 }, context()),
        code('backend_unavailable')
      )
      await assert.rejects(
        f.service.execute('runtime_call_cancel', { call_id: 'call_fixture' }, context()),
        code('backend_unavailable')
      )
      await assert.rejects(
        f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, context()),
        code('backend_unavailable')
      )
      const write = {
        confirmation_id: 'not_a_confirmation',
        request_id: 'req_1',
        history_epoch: 'admin_history',
        recovery_generation: f.store.generation(),
        expected_revision: 1,
        reason: 'isolated test'
      }
      const provider = {
        ...write,
        machine_id: 'machine_a',
        provider_id: 'luvus_a',
        kind: 'luvus' as const,
        expected_binding_revision: 1
      }
      type ManagementRequest = {
        [K in ManagementOperation]: { name: K; args: ManagementArguments[K] }
      }[ManagementOperation]
      const unavailable: ManagementRequest[] = [
        {
          name: 'operations_get',
          args: {
            request_id: write.request_id,
            history_epoch: write.history_epoch,
            recovery_generation: write.recovery_generation
          }
        },
        {
          name: 'confirmations_create',
          args: {
            request_id: write.request_id,
            history_epoch: write.history_epoch,
            recovery_generation: write.recovery_generation,
            expected_revision: write.expected_revision,
            reason: write.reason,
            action: 'device_revoke',
            target: { machine_id: 'machine_a' }
          }
        },
        { name: 'confirmations_confirm', args: { ...write, operation_digest: 'a'.repeat(64) } },
        { name: 'pairings_create', args: { ...write, name: 'new', policy_ref: 'policy_1', labels: [] } },
        { name: 'pairings_cancel', args: { ...write, machine_id: 'machine_a', pairing_id: 'pairing_1' } },
        {
          name: 'devices_disconnect',
          args: { ...write, machine_id: 'machine_a', expected_connection_epoch: 'synthetic_epoch' }
        },
        { name: 'devices_revoke', args: { ...write, machine_id: 'machine_a' } },
        { name: 'providers_disable', args: provider },
        { name: 'providers_enable', args: provider }
      ]
      for (const request of unavailable) {
        await assert.rejects(
          f.service.management.execute(request.name, request.args, adminContext()),
          code('backend_unavailable')
        )
      }
      assert.equal(f.store.machine('machine_a').name, 'alpha')
      assert.equal(f.store.machine('machine_a').status, 'offline')
      assert.equal(f.store.provider('machine_a', 'luvus_a')?.binding_revision, 1)
      assert(f.store.call('alice', 'call_fixture').response?.includes(syntheticSecret))
      f.store.close()
      const inspect = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM calls').get()!.n, 1)
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM enrollments').get()!.n, 0)
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM management').get()!.n, 0)
      } finally {
        inspect.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  'MCP清理沿用Store提交后回收：回滚不通知，成功提交后外部连接只见已删除内容',
  /* 对真实SQLite提交注入故障，验证facade不绕开Store回收次序，也不向公共结果泄露内部通知。 */ async () => {
    const f = storeFixture()
    f.store.close()
    let fail = false
    const store = new Store(f.path, /* 固定为人工历史的当前时刻，不接入用户时钟或会话。 */ () => 1_000_000, {
      fault: /* 只阻断明确指定的提交阶段，保留真实SQLite事务与回滚。 */ (point) => {
        if (fail && point === 'before_commit') {
          throw new Error('synthetic commit failure')
        }
      }
    })
    const service = new StoreGatewayService({ targets: f.targets, store, identities: f.identities })
    const inspect = new DatabaseSync(f.path, { readOnly: true })
    const observed: { machine_id: string; call_id: string; request_json: unknown; response: unknown }[] = []
    const unsubscribe = store.subscribeInvalidation(
      /* 从独立只读连接记录通知时已提交的内容状态，回调中不重入Store或改变事务。 */ (event) => {
        if (event.kind === 'content') {
          const row = inspect.prepare('SELECT request_json,response FROM calls WHERE call_id=?').get(event.call_id)!
          observed.push({
            machine_id: event.machine_id,
            call_id: event.call_id,
            request_json: row.request_json,
            response: row.response
          })
        }
      }
    )
    try {
      fail = true
      await assert.rejects(
        service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context()),
        code('storage_degraded')
      )
      assert.deepEqual(observed, [])
      assert(inspect.prepare('SELECT response FROM calls WHERE call_id=?').get('call_fixture')!.response)
      fail = false
      const discarded = await service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context())
      assert.deepEqual(discarded.data, { call_id: 'call_fixture', content_status: 'discarded' })
      assert.deepEqual(observed, [
        { machine_id: 'machine_a', call_id: 'call_fixture', request_json: null, response: null }
      ])
      assert.equal(inspect.prepare('SELECT COUNT(*) n FROM results').get()!.n, 0)
      assert(!JSON.stringify(discarded).includes(syntheticSecret))
      assert.equal(
        (await service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())).data.content_delivery,
        'unavailable'
      )
    } finally {
      unsubscribe()
      inspect.close()
      store.close()
      f.close()
    }
  }
)

test(
  '独立管理会话复用同一身份后端，状态和权限快照不伪造现场能力或暴露配置路径',
  /* 同时验证MCP身份隔离、provider独立查看权和管理写后端阻断。 */ async () => {
    const f = storeFixture()
    try {
      const status = await f.service.management.execute('status', {}, adminContext())
      assert.equal(status.mode, 'active')
      assert.equal(status.history, null)
      assert.equal(status.components.transport, 'unavailable')
      const provider = await f.service.management.execute(
        'providers_get',
        { machine_id: 'machine_a', provider_id: 'herdr_a' },
        adminContext()
      )
      assert.equal(provider.config_ref, null)
      assert.equal(provider.runtime.verification, 'unverified')
      const snap = await f.service.management.execute(
        'permissions_get',
        { machine_id: 'machine_a', provider_id: 'luvus_a' },
        adminContext()
      )
      assert(
        snap.decisions.some(
          /* 有providers_manage授权仍因缺后端而不能执行写入。 */ (decision) =>
            decision.action === 'providers_manage' &&
            !decision.allowed &&
            decision.reason_code === 'backend_unavailable'
        )
      )
      assert(!JSON.stringify({ status, provider, snap }).includes(syntheticSecret))
      const page = await f.service.management.execute('devices_list', { limit: 1 }, adminContext())
      assert(page.next_cursor)
      assert.equal(
        (await f.service.management.execute('devices_list', { limit: 1, cursor: page.next_cursor }, adminContext()))
          .items[0]?.machine_id,
        'machine_b'
      )
      f.setAdmin(null)
      await assert.rejects(f.service.management.execute('status', {}, adminContext()), code('unauthenticated'))
      assert.equal(
        (await f.service.execute('machines_get', { machine_id: 'machine_a' }, context())).data.machine_id,
        'machine_a'
      )
    } finally {
      f.close()
    }
  }
)

test(
  '当前身份失效、伪造管理会话和非法参数只返回固定拒绝',
  /* 验证直接服务入口也不接受额外身份字段，不依赖HTTP facade预先验证。 */ async () => {
    const f = storeFixture()
    try {
      await assert.rejects(
        f.service.management.execute(
          'devices_get',
          { machine_id: 'machine_a', principal_id: 'alice' } as never,
          adminContext()
        ),
        code('invalid_arguments')
      )
      await assert.rejects(
        f.service.management.execute('status', {}, { ...adminContext(), management_session_ref: 'forged' }),
        code('unauthenticated')
      )
      f.setCaller(null)
      await assert.rejects(f.service.execute('machines_list', {}, context()), code('unauthenticated'))
    } finally {
      f.close()
    }
  }
)

test(
  '真实Store降级约束覆盖服务，内容期限不会因查询或缺后端重建',
  /* 用关闭writer时设置的降级fixture验证模式。 */ async () => {
    const degraded = storeFixture('storage_degraded')
    try {
      assert.equal((await degraded.service.management.execute('status', {}, adminContext())).mode, 'storage_degraded')
      assert.equal((await degraded.service.execute('machines_list', {}, context())).data.items.length, 2)
      await degraded.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context())
      assert.equal(degraded.store.call('alice', 'call_fixture').content_status, 'discarded')
    } finally {
      degraded.close()
    }
    const expired = storeFixture()
    try {
      expired.advance(60_001)
      assert.equal(
        (await expired.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())).data.content_status,
        'expired'
      )
      assert(
        !JSON.stringify(
          await expired.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())
        ).includes(syntheticSecret)
      )
    } finally {
      expired.close()
    }
  }
)

test(
  '未知持久设备状态拒绝而非激活，旧binding调用返回明确revision冲突',
  /* 在关闭writer的fixture阶段模拟未来状态和真实绑定变更，不替换服务或Router行为。 */ async () => {
    const unknown = storeFixture(
      'active',
      /* 持久状态未知时不允许MCP将它映射为active。 */ (db) => {
        db.prepare('UPDATE machines SET status=? WHERE machine_id=?').run('quarantined_unknown', 'machine_a')
      }
    )
    try {
      await assert.rejects(
        unknown.service.execute('machines_get', { machine_id: 'machine_a' }, context()),
        code('unavailable')
      )
      await assert.rejects(
        unknown.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext()),
        code('unavailable')
      )
    } finally {
      unknown.close()
    }
    const changed = storeFixture(
      'active',
      /* 当前binding变更不能让旧调用以一般内部错误或新实例身份返回。 */ (db) => {
        db.prepare('UPDATE providers SET binding_revision=2 WHERE machine_id=? AND provider_id=?').run(
          'machine_a',
          'luvus_a'
        )
      }
    )
    try {
      await assert.rejects(
        changed.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context()),
        code('binding_revision_conflict')
      )
    } finally {
      changed.close()
    }
  }
)

test(
  '独立管理设备状态筛选有界且绑定游标，不从持久offline猜测现场重连',
  /* 同一真实Store验证匹配、无匹配和非法枚举，筛选不能改写或绕过当前授权。 */ async () => {
    const f = storeFixture()
    try {
      assert.equal(
        (await f.service.management.execute('devices_list', { states: ['offline'] }, adminContext())).items.length,
        2
      )
      assert.deepEqual(
        (await f.service.management.execute('devices_list', { states: ['pending'] }, adminContext())).items,
        []
      )
      const page = await f.service.management.execute('devices_list', { states: ['offline'], limit: 1 }, adminContext())
      assert(page.next_cursor)
      await assert.rejects(
        f.service.management.execute(
          'devices_list',
          { states: ['pending'], limit: 1, cursor: page.next_cursor },
          adminContext()
        ),
        code('invalid_cursor')
      )
      for (const states of [[], ['offline', 'offline'], ['connecting']]) {
        await assert.rejects(
          f.service.management.execute('devices_list', { states } as never, adminContext()),
          code('invalid_arguments')
        )
      }
    } finally {
      f.close()
    }
  }
)

test(
  '管理读取接入真实传输观测：有观测的设备显示在线与认证，没有观测的保持未核实，native 不由传输推断',
  /** 观测来源只提供 gateway_transport 事实；Store 的持久 offline 状态不会被当作现场状态，原生层如实未核实。 */ async () => {
    const f = storeFixture()
    try {
      const health = f.store.health()
      const at = f.store.clock()
      const verified = <T>(value: T) => ({
        verification: 'verified' as const,
        observed_at: at,
        source: 'gateway_transport' as const,
        value
      })
      const service = new StoreGatewayService({
        targets: f.targets,
        store: f.store,
        identities: f.identities,
        transportObservations: {
          snapshot: () => ({
            observed_at: at,
            recovery_generation: health.generation,
            transport: verified('available' as const),
            devices: [
              {
                machine_id: 'machine_a',
                connection: verified({
                  state: 'online' as const,
                  connection_epoch_ref: 'epoch_ref',
                  last_heartbeat_at: at - 1000
                }),
                authentication: verified({ state: 'authenticated' as const, last_failure: null }),
                providers: []
              }
            ]
          })
        }
      })
      const status = await service.management.execute('status', {}, adminContext())
      assert.equal(status.components.transport, 'available')
      assert.equal(status.components.native, 'unverified')
      const online = await service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext())
      assert(online.connection.verification === 'verified')
      assert.equal(online.connection.value.state, 'online')
      assert.equal(online.connection.value.last_heartbeat_at, at - 1000)
      assert(online.authentication.verification === 'verified')
      const other = await service.management.execute('devices_get', { machine_id: 'machine_b' }, adminContext())
      assert.equal(other.connection.verification, 'unverified')
      assert.equal(other.authentication.verification, 'unverified')
      // 没有观测来源时与之前完全一致：传输不可用、设备现场状态未核实。
      const bare = await f.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext())
      assert.equal(bare.connection.verification, 'unverified')
      assert.equal(
        (await f.service.management.execute('status', {}, adminContext())).components.transport,
        'unavailable'
      )
    } finally {
      f.close()
    }
  }
)

test(
  '设备视图回传完整授权 tuple，runtime_discover 可直接使用该 tuple 而不必猜 session',
  /** 元数据层必须自描述：调用方从 machines_list 取到的 target 原样回传即可通过可见性检查。 */ async () => {
    const f = storeFixture()
    try {
      const listed = await f.service.execute('machines_get', { machine_id: 'machine_a' }, context())
      assert.deepEqual(listed.data.targets, [target])
      // 原样回传该 tuple 必须通过可见性检查，而不是返回 not_found。
      await assert.rejects(
        f.service.execute(
          'runtime_discover',
          { target: listed.data.targets[0]!, expected_binding_revision: 1 },
          context()
        ),
        /* 没有接线 catalog 时报告后端缺失，证明可见性与 revision 检查已通过。 */ code('backend_unavailable')
      )
      // 只改 session 名就会退回 not_found，说明元组必须逐字段一致。
      const guessed = { ...target, profile: 'session' as const, session: 'guessed' }
      await assert.rejects(
        f.service.execute('runtime_discover', { target: guessed, expected_binding_revision: 1 }, context()),
        code('not_found')
      )
      // 未被授权的设备 provider 不进入 targets。
      const second = await f.service.execute('machines_get', { machine_id: 'machine_b' }, context())
      assert.deepEqual(second.data.targets, [secondTarget])
    } finally {
      f.close()
    }
  }
)

test(
  'MCP 设备连接与 provider 就绪来自真实传输观测，无观测时保持未核实',
  /** 同一观测来源同时驱动管理面与 MCP 视图，revision 不符的旧观测不能为新绑定背书。 */ async () => {
    const f = storeFixture()
    try {
      const health = f.store.health()
      const at = f.store.clock()
      const verified = <T>(value: T) => ({
        verification: 'verified' as const,
        observed_at: at,
        source: 'gateway_transport' as const,
        value
      })
      const service = new StoreGatewayService({
        targets: f.targets,
        store: f.store,
        identities: f.identities,
        transportObservations: {
          snapshot: () => ({
            observed_at: at,
            recovery_generation: health.generation,
            transport: verified('available' as const),
            devices: [
              {
                machine_id: 'machine_a',
                connection: verified({
                  state: 'online' as const,
                  connection_epoch_ref: 'epoch_ref',
                  last_heartbeat_at: at - 1000
                }),
                authentication: verified({ state: 'authenticated' as const, last_failure: null }),
                providers: [
                  { provider_id: 'luvus_a', binding_revision: 1, dispatch_ready: verified(true) },
                  /* revision 已过期：不能把旧就绪投影给当前绑定。 */
                  { provider_id: 'luvus_b', binding_revision: 99, dispatch_ready: verified(true) }
                ]
              }
            ]
          })
        }
      })
      const machine = await service.execute('machines_get', { machine_id: 'machine_a' }, context())
      assert.equal(machine.data.link, 'connected')
      const ready = await service.execute(
        'providers_get',
        { machine_id: 'machine_a', provider_id: 'luvus_a' },
        context()
      )
      assert.equal(ready.data.readiness, 'ready')
      // 没有观测的设备不被推断为在线；其 provider 就绪也保持未核实。
      const unseen = await service.execute('machines_get', { machine_id: 'machine_b' }, context())
      assert.equal(unseen.data.link, 'unverified')
      const unseenProvider = await service.execute(
        'providers_get',
        { machine_id: 'machine_b', provider_id: 'luvus_b' },
        context()
      )
      assert.equal(unseenProvider.data.readiness, 'unverified')
      // 没有观测来源时全部保持未核实，与既有行为一致。
      const bare = await f.service.execute('machines_get', { machine_id: 'machine_a' }, context())
      assert.equal(bare.data.link, 'unverified')
    } finally {
      f.close()
    }
  }
)

test(
  'Store.resources 只读枚举全部设备及其 provider',
  /** 管理员的全设备授权据此按现状生成；不含凭据，不改变任何状态。 */ () => {
    const f = storeFixture()
    try {
      assert.deepEqual(f.store.resources(), [
        { machine_id: 'machine_a', provider_ids: ['herdr_a', 'luvus_a'] },
        { machine_id: 'machine_b', provider_ids: ['luvus_b'] }
      ])
    } finally {
      f.close()
    }
  }
)

test(
  '管理调用窗口只覆盖 calls_read 授权设备，投影不含请求或响应正文',
  /** 真实 Store 中的人工调用同时含正文；窗口必须只输出元数据并按设备范围过滤。 */ async () => {
    const f = storeFixture()
    try {
      const window = await f.service.management.execute('calls_list', {}, adminContext())
      assert.equal(window.aggregate.total, 1)
      assert.deepEqual(
        window.items.map(/* 只有 machine_a 在授权范围内。 */ (item) => item.machine_id),
        ['machine_a']
      )
      const item = window.items[0]!
      assert.equal(item.method, 'pane.read')
      assert.equal(item.state, 'responded')
      assert.equal(item.dispatched, false)
      assert.deepEqual(item.target, { profile: 'session', session: target.session })
      assert.equal(item.outcome, null)
      assert.equal(window.aggregate.by_provider[0]?.provider_id, 'luvus_a')
      assert.equal(window.aggregate.by_principal[0]?.principal, 'alice')
      assert.equal(window.aggregate.by_method[0]?.method, 'pane.read')
      // 正文与内部摘要不属于管理调用视图。
      const encoded = JSON.stringify(window)
      assert(!encoded.includes(syntheticSecret))
      assert(!encoded.includes('identity_json'))
      assert(!encoded.includes('binding_json'))
      assert(!encoded.includes('request_hash'))
      // 越范围设备与未知状态筛选都被拒绝。
      await assert.rejects(
        f.service.management.execute('calls_list', { machine_id: 'machine_b' }, adminContext()),
        code('not_found')
      )
      await assert.rejects(
        f.service.management.execute('calls_list', { states: ['bogus'] } as never, adminContext()),
        code('invalid_arguments')
      )
      await assert.rejects(
        f.service.management.execute(
          'calls_list',
          { machine_id: 'machine_a', cursor: 'bogus' } as never,
          adminContext()
        ),
        code('invalid_cursor')
      )
    } finally {
      f.close()
    }
  }
)

test(
  '调用窗口分页游标绑定设备范围与状态筛选，撤销授权立即拒绝',
  /** 游标不能跨 scope 复用；管理会话撤销后窗口读取与其它管理读取一同失败。 */ async () => {
    const f = storeFixture('active', (db) => {
      for (const [index, machine] of ['machine_a', 'machine_a'].entries()) {
        db.prepare(
          `INSERT INTO calls(call_id,principal,machine_id,provider_id,binding_revision,provider_kind,
          request_hash,state,identity_json,target_json,method,mode,
          created,deadline,content_expires,metadata_expires,dedup_expires,content_status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          `call_page_${index}`,
          'alice',
          machine!,
          'luvus_a',
          1,
          'luvus',
          'a'.repeat(64),
          'not_dispatched',
          '{}',
          JSON.stringify({ machine_id: 'machine_a', provider_id: 'luvus_a', profile: 'host' }),
          'pane.list',
          'strict',
          1_000_000 + index,
          1_030_000,
          1_060_000,
          2_000_000,
          2_000_000,
          'unavailable'
        )
      }
    })
    try {
      const first = await f.service.management.execute('calls_list', { limit: 1 }, adminContext())
      assert.equal(first.items.length, 1)
      assert(first.next_cursor)
      const second = await f.service.management.execute(
        'calls_list',
        { limit: 1, cursor: first.next_cursor },
        adminContext()
      )
      assert.notEqual(second.items[0]!.call_id, first.items[0]!.call_id)
      // 同一游标不能用于不同设备范围或状态筛选。
      await assert.rejects(
        f.service.management.execute(
          'calls_list',
          { limit: 1, cursor: first.next_cursor, machine_id: 'machine_a', states: ['not_dispatched'] },
          adminContext()
        ),
        code('invalid_cursor')
      )
      f.setAdmin(null)
      await assert.rejects(f.service.management.execute('calls_list', {}, adminContext()), code('unauthenticated'))
    } finally {
      f.close()
    }
  }
)

test(
  '存储降级时调用窗口把未定派发状态收敛为结果未知',
  /** 降级不能把 dispatching 宣称成已执行；窗口读取本身仍允许，与既有只读规则一致。 */ async () => {
    const f = storeFixture('storage_degraded', (db) => {
      db.prepare(
        `INSERT INTO calls(call_id,principal,machine_id,provider_id,binding_revision,provider_kind,
        request_hash,state,identity_json,target_json,method,mode,
        created,deadline,content_expires,metadata_expires,dedup_expires,content_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        'call_inflight',
        'alice',
        'machine_a',
        'luvus_a',
        1,
        'luvus',
        'b'.repeat(64),
        'dispatching',
        '{}',
        JSON.stringify({ machine_id: 'machine_a', provider_id: 'luvus_a', profile: 'host' }),
        'pane.list',
        'strict',
        1_000_000,
        1_030_000,
        1_060_000,
        2_000_000,
        2_000_000,
        'available'
      )
    })
    try {
      const window = await f.service.management.execute('calls_list', {}, adminContext())
      const inflight = window.items.find(/* 只看本次新增的未定调用。 */ (item) => item.call_id === 'call_inflight')!
      assert.equal(inflight.state, 'outcome_unknown')
    } finally {
      f.close()
    }
  }
)

test(
  'devices_get 把平台作为设备属性原样返回，未上报时为 null',
  /** 平台只来自真实列；本用例不连真实传输，连接与认证仍保持未知。 */ async () => {
    const f = storeFixture()
    try {
      // 未上报平台的设备：直接为 null，不构造 verification 或占位说明。
      const absent = await f.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext())
      assert.equal(absent.platform, null)

      // 写入一条与真实 Wire 校验同形的平台记录后重新读取。
      const f2 = storeFixture('active', (db) => {
        db.prepare('UPDATE machines SET platform_json=? WHERE machine_id=?').run(
          '{"arch":"arm64","distribution":null,"os":"darwin"}',
          'machine_a'
        )
      })
      try {
        const device = await f2.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext())
        assert.deepEqual(device.platform, { os: 'darwin', arch: 'arm64', distribution: null })
        // 列表投影与详情一致，且同一设备不会因列表/详情不同而改变平台。
        const list = await f2.service.management.execute('devices_list', { limit: 10 }, adminContext())
        const listed = list.items.find(/** 只取本用例的目标设备。 */ (item) => item.machine_id === 'machine_a')
        assert.deepEqual(listed?.platform, device.platform)
        // 平台不推进 resource_revision，也不冒充连接或认证事实。
        assert.equal(device.connection.verification, 'unverified')
        assert.equal(device.resource_revision, null)
      } finally {
        f2.close()
      }
    } finally {
      f.close()
    }
  }
)
