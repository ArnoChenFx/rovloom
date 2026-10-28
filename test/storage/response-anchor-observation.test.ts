// 验证无宿主回调的最小锚点批观察：固定一次可信采样、逐项域失效、全局故障降级和容量边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/store.js'
import type { AttemptBinding } from '../../src/wire/types.js'
import { LIMITS } from '../../src/wire/index.js'
import { connected, management, options } from './helpers.js'
import { clockWrites } from './clock-write-helpers.js'

/** 只建立内存 Store 与合成登记绑定，不创建进程、socket 或生产原生证明。 */
function fixture(count = 1) {
  let now = 1000
  const store = new Store(':memory:', /** 提供可控的可信时间。 */ () => now, { management })
  const device = connected(store)
  const bindings: AttemptBinding[] = []
  for (let index = 0; index < count; index++) {
    const call = store.createCall('alice', device.target, { method: 'ping', params: {} }, options())
    bindings.push(store.dispatch('alice', call.call_id, device.epoch))
  }
  return {
    store,
    bindings,
    db: (store as unknown as { db: DatabaseSync }).db,
    /** 只推进本 fixture 的时间，不改变任何已登记期限。 */
    time(value: number) {
      now = value
    }
  }
}

for (const count of [1, 8, 16]) {
  test(
    `${count} 个批锚点仅在时钟推进时不写时钟，返回独立最小副本且不执行预算或公开宿主入口`,
    /** 用实际 SQL 计数验证常数写入，并禁止把批观察变成通用事务或公开逐项循环。 */ () => {
      const f = fixture(count)
      try {
        const expected = f.bindings.map(
          /** 先保存原逐项事实，用于比较批观察的字段与原期限。 */ (binding) => f.store.responseAnchor(binding)
        )
        for (const name of ['responseAnchor', 'machine', 'provider', 'generation', 'budget'] as const) {
          Object.defineProperty(f.store, name, {
            /** 批内部不得调用这些可覆盖的公开方法或全库预算扫描。 */
            value() {
              throw new Error('unexpected_host_or_budget')
            }
          })
        }
        f.time(1001)
        const measured = clockWrites(f.store, /** 只计量本次同步批观察。 */ () => f.store.responseAnchors(f.bindings))
        assert.equal(measured.updates, 0)
        assert.equal(measured.result.now, 1001)
        assert.deepEqual(
          measured.result.entries,
          expected.map(/** 保留每个成功项的明确可用判别。 */ (anchor) => ({ available: true, anchor }))
        )
        const entry = measured.result.entries[0]!
        assert(entry.available)
        entry.anchor.binding.target.provider_id = 'changed_copy'
        assert.equal(f.bindings[0]!.target.provider_id, 'provider')
        const repeated = clockWrites(
          f.store,
          /** 同毫秒重复批观察仍核对锚点，但不重复持久相同时间。 */ () => f.store.responseAnchors(f.bindings)
        )
        assert.equal(repeated.updates, 0)
        const again = repeated.result.entries[0]!
        assert(again.available)
        assert.equal(again.anchor.binding.target.provider_id, 'provider')
        assert.equal('native_request' in again.anchor, false)
        assert.equal('response' in again.anchor, false)
      } finally {
        f.store.close()
      }
    }
  )
}

test(
  '单项坏绑定不污染其它锚点，固定 content/dedup 期限仍按同一批时刻投影',
  /** 绑定失效只返回 unavailable，过期投影不续期或扩大响应能力。 */ () => {
    const f = fixture(2)
    try {
      const first = f.store.responseAnchor(f.bindings[0]!)
      const bad = { ...f.bindings[0]!, attempt_id: 'wrong_attempt' }
      f.time(first.content_expires_at)
      const result = f.store.responseAnchors([bad, f.bindings[1]!])
      assert.deepEqual(result.entries[0], { available: false })
      const good = result.entries[1]!
      assert(good.available)
      assert.equal(good.anchor.content_status, 'expired')
      assert.equal(good.anchor.content_expires_at, first.content_expires_at)
      assert.equal(good.anchor.dedup_expires_at, first.dedup_expires_at)
      assert.equal(f.store.health().mode, 'active')
    } finally {
      f.store.close()
    }
  }
)

