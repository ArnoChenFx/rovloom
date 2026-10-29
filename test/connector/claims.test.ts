/** 用真实 SQLite 和私有文件覆盖持久发送账本；不连接 native，也不提供生产认证。 */
import { createHash } from 'node:crypto'
import { boundedJson } from '../../src/wire/index.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DispatchClaims } from '../../src/connector/claims.js'
import { ConnectorCapacityError } from '../../src/connector/capacity.js'
import { ProviderAdapterError } from '../../src/connector/provider-error.js'
import type { AttemptBinding } from '../../src/wire/types.js'

/** 仅建立账本测试需要的合法绑定；不将这些合成身份当作原生来源。 */
function binding(call = 'call1'): AttemptBinding {
  return {
    machine_id: 'm1',
    recovery_generation: 'g1',
    connection_epoch: 'e1',
    call_id: call,
    attempt_id: 'attempt1',
    native_request_id: 'native1',
    provider_kind: 'luvus',
    binding_revision: 1,
    contract_ref: 'a'.repeat(64),
    target: { machine_id: 'm1', provider_id: 'p1', profile: 'session', session: 'synthetic' },
    registration: { deadline: 500 }
  }
}

/** 在非共享可写祖先下创建私有目录，返回显式时钟和首次/正常打开选项。 */
function setup() {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.luvus-claims-')
  )
  const path = join(root, 'claims.sqlite')
  const clock = { now: 100 }
  const options = {
    path,
    ledger_id: 'connector1',
    limits: { entries: 16, bytes: 262_144 },
    now: /* 提供隔离用例的可控时钟，不冒称生产时钟。 */ () => clock.now
  }
  return {
    root,
    path,
    clock,
    options,
    create: /* 仅首次显式创建测试账本。 */ () => new DispatchClaims({ ...options, mode: 'create' }),
    open: /* 正常重启必须打开同一份持久账本。 */ () => new DispatchClaims({ ...options, mode: 'open' }),
    close: /* 测试结束删除仅本用例拥有的私有文件。 */ () => rmSync(root, { recursive: true, force: true })
  }
}

