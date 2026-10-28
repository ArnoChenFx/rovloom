// 验证真实 NativeValidator 与 Wire 适配器能将迟到响应幂等提交到 SQLite，且不重新派发。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { commitLuvusResponse } from '../../src/wire/persistence.js'
import { management, responseFrame } from './helpers.js'
import { nativeBackend } from './native-backend.js'

test(
  'real NativeValidator and Wire adapter commit a late response through the durable SQLite backend',
  /* 验证超时后仍可提交精确绑定的迟到响应，重复响应幂等且派发与迟到审计各仅一次。 */ () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-native-ledger-'))
    let now = 100
    const store = new Store(join(root, 'db'), /* 返回用例控制的当前时间，供验证截止边界的迟到响应使用。 */ () => now, {
      management
    })
    try {
      const native = nativeBackend(store)
      const call = native.create({ timeoutMs: 10 })
      const binding = native.dispatch(call.call_id)
      assert.equal(native.state.sends, 1)
      now = 110
      store.expire()
      const frame = responseFrame(binding, { result: { id: 'task-created' } })
      const result = commitLuvusResponse(store, native.adapter, frame)
      assert.equal(result.state, 'responded')
      assert.equal(JSON.parse(result.response!).result.id, 'task-created')
      const duplicate = commitLuvusResponse(store, native.adapter, frame)
      assert.equal(duplicate.call_id, call.call_id)
      assert.throws(
        /* 尝试重新派发已有响应的调用，确认不会创建额外尝试或发送。 */ () =>
          store.dispatch('synthetic', call.call_id, native.device.epoch),
        /dispatch_rejected/
      )
      const events = store.auditRecords()
      assert.equal(
        events.filter(/* 筛选派发审计，核对整条链路仅发生一次派发。 */ (event) => event.action === 'dispatching')
          .length,
        1
      )
      assert.equal(
        events.filter(/* 筛选迟到证据审计，核对幂等重放不会重复记账。 */ (event) => event.action === 'late_evidence')
          .length,
        1
      )
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
