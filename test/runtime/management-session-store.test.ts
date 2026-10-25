// 会话绑定落盘的解析与写入边界：只存摘要、损坏文件 fail closed 且不阻塞后续持久化。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createManagementSessionPersistence,
  MANAGEMENT_SESSIONS_MAX,
  MANAGEMENT_SESSIONS_MAX_BYTES,
  type PersistedManagementSession
} from '../../src/runtime/management-session-store.js'
import { readSetupJson, writeSetupJson } from '../../src/cli/setup-files.js'

const digest = (seed: string) => seed.repeat(64).slice(0, 64)
const other = (seed: string) => seed.repeat(64).slice(0, 64)

/** 构造一条只含摘要的合法绑定；原 cookie/CSRF 从不落盘。 */
function row(cookie: string, csrf: string, expires = 601_000): PersistedManagementSession {
  return {
    principal_id: 'admin',
    session_ref: 'session',
    issued_at: 1000,
    expires_at: expires,
    cookie_sha256: cookie,
    csrf_sha256: csrf,
    policy: 'policy',
    upstream: {
      caller: { principal_id: 'admin' },
      management_session_ref: 'session',
      issued_at: 1000,
      expires_at: expires
    }
  }
}

test(
  '损坏或结构不符的会话文件返回空集，不阻塞启动',
  /** 整份文档不可解析时 fail closed；单条非法只丢弃该条。 */ () => {
    const persistence = createManagementSessionPersistence({
      now: /** 固定可信时钟，避免用例依赖真实时间。 */ () => 1000,
      read: () => ({ schema_version: 1, sessions: [{ nope: true }, row(digest('a'), other('b'))] }),
      write: /** 本用例不写盘。 */ () => {}
    })
    // 单条非法只丢弃该条，合法条目仍然恢复。
    assert.equal(persistence.load().length, 1)
    for (const broken of [undefined, null, 'text', {}, { schema_version: 2, sessions: [] }]) {
      const store = createManagementSessionPersistence({
        now: () => 1000,
        read: () => broken,
        write: () => {}
      })
      assert.deepEqual(store.load(), broken === undefined ? [] : [])
    }
  }
)

test(
  '同一租期可落盘多条绑定：重启前多个浏览器各持有一条',
  /** 只按 cookie 摘要去重，不把同一 (principal, session_ref) 的其它浏览器误判成重复。 */ () => {
    const persistence = createManagementSessionPersistence({
      now: /** 固定可信时钟。 */ () => 1000,
      read: () => ({ schema_version: 1, sessions: [row(digest('a'), other('b')), row(digest('c'), other('d'))] }),
      write: /** 本用例不写盘。 */ () => {}
    })
    const rows = persistence.load()
    assert.equal(rows.length, 2)
    assert.deepEqual(
      rows.map((entry) => entry.cookie_sha256),
      [digest('a'), digest('c')]
    )
  }
)

test(
  '损坏文件不会永久阻止后续持久化，重新登录后可再次落盘',
  /** 写入前只判断文件是否存在，不用解析结果决定是否覆盖；否则损坏文件会让每次重启都掉线。 */ () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-session-store-'))
    const path = join(root, 'management-sessions.json')
    try {
      // 模拟被截断/写坏的旧文件。
      writeFileSync(path, '{ not json', { mode: 0o600 })
      const persistence = createManagementSessionPersistence({
        now: /** 固定可信时钟。 */ () => 1000,
        read: () => readSetupJson(path),
        write: (value) => writeSetupJson(path, value, existsSync(path))
      })
      // 损坏文件不提供可恢复会话，但也不抛出。
      assert.deepEqual(persistence.load(), [])
      // 用户重新登录：新绑定必须能覆盖损坏文件，而不是被永久挡住。
      persistence.save([row(digest('e'), other('f'))])
      const restored = persistence.load()
      assert.equal(restored.length, 1)
      assert.equal(restored[0]!.cookie_sha256, digest('e'))
      // 再次覆盖同一文件仍然成功（代次比较使用的是可解析的当前内容）。
      persistence.save([row(digest('1'), other('2'))])
      assert.equal(persistence.load()[0]!.cookie_sha256, digest('1'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '多管理员多轮交付超过 16 KiB 时仍完整落盘并可全部恢复',
  /** 16 个管理员各 3 条绑定约 30 KiB；若沿用默认 16 KiB 预算，写入会被静默吞掉，重启只恢复一部分。 */ () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-session-budget-'))
    const path = join(root, 'management-sessions.json')
    try {
      // 每条绑定使用互不相同的合法小写十六进制摘要；直接用索引生成，避免种子周期造成重复。
      const hex = (value: number, offset: number) => (value * 4 + offset).toString(16).padStart(64, '0').slice(-64)
      const rows: PersistedManagementSession[] = []
      for (let admin = 0; admin < 16; admin++) {
        for (let round = 0; round < 3; round++) {
          const index = admin * 3 + round
          rows.push({
            ...row(hex(index, 0), hex(index, 1)),
            principal_id: 'admin' + admin,
            session_ref: 'session' + admin,
            upstream: {
              caller: { principal_id: 'admin' + admin },
              management_session_ref: 'session' + admin,
              issued_at: 1000,
              expires_at: 601_000
            }
          })
        }
      }
      const persistence = createManagementSessionPersistence({
        now: /** 固定可信时钟。 */ () => 1000,
        read: () => readSetupJson(path, MANAGEMENT_SESSIONS_MAX_BYTES),
        write: (value) => writeSetupJson(path, value, existsSync(path), MANAGEMENT_SESSIONS_MAX_BYTES)
      })
      persistence.save(rows)
      // 真实文件确实超过了默认 16 KiB 预算，否则这个用例不会暴露问题。
      assert.ok(statSync(path).size > 16_384, `文件应超过 16 KiB，实际 ${statSync(path).size}`)
      const restored = persistence.load()
      assert.equal(restored.length, 48, '全部 48 条绑定都能恢复')
      assert.equal(new Set(restored.map((entry) => entry.cookie_sha256)).size, 48)
      // 默认预算下同一文件读不出来，正是被复审发现的失败模式。
      assert.throws(/** 默认 16 KiB 读取无法容纳这份合法文件。 */ () => readSetupJson(path), {
        code: 'config_unreadable'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '落盘只保存摘要与租期，上限内截断',
  /** 序列化输出不得包含原 cookie/CSRF，也不得超过声明容量。 */ () => {
    let written: unknown
    const persistence = createManagementSessionPersistence({
      now: /** 固定可信时钟。 */ () => 1000,
      max_sessions: 2,
      read: /** 本用例不读盘。 */ () => undefined,
      write: (value) => {
        written = value
      }
    })
    persistence.save([row(digest('a'), other('b')), row(digest('c'), other('d')), row(digest('e'), other('f'))])
    const document = written as { schema_version: number; sessions: unknown[] }
    assert.equal(document.schema_version, 1)
    assert.equal(document.sessions.length, 2)
    // 每条摘要字段都是 64 位十六进制；原值（base64url）从未进入文档。
    for (const entry of document.sessions as Record<string, unknown>[]) {
      assert.match(entry.cookie_sha256 as string, /^[a-f0-9]{64}$/)
      assert.match(entry.csrf_sha256 as string, /^[a-f0-9]{64}$/)
    }
    assert.equal(MANAGEMENT_SESSIONS_MAX, 1024)
  }
)
