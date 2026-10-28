// 用真实 Store/Router 与明确标记的投影 fixture 验证已有句柄复用，不把元数据缓存当授权或续期。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Store } from '../../src/store.js'
import { projectionFixture } from './runtime-service-fixture.js'

// 只观察本测试实例的全量预算入口，保留原实现与接收者，结束后恢复。
function budgetCalls(store: Store) {
  const observed = store as unknown as { budget(admission: boolean): void }
  const original = observed.budget
  let calls = 0
  observed.budget = /** 每次仍执行真实预算，只统计是否进入。 */ (admission) => {
    calls++
    return original.call(store, admission)
  }
  return {
    count: /** 返回本次观察期间的真实入口次数。 */ () => calls,
    close: /** 恢复本实例，不修改其它测试或生产预算实现。 */ () => {
      observed.budget = original
    }
  }
}

test(
  '已有句柄的已完成 call_get 不进入全量预算，缺失时仍走原签发事务',
  /** 原生结果许可端口是明确的组件 stub；真实 Wire 的末次复验另在 runtime/results 回归。 */ async (t) => {
    const f = projectionFixture()
    const observed = budgetCalls(f.store)
    t.after(
      /** 先恢复观察器再关闭本 fixture。 */ () => {
        observed.close()
        f.close()
      }
    )
    const first = (await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context)).data
    const firstResult = first.result as { result_id: string }
    f.advance(1)
    const again = (await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context)).data
    assert.deepEqual(again.result, first.result)
    assert.equal(observed.count(), 0)
    assert.equal(f.calls.length, 0)
    const cleanup = new DatabaseSync(f.path)
    try {
      cleanup.prepare('DELETE FROM results WHERE result_id=?').run(firstResult.result_id)
    } finally {
      cleanup.close()
    }
    const replacement = (await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context)).data
    assert.equal(replacement.content_delivery, 'result_handle')
    assert.notEqual((replacement.result as { result_id: string }).result_id, firstResult.result_id)
    assert.equal(observed.count(), 1)
  }
)

test(
  '已有句柄元数据仍受当前 ACL、归属、降级及持久时钟约束',
  /** 命中结果行不能绕过原 Router 与 Store 的实时门禁。 */ async (t) => {
    const f = projectionFixture()
    t.after(/** 回收本例私有文件库和服务。 */ () => f.close())
    f.setCaller({ id: 'alice', device_scope: { mode: 'selected', machine_ids: [] } })
    await assert.rejects(f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context), {
      code: 'forbidden'
    })
    assert.throws(
      /** Store 本身也必须隐藏其它主体的句柄归属。 */ () => f.store.findResult('bob', 'call_fixture'),
      /call_not_found/
    )
    f.setCaller({ id: 'alice' })
    f.advance(1)
    assert(f.store.findResult('alice', 'call_fixture'))
    f.advance(-1)
    assert.throws(
      /** 元数据读取同样持久化高水位并拒绝后续回退。 */ () => f.store.findResult('alice', 'call_fixture'),
      /clock_untrusted/
    )
    assert.throws(
      /** 已锁存的降级不能借已有句柄绕过原签发准入限制。 */ () => f.store.findResult('alice', 'call_fixture'),
      /storage_degraded/
    )
  }
)

for (const mode of ['storage_degraded'] as const) {
  test(
    '已有句柄元数据保留原签发准入限制：' + mode,
    /** 只在关闭 writer 的人工历史准备阶段设置模式，不绕过任何生产管理入口。 */ (t) => {
      const f = projectionFixture({
        /** 固定已有句柄，模式限制不能因元数据命中而绕过。 */ mutateSeed(db) {
          db.prepare('UPDATE metadata SET mode=?').run(mode)
        }
      })
      t.after(/** 回收本例私有文件库和服务。 */ () => f.close())
      assert.throws(/** 仍按原错误码拒绝。 */ () => f.store.findResult('alice', 'call_fixture'), { message: mode })
    }
  )
}

for (const change of ['delete', 'expiry'] as const) {
  test(
    '已有句柄元数据查询重新观察归属检查后的 ' + change,
    /** 与真实归属查询交错第二连接删除或可信时钟推进，成功预读不能冻结句柄期限。 */ (t) => {
      const f = projectionFixture({
        /** 句柄先于内容到期，区分句柄失效与正文可见性。 */ mutateSeed(db) {
          db.prepare('UPDATE results SET expires=?').run(1_000_010)
        }
      })
      t.after(/** 回收本例私有文件库和服务。 */ () => f.close())
      const original = f.store.call.bind(f.store)
      f.store.call = /** 保留真实归属和内容检查，只在返回后改变测试事实。 */ (principal, callId) => {
        const call = original(principal, callId)
        if (change === 'expiry') {
          f.advance(10)
        } else {
          const cleanup = new DatabaseSync(f.path)
          try {
            cleanup.prepare('DELETE FROM results WHERE call_id=?').run(callId)
          } finally {
            cleanup.close()
          }
        }
        return call
      }
      assert.equal(f.store.findResult('alice', 'call_fixture'), undefined)
    }
  )
}