/** 断言公开错误只有稳定码，不包含路径、绑定内容或底层 SQLite 信息。 */
function failure(code: string) {
  return /* 验证稳定异常类型、码与消息。 */ (error: unknown) => {
    assert(error instanceof ProviderAdapterError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    return true
  }
}

test(
  'dispatch claim survives reopen and cannot be renewed by changing epoch or provider',
  /** 真正关闭并重开 SQLite；读取独立连接确认固定期限与原绑定仍在。 */ () => {
    const f = setup()
    let claims = f.create()
    try {
      claims.claim(binding(), 1000)
      claims.close()
      claims = f.open()
      for (const change of [{}, { connection_epoch: 'e2' }, { target: { ...binding().target, provider_id: 'p2' } }]) {
        assert.throws(
          /* 相同 call/attempt 在任何新连接绑定下都拒绝。 */ () => claims.claim({ ...binding(), ...change }, 2000),
          failure('dispatch_already_claimed')
        )
      }
      const reader = new DatabaseSync(f.path, { readOnly: true })
      try {
        const row = reader.prepare('SELECT binding_digest,expires FROM luvus_dispatch_claims').get()!
        assert.deepEqual(
          Buffer.from(row.binding_digest as Uint8Array),
          createHash('sha256').update(boundedJson(binding())).digest()
        )
        assert.equal(reader.prepare('SELECT version FROM luvus_claim_meta').get()!.version, 2)
        assert.equal(reader.prepare('SELECT length(binding_digest) AS n FROM luvus_dispatch_claims').get()!.n, 32)
        assert.equal(row.expires, binding().registration.deadline)
      } finally {
        reader.close()
      }
    } finally {
      claims.close()
      f.close()
    }
  }
)

test(
  'normal open never recreates a missing ledger and creation never replaces one',
  /** 区分首次配置和正常启动；丢库或 ledger ID 错误都不重置唯一 fence。 */ () => {
    const f = setup()
    try {
      assert.throws(f.open, failure('claim_ledger_missing'))
      assert.equal(existsSync(f.path), false)
      const claims = f.create()
      assert.throws(f.create, failure('claim_ledger_exists'))
      assert.throws(f.open, failure('claim_storage_unavailable'))
      claims.close()
      assert.throws(
        /* 错误配置引用不能把旧库当作新的实例账本。 */ () =>
          new DispatchClaims({ ...f.options, ledger_id: 'other', mode: 'open' }),
        failure('claim_ledger_mismatch')
      )
      const reopened = f.open()
      reopened.close()
    } finally {
      f.close()
    }
  }
)

test(
  'untrusted residual lock and replaced database fail closed without deleting foreign files',
  /** 模拟崩溃遗留锁，再检查打开期间实际 inode 替换。 */ () => {
    const f = setup()
    const claims = f.create()
    claims.close()
    try {
      writeFileSync(f.path + '.lock', 'controlled crash marker', { mode: 0o600, flag: 'wx' })
      assert.throws(f.open, failure('claim_storage_unavailable'))
      assert(existsSync(f.path + '.lock'))
      // 仅测试所有者显式移除自己构造的锁；生产没有自动恢复路径。
      rmSync(f.path + '.lock')
      const active = f.open()
      try {
        renameSync(f.path, f.path + '.old')
        writeFileSync(f.path, '', { mode: 0o600, flag: 'wx' })
        assert.throws(
          /* 活跃连接不能继续写被替换的旧 inode。 */ () => active.claim(binding(), 1000),
          failure('claim_ledger_identity_changed')
        )
        renameSync(f.path + '.lock', f.path + '.lock.old')
        writeFileSync(f.path + '.lock', 'foreign', { mode: 0o600, flag: 'wx' })
      } finally {
        active.close()
      }
      assert(existsSync(f.path + '.lock'))
    } finally {
      f.close()
    }
  }
)

test(
  'fixed deadlines, persistent clock rollback and capacity all block new claims',
  /** 拒绝过短墓碑和过期请求；容量失败后保留既有 claim 且正常事务仍可继续。 */ () => {
    const f = setup()
    f.options.limits.entries = 1
    let claims = f.create()
    try {
      assert.throws(
        /* 墓碑不能在原派发 deadline 前消失。 */ () => claims.claim(binding(), 499),
        failure('claim_deadline_invalid')
      )
      claims.claim(binding(), 1000)
      const early = binding('call2')
      early.registration.deadline = 400
      assert.throws(
        /* 被拒候选不会持久化，不能把它较早的 deadline 当作可回收时间。 */ () => claims.claim(early, 1000),
        (error: unknown) => {
          assert(error instanceof ConnectorCapacityError)
          assert.deepEqual(error.capacity, { resource: 'claim_entries', reclaim_at: 500 })
          return true
        }
      )
      claims.close()
      claims = f.open()
      f.clock.now = 99
      assert.throws(
        /* 跨重启保留时钟高水位。 */ () => claims.claim(binding('call2'), 1000),
        failure('claim_deadline_invalid')
      )
      f.clock.now = 1100
      assert.throws(
        /* 请求 deadline 已过，不能因墓碑 TTL 到期重新发送。 */ () => claims.claim(binding(), 2000),
        failure('claim_deadline_invalid')
      )
      const next = binding('call2')
      next.registration.deadline = 1500
      claims.claim(next, 2000)
    } finally {
      claims.close()
      f.close()
    }
  }
)

test(
  'SQLite byte exhaustion cannot publish a claim or exceed the allocated file budget',
  /** 真正写满小配额库，确认失败的 attempt 没有提交，先前墓碑仍保留。 */ () => {
    const f = setup()
    f.options.limits.entries = 4096
    const claims = f.create()
    let accepted = 0
    try {
      for (let index = 0; index < 4096; index++) {
        try {
          claims.claim(binding('call' + index.toString().padStart(124, '0')), 1000)
          accepted++
        } catch (error) {
          assert(error instanceof ProviderAdapterError)
          assert(['claim_capacity', 'claim_storage_unavailable'].includes(error.code))
          break
        }
      }
      assert(accepted > 1 && accepted < 4096)
      assert(lstatSync(f.path).size <= f.options.limits.bytes)
      const reader = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(reader.prepare('SELECT count(*) AS n FROM luvus_dispatch_claims').get()!.n, accepted)
      } finally {
        reader.close()
      }
    } finally {
      claims.close()
      f.close()
    }
  }
)

