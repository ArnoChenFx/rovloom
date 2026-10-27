// 验证 v5 句柄去重、删除授权和原文保留期限，确保重开数据库不延长内容寿命。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'
import { connected, management, options, respond } from './storage/helpers.js'

test(
  'deduplicated handles retain expiry; aggregate quota reclaims expired payloads; cursor boundaries',
  /* 验证句柄去重不续期、过期句柄可回收，以及分页游标和页长必须有效。 */ () => {
    let now = 100
    const s = new Store(':memory:', /* 控制结果有效期边界，避免测试依赖真实等待。 */ () => now, {
      management,
      retention: { result_ttl: 10 }
    })
    try {
      const d = connected(s)
      const first = s.createCall('alice', d.target, { method: 'pane.read' }, options())
      const second = s.createCall('alice', d.target, { method: 'pane.read' }, options())
      respond(s, s.dispatch('alice', first.call_id, d.epoch), { result: { text: 'abc' } }, now)
      respond(s, s.dispatch('alice', second.call_id, d.epoch), { result: { text: 'abc' } }, now)
      const a = s.saveResult('alice', first.call_id)
      now = 101
      assert.deepEqual(s.saveResult('alice', first.call_id), a)
      assert.throws(
        /* 已有句柄占满指定总配额时保存第二个响应，要求拒绝。 */ () => s.saveResult('alice', second.call_id, a.bytes),
        /result_quota/
      )
      assert.equal(s.readResult('alice', a.result_id, a.bytes, 1).data, '')
      for (const cursor of [a.bytes + 1, -1, 0.5, NaN, Infinity]) {
        assert.throws(
          /* 逐一传入越界、负数或非整数游标，要求拒绝。 */ () => s.readResult('alice', a.result_id, cursor),
          /invalid_result_cursor/
        )
      }
      for (const limit of [0, -1, 65_537, 0.5, NaN]) {
        assert.throws(
          /* 逐一传入零、超限或非整数页长，要求拒绝。 */ () => s.readResult('alice', a.result_id, 0, limit),
          /invalid_result_cursor/
        )
      }
      now = 105
      const b = s.saveResult('alice', second.call_id)
      assert(b.bytes > 0)
      assert.equal(b.expires, 110)
      now = 110
      assert.throws(
        /* 句柄与内容同期限，到期后句柄不可读且不能为过期内容重新签发。 */ () => s.readResult('alice', a.result_id),
        /result_not_found/
      )
      assert.throws(() => s.saveResult('alice', first.call_id), /result_not_ready/)
    } finally {
      s.close()
    }
  }
)
test(
  'discard is reauthorized, removes inline response and handles, preserves deduplication tombstone',
  /* 验证删除需独立权限且重新授权，清除原文与句柄后仍保留 history 幂等墓碑。 */ () => {
    const s = new Store(':memory:', /* 固定存储时间，使本例只测试删除规则而非计时差异。 */ () => 100, { management })
    try {
      const d = connected(s)
      const o = options({
        client_request_key: 'retained-key'
      })
      const c = s.createCall('alice', d.target, { method: 'pane.read' }, o)
      respond(s, s.dispatch('alice', c.call_id, d.epoch), { result: { text: 'abc' } }, 100)
      const meta = s.saveResult('alice', c.call_id)
      const p: import('../src/router.js').Principal = { id: 'alice' }
      const router = new Router(s)
      assert.throws(
        /* 用其他主体删除响应，要求隐藏调用并拒绝。 */ () => router.discardResponse({ ...p, id: 'other' }, c.call_id),
        /call_not_found/
      )
      p.device_scope = { mode: 'selected', machine_ids: [] }
      assert.throws(
        /* 撤销本地读取授权后删除响应，要求重新授权失败。 */ () => router.discardResponse(p, c.call_id),
        /forbidden/
      )
      delete p.device_scope
      assert(s.call('alice', c.call_id).response)
      const manager = { ...p, permissions: { discard_response: true } }
      router.discardResponse(manager, c.call_id)
      assert.equal(s.call('alice', c.call_id).response, null)
      assert.equal(s.call('alice', c.call_id).state, 'responded')
      assert.equal(s.createCall('alice', d.target, { method: 'pane.read' }, o).call_id, c.call_id)
      assert.throws(
        /* 读取已删除响应对应的句柄，要求判为不存在。 */ () => router.readResult(p, meta.result_id),
        /result_not_found/
      )
      assert.throws(
        /* 尝试为已删除的原文再次保存句柄，要求拒绝。 */ () => router.saveResult(p, c.call_id),
        /result_not_ready/
      )
      assert.throws(
        /* 对已完成调用再次派发，要求状态栅栏阻止重放。 */ () => s.dispatch('alice', c.call_id, 'old'),
        /dispatch_rejected/
      )
      router.discardResponse(manager, c.call_id)
    } finally {
      s.close()
    }
  }
)
test(
  'canonical schema results survive reopen only until their original content deadline',
  /* 重开规范 schema 数据库，验证句柄仍受最初的原文截止时间约束。 */ () => {
    let now = 100
    const dir = mkdtempSync(join(tmpdir(), 'rovloom-ttl-'))
    const path = join(dir, 'db')
    let s = new Store(path, /* 注入初始可控时钟，将原文截止时间固定为创建后二十毫秒。 */ () => now, {
      management,
      retention: { result_ttl: 20 }
    })
    try {
      const d = connected(s)
      const c = s.createCall('alice', d.target, { method: 'ping' }, options())
      respond(s, s.dispatch('alice', c.call_id, d.epoch), { result: { text: 'abc' } }, now)
      const meta = s.saveResult('alice', c.call_id)
      assert.equal(meta.expires, 120)
      s.close()
      s = new Store(path, /* 为重开实例继续使用同一时钟，验证重启不会续期。 */ () => now, { management })
      assert.equal(s.readResult('alice', meta.result_id).hash, meta.hash)
      assert.equal(s.machine(d.machine_id).status, 'offline')
      now = 120
      s.expire()
      assert.throws(
        /* 清理原文到期记录后读取旧句柄，要求拒绝。 */ () => s.readResult('alice', meta.result_id),
        /result_not_found/
      )
      assert.equal(s.call('alice', c.call_id).response, null)
      assert.throws(
        /* 原文到期已被清除后申请新句柄，要求拒绝重新保留内容。 */ () => s.saveResult('alice', c.call_id),
        /result_not_ready/
      )
    } finally {
      s.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
