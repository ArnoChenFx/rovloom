// 用真实Store和当前授权验证列表无状态游标的容量、完整性、期限与门面生命周期。
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { digest } from '../../src/contracts.js'
import { StoreGatewayService, type AdminContext, type ServiceContext } from '../../src/mcp/index.js'
import type { ServiceReply } from '../../src/mcp/types.js'
import { storeFixture } from './store-fixture.js'
import { projectionFixture } from './runtime-service-fixture.js'

// 构造受信上下文；身份和管理会话不从列表参数中接受。
function context(principal = 'alice'): ServiceContext {
  return { caller: { principal_id: principal }, wait_signal: new AbortController().signal }
}

// 管理列表继续经过同一身份源中的独立管理会话复验。
function adminContext(): AdminContext {
  return { ...context(), management_session_ref: 'admin_session' }
}

// 生成实际可授权设备；本地策略按目标返回单条grant，避免把容量回归变成重复大策略压力测试。
function listFixture(count = 3) {
  const targets = Array.from(
    { length: count },
    /** 稳定补零使完整遍历的期望顺序独立于服务实现。 */ (_, index) => ({
      machine_id: `list_machine_${String(index).padStart(3, '0')}`,
      provider_id: 'luvus',
      profile: 'session' as const,
      session: 'synthetic'
    })
  )
  const f = storeFixture(
    'active',
    /** 只在writer关闭的fixture准备阶段写入合成设备与provider，不跳过请求时的实际授权。 */ (db) => {
      for (const target of targets) {
        db.prepare('INSERT INTO machines(machine_id,name,status,credential_hash) VALUES(?,?,?,?)').run(
          target.machine_id,
          target.machine_id,
          'offline',
          digest('synthetic')
        )
        db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)').run(
          target.machine_id,
          target.provider_id,
          'luvus',
          'synthetic',
          1,
          1
        )
      }
    }
  )
  f.setCaller({
    id: 'alice',
    device_scope: { mode: 'selected', machine_ids: targets.map((target) => target.machine_id) }
  })
  const service = new StoreGatewayService({
    targets: () => targets,
    store: f.store,
    identities: f.identities
  })
  return {
    ...f,
    service,
    targets,
    /** 先销毁门面游标密钥，再由原fixture回收文件库。 */ close() {
      service.close()
      f.service.close()
      f.close()
    }
  }
}

describe(
  '同一次机器列表可读完130页，并发管理列表不占用彼此游标容量',
  /** 分段共享同一游标和时钟，保留单例5秒期限；不借过期、重启或跳页回收旧缓存。 */ () => {
    let f: ReturnType<typeof listFixture>
    const actual: string[] = []
    let cursor: string | undefined
    let firstCursor: string | undefined
    before(
      /** 只建立一个真实Store与服务，各段继续前一段的分页位置。 */ () => {
        f = listFixture(130)
      }
    )
    after(
      /** 成功或失败都回收整个遍历共用的唯一fixture。 */ () => {
        f?.close()
      }
    )
    for (let segment = 0; segment < 10; segment++) {
      test(
        `连续读取第${segment + 1}组13页并交错管理列表`,
        /** 所有页均经过真实授权与存储，不因分组重建游标或缩短完整行集合。 */ async () => {
          assert.equal(actual.length, segment * 13)
          for (let index = 0; index < 13; index++) {
            const [machines, devices] = await Promise.all([
              f.service.execute('machines_list', { limit: 1, ...(cursor ? { cursor } : {}) }, context()),
              f.service.management.execute('devices_list', { limit: 1 }, adminContext())
            ])
            assert.equal(machines.data.items.length, 1)
            actual.push(machines.data.items[0]!.machine_id)
            cursor = machines.data.next_cursor
            if (actual.length === 1) {
              firstCursor = cursor
            }
            assert.equal(cursor === undefined, actual.length === 130)
            assert(devices.next_cursor)
            const lastDevice = await f.service.management.execute(
              'devices_list',
              { limit: 1, cursor: devices.next_cursor },
              adminContext()
            )
            assert.equal(lastDevice.items[0]!.machine_id, 'machine_b')
            assert.equal(lastDevice.next_cursor, undefined)
          }
        }
      )
    }
    test(
      '完整130页到EOF后核对全部设备，并重读首个游标',
      /** 完整集合来自fixture输入，检测遗漏、重复和乱序，且旧游标不因后续分页被消费。 */ async () => {
        assert.equal(actual.length, 130)
        assert.equal(cursor, undefined)
        assert.deepEqual(
          actual,
          f.targets.map(/** 投影固定输入的设备ID，不从服务返回构造期望集合。 */ (target) => target.machine_id)
        )
        const replay = await f.service.execute('machines_list', { limit: 1, cursor: firstCursor! }, context())
        assert.equal(replay.data.items[0]!.machine_id, f.targets[1]!.machine_id)
      }
    )
  }
)

