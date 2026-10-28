/** 用真实 SQLite、NativeValidator 和原 Wire 上下文验证结果分页、固定期限、当前授权和安全丢弃。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../../src/store.js'
import type { Principal } from '../../../src/router.js'
import { commitNativeResponse } from '../../../src/wire/persistence.js'
import { createLuvusResultAccess } from '../../../src/connector/luvus/index.js'
import { management, responseFrame } from '../../storage/helpers.js'
import { nativeBackend } from '../../storage/native-backend.js'

/** 建立真实隔离账本与原生响应，只读观察连接仅用于核对实际句柄数量。 */
function fixture() {
  const state = { now: 100, available: true }
  const root = mkdtempSync(join(tmpdir(), 'rovloom-luvus-results-'))
  const path = join(root, 'ledger.sqlite')
  const store = new Store(path, /* 返回受控且不可回拨的 Store 时间。 */ () => state.now, {
    management,
    retention: { result_ttl: 10 }
  })
  const inspect = new DatabaseSync(path, { readOnly: true })
  const native = nativeBackend(store)
  const call = native.create()
  const binding = native.dispatch(call.call_id)
  const frame = responseFrame(binding, {
    error: { code: 'synthetic', message: 'preserved', data: { revision: 7, text: '你好🌍'.repeat(8000) } }
  })
  commitNativeResponse(store, native.adapter, frame)
  const principal: Principal = {
    id: 'synthetic'
  }
  const ports = {
    store,
    principal: /* 返回当前测试身份和调用方策略，供每次操作重新快照。 */ () => principal
  }
  return {
    store,
    native,
    call,
    binding,
    frame,
    principal,
    state,
    ports,
    access: createLuvusResultAccess(ports),
    /** 在真实保留门禁通过的初始 fixture 阶段预置 Store 句柄，不为 adapter 模拟保留许可。 */
    savedHandle() {
      return store.saveResult('synthetic', call.call_id)
    },
    /** 查询实际 SQLite 句柄数量，检验读取失败不会创建或续期结果。 */
    handles() {
      return Number(inspect.prepare('SELECT COUNT(*) AS n FROM results').get()!.n)
    },
    /** 通过第二个真实连接模拟已提交的句柄维护删除，不改变调用正文或原 Wire。 */
    deleteHandle(resultId: string) {
      const maintenance = new DatabaseSync(path)
      try {
        maintenance.prepare('DELETE FROM results WHERE result_id=?').run(resultId)
      } finally {
        maintenance.close()
      }
    },
    /** 按所有权关闭原 Wire 与测试 Store，避免保留维护计时器或订阅。 */
    close() {
      native.adapter.close()
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'native error pagination preserves complete bytes, nested data, hash and actual handle expiry',
  /* 把大于一页的多字节原生错误按字节拆开重组，核对每页期限及完整响应字段。 */ (t) => {
    const f = fixture()
    t.after(/* 关闭本用例的原 Wire 和隔离 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    assert.equal(meta.expires, 110)
    const parts: Buffer[] = []
    let cursor = 0
    while (true) {
      const page = f.access.read(meta.result_id, cursor, 65_535)
      assert.equal(page.expires, meta.expires)
      assert.equal(page.hash, meta.hash)
      assert.equal(page.bytes, meta.bytes)
      parts.push(Buffer.from(page.data, 'base64'))
      cursor = page.next_cursor
      if (page.eof) {
        break
      }
    }
    const all = Buffer.concat(parts)
    assert(parts.length > 1)
    assert.equal(all.length, meta.bytes)
    assert.equal(createHash('sha256').update(all).digest('hex'), meta.hash)
    assert.deepEqual(JSON.parse(all.toString('utf8')), f.frame.payload.native_response)
    assert.equal(f.handles(), 1)
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'read preserves actual Store expiry and never recreates or extends an expired handle',
  /* 由 fixture 在合法保留阶段预置句柄，证明每页期限固定且 read 不重开到期句柄。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire 和 SQLite。 */ () => f.close())
    const first = f.savedHandle()
    f.state.now = 105
    assert.equal(f.access.read(first.result_id).expires, first.expires)
    f.state.now = 110
    assert.throws(
      /* 到期句柄必须直接失败，不能转为保存或重发。 */ () => f.access.read(first.result_id),
      /result_not_found/
    )
    assert.equal(f.handles(), 1)
    assert.throws(
      /* 句柄与内容同期限，到期后显式 open 也不能恢复内容或重建句柄。 */ () => f.access.open(f.call.call_id)
    )
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'background expiry removes actual handles and content without restoring original read access',
  /* 调用 Store 的真实后台清理，分别核对句柄 TTL 和内容 TTL 到期后的持久状态。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    f.state.now = 110
    f.store.expire()
    assert.equal(f.handles(), 0)
    assert.throws(/* 后台删除的句柄不能被 read 自动重建。 */ () => f.access.read(meta.result_id), /result_not_found/)
    assert.equal(f.store.call('synthetic', f.call.call_id).response, null)
    assert.throws(/* 内容到期后不能凭仍持有的原 binding 重开结果。 */ () => f.access.open(f.call.call_id))
    assert.equal(f.handles(), 0)
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'result cursor and page budget stay bounded and never create another handle',
  /* 页大小和游标直接受现有 Store 字节规则约束，不能用无效参数扩大读取或触发重新执行。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    for (const [cursor, maxBytes] of [
      [-1, 1],
      [0.5, 1],
      [meta.bytes + 1, 1],
      [0, 0],
      [0, 65_537],
      [0, Infinity]
    ]) {
      assert.throws(
        /* 每个越界组合必须按 Store 的既有规则拒绝。 */ () => f.access.read(meta.result_id, cursor, maxBytes),
        /invalid_result_cursor/
      )
    }
    const end = f.access.read(meta.result_id, meta.bytes, 1)
    assert.equal(end.eof, true)
    assert.equal(end.data, '')
    assert.equal(end.next_cursor, meta.bytes)
    assert.equal(f.handles(), 1)
    assert.equal(f.native.state.sends, 1)
  }
)