test(
  '批复制支持原 4096 项和全长合法标识，不把单帧对象字节预算当成整批上限',
  { timeout: 15_000 },
  /** 每项沿用原 JSON/绑定校验，整批另受既有缓冲字节上限约束。 */ () => {
    const f = fixture()
    try {
      const binding = structuredClone(f.bindings[0]!)
      const long = 'x'.repeat(128)
      binding.machine_id = binding.recovery_generation = binding.connection_epoch = long
      binding.call_id = binding.attempt_id = binding.native_request_id = long
      binding.target = { machine_id: long, provider_id: long, profile: 'session', session: long }
      binding.registration = {
        ...binding.registration
      }
      f.time(1001)
      const measured = clockWrites(
        f.store,
        /** 不存在的合法绑定只产生逐项 unavailable。 */ () =>
          f.store.responseAnchors(Array(LIMITS.dedup_entries).fill(binding))
      )
      assert.equal(measured.updates, 0)
      assert.equal(measured.result.entries.length, LIMITS.dedup_entries)
      assert(
        measured.result.entries.every(
          /** 完整复制通过后逐项按原账本查找拒绝，不冒充执行许可。 */ (entry) => !entry.available
        )
      )
      assert.throws(
        /** 原最大项数仍严格有界。 */ () => f.store.responseAnchors(Array(LIMITS.dedup_entries + 1).fill(binding)),
        /invalid_response_anchor_batch/
      )
    } finally {
      f.store.close()
    }
  }
)

test(
  '批输入拒绝 getter，已存在的写事务内拒绝批观察，不窥见未提交数据',
  /** 非数据属性在 BEGIN 前拒绝；嵌套观察不能污染原事务时钟或 Store 模式。 */ () => {
    const f = fixture()
    try {
      let invoked = 0
      const binding = { ...f.bindings[0]! }
      Object.defineProperty(binding, 'target', {
        /** 序列化器应拒绝 getter 而不是执行它。 */ get() {
          invoked++
          return f.bindings[0]!.target
        }
      })
      assert.throws(/** 不纯输入不进入数据库观察。 */ () => f.store.responseAnchors([binding]))
      assert.equal(invoked, 0)
      assert.throws(
        /** 原写事务的 planner 不得开启批只读事务。 */ () =>
          f.store.commitEvidence(
            f.bindings[0]!,
            /** 只验证嵌套拒绝，不提供伪造证据计划。 */ () => {
              f.store.responseAnchors(f.bindings)
              throw new Error('unreachable')
            }
          ),
        /transaction_in_progress/
      )
      assert.equal(f.store.health().mode, 'active')
      assert(f.store.responseAnchors(f.bindings).entries[0]!.available)
    } finally {
      f.store.close()
    }
  }
)

for (const fault of ['active_sql', 'row_sql', 'commit_sql', 'clock'] as const) {
  test(
    `批观察 ${fault} 故障不返回部分快照且锁存降级`,
    /** 全局 SQL/时钟错误与逐项域失效分开，开始事务后必须回滚。 */ () => {
      const f = fixture(2)
      try {
        const prepare = f.db.prepare.bind(f.db)
        const exec = f.db.exec.bind(f.db)
        let rollback = 0
        f.db.prepare = /** 精确破坏本测试指定读取，不影响模式锁存和清理。 */ (...args) => {
          if (
            (fault === 'active_sql' && args[0].startsWith('SELECT generation,mode,clock')) ||
            (fault === 'row_sql' && args[0].startsWith('SELECT * FROM calls'))
          ) {
            throw new Error('synthetic_private_sql_failure')
          }
          return prepare(...args)
        }
        f.db.exec = /** COMMIT 失败仍允许真实 ROLLBACK，记录回滚并保留原 SQLite 语义。 */ (...args) => {
          if (args[0] === 'COMMIT' && fault === 'commit_sql') {
            throw new Error('synthetic_commit_failure')
          }
          if (args[0] === 'ROLLBACK') {
            rollback++
          }
          return exec(...args)
        }
        if (fault === 'clock') {
          f.time(999)
        }
        assert.throws(
          /** 全局失败不得降成每项 unavailable 或空成功。 */ () => f.store.responseAnchors(f.bindings),
          fault === 'clock' ? /clock_untrusted/ : /storage_degraded/
        )
        f.db.prepare = prepare
        assert.equal(f.store.health().mode, 'storage_degraded')
        // active() 不再单独查询元数据（隔离模式已删除），模式读取发生在事务内，故其失败同样回滚。
        assert.equal(rollback, fault === 'clock' ? 0 : 1)
      } finally {
        f.store.close()
      }
    }
  )
}