test(
  '设备范围进入游标绑定：改范围后旧游标失效，重读仍在范围内',
  /** 同一 Store 上收窄范围，旧页不能被重放；新范围的第一页只含范围内设备。 */ async () => {
    const f = listFixture(3)
    try {
      const start = (await f.service.execute('machines_list', { limit: 1 }, context())).data
      assert(start.next_cursor)
      const machine = f.targets[0]!.machine_id
      f.setCaller({ ...f.current(), device_scope: { mode: 'selected', machine_ids: [machine] } })
      await assert.rejects(
        f.service.execute('machines_list', { limit: 1, cursor: start.next_cursor }, context()),
        /* 旧游标绑定的是未收窄的可见集合。 */ (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === 'invalid_cursor'
      )
      const narrowed = (await f.service.execute('machines_list', {}, context())).data
      assert.deepEqual(
        narrowed.items.map(/* 只保留范围内设备。 */ (item) => item.machine_id),
        [machine]
      )
      // 范围内重读同一页保持稳定。
      assert.deepEqual((await f.service.execute('machines_list', {}, context())).data, narrowed)
    } finally {
      f.close()
    }
  }
)

test(
  '重读同一列表页超过128次仍保持页面和后继，EOF重读不累积容量',
  /** 重试第二页仍需返回第三页游标，不能通过提前消费或删除旧token掩盖容量上限。 */ async () => {
    const f = listFixture()
    try {
      const start = (await f.service.execute('machines_list', { limit: 1 }, context())).data
      assert(start.next_cursor)
      const args = { limit: 1, cursor: start.next_cursor }
      const second = (await f.service.execute('machines_list', args, context())).data
      assert(second.next_cursor)
      for (let attempt = 0; attempt < 130; attempt++) {
        const [replay, eof]: [ServiceReply<'machines_list'>, ServiceReply<'machines_list'>] = await Promise.all([
          f.service.execute('machines_list', args, context()),
          f.service.execute('machines_list', { limit: 1, cursor: second.next_cursor }, context())
        ])
        assert.deepEqual(replay.data, second)
        assert.equal(eof.data.items[0]!.machine_id, f.targets[2]!.machine_id)
        assert.equal(eof.data.next_cursor, undefined)
      }
    } finally {
      f.close()
    }
  }
)

test(
  '列表游标拒绝位置、期限、签名篡改和非规范整数，并保持合法分页参数边界',
  /** 持有合法token也不能自报offset或延期；输入大小门禁仍先于签名解析执行。 */ async () => {
    const f = listFixture()
    try {
      const first = (await f.service.execute('machines_list', { limit: 1 }, context())).data
      assert(first.next_cursor)
      const [version, offset, expires, tag] = first.next_cursor.split('.') as [string, string, string, string]
      for (const cursor of [
        'page_legacy',
        `${version}.${Number(offset) + 1}.${expires}.${tag}`,
        `${version}.${offset}.${Number(expires) + 30_000}.${tag}`,
        `${version}.9007199254740992.${expires}.${tag}`,
        `${version}.${offset}.9007199254740992.${tag}`,
        `${version}.0${offset}.${expires}.${tag}`,
        `${version}.-1.${expires}.${tag}`,
        `${version}.${offset}.${expires}.${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`
      ]) {
        await assert.rejects(f.service.execute('machines_list', { limit: 1, cursor }, context()), {
          code: 'invalid_cursor'
        })
      }
      for (const limit of [0, 101, 1.5]) {
        await assert.rejects(f.service.execute('machines_list', { limit }, context()), { code: 'invalid_arguments' })
      }
      for (const limit of [0, 201, 1.5]) {
        await assert.rejects(f.service.management.execute('devices_list', { limit }, adminContext()), {
          code: 'invalid_arguments'
        })
      }
      assert.equal((await f.service.execute('machines_list', { limit: 100 }, context())).data.items.length, 3)
      assert.equal((await f.service.management.execute('devices_list', { limit: 200 }, adminContext())).items.length, 2)
      await assert.rejects(f.service.execute('machines_list', { cursor: 'x'.repeat(1025) }, context()), {
        code: 'invalid_arguments'
      })
      await assert.rejects(f.service.management.execute('devices_list', { cursor: 'x'.repeat(1025) }, adminContext()), {
        code: 'invalid_arguments'
      })
    } finally {
      f.close()
    }
  }
)

test(
  '后续页和重读沿用首个游标的30秒期限，到期等号边界拒绝',
  /** 使用合成时钟验证不会滑动续期；新列表可以在旧列表到期后独立开始。 */ async () => {
    const f = listFixture()
    try {
      const first = (await f.service.execute('machines_list', { limit: 1 }, context())).data
      assert(first.next_cursor)
      f.advance(29_999)
      const second = (await f.service.execute('machines_list', { limit: 1, cursor: first.next_cursor }, context())).data
      assert(second.next_cursor)
      assert.deepEqual(
        (await f.service.execute('machines_list', { limit: 1, cursor: first.next_cursor }, context())).data,
        second
      )
      f.advance(1)
      for (const cursor of [first.next_cursor, second.next_cursor]) {
        await assert.rejects(f.service.execute('machines_list', { limit: 1, cursor }, context()), {
          code: 'invalid_cursor'
        })
      }
      const restarted = (await f.service.execute('machines_list', { limit: 1 }, context())).data
      assert(restarted.next_cursor)
      assert.equal(
        (await f.service.execute('machines_list', { limit: 1, cursor: restarted.next_cursor }, context())).data
          .items[0]!.machine_id,
        f.targets[1]!.machine_id
      )
    } finally {
      f.close()
    }
  }
)

test(
  '列表游标绑定当前caller、政策、操作、查询、limit和恢复代次，管理列表不能互换',
  /** 保留真实授权与Store读取；只有scope改变，即使行集合相同也必须重新开始分页。 */ async () => {
    const f = listFixture()
    const update = new DatabaseSync(f.path)
    try {
      const first = (await f.service.execute('machines_list', { limit: 1 }, context())).data
      assert(first.next_cursor)
      const args = { limit: 1, cursor: first.next_cursor }
      await assert.rejects(f.service.execute('machines_list', { ...args, limit: 2 }, context()), {
        code: 'invalid_cursor'
      })
      await assert.rejects(
        f.service.execute('providers_list', { ...args, machine_id: f.targets[0]!.machine_id }, context()),
        { code: 'invalid_cursor' }
      )
      await assert.rejects(f.service.management.execute('devices_list', args, adminContext()), {
        code: 'invalid_cursor'
      })
      f.setCaller({ id: 'bob' })
      await assert.rejects(f.service.execute('machines_list', args, context('bob')), { code: 'invalid_cursor' })
      f.setCaller({ id: 'alice' })
      await assert.rejects(f.service.execute('machines_list', args, context()), { code: 'invalid_cursor' })
      f.setCaller({ id: 'alice' })
      await assert.rejects(f.service.execute('machines_list', args, context()), { code: 'invalid_cursor' })
      f.setCaller({ id: 'alice' })
      const admin = await f.service.management.execute('devices_list', { limit: 1 }, adminContext())
      assert(admin.next_cursor)
      await assert.rejects(
        f.service.management.execute(
          'devices_list',
          { limit: 1, states: ['offline'], cursor: admin.next_cursor },
          adminContext()
        ),
        { code: 'invalid_cursor' }
      )
      update.prepare('UPDATE metadata SET generation=?').run('generation_changed')
      await assert.rejects(f.service.execute('machines_list', args, context()), { code: 'invalid_cursor' })
      await assert.rejects(
        f.service.management.execute('devices_list', { limit: 1, cursor: admin.next_cursor }, adminContext()),
        { code: 'invalid_cursor' }
      )
    } finally {
      update.close()
      f.close()
    }
  }
)

test(
  '同一Store的新门面不能复用旧游标，关闭拒绝列表、管理读取及尚未交付的页',
  /** 新实例使用独立密钥；close只结束门面，不通过关闭Store制造错误。 */ async () => {
    const f = storeFixture()
    const other = new StoreGatewayService(f)
    try {
      const first = (await f.service.execute('machines_list', { limit: 1 }, context())).data
      assert(first.next_cursor)
      await assert.rejects(other.execute('machines_list', { limit: 1, cursor: first.next_cursor }, context()), {
        code: 'invalid_cursor'
      })
      const pending = f.service.execute('machines_list', { limit: 1, cursor: first.next_cursor }, context())
      f.service.close()
      f.service.close()
      await assert.rejects(pending, { code: 'unavailable' })
      await assert.rejects(f.service.execute('machines_list', {}, context()), { code: 'unavailable' })
      await assert.rejects(f.service.management.execute('devices_list', { limit: 1 }, adminContext()), {
        code: 'unavailable'
      })
      assert.equal((await other.execute('machines_list', {}, context())).data.items.length, 2)
    } finally {
      other.close()
      f.service.close()
      f.close()
    }
  }
)

test(
  '运行时门面关闭同步关闭其管理列表入口',
  /** 管理入口直接引用StoreGatewayService，必须跟随拥有它的运行时门面结束生命周期。 */ async () => {
    const f = projectionFixture()
    try {
      const first = await f.service.management.execute('devices_list', { limit: 1 }, adminContext())
      assert(first.next_cursor)
      f.service.close()
      await assert.rejects(
        f.service.management.execute('devices_list', { limit: 1, cursor: first.next_cursor }, adminContext()),
        { code: 'unavailable' }
      )
      assert.equal(f.store.machine('machine_a').machine_id, 'machine_a')
    } finally {
      f.close()
    }
  }
)
