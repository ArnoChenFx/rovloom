// 用真实磁盘 SQLite 验证绝对期限准入、双端授权、独立连接竞争及重启去重，不绕过 Store 独占锁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/store.js'
import type { CallAdmissionOptions, StoreOptions } from '../../src/store.js'
import { Router } from '../../src/router.js'
import { connected, management, options, policy } from './helpers.js'

// 为每例创建私有真实数据库路径，异常时也清理全部隔离资源。
function disk(run: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-admission-'))
  try {
    run(join(root, 'db'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
// 在固定 fixture 契约和策略版本上构造绝对截止登记选项。
function absolute(deadline = 200, extra: Partial<CallAdmissionOptions> = {}): CallAdmissionOptions {
  return { ...options(), timeoutMs: undefined, deadline, ...extra }
}
// 从独立 SQLite 连接观察完整调用及审计快照，不通过 Store 的管理读取改变审计。
function ledger(db: DatabaseSync) {
  return {
    calls: db.prepare('SELECT * FROM calls ORDER BY call_id').all(),
    audit: db.prepare('SELECT * FROM audit ORDER BY event_id').all()
  }
}
// 以可推进的可信时间和指定治理配置打开隔离 Store，始终关闭 writer。
function fixture(
  run: (store: Store, db: DatabaseSync, advance: (now: number) => void) => void,
  extra: StoreOptions = {}
) {
  disk(
    /* 为 Store 与独立观察连接打开同一私有磁盘数据库。 */ (path) => {
      let now = 100
      const store = new Store(path, /* 返回测试推进后的可信时间。 */ () => now, { management, ...extra })
      const db = new DatabaseSync(path)
      try {
        run(
          store,
          db,
          /* 推进单调测试时间以验证精确边界。 */ (value) => {
            now = value
          }
        )
      } finally {
        db.close()
        store.close()
      }
    }
  )
}

test(
  'absolute admission commits one intent and never renews or dispatches duplicates',
  /* 检查重复调用在原执行期限前后均返回同一行，全部期限与审计保持不变。 */ () =>
    fixture(
      /* 用 history/key 登记并跨执行截止时间重送，不触发任何派发。 */ (s, db, advance) => {
        const d = connected(s)
        const o = absolute(110, { client_request_key: 'same' })
        const first = s.admitCall('alice', d.target, { method: 'ping' }, o)
        assert.equal(first.created, true)
        assert.equal(first.call.deadline, 110)
        const before = ledger(db)
        for (const now of [101, 110, 150]) {
          advance(now)
          const repeated = s.admitCall('alice', d.target, { method: 'ping' }, o)
          assert.equal(repeated.created, false)
          assert.equal(repeated.call.call_id, first.call.call_id)
          assert.equal(repeated.call.deadline, 110)
          assert.deepEqual(ledger(db), before)
        }
        assert.equal(first.call.state, 'created')
        assert.equal(first.call.attempt_id, null)
        assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='dispatching'").get()!.n, 0)
      }
    )
)

test(
  'fresh absolute deadlines use exact open and closed boundaries without relative renewal',
  /* 检查新意图只有未来十分钟内的安全整数 deadline 可登记，未带 key 的意图各自独立。 */ () =>
    fixture(
      /* 在固定接收时间逐项验证期限边界与非法混用选项。 */ (s, db) => {
        const d = connected(s)
        for (const deadline of [101, 600_100]) {
          const admitted = s.admitCall('alice', d.target, { method: 'ping' }, absolute(deadline))
          assert.equal(admitted.created, true)
          assert.equal(admitted.call.deadline, deadline)
        }
        assert.equal(s.admitCall('alice', d.target, { method: 'ping' }, absolute(101)).created, true)
        const before = ledger(db)
        for (const deadline of [1, 99, 100]) {
          assert.throws(
            /* 到期和边界同刻不允许首次登记。 */ () =>
              s.admitCall('alice', d.target, { method: 'ping' }, absolute(deadline)),
            /deadline_exceeded/
          )
        }
        for (const deadline of [0, -1, 100.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 600_101]) {
          assert.throws(
            /* 不接受无效整数或超出最长执行窗的绝对期限。 */ () =>
              s.admitCall('alice', d.target, { method: 'ping' }, absolute(deadline)),
            /invalid_deadline/
          )
        }
        assert.throws(
          /* 运行时同样拒绝绕过类型系统混用相对 timeout。 */ () =>
            s.admitCall('alice', d.target, { method: 'ping' }, {
              ...absolute(),
              timeoutMs: 10
            } as unknown as CallAdmissionOptions),
          /invalid_deadline/
        )
        assert.deepEqual(ledger(db), before)
      }
    )
)

test(
  'same key conflicts include absolute deadline and complete registration intent',
  /* 核对同 key 的目标、请求、契约、验证方式及策略版本差异均不会偷换旧意图。 */ () =>
    fixture(
      /* 登记一个原始意图，再分别改变每个摘要维度并检查无写入。 */ (s, db, advance) => {
        const d = connected(s)
        const o = absolute(110, { client_request_key: 'same' })
        const first = s.admitCall('alice', d.target, { method: 'ping' }, o)
        advance(120)
        const before = ledger(db)
        for (const changed of [
          { deadline: 111 },
          { deadline: 109 },
          { validation: 'raw-contract' as const },
          { contract_ref: 'f'.repeat(64) }
        ]) {
          assert.throws(
            /* 同 key 即便已过执行期限，也先报告意图冲突而不新建或延长。 */ () =>
              s.admitCall('alice', d.target, { method: 'ping' }, { ...o, ...changed }),
            /request_key_conflict/
          )
        }
        assert.throws(
          /* 同一 provider 的不同 session 也属于不同意图。 */ () =>
            s.admitCall('alice', { ...d.target, session: 'another' }, { method: 'ping' }, o),
          /request_key_conflict/
        )
        assert.throws(
          /* 原生参数差异不能复用旧 key。 */ () =>
            s.admitCall('alice', d.target, { method: 'ping', params: { value: 1 } }, o),
          /request_key_conflict/
        )
        assert.deepEqual(ledger(db), before)
        assert.equal(s.admitCall('alice', d.target, { method: 'ping' }, o).call.call_id, first.call.call_id)
        // key 按主体隔离：其它主体使用同一 key 登记的是自己的独立调用，看不到 alice 的。
        const other = s.admitCall('bob', d.target, { method: 'ping' }, { ...o, deadline: 600 })
        assert.equal(other.created, true)
        assert.notEqual(other.call.call_id, first.call.call_id)
      }
    )
)

test(
  'absolute and internal relative APIs share the key window without changing old duration semantics',
  /* 验证两种入口共用原事务去重，旧相对入口仍要求首次持续时长相同。 */ () =>
    fixture(
      /* 交叉调用绝对与相对入口，分别核对截止值、返回类型和旧超时校验。 */ (s, db, advance) => {
        const d = connected(s)
        const client_request_key = 'relative'
        const relative = s.createCall(
          'alice',
          d.target,
          { method: 'ping' },
          options({ timeoutMs: 20, client_request_key })
        )
        advance(105)
        const absoluteRetry = s.admitCall('alice', d.target, { method: 'ping' }, absolute(120, { client_request_key }))
        assert.equal(absoluteRetry.created, false)
        assert.equal(absoluteRetry.call.call_id, relative.call_id)
        const key2 = 'absolute'
        const first = s.admitCall('alice', d.target, { method: 'ping' }, absolute(125, { client_request_key: key2 }))
        advance(110)
        const before = ledger(db)
        assert.equal(
          s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 20, client_request_key: key2 }))
            .call_id,
          first.call.call_id
        )
        assert.throws(
          /* 相对入口不能把不同原持续时长归一为旧请求。 */ () =>
            s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 21, client_request_key: key2 })),
          /request_key_conflict/
        )
        assert.deepEqual(ledger(db), before)
        assert.equal(
          s.createCall(
            'alice',
            d.target,
            { method: 'ping' },
            options({ timeoutMs: undefined, client_request_key: undefined, validation: undefined })
          ).deadline,
          30_110
        )
        assert.throws(
          /* 旧相对入口继续拒绝超出原范围的 timeout。 */ () =>
            s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 600_001 })),
          /invalid_timeout/
        )
      }
    )
)

