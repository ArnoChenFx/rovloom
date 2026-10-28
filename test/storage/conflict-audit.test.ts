// 验证同锚点响应冲突的脱敏审计、可信来源边界和受保护完成配额。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { nativeBackend } from './native-backend.js'
import { management, responseFrame } from './helpers.js'
import { commitLuvusResponse } from '../../src/wire/persistence.js'

/* 创建私有磁盘库和真实原生校验适配器，并开放只读连接检查事务结果。 */ function fixture(overrides: StoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-conflict-audit-'))
  const path = join(root, 'db')
  const store = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
    management,
    ...overrides
  })
  const native = nativeBackend(store)
  const inspect = new DatabaseSync(path, { readOnly: true })
  return {
    path,
    store,
    native,
    inspect,
    // 关闭检查连接及存储写者后删除本次测试的私有目录。
    close() {
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'real native same-anchor conflict persists one redacted audit and keeps the original result and dispatch count',
  /* 验证同锚点冲突仅记录一次脱敏审计，保留原响应且不增加派发次数。 */ () => {
    const f = fixture()
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.native.respond(binding, { id: 'original', text: 'synthetic-first-secret' })
      const original = f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id)
      const before = f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n
      for (let i = 0; i < 8; i++) {
        assert.throws(
          /* 重复提交带不同敏感文本的冲突响应，检查冲突拒绝和审计去重。 */ () =>
            f.native.respond(binding, { id: 'conflict', text: 'synthetic-conflict-secret-' + i }),
          /response_evidence_conflict/
        )
      }
      assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n, Number(before) + 1)
      const events = f.inspect.prepare("SELECT * FROM audit WHERE action='response_conflict'").all()
      assert.equal(events.length, 1)
      assert.equal(events[0]!.call_id, call.call_id)
      assert(!JSON.stringify(events).includes('synthetic-first-secret'))
      assert(!JSON.stringify(events).includes('synthetic-conflict-secret'))
      assert.deepEqual(f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id), original)
      assert.equal(f.native.state.sends, 1)
      assert.equal(f.store.health().mode, 'active')
      assert.equal(f.native.respond(binding, { id: 'original', text: 'synthetic-first-secret' }).state, 'responded')
    } finally {
      f.close()
    }
  }
)

test(
  'untrusted native source and invalid native ID are rejected without classifying them as trusted conflicts',
  /* 验证未受信来源和错误原生请求标识先被拒绝，不被归类为可信响应冲突。 */ () => {
    const f = fixture()
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.native.respond(binding)
      f.native.state.sourceVerified = false
      assert.throws(
        /* 从已标记不可信的原生来源提交不同响应，检查来源校验优先拒绝。 */ () =>
          f.native.respond(binding, { id: 'different' }),
        /native_source_untrusted/
      )
      f.native.state.sourceVerified = true
      assert.throws(
        /* 提交原生请求标识不匹配的响应帧，检查其在冲突分类前被拒绝。 */ () =>
          commitLuvusResponse(
            f.store,
            f.native.adapter,
            responseFrame(binding, { id: 'wrong-native-id', result: { id: 'different' } })
          ),
        /native_id_mismatch/
      )
      assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='response_conflict'").get()!.n, 0)
      assert.equal(f.store.health().mode, 'active')
    } finally {
      f.close()
    }
  }
)

test(
  'conflict audit commit failure reports degraded, rolls back the audit, and preserves the durable original response',
  /* 验证冲突审计提交失败会降级并回滚审计，原始持久化响应仍被保留。 */ () => {
    let fail = false
    const f = fixture({
      fault: /* 在提交前注入带私有文本的异常，检查事务失败与对外错误脱敏。 */ (point) => {
        if (fail && point === 'before_commit') {
          throw Error('synthetic-private-error')
        }
      }
    })
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.native.respond(binding)
      const original = f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id)
      const before = f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n
      fail = true
      assert.throws(
        /* 在提交故障开启时制造响应冲突，触发审计写入失败。 */ () => f.native.respond(binding, { id: 'different' }),
        /* 仅接纳对外统一的存储降级错误，排除泄露注入异常文本。 */ (error) =>
          error instanceof Error && error.message === 'storage_degraded'
      )
      assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n, before)
      assert.deepEqual(f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id), original)
      assert.equal(f.store.health().mode, 'storage_degraded')
      fail = false
      f.store.resumeStorage()
      assert.throws(
        /* 恢复存储后再次提交冲突响应，验证拒绝同时能持久化唯一冲突审计。 */ () =>
          f.native.respond(binding, { id: 'different' }),
        /response_evidence_conflict/
      )
      assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='response_conflict'").get()!.n, 1)
    } finally {
      f.close()
    }
  }
)