test(
  'opening with a smaller quota cannot silently keep a larger SQLite page allocation',
  /** 先生成真实较大库，再以较小配额打开；拒绝发生在任何下一次清理/插入之前。 */ () => {
    const f = setup()
    f.options.limits.entries = 4096
    f.options.limits.bytes = 1_048_576
    try {
      const claims = f.create()
      try {
        claims.claim(binding('call0'), 1000)
      } finally {
        claims.close()
      }
      // 本例检验重开配额，不重复做数百次同步派发；同一真实库批量准备合法墓碑与较大页分配。
      const writer = new DatabaseSync(f.path)
      try {
        writer.exec('BEGIN IMMEDIATE')
        const insert = writer.prepare('INSERT INTO luvus_dispatch_claims VALUES(?,?,?,?)')
        const pageSize = Number(writer.prepare('PRAGMA page_size').get()!.page_size)
        for (
          let index = 1;
          Number(writer.prepare('PRAGMA page_count').get()!.page_count) * pageSize <= 131_072;
          index++
        ) {
          assert(index < f.options.limits.entries)
          const next = binding('call' + index)
          insert.run(next.call_id, next.attempt_id, createHash('sha256').update(boundedJson(next)).digest(), 1000)
        }
        writer.exec('COMMIT')
      } finally {
        writer.close()
      }
      const bytes = lstatSync(f.path).size
      assert(bytes > 131_072)
      f.options.limits.bytes = 262_144
      assert(bytes < f.options.limits.bytes)
      assert.throws(f.open, failure('claim_capacity'))
      assert.equal(lstatSync(f.path).size, bytes)
      assert.equal(existsSync(f.path + '-journal'), false)
      f.options.limits.bytes = 1_048_576
      const original = f.open()
      try {
        assert.throws(
          /* 原 claim 保留，不因失败的配额变更而重建库。 */ () => original.claim(binding('call0'), 1000),
          failure('dispatch_already_claimed')
        )
      } finally {
        original.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  'opening checks combined database and journal bytes before SQLite recovery',
  /** 两个文件单独都未超配额，合计超限仍须在 SQLite 触碰 journal 前拒绝。 */ () => {
    const f = setup()
    const claims = f.create()
    claims.close()
    try {
      const journal = f.path + '-journal'
      writeFileSync(journal, Buffer.alloc(250_000), { flag: 'wx', mode: 0o600 })
      assert(lstatSync(f.path).size + lstatSync(journal).size > f.options.limits.bytes)
      assert.throws(f.open, failure('claim_capacity'))
      assert.equal(lstatSync(journal).size, 250_000)
    } finally {
      f.close()
    }
  }
)

test(
  'invalid claim configuration always has a safe adapter error',
  /** 不读取文件、不把 TypeError/WireError 当作公开配置错误格式。 */ () => {
    for (const options of [undefined, {}, { ledger_id: 'bad.id' }, { ledger_id: 'valid', limits: null }]) {
      assert.throws(
        /* 非法受保护配置也应稳定失败，不落入隐式默认配置。 */ () => new DispatchClaims(options as never),
        failure('claim_config_invalid')
      )
    }
  }
)

test(
  'dangling journal links are rejected before SQLite can open or recover them',
  /** lstat 必须看到断链；不能用 exists 跳过后让 SQLite 创建链接目标。 */ () => {
    const f = setup()
    const claims = f.create()
    claims.close()
    const destination = join(f.root, 'must-not-exist')
    try {
      symlinkSync(destination, f.path + '-journal')
      assert.throws(f.open, failure('claim_storage_unavailable'))
      assert.equal(existsSync(destination), false)
    } finally {
      f.close()
    }
  }
)

test(
  'unexpected schema cannot be accepted as a dispatch ledger',
  /** 额外表和schema仍不能成为合法账本，不以本地权限作为schema证据。 */ () => {
    const f = setup()
    const claims = f.create()
    try {
      claims.close()
      const writer = new DatabaseSync(f.path)
      try {
        writer.exec('CREATE TABLE foreign_table(value TEXT)')
      } finally {
        writer.close()
      }
      assert.throws(f.open, failure('claim_ledger_invalid'))
    } finally {
      claims.close()
      f.close()
    }
  }
)

test(
  'production claim quota is reusable beyond 1024 calls without reopening an expired attempt',
  { timeout: 30_000 },
  /** 两轮各 1024 个真实持久 claim；只在固定 deadline 后回收，重启仍保留删除时的时钟屏障。 */ () => {
    const f = setup()
    f.options.limits.entries = 1024
    f.options.limits.bytes = 4_194_304
    let claims = f.create()
    try {
      for (let wave = 0; wave < 2; wave++) {
        f.clock.now = 100 + wave * 500
        for (let index = 0; index < 1024; index++) {
          const next = binding('wave' + wave + 'call' + index)
          next.registration.deadline = 500 + wave * 500
          claims.claim(next, f.clock.now + 30 * 86_400_000)
        }
        const extra = binding('extra')
        extra.registration.deadline = 500 + wave * 500
        assert.throws(
          /* 尚未到期的真实满额不能提前回收或放行。 */ () => claims.claim(extra, 3_000_000_000),
          (error: unknown) => {
            assert(error instanceof ConnectorCapacityError)
            assert.deepEqual(error.capacity, { resource: 'claim_entries', reclaim_at: 500 + wave * 500 })
            return true
          }
        )
        claims.close()
        claims = f.open()
      }
      f.clock.now = 600
      assert.throws(
        /* 回收后重开也拒绝原完整意图。 */ () => claims.claim(binding('wave0call0'), 3_000_000_000),
        failure('claim_deadline_invalid')
      )
      f.clock.now = 499
      const fresh = binding('fresh')
      fresh.registration.deadline = 900
      assert.throws(
        /* 即使新请求未到期，跨重启回拨到回收前仍被持久时钟拒绝。 */ () => claims.claim(fresh, 1000),
        failure('claim_deadline_invalid')
      )
      const reader = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(reader.prepare('SELECT count(*) AS n FROM luvus_dispatch_claims').get()!.n, 1024)
        assert.equal(reader.prepare('SELECT min(expires) AS n FROM luvus_dispatch_claims').get()!.n, 1000)
        assert.equal(reader.prepare('SELECT clock FROM luvus_claim_meta').get()!.clock, 600)
      } finally {
        reader.close()
      }
      assert(lstatSync(f.path).size < f.options.limits.bytes)
    } finally {
      claims.close()
      f.close()
    }
  }
)

test(
  'schema v1 is rejected without converting or deleting its live tombstones',
  /** 不提供升级路径；版本变更不能静默忘掉任何旧库中的未到期意图。 */ () => {
    const f = setup()
    const claims = f.create()
    claims.close()
    const writer = new DatabaseSync(f.path)
    try {
      writer.exec(
        'DROP TABLE luvus_dispatch_claims; CREATE TABLE luvus_dispatch_claims(call_id TEXT NOT NULL, attempt_id TEXT NOT NULL, binding TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(call_id,attempt_id)); UPDATE luvus_claim_meta SET version=1'
      )
      writer
        .prepare('INSERT INTO luvus_dispatch_claims VALUES(?,?,?,?)')
        .run('call1', 'attempt1', boundedJson(binding()), 30 * 86_400_000)
    } finally {
      writer.close()
    }
    try {
      assert.throws(f.open, failure('claim_ledger_invalid'))
      const reader = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(reader.prepare('SELECT binding FROM luvus_dispatch_claims').get()!.binding, boundedJson(binding()))
        assert.equal(reader.prepare('SELECT version FROM luvus_claim_meta').get()!.version, 1)
      } finally {
        reader.close()
      }
    } finally {
      f.close()
    }
  }
)