test(
  'discarded content retains the fixed tombstone, then the key becomes reusable',
  /* 验证内容丢弃和元数据清理前 key 仍命中原调用，窗口结束后同 key 才是新意图。 */ () =>
    fixture(
      /* 丢弃内容后重复旧键并推进到墓碑恰好到期，检查窗口内不新增调用。 */ (s, db, advance) => {
        const d = connected(s)
        const o = absolute(105, { client_request_key: 'same' })
        const first = s.admitCall('alice', d.target, { method: 'ping' }, o)
        s.discardResponse('alice', first.call.call_id)
        advance(110)
        const before = ledger(db)
        const duplicate = s.admitCall('alice', d.target, { method: 'ping' }, o)
        assert.equal(duplicate.created, false)
        assert.equal(duplicate.call.content_status, 'discarded')
        assert.equal(duplicate.call.dedup_expires, 200)
        assert.deepEqual(ledger(db), before)
        advance(199)
        assert.equal(s.admitCall('alice', d.target, { method: 'ping' }, o).created, false)
        advance(200)
        const fresh = s.admitCall('alice', d.target, { method: 'ping' }, absolute(250, { client_request_key: 'same' }))
        assert.equal(fresh.created, true)
        assert.notEqual(fresh.call.call_id, first.call.call_id)
      },
      { retention: { metadata_ttl: 100 } }
    )
)

