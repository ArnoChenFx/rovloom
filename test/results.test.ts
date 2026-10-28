// 验证 v5 结果句柄的授权和字节分页，以及未发布旧数据库被无损拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'
import { connected, management, options, respond } from './storage/helpers.js'

test(
  'results enforce ownership, quota, TTL and byte-perfect pagination',
  /* 在真实 provider 调用上验证结果归属、配额、原始 TTL 与跨 UTF-8 字节分页。 */ () => {
    let now = 100
    const s = new Store(':memory:', /* 注入可推进时钟，精确触发结果句柄到期。 */ () => now, {
      management,
      retention: { result_ttl: 50 }
    })
    try {
      const d = connected(s)
      const router = new Router(s)
      const p: import('../src/router.js').Principal = { id: 'alice' }
      const c = router.create(p, d.target, { method: 'pane.read' }, options())
      assert.throws(
        /* 对尚未收到响应的调用申请句柄，要求拒绝。 */ () => router.saveResult(p, c.call_id),
        /result_not_ready/
      )
      const binding = router.dispatch(p, c.call_id, d.epoch)
      respond(s, binding, { result: { text: '你好'.repeat(100) } }, now)
      assert.throws(
        /* 用不足以容纳响应的配额保存句柄，要求拒绝。 */ () => s.saveResult(p.id, c.call_id, 1),
        /result_quota/
      )
      const meta = s.saveResult(p.id, c.call_id)
      const chunks: Buffer[] = []
      let cursor = 0
      while (true) {
        const page = router.readResult(p, meta.result_id, cursor, 7)
        chunks.push(Buffer.from(page.data, 'base64'))
        cursor = page.next_cursor
        if (page.eof) {
          break
        }
      }
      assert.equal(JSON.parse(Buffer.concat(chunks).toString()).result.text, '你好'.repeat(100))
      assert.throws(
        /* 使用其他主体读取句柄，要求隐藏所属调用。 */ () => router.readResult({ ...p, id: 'bob' }, meta.result_id),
        /call_not_found/
      )
      assert.throws(
        /* 传入负字节游标，要求分页边界校验拒绝。 */ () => router.readResult(p, meta.result_id, -1),
        /invalid_result_cursor/
      )
      p.device_scope = { mode: 'selected', machine_ids: [] }
      assert.throws(
        /* 撤销本地授权后读取已有结果，要求重新授权失败。 */ () => router.readResult(p, meta.result_id),
        /forbidden/
      )
      delete p.device_scope
      now = 200
      assert.throws(
        /* 推进到句柄到期时刻后读取，要求句柄不存在。 */ () => router.readResult(p, meta.result_id),
        /result_not_found/
      )
      assert.throws(
        /* 内容与句柄同期限，到期后不能为已过期内容重新签发句柄。 */ () => router.saveResult(p, c.call_id),
        /result_not_ready/
      )
    } finally {
      s.close()
    }
  }
)
test(
  'unreleased v1 v2 v3 schemas are rejected without migration or source mutation',
  /* 逐一打开未发布的 v1/v2/v3 数据库，验证拒绝迁移且原文件字节不变。 */ () => {
    for (const version of [1, 2, 3]) {
      const dir = mkdtempSync(join(tmpdir(), 'rovloom-legacy-'))
      const path = join(dir, 'db')
      try {
        const db = new DatabaseSync(path)
        db.exec(
          `CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(${version}); CREATE TABLE calls(response TEXT); INSERT INTO calls VALUES('synthetic-secret')`
        )
        db.close()
        chmodSync(path, 0o600)
        const before = readFileSync(path)
        assert.throws(
          /* 尝试打开不受支持的旧 schema，要求在写入或迁移前拒绝。 */ () => new Store(path),
          /unsupported_database_version/
        )
        assert.deepEqual(readFileSync(path), before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
)
