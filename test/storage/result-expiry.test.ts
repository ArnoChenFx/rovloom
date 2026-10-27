// 用隔离磁盘 SQLite 验证结果页报告实际句柄期限，且读取、撤权和交错清理不会重建或续期句柄。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/store.js'
import type { ResultPage } from '../../src/store.js'
import { Router } from '../../src/router.js'
import { connected, management, options, policy, respond } from './helpers.js'

// 创建已持久化响应与结果句柄，使用短 result_ttl 和独立检查连接观察句柄期限。
function fixture(resultTtl = 10) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-result-expiry-'))
  const path = join(root, 'state.sqlite')
  const clock = { now: 100 }
  const store = new Store(path, /* 精确推进有效区间和截止边界，避免真实等待带来的测试漂移。 */ () => clock.now, {
    management,
    maintenanceIntervalMs: 60_000,
    retention: { result_ttl: resultTtl }
  })
  const device = connected(store)
  const state = { local: policy(device.target, true) }
  const router = new Router(store)
  const principal = { id: 'alice', policy: policy(device.target) }
  const call = router.create(principal, device.target, { method: 'pane.read' }, options())
  const binding = router.dispatch(principal, call.call_id, device.epoch)
  respond(store, binding, { result: { text: '你好abc'.repeat(30) } }, clock.now)
  const handle = store.saveResult(principal.id, call.call_id)
  const inspect = new DatabaseSync(path, { readOnly: true })
  return {
    path,
    clock,
    store,
    device,
    state,
    router,
    principal,
    call,
    handle,
    inspect,
    // 读取实际持久化句柄，观察分页是否意外修改 ID、期限、摘要或计量。
    resultRow() {
      return inspect.prepare('SELECT * FROM results WHERE result_id=?').get(handle.result_id)
    },
    // 统计真实句柄签发审计；只读分页不能通过重签发增加该记录。
    handleAudits() {
      return inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='result_handle'").get()!.n
    },
    // 关闭独立检查连接和 Store，删除仅属于本测试的数据库目录。
    close() {
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  '每页返回实际句柄 expires，多页、重复及 EOF 读取不续期或新建句柄',
  // 句柄与内容同在 110 到期；逐字节重组原响应并核对固定的持久化元数据。
  () => {
    const f = fixture()
    try {
      assert.equal(f.handle.expires, 110)
      assert.equal(f.store.call('alice', f.call.call_id).content_expires, 110)
      const before = f.resultRow()
      const audits = f.handleAudits()
      const parts: Buffer[] = []
      let cursor = 0
      f.clock.now = 105
      while (true) {
        const page: ResultPage = f.router.readResult(f.principal, f.handle.result_id, cursor, 7)
        assert.equal(page.expires, f.handle.expires)
        assert.equal(page.bytes, f.handle.bytes)
        assert.equal(page.hash, f.handle.hash)
        parts.push(Buffer.from(page.data, page.encoding))
        cursor = page.next_cursor
        if (page.eof) {
          break
        }
      }
      assert.equal(Buffer.concat(parts).toString(), f.store.call('alice', f.call.call_id).response)
      f.clock.now = 109
      const end: ResultPage = f.store.readResult('alice', f.handle.result_id, f.handle.bytes, 1)
      assert.equal(end.expires, 110)
      assert.equal(end.eof, true)
      assert.equal(end.data, '')
      assert.equal(f.router.readResult(f.principal, f.handle.result_id).expires, 110)
      assert.deepEqual(f.resultRow(), before)
      assert.equal(f.handleAudits(), audits)
      assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM results').get()!.n, 1)
    } finally {
      f.close()
    }
  }
)

test(
  '句柄到期前一毫秒可读，等于实际 expires 时拒绝且不重建句柄',
  // 不运行清理也必须拒绝到期句柄；数据库中的过期行和签发审计保持不变。
  () => {
    const f = fixture()
    try {
      const before = f.resultRow()
      f.clock.now = 109
      assert.equal(f.store.readResult('alice', f.handle.result_id).expires, 110)
      f.clock.now = 110
      assert.throws(
        /* 截止时间采用开区间，now 等于 expires 就不能继续读取。 */ () =>
          f.store.readResult('alice', f.handle.result_id),
        /result_not_found/
      )
      assert.equal(f.store.call('alice', f.call.call_id).response, null)
      assert.deepEqual(f.resultRow(), before)
      assert.equal(f.handleAudits(), 1)
      f.store.expire()
      assert.equal(f.resultRow(), undefined)
      assert.throws(
        /* 已被真实维护删除的句柄也不能通过读取隐式重新签发。 */ () => f.store.readResult('alice', f.handle.result_id),
        /result_not_found/
      )
      assert.equal(f.handleAudits(), 1)
    } finally {
      f.close()
    }
  }
)

for (const action of ['discard', 'revoke', 'provider_disabled'] as const) {
  test(
    `${action} 提前失效已有句柄，先前报告的 expires 不赋予后续读取权`,
    // 在时间仍早于 110 时改变真实 Store 状态，保留既有结果读取门禁的拒绝语义。
    () => {
      const f = fixture()
      try {
        assert.equal(f.router.readResult(f.principal, f.handle.result_id).expires, 110)
        f.clock.now = 105
        if (action === 'discard') {
          f.store.discardResponse('alice', f.call.call_id)
        } else if (action === 'revoke') {
          f.store.revoke(f.device.machine_id)
        } else {
          f.store.setProviderEnabled(f.device.machine_id, f.device.target.provider_id, 1, false)
        }
        assert.throws(
          /* 通过原 Router 入口重新读取，不能把页中期限当作绕过当前授权或可见性的租约。 */ () =>
            f.router.readResult(f.principal, f.handle.result_id),
          action === 'provider_disabled' ? /provider_disabled/ : /result_not_found/
        )
        assert.equal(f.handleAudits(), 1)
      } finally {
        f.close()
      }
    }
  )
}

for (const side of ['device_scope'] as const) {
  test(
    `${side} 撤回读取授权后不返回含 expires 的结果页，其他 principal 也不能探测元数据`,
    // Router 仍逐次核验双端策略，新增字段不能成为独立的未授权 metadata 读取路径。
    () => {
      const f = fixture()
      try {
        const before = f.resultRow()
        assert.equal(f.router.readResult(f.principal, f.handle.result_id).expires, 110)
        assert.throws(
          /* 外部主体不能读取结果正文或期限。 */ () =>
            f.router.readResult({ ...f.principal, id: 'other' }, f.handle.result_id),
          /call_not_found/
        )
        const principal = { ...f.principal, device_scope: { mode: 'selected' as const, machine_ids: [] } }
        assert.throws(
          /* 先前已经读过的句柄也必须经过本次双端授权。 */ () => f.router.readResult(principal, f.handle.result_id),
          /forbidden/
        )
        assert.deepEqual(f.resultRow(), before)
        assert.equal(f.handleAudits(), 1)
      } finally {
        f.close()
      }
    }
  )
}

test(
  '第二 SQLite 连接在归属检查后提交句柄清理，读取返回 result_not_found 而非解引用缺行',
  // 用受控交错复现两个实际查询之间的提交；归属检查、正文和数据库均使用真实实现。
  () => {
    const f = fixture()
    const original = f.store.resultCall.bind(f.store)
    let checked = false
    f.store.resultCall = /* 保留原归属和内容门禁，仅在其返回后让独立连接提交清理。 */ (principal, resultId) => {
      const call = original(principal, resultId)
      checked = true
      const cleanup = new DatabaseSync(f.path)
      try {
        cleanup.exec('BEGIN IMMEDIATE')
        cleanup.prepare('DELETE FROM results WHERE result_id=?').run(resultId)
        cleanup.exec('COMMIT')
      } finally {
        cleanup.close()
      }
      return call
    }
    try {
      assert.throws(
        /* 实际句柄在第二次查询前已经消失，必须按既有固定错误拒绝。 */ () =>
          f.store.readResult('alice', f.handle.result_id),
        /result_not_found/
      )
      assert.equal(checked, true)
      assert.equal(f.resultRow(), undefined)
      assert(f.store.call('alice', f.call.call_id).response)
      assert.equal(f.handleAudits(), 1)
    } finally {
      f.close()
    }
  }
)

test(
  '归属检查后可信时间跨过句柄 expires，分页元数据查询再次核对实际期限',
  // 句柄行未被清理；不能只复用先前成功检查时取得的正文快照。
  () => {
    const f = fixture()
    const original = f.store.resultCall.bind(f.store)
    f.store.resultCall = /* 在真实归属检查完成后推进时钟，精确触发第二次查询的到期边界。 */ (principal, resultId) => {
      const call = original(principal, resultId)
      f.clock.now = f.handle.expires
      return call
    }
    try {
      assert.throws(
        /* now 等于句柄截止时间时不能返回旧正文及 expires 页。 */ () => f.store.readResult('alice', f.handle.result_id),
        /result_not_found/
      )
      assert.equal(f.resultRow()!.expires, 110)
      assert.equal(f.store.call('alice', f.call.call_id).response, null)
      assert.equal(f.handleAudits(), 1)
    } finally {
      f.close()
    }
  }
)