test(
  'reopened Store returns created false for original offline intent and cannot replay it',
  /* 顺序释放独占锁并由新 Store writer 打开真实数据库，检查旧待发调用不会重新入队。 */ () =>
    disk(
      /* 跨两次 Store 生命周期观察原调用、审计和固定期限。 */ (path) => {
        let now = 100
        let s = new Store(path, /* 为第一次及重开生命周期返回同一可控时间。 */ () => now, { management })
        let db = new DatabaseSync(path)
        try {
          const d = connected(s)
          const o = absolute(110, { client_request_key: 'restart' })
          const first = s.admitCall('alice', d.target, { method: 'ping' }, o)
          assert.throws(
            /* Store 独占锁仍阻止第二个合法 writer 同时打开同库。 */ () =>
              new Store(path, /* 固定被拒绝的 writer 时钟。 */ () => now, { management }),
            /EEXIST/
          )
          db.close()
          s.close()
          now = 150
          s = new Store(path, /* 重开不会换 generation、恢复连接或重放旧意图。 */ () => now, { management })
          db = new DatabaseSync(path)
          const before = ledger(db)
          const duplicate = s.admitCall('alice', d.target, { method: 'ping' }, o)
          assert.equal(duplicate.created, false)
          assert.equal(duplicate.call.call_id, first.call.call_id)
          assert.equal(duplicate.call.state, 'not_dispatched')
          assert.equal(duplicate.call.deadline, first.call.deadline)
          assert.equal(duplicate.call.content_expires, first.call.content_expires)
          assert.equal(duplicate.call.dedup_expires, first.call.dedup_expires)
          assert.deepEqual(ledger(db), before)
          assert.throws(
            /* 新连接 epoch 不能用于重派重启前已终止的调用。 */ () => s.dispatch('alice', first.call.call_id, d.epoch),
            /dispatch_rejected/
          )
        } finally {
          db.close()
          s.close()
        }
      }
    )
)

test(
  'writer lock covers authorization and duplicate decision against an independent SQLite connection',
  /* 用第二 SQLite 连接真实竞争 writer 锁并观察未提交数据，证明授权不是查询后创建。 */ () =>
    fixture(
      /* 在授权回调内争抢写锁并查询行；首次及重复都应已持 BEGIN IMMEDIATE。 */ (s, db) => {
        const d = connected(s)
        const o = absolute(200, { client_request_key: 'locked' })
        const before = ledger(db)
        let authorized = 0
        const authorize = /* 在真实独立连接上验证 RESERVED writer 锁及提交前可见性。 */ () => {
          authorized++
          assert.throws(
            /* 第二 writer 无法在正在准入的事务中取得写锁。 */ () => db.exec('BEGIN IMMEDIATE'),
            /locked|busy/i
          )
          assert.deepEqual(ledger(db), authorized === 1 ? before : committed)
        }
        const first = s.admitCall('alice', d.target, { method: 'ping' }, o, authorize)
        const committed = ledger(db)
        assert.equal(first.created, true)
        const repeated = s.admitCall('alice', d.target, { method: 'ping' }, o, authorize)
        assert.equal(repeated.created, false)
        assert.equal(authorized, 2)
        assert.deepEqual(ledger(db), committed)
      }
    )
)

