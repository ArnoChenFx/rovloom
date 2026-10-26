// 使用私有真实 SQLite 验证逐调用拒绝的事务、审计、固定期限及提交失败；身份均为合成 fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { connected, management, options } from './helpers.js'

/** 为每例创建私有账本和独立只读观察器，不通过访问 Store 私有字段取得结论。 */
function fixture(run: (store: Store, db: DatabaseSync, state: { now: number; fail: boolean }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-dispatch-refusal-'))
  const state = { now: 100, fail: false }
  const settings: StoreOptions = {
    management,
    maintenanceIntervalMs: 60_000,
    /** 只在指定拒绝事务提交时制造磁盘提交故障。 */ fault(point) {
      if (state.fail && point === 'before_commit') {
        throw new Error('synthetic_commit_failure')
      }
    }
  }
  const store = new Store(join(root, 'db'), /** 使用可控单调时钟。 */ () => state.now, settings)
  const db = new DatabaseSync(join(root, 'db'), { readOnly: true })
  try {
    run(store, db, state)
  } finally {
    db.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('Gateway 未写出拒绝单独记为 gateway 审计，不能覆盖 accepted、unknown 或已到期调用', () =>
  fixture((store, db, state) => {
    const device = connected(store)
    for (const phase of ['dispatching', 'accepted', 'cancelled', 'expired']) {
      const call = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
      const binding = store.dispatch('alice', call.call_id, device.epoch)
      if (phase === 'accepted') {
        store.accepted(binding)
      }
      if (phase === 'cancelled') {
        store.stop('alice', call.call_id)
      }
      if (phase === 'expired') {
        state.now = call.deadline
      }
      assert.equal(store.commitGatewayDispatchRefusal(binding, 'raw_contract_not_authorized'), phase === 'dispatching')
      assert.equal(
        store.call('alice', call.call_id).state,
        phase === 'dispatching' ? 'not_dispatched' : phase === 'accepted' ? 'connector_accepted' : 'outcome_unknown'
      )
    }
    const rows = db.prepare("SELECT actor, details FROM audit WHERE action='dispatch_refused'").all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.actor, 'gateway')
    assert.equal(JSON.parse(String(rows[0]!.details)).code, 'raw_contract_not_authorized')
  }))

test('Gateway 拒绝证据提交失败时不发布确定未派发或伪造审计', () =>
  fixture((store, db, state) => {
    const device = connected(store)
    const call = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
    const binding = store.dispatch('alice', call.call_id, device.epoch)
    state.fail = true
    assert.throws(() => store.commitGatewayDispatchRefusal(binding, 'raw_contract_not_authorized'))
    assert.equal(db.prepare('SELECT state FROM calls WHERE call_id=?').get(call.call_id)!.state, 'dispatching')
    assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='dispatch_refused'").get()!.n, 0)
    assert.equal(store.health().mode, 'storage_degraded')
  }))

test(
  '确定拒绝只终结原 accepted call，审计幂等且保留固定期限和邻近 attempt',
  /** 与独立只读连接核对实际已提交状态及预约释放，不使用服务 stub 伪造成功。 */ () =>
    fixture(
      /** 两份相同 provider 的调用具有独立完整 attempt。 */ (store, db) => {
        const device = connected(store)
        const first = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
        const second = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
        const pending = store.dispatch('alice', first.call_id, device.epoch)
        const refused = store.dispatch('alice', second.call_id, device.epoch)
        store.accepted(pending)
        store.accepted(refused)
        const before = store.call('alice', second.call_id)
        assert.equal(store.commitDispatchRefusal(refused, 'terminal_execution_disabled'), true)
        assert.equal(store.commitDispatchRefusal(refused, 'terminal_execution_disabled'), false)
        const after = store.call('alice', second.call_id)
        assert.equal(after.state, 'not_dispatched')
        assert.equal(after.response, null)
        assert.deepEqual(
          [after.deadline, after.content_expires, after.metadata_expires, after.dedup_expires],
          [before.deadline, before.content_expires, before.metadata_expires, before.dedup_expires]
        )
        assert.equal(store.call('alice', first.call_id).state, 'connector_accepted')
        assert.equal(db.prepare('SELECT reserved FROM calls WHERE call_id=?').get(second.call_id)!.reserved, 0)
        const audit = db.prepare("SELECT details FROM audit WHERE action='dispatch_refused'").all()
        assert.equal(audit.length, 1)
        assert.equal(JSON.parse(String(audit[0]!.details)).code, 'terminal_execution_disabled')
        assert.throws(
          /** 已拒绝 attempt 不得自动重派。 */ () => store.dispatch('alice', second.call_id, device.epoch),
          /dispatch_rejected/
        )
      }
    )
)

test(
  '取消或固定 deadline 已提交 unknown 后，迟到拒绝不能改成 not_dispatched',
  /** 分别覆盖取消先到和截止边界同刻，不依靠真实等待时间。 */ () =>
    fixture(
      /** 每个分支先得到原有效绑定，再提交不可倒退状态。 */ (store, db, state) => {
        const device = connected(store)
        for (const reason of ['cancel', 'deadline']) {
          const call = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 10 }))
          const binding = store.dispatch('alice', call.call_id, device.epoch)
          store.accepted(binding)
          if (reason === 'cancel') {
            store.stop('alice', call.call_id)
          } else {
            state.now = call.deadline
          }
          assert.equal(store.commitDispatchRefusal(binding, 'terminal_execution_disabled'), false)
          assert.equal(store.call('alice', call.call_id).state, 'outcome_unknown')
        }
        assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='dispatch_refused'").get()!.n, 0)
      }
    )
)

test(
  '完整 attempt 不匹配时拒绝事务回滚，提交失败保留原 durable accepted 锚点并降级',
  /** 观察实际磁盘行和审计；不能在故障后发布假 not_dispatched。 */ () =>
    fixture(
      /** 仅改变明确的故障开关，其余账本行为保持原实现。 */ (store, db, state) => {
        const device = connected(store)
        const call = store.createCall('alice', device.target, { method: 'ping' }, options({ timeoutMs: 1000 }))
        const binding = store.dispatch('alice', call.call_id, device.epoch)
        store.accepted(binding)
        assert.throws(
          /** 帧中的 attempt ID 不能替换原账本锚点。 */ () =>
            store.commitDispatchRefusal({ ...binding, attempt_id: 'wrong_attempt' }, 'terminal_execution_disabled'),
          /attempt_binding_mismatch/
        )
        assert.equal(store.call('alice', call.call_id).state, 'connector_accepted')
        state.fail = true
        assert.throws(
          /** 在 COMMIT 前制造有界测试故障。 */ () =>
            store.commitDispatchRefusal(binding, 'terminal_execution_disabled'),
          /storage_degraded/
        )
        assert.equal(store.health().mode, 'storage_degraded')
        assert.equal(
          db.prepare('SELECT state FROM calls WHERE call_id=?').get(call.call_id)!.state,
          'connector_accepted'
        )
        assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='dispatch_refused'").get()!.n, 0)
        assert.equal(store.call('alice', call.call_id).state, 'outcome_unknown')
      }
    )
)