test(
  'external writer contention returns no admission and protected recovery preserves duplicate decision',
  /* 独立 SQLite writer 先持锁时，准入拒绝并降级；受保护恢复后仍复用已提交原意图。 */ () =>
    fixture(
      /* 先提交原意图，再以外部真实事务阻止 Store 取写锁并检查无新增行。 */ (s, db) => {
        const d = connected(s)
        const o = absolute(200, { client_request_key: 'contended' })
        const first = s.admitCall('alice', d.target, { method: 'ping' }, o)
        const before = ledger(db)
        let authorized = false
        db.exec('BEGIN IMMEDIATE')
        try {
          assert.throws(
            /* 持锁期间不得返回 created 标志或误称登记成功。 */ () =>
              s.admitCall(
                'alice',
                d.target,
                { method: 'ping' },
                o,
                /* 若授权回调被执行则标记，以检查失败发生在 writer 持锁前。 */ () => {
                  authorized = true
                }
              ),
            /storage_degraded/
          )
          assert.equal(authorized, false)
          assert.deepEqual(ledger(db), before)
        } finally {
          db.exec('ROLLBACK')
        }
        assert.equal(s.health().mode, 'storage_degraded')
        s.resumeStorage()
        const recovered = ledger(db)
        const repeated = s.admitCall('alice', d.target, { method: 'ping' }, o)
        assert.equal(repeated.created, false)
        assert.equal(repeated.call.call_id, first.call.call_id)
        assert.deepEqual(ledger(db), recovered)
      }
    )
)

test(
  'synchronous authorization rejects stale, asynchronous and reentrant admission without rows or audit',
  /* 同步可信授权只能返回 undefined；异常、异步返回及重入都回滚，旧 key 也不能绕过复验。 */ () =>
    fixture(
      /* 注入各类非法授权回调并检查数据库快照完全不变。 */ (s, db) => {
        const d = connected(s)
        const o = absolute(200, { client_request_key: 'auth' })
        const before = ledger(db)
        for (const authorize of [
          /* 显式 false 不是此同步端口的许可协议。 */ () => false,
          /* 普通对象也不能冒充已授权标志。 */ () => ({}),
          /* Promise 完成不影响已同步拒绝的准入事务。 */ () => Promise.resolve()
        ]) {
          assert.throws(
            /* 拒绝所有非 undefined 同步返回。 */ () =>
              s.admitCall('alice', d.target, { method: 'ping' }, o, authorize),
            /synchronous_authorization_required/
          )
          assert.deepEqual(ledger(db), before)
        }
        assert.throws(
          /* 授权中重入 writer 不能开启嵌套准入事务。 */ () =>
            s.admitCall(
              'alice',
              d.target,
              { method: 'ping' },
              o,
              /* 在外层 writer 内尝试新增另一调用。 */ () => {
                s.admitCall('alice', d.target, { method: 'ping' }, absolute())
              }
            ),
          /transaction_in_progress/
        )
        assert.deepEqual(ledger(db), before)
        s.admitCall('alice', d.target, { method: 'ping' }, o)
        const committed = ledger(db)
        assert.throws(
          /* 原 key 命中仍执行当前授权且必须回滚任何拒绝。 */ () =>
            s.admitCall(
              'alice',
              d.target,
              { method: 'ping' },
              o,
              /* 模拟可信宿主撤销本次请求权限。 */ () => {
                throw Error('synthetic authorization denied')
              }
            ),
          /storage_degraded/
        )
        assert.deepEqual(ledger(db), committed)
      }
    )
)

test(
  'content capacity permits unchanged duplicates but rolls back a new intent',
  /* 固定内容子额恰好容纳一个请求，重复不新增内容与审计，新意图超额完全回滚。 */ () =>
    fixture(
      /* 在内容满额时分别重送旧键与申请新键。 */ (s, db) => {
        const d = connected(s)
        const o = absolute(200, { client_request_key: 'capacity' })
        s.admitCall('alice', d.target, { method: 'ping' }, o)
        const before = ledger(db)
        assert.equal(s.admitCall('alice', d.target, { method: 'ping' }, o).created, false)
        assert.deepEqual(ledger(db), before)
        assert.throws(
          /* 新 key 需要额外内容容量，不能只返回一个未提交的 created。 */ () =>
            s.admitCall('alice', d.target, { method: 'ping' }, absolute(200, { client_request_key: 'overflow' })),
          /content_quota/
        )
        assert.deepEqual(ledger(db), before)
      },
      { retention: { content_bytes: Buffer.byteLength('{"method":"ping"}') } }
    )
)

test(
  'commit failure returns no created flag, persists degradation and retries only after protected recovery',
  /* 在真实 SQLite 提交前注入故障，检查调用与审计同事务回滚且恢复前不准入。 */ () => {
    let fail = false
    fixture(
      /* 记录每次成功返回的 created，失败不增加任何发送资格。 */ (s, db) => {
        const d = connected(s)
        const o = absolute(200, { client_request_key: 'failure' })
        const before = ledger(db)
        let created = 0
        fail = true
        assert.throws(
          /* 只在完整提交返回后计入首次准入。 */ () => {
            if (s.admitCall('alice', d.target, { method: 'ping' }, o).created) {
              created++
            }
          },
          /storage_degraded/
        )
        assert.equal(created, 0)
        assert.deepEqual(ledger(db), before)
        assert.equal(s.health().mode, 'storage_degraded')
        fail = false
        assert.throws(
          /* 故障解除仍须独立受保护恢复，不能自动放行。 */ () => s.admitCall('alice', d.target, { method: 'ping' }, o),
          /storage_degraded/
        )
        s.resumeStorage()
        assert.equal(s.admitCall('alice', d.target, { method: 'ping' }, o).created, true)
        assert.equal(s.admitCall('alice', d.target, { method: 'ping' }, o).created, false)
      },
      {
        fault: /* 只在测试开关启用时中断提交阶段。 */ (point) => {
          if (fail && point === 'before_commit') {
            throw Error('synthetic SQLite commit failure')
          }
        }
      }
    )
  }
)

test(
  'Router malformed deadlines match Store errors before optional input normalization',
  /* 绝对期限形状错误在 JSON 快照前统一返回 invalid_deadline，不泄漏不同入口的规范化差异。 */ () =>
    fixture(
      /* 对 Router 执行非有限值、缺值及相对混用校验，确认没有登记或审计。 */ (s, db) => {
        const d = connected(s)
        const principal = { id: 'alice', policy: policy(d.target) }
        const router = new Router(s)
        const before = ledger(db)
        for (const deadline of [undefined, NaN, Infinity, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
          assert.throws(
            /* 不安全 deadline 在进入事务前统一拒绝。 */ () =>
              router.admit(principal, d.target, { method: 'ping' }, { ...absolute(), deadline: deadline as number }),
            /invalid_deadline/
          )
        }
        assert.throws(
          /* 不能经 Router 将相对 timeout 混进绝对意图。 */ () =>
            router.admit(principal, d.target, { method: 'ping' }, {
              ...absolute(),
              timeoutMs: 10
            } as unknown as CallAdmissionOptions),
          /invalid_deadline/
        )
        assert.deepEqual(ledger(db), before)
      }
    )
)

test(
  'storage exhaustion rolls back call and created audit before returning admission',
  /* 实际填满总存储预算，确认触限登记不会留下调用或创建审计且锁存降级。 */ () =>
    fixture(
      /* 重复登记新 key 直到真实预算拒绝，逐次观察最后一次事务的完整回滚。 */ (s, db) => {
        const d = connected(s)
        let exhausted = false
        for (let i = 0; i < 100; i++) {
          const before = ledger(db)
          try {
            assert.equal(
              s.admitCall('alice', d.target, { method: 'ping' }, absolute(200, { client_request_key: `audit_${i}` }))
                .created,
              true
            )
          } catch (error) {
            assert.match(String(error), /storage_degraded/)
            assert.deepEqual(ledger(db), before)
            assert.equal(s.health().mode, 'storage_degraded')
            exhausted = true
            break
          }
        }
        assert.equal(exhausted, true)
      },
      {
        retention: {
          storage_total_bytes: 300_000,
          storage_reserve_bytes: 17_000,
          content_bytes: 100_000,
          backup_bytes: 100_000
        }
      }
    )
)
