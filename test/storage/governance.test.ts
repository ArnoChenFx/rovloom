// 验证 SQLite 的历史去重、保留配额、路径安全与事务失败治理边界。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GATEWAY_LOCK_FORMAT, Store } from '../../src/store.js'
import { currentProcessIdentity } from '../../src/storage/process-identity.js'
import { Router } from '../../src/router.js'
import { management, connected, options, respond, responseFrame, evidenceContext } from './helpers.js'
import { planResponseEvidence } from '../../src/wire/index.js'
import type { AttemptBinding } from '../../src/wire/types.js'

/* 在私有磁盘目录运行测试回调，并在成功或异常后删除整个临时目录。 */ function disk(
  run: (root: string, path: string) => void
) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-governance-'))
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  try {
    run(root, join(state, 'db'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test(
  'SQLite key window survives restart, ends with the tombstone, and clock rollback is untrusted',
  /* 验证 key 在窗口内跨重启仍命中原调用，墓碑清理后才可重新登记，时间回退触发降级。 */ () =>
    disk(
      /* 构造短元数据期限并跨重启和清理检查 key 语义，最后注入时钟回退。 */ (_root, path) => {
        let now = 100
        let s = new Store(path, /* 返回治理测试的当前时间，供用例推进清理期限并注入回拨。 */ () => now, {
          management,
          retention: { metadata_ttl: 100 }
        })
        try {
          const d = connected(s)
          const o = options({ client_request_key: 'same' })
          const c = s.createCall('alice', d.target, { method: 'ping' }, o)
          const b = s.dispatch('alice', c.call_id, d.epoch)
          s.stop('alice', c.call_id)
          assert.equal(s.createCall('alice', d.target, { method: 'ping' }, o).call_id, c.call_id)
          s.close()
          s = new Store(path, /* 重开实例沿用可控时间，验证持久 key 和旧连接不会随重启复活。 */ () => now, {
            management
          })
          assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown')
          assert.equal(s.createCall('alice', d.target, { method: 'ping' }, o).call_id, c.call_id)
          assert.throws(
            /* 提交重启前尝试的响应，检查重启清除在线连接后不能用原 epoch 补证。 */ () =>
              respond(s, b, { result: {} }, now),
            /stale_response/
          )
          now = 100 + s.limits.metadata_ttl
          s.expire()
          assert.throws(
            /* 窗口结束并清理后原行已删除，调用只能按未知处理。 */ () => s.call('alice', c.call_id),
            /call_not_found/
          )
          now = 110
          assert.throws(
            /* 把时钟调回已观察时间之前再登记，检查时钟不可信会触发降级。 */ () =>
              s.createCall('alice', d.target, { method: 'ping' }, options({ client_request_key: 'other' })),
            /clock_untrusted/
          )
          assert.equal(s.health().mode, 'storage_degraded')
        } finally {
          s.close()
        }
      }
    )
)
test(
  'SQLite content and request TTL is anchored at registration; late evidence and discard never revive payload',
  /* 验证请求和响应内容按登记时间到期，迟到证据及丢弃操作都不能复活载荷。 */ () =>
    disk(
      /* 推进可控时钟跨超时与内容到期，再提交迟到或已丢弃响应检查内容不回填且审计不含秘密。 */ (_root, path) => {
        let now = 100
        const s = new Store(path, /* 返回内容 TTL 测试的当前时间，供用例分阶段触发调用超时与原文到期。 */ () => now, {
          management,
          retention: { result_ttl: 10 }
        })
        try {
          const d = connected(s)
          const c = s.createCall(
            'alice',
            d.target,
            { method: 'ping', params: { fake_secret: 'synthetic-secret-ttl' } },
            options({ timeoutMs: 5 })
          )
          const b = s.dispatch('alice', c.call_id, d.epoch)
          now = 105
          s.expire()
          assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown')
          now = 110
          s.expire()
          const result = respond(s, b, { result: { text: 'synthetic-secret-response' } }, now)
          assert.equal(result.state, 'responded')
          assert.equal(result.response, null)
          assert.equal(result.content_status, 'expired')
          assert.throws(
            /* 尝试保存已过内容期限的响应，确认不能创建可读取的结果句柄。 */ () => s.saveResult('alice', c.call_id),
            /result_not_ready/
          )
          respond(s, b, { result: { text: 'synthetic-secret-response' } }, now)
          const other = s.createCall('alice', d.target, { method: 'ping' }, options())
          const b2 = s.dispatch('alice', other.call_id, d.epoch)
          s.discardResponse('alice', other.call_id)
          respond(s, b2, { result: { text: 'not-stored' } }, now)
          assert.equal(s.call('alice', other.call_id).response, null)
          const audit = JSON.stringify(s.auditRecords())
          for (const secret of ['synthetic-secret-ttl', 'synthetic-secret-response', 'not-stored']) {
            assert(!audit.includes(secret))
          }
        } finally {
          s.close()
        }
        const db = new DatabaseSync(path)
        assert.equal(
          db.prepare("SELECT request_json FROM calls WHERE content_status='expired'").get()!.request_json,
          null
        )
        db.close()
      }
    )
)
test(
  'SQLite late evidence is exactly bound, preserves timeout history, rejects conflict and never adds attempts',
  /* 验证迟到证据精确绑定尝试，保留超时历史并拒绝冲突及再次派发。 */ () =>
    disk(
      /* 让响应恰逢截止时间提交，再逐项篡改绑定并检查审计及派发次数保持正确。 */ (_root, path) => {
        let now = 100
        const s = new Store(path, /* 返回用例控制的时间，供验证恰逢调用截止边界的响应提交。 */ () => now, {
          management
        })
        try {
          const d = connected(s)
          const c = s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 5 }))
          const b = s.dispatch('alice', c.call_id, d.epoch)
          now = 105
          const result = respond(s, b, { result: { pong: true } }, now)
          assert.equal(result.state, 'responded')
          for (const field of [
            'machine_id',
            'recovery_generation',
            'connection_epoch',
            'call_id',
            'attempt_id',
            'native_request_id',
            'contract_ref'
          ] as const) {
            const wrong = { ...b, [field]: 'mismatch' }
            assert.throws(
              /* 篡改当前绑定维度后查询锚点，检查任何身份或契约不匹配都被拒绝。 */ () => s.responseAnchor(wrong)
            )
          }
          assert.throws(
            /* 用错误 provider 绑定版本查询锚点，检查版本围栏生效。 */ () =>
              s.responseAnchor({ ...b, binding_revision: 2 })
          )
          assert.throws(
            /* 把响应目标改为另一 provider，检查目标元组不匹配被拒绝。 */ () =>
              s.responseAnchor({ ...b, target: { ...b.target, provider_id: 'another' } })
          )
          respond(s, b, { result: { pong: true } }, now)
          assert.throws(
            /* 在相同绑定下提交不同结果，检查已提交响应不能被冲突证据改写。 */ () =>
              respond(s, b, { result: { pong: false } }, now),
            /response_evidence_conflict/
          )
          assert.throws(
            /* 尝试再次派发已获得响应的调用，检查不会增加执行尝试。 */ () => s.dispatch('alice', c.call_id, d.epoch),
            /dispatch_rejected/
          )
          const audit = s.auditRecords()
          assert.equal(
            audit.filter(/* 筛选派发审计，核对迟到响应处理没有引入重发。 */ (e) => e.action === 'dispatching').length,
            1
          )
          assert.equal(
            audit.filter(
              /* 筛选截止时间审计，核对迟到提交仍保留一次超时记录。 */ (e) => e.action === 'deadline_exceeded'
            ).length,
            1
          )
          assert.equal(
            audit.filter(/* 筛选迟到证据审计，核对重复提交不重复记账。 */ (e) => e.action === 'late_evidence').length,
            1
          )
        } finally {
          s.close()
        }
      }
    )
)
test(
  'SQLite provider revision and tuple policies isolate same-name IDs, keys and handles',
  /* 验证 provider 目标和版本隔离调用及结果句柄，禁用或撤销后旧权限不再有效。 */ () =>
    disk(
      /* 建立同机器的两个 provider，逐步禁用、改版和撤销设备以检查目标隔离。 */ (_root, path) => {
        const s = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, { management })
        try {
          const d = connected(s)
          s.defineProvider({
            machine_id: d.machine_id,
            provider_id: 'second',
            kind: 'luvus',
            config_ref: 'other',
            binding_revision: 1,
            enabled: true
          })
          const second = { ...d.target, provider_id: 'second' }
          const p = { id: 'alice' }
          const router = new Router(s)
          assert.doesNotThrow(() => router.create(p, second, { method: 'ping' }, options()))
          const a = s.createCall('alice', d.target, { method: 'ping' }, options())
          const b = s.createCall('alice', second, { method: 'ping' }, options())
          respond(s, s.dispatch('alice', a.call_id, d.epoch), { result: { name: 'a' } }, 100)
          respond(s, s.dispatch('alice', b.call_id, d.epoch), { result: { name: 'b' } }, 100)
          const handle = s.saveResult('alice', a.call_id)
          s.setProviderEnabled(d.machine_id, 'provider', 1, false)
          assert.throws(
            /* 读取已禁用 provider 的调用，确认禁用状态立即阻止访问。 */ () => s.call('alice', a.call_id),
            /provider_disabled/
          )
          assert.throws(
            /* 读取已禁用 provider 的结果句柄，确认句柄不能绕过 provider 状态。 */ () =>
              s.readResult('alice', handle.result_id),
            /provider_disabled/
          )
          assert(s.call('alice', b.call_id).response)
          const next = s.setProviderEnabled(d.machine_id, 'provider', 2, true)
          assert.equal(next.binding_revision, 3)
          assert.throws(
            /* 重新启用并升级绑定后访问旧调用，确认旧版本仍不能恢复访问。 */ () => s.call('alice', a.call_id),
            /provider_binding_mismatch/
          )
          s.revoke(d.machine_id)
          assert.throws(
            /* 撤销设备后读取另一 provider 的调用，确认设备级撤销覆盖该目标。 */ () => s.call('alice', b.call_id),
            /call_not_found/
          )
        } finally {
          s.close()
        }
      }
    )
)
test(
  'SQLite anchor and late-evidence commit failures publish no false durable result and no resend',
  /* 验证派发锚点和迟到证据提交失败均不发布虚假结果，恢复后只完成原尝试。 */ () =>
    disk(
      /* 按阶段切换事务故障，检查发送次数、调用状态和存储恢复后的提交行为。 */ (_root, path) => {
        let point = ''
        const s = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management,
          fault: /* 仅在指定事务阶段抛出模拟 I/O 异常，便于分别检查锚点和证据回滚。 */ (p) => {
            if (p === point) {
              throw Error('synthetic I/O failure')
            }
          }
        })
        try {
          const d = connected(s)
          const c = s.createCall('alice', d.target, { method: 'ping' }, options())
          let sends = 0
          point = 'before_commit'
          assert.throws(
            /* 在锚点提交故障期间派发，仅在派发成功后才增加模拟发送计数。 */ () => {
              s.dispatch('alice', c.call_id, d.epoch)
              sends++
            },
            /storage_degraded/
          )
          assert.equal(sends, 0)
          assert.equal(s.call('alice', c.call_id).state, 'created')
          assert.throws(
            /* 在存储已降级时重连设备，确认连接变更也被拒绝。 */ () => s.connect(d.machine_id, d.credential),
            /storage_degraded/
          )
          point = ''
          s.resumeStorage()
          const b = s.dispatch('alice', c.call_id, d.epoch)
          sends++
          point = 'evidence_commit'
          assert.throws(
            /* 在证据提交阶段注入故障，检查响应不被误标为持久化成功。 */ () => respond(s, b, { result: {} }, 100),
            /storage_degraded/
          )
          assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown')
          assert.equal(s.call('alice', c.call_id).response, null)
          assert.throws(
            /* 在证据失败后的降级状态保存结果，确认不能导出未提交响应。 */ () => s.saveResult('alice', c.call_id),
            /storage_degraded/
          )
          point = ''
          s.resumeStorage()
          respond(s, b, { result: {} }, 100)
          assert.equal(sends, 1)
          assert.equal(s.call('alice', c.call_id).state, 'responded')
        } finally {
          s.close()
        }
      }
    )
)
test(
  'SQLite SQLITE_FULL while committing an anchor prevents any send and remains degraded after restart',
  /* 验证提交锚点时出现真实 SQLITE_FULL 会在发送前失败，且重启后仍保持降级。 */ () =>
    disk(
      /* 限制数据库页数并写入超大审计制造真实磁盘满错误，再重开检查降级持久性。 */ (_root, path) => {
        let full = false
        const s = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management,
          fault: /* 在提交前冻结页数上限并写入超大记录，强制 SQLite 报告容量耗尽。 */ (p) => {
            if (full && p === 'before_commit') {
              const db = (s as unknown as { db: DatabaseSync }).db
              const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count)
              db.exec(`PRAGMA max_page_count=${pages}`)
              db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(
                'force-full',
                'test',
                'test',
                null,
                100,
                1000,
                'x'.repeat(2_000_000)
              )
            }
          }
        })
        try {
          const d = connected(s)
          const c = s.createCall('alice', d.target, { method: 'ping' }, options())
          full = true
          let sends = 0
          assert.throws(
            /* 在数据库已满时派发，仅在成功返回后才增加模拟发送计数。 */ () => {
              s.dispatch('alice', c.call_id, d.epoch)
              sends++
            },
            /storage_degraded/
          )
          assert.equal(sends, 0)
        } finally {
          s.close()
        }
        const reopened = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management
        })
        try {
          assert.equal(reopened.health().mode, 'storage_degraded')
          assert.throws(
            /* 对重启后仍降级的存储注册设备，确认不会自动恢复写入。 */ () => reopened.register('blocked'),
            /storage_degraded/
          )
        } finally {
          reopened.close()
        }
      }
    )
)
test(
  'SQLite total disk budget includes unrelated managed files, leaves tombstones intact, and requires explicit resume',
  /* 验证托管目录中的无关文件也计入磁盘预算，清除压力后仍须显式恢复且旧键不丢失。 */ () =>
    disk(
      /* 用额外文件压满托管目录，移除文件后检查降级保持，并在恢复后确认去重仍生效。 */ (_root, path) => {
        const s = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management,
          retention: {
            storage_total_bytes: 1_048_576,
            storage_reserve_bytes: 65_536,
            content_bytes: 100_000,
            backup_bytes: 100_000
          }
        })
        try {
          const d = connected(s)
          const o = options({ client_request_key: 'k' })
          const c = s.createCall('alice', d.target, { method: 'ping' }, o)
          const junk = join(path, '..', 'pressure')
          writeFileSync(junk, Buffer.alloc(1_000_000))
          assert.throws(
            /* 在总磁盘预算不足时派发，检查分配在发送前被拒绝。 */ () => s.dispatch('alice', c.call_id, d.epoch),
            /storage_degraded/
          )
          rmSync(junk)
          assert.throws(
            /* 只移除占用文件后再次派发，检查存储不会自动退出降级模式。 */ () =>
              s.dispatch('alice', c.call_id, d.epoch),
            /storage_degraded/
          )
          s.resumeStorage()
          assert.equal(s.createCall('alice', d.target, { method: 'ping' }, o).call_id, c.call_id)
        } finally {
          s.close()
        }
      }
    )
)
test(
  'SQLite metadata-only backup restores as re-pair state; restored credentials, enrollments, scopes and providers stay fenced',
  /* 验证备份剥除本例请求/响应原文与设备凭据；恢复后设备回到 pending，旧凭据、令牌和绑定均失效，需重新配对。 */ () =>
    disk(
      /* 创建含调用与登记信息的备份并恢复，依次检查旧凭据吊销、设备 pending 及 provider 版本围栏。 */ (root, path) => {
        const backupDirectory = join(root, 'backups')
        mkdirSync(backupDirectory, { mode: 0o700 })
        const destination = join(backupDirectory, 'snapshot')
        const s = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management,
          backupDirectory
        })
        let credential = ''
        let token = ''
        let machine = ''
        let target: ReturnType<typeof connected>['target']
        let oldBinding: AttemptBinding
        try {
          const d = connected(s)
          credential = d.credential
          machine = d.machine_id
          target = d.target
          const pending = s.register('pending')
          token = s.issueEnrollment(pending.machine_id)
          const c = s.createCall(
            'alice',
            d.target,
            { method: 'ping', params: { secret: 'backup-fake-secret' } },
            options()
          )
          oldBinding = s.dispatch('alice', c.call_id, d.epoch)
          respond(s, oldBinding, { result: { secret: 'output-fake-secret' } }, 100)
          s.backup(destination)
          s.revoke(d.machine_id)
          const bytes = readFileSync(destination)
          for (const secret of [credential, token, 'backup-fake-secret', 'output-fake-secret']) {
            assert(!bytes.includes(Buffer.from(secret)))
          }
        } finally {
          s.close()
        }
        const restored = new Store(destination, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management
        })
        try {
          assert.equal(restored.health().mode, 'active')
          assert.notEqual(restored.generation(), oldBinding!.recovery_generation)
          assert.equal(restored.machine(machine).status, 'pending')
          assert.throws(
            /* 恢复后沿用旧 provider revision 创建调用：provider 已禁用并升版，旧绑定被围栏。 */ () =>
              restored.createCall('alice', target!, { method: 'ping' }, options()),
            /provider_binding_mismatch/
          )
          assert.throws(
            /* 恢复后使用旧设备凭据连接，检查旧凭据已失效。 */ () => restored.connect(machine, credential),
            /invalid_device_credential/
          )
          assert.throws(/* 恢复后兑换旧登记令牌，检查其无效。 */ () => restored.redeem(token), /invalid_enrollment/)
          assert.equal(restored.provider(machine, 'provider')!.enabled, false)
          assert.throws(
            /* 在 provider 尚未重新启用时使用旧尝试查询锚点，检查其被禁用状态隔离。 */ () =>
              restored.responseAnchor(oldBinding!),
            /provider_disabled/
          )
          const fresh = restored.redeem(restored.issueEnrollment(machine))
          restored.connect(machine, fresh.credential)
          restored.setProviderEnabled(machine, 'provider', 2, true)
          assert.throws(
            /* 重新启用 provider 后仍使用旧尝试查询锚点，检查版本升级继续拒绝旧绑定。 */ () =>
              restored.responseAnchor(oldBinding!),
            /provider_binding_mismatch/
          )
        } finally {
          restored.close()
        }
      }
    )
)
test(
  'SQLite accepts ordinary paths and permissions; corruption and abandoned locks still reject',
  /* 普通目录及文件链接可以使用，残留写锁和损坏数据库仍阻止打开。 */ () =>
    disk(
      /* 只更改本例自有目录，核对正常读取与锁、损坏数据的拒绝。 */ (root, path) => {
        const open = new Store(path)
        open.close()
        const publicDirectory = join(root, 'public')
        mkdirSync(publicDirectory, { mode: 0o755 })
        chmodSync(publicDirectory, 0o755)
        new Store(join(publicDirectory, 'db')).close()
        assert.equal(statSync(publicDirectory).mode & 0o777, 0o755)
        const link = join(root, 'linked')
        symlinkSync(join(root, 'state'), link)
        new Store(join(link, 'db')).close()
        const lock = path + '.lock'
        writeFileSync(lock, 'crash', { mode: 0o600 })
        assert.throws(/* 在残留写锁存在时打开数据库，检查操作失败并保留锁文件。 */ () => new Store(path), /EEXIST/)
        assert(existsSync(lock))
        rmSync(lock)
        chmodSync(path, 0o644)
        new Store(path).close()
        assert.equal(statSync(path).mode & 0o777, 0o644)
        writeFileSync(path, 'corrupt SQLite')
        assert.throws(
          /* 打开被替换为非 SQLite 字节的数据库，检查损坏不会被静默重建。 */ () => new Store(path),
          /database_open_failed/
        )
      }
    )
)
test(
  'actual abrupt SQLite writer exit leaves a lock that is recovered only because its owner is provably dead',
  /* 验证真实写进程突然退出后留下带持有者身份的锁；有死亡证据才自动接管，没有证据的平台仍要求显式处理。 */ () =>
    disk(
      /* 启动持锁后立即退出的隔离子进程，再检查退出码、残留锁内容及重新打开的结果。 */ (_root, path) => {
        const script = `import {Store} from ${JSON.stringify(new URL('../../src/store.ts', import.meta.url).pathname)};new Store(${JSON.stringify(path)});process.exit(17)`
        const child = spawnSync(process.execPath, ['--no-env-file', '-e', script], {
          encoding: 'utf8'
        })
        assert.equal(child.status, 17, child.stderr)
        assert(existsSync(path + '.lock'))
        if (currentProcessIdentity() === undefined) {
          assert.throws(/* 没有进程身份证据的平台保持 fail-closed。 */ () => new Store(path), /EEXIST/)
          return
        }
        const recorded = JSON.parse(readFileSync(path + '.lock', 'utf8'))
        assert.equal(recorded.format, GATEWAY_LOCK_FORMAT)
        assert.equal(recorded.process.pid, child.pid)
        const reopened = new Store(path)
        try {
          assert.equal(JSON.parse(readFileSync(path + '.lock', 'utf8')).process.pid, process.pid)
        } finally {
          reopened.close()
        }
        assert.equal(existsSync(path + '.lock'), false)
      }
    )
)
test(
  'a lock whose recorded owner is alive, unrecognised or empty is never taken over; a reused PID is',
  /* 验证接管只在“记录的进程确已不在”时发生：存活持有者、空锁、未知格式都保持拒绝，PID 被复用视为已死。 */ () =>
    disk(
      /* 用真实存活的子进程制造持有者身份，分别写入不同内容的残留锁。 */ (_root, path) => {
        if (currentProcessIdentity() === undefined) {
          return
        }
        const holder = spawn(process.execPath, ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore'
        })
        try {
          const alive = currentProcessIdentity(holder.pid!)
          assert(alive)
          const lock = path + '.lock'
          for (const content of [
            JSON.stringify({ format: GATEWAY_LOCK_FORMAT, process: alive }),
            JSON.stringify({ format: 'other-format', process: { pid: 999_999, start: '1' } }),
            '{"format":'
          ]) {
            writeFileSync(lock, content, { mode: 0o600 })
            assert.throws(/* 存活持有者、未知格式、损坏内容都不接管。 */ () => new Store(path), /EEXIST/)
            assert.equal(readFileSync(lock, 'utf8'), content)
            rmSync(lock)
          }
          // 同 PID 但启动标识不同：该 PID 已被无关进程复用，原持有者已死，可以接管。
          writeFileSync(lock, JSON.stringify({ format: GATEWAY_LOCK_FORMAT, process: { ...alive, start: 'reused' } }), {
            mode: 0o600
          })
          new Store(path).close()
        } finally {
          holder.kill('SIGKILL')
        }
      }
    )
)
test(
  'invalid retention relations and missing management/confirmation replay reject allocation',
  /* 验证无效保留配置、缺少管理授权和确认标识重放都会阻止相应分配或变更。 */ () => {
    for (const retention of [
      { storage_reserve_bytes: 536_870_912 },
      { content_bytes: 536_870_913 },
      { metadata_ttl: NaN }
    ]) {
      assert.throws(
        /* 用违反限制关系的保留配置构造存储，确认初始化拒绝无效限额。 */ () =>
          new Store(':memory:', /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, { retention }),
        /invalid_storage_limits/
      )
    }
    const s = new Store(':memory:', /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
      management: /* 重复返回同一管理确认标识，专门触发后续管理操作的重放检查。 */ () => ({
        actor: 'a',
        confirmation_id: 'same'
      })
    })
    try {
      const m = s.register('a')
      s.defineProvider({
        machine_id: m.machine_id,
        provider_id: 'one',
        kind: 'luvus',
        config_ref: 'test',
        binding_revision: 1,
        enabled: true
      })
      assert.throws(
        /* 复用已消费的确认标识禁用 provider，检查管理确认不能重复授权。 */ () =>
          s.setProviderEnabled(m.machine_id, 'one', 1, false),
        /confirmation_replayed/
      )
    } finally {
      s.close()
    }
    const denied = new Store(':memory:', /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100)
    try {
      const m = denied.register('a')
      assert.throws(
        /* 在未配置管理授权器时定义 provider，检查管理操作默认拒绝。 */ () =>
          denied.defineProvider({
            machine_id: m.machine_id,
            provider_id: 'p',
            kind: 'luvus',
            config_ref: 'test',
            binding_revision: 1,
            enabled: true
          }),
        /management_authorization_required/
      )
    } finally {
      denied.close()
    }
  }
)
test(
  'evidence planner exceptions do not publish a response or expose planted secret errors',
  /* 验证证据规划异常既不发布响应，也不把植入的秘密异常文本传给调用者。 */ () =>
    disk(
      /* 构造已派发调用并注入规划异常，检查统一降级错误和空响应状态。 */ (_root, path) => {
        const s = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, { management })
        try {
          const d = connected(s)
          const c = s.createCall('alice', d.target, { method: 'ping' }, options())
          const b = s.dispatch('alice', c.call_id, d.epoch)
          assert.throws(
            /* 调用带故障规划器的证据事务，检查规划失败不会提交响应。 */ () =>
              s.commitEvidence(
                b,
                /* 抛出带固定秘密文本的规划异常，检查上层事务对外错误会被脱敏。 */ () => {
                  throw Error('planted-fake-secret')
                }
              ),
            /* 只接纳统一存储降级错误，拒绝把植入的异常消息作为公开错误。 */ (e) =>
              e instanceof Error && e.message === 'storage_degraded'
          )
          assert.equal(s.call('alice', c.call_id).response, null)
        } finally {
          s.close()
        }
      }
    )
)

test(
  'SQLite reserve exhaustion and audit quota reject new dispatch without deleting required records',
  /* 验证总预留耗尽或审计限额不足会拒绝新分配，且不删除已有调用记录。 */ () =>
    disk(
      /* 先占满尝试预留再竞争派发，并另建极小审计库检查分配前的配额拒绝。 */ (_root, path) => {
        const s = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management,
          retention: { storage_reserve_bytes: 16_384 }
        })
        try {
          const d = connected(s)
          const a = s.createCall('alice', d.target, { method: 'ping' }, options())
          const b = s.createCall('alice', d.target, { method: 'ping' }, options())
          s.dispatch('alice', a.call_id, d.epoch)
          let sends = 0
          assert.throws(
            /* 在已有在途尝试占用预留时派发第二调用，仅成功后才登记模拟发送。 */ () => {
              s.dispatch('alice', b.call_id, d.epoch)
              sends++
            },
            /storage_degraded/
          )
          assert.equal(sends, 0)
          assert.equal(s.call('alice', a.call_id).state, 'outcome_unknown')
          assert.equal(s.call('alice', b.call_id).state, 'created')
        } finally {
          s.close()
        }
        const auditPath = path + '-audit'
        const limited = new Store(auditPath, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
          management,
          retention: {
            storage_total_bytes: 20_000,
            storage_reserve_bytes: 17_000,
            content_bytes: 10_000,
            backup_bytes: 10_000
          }
        })
        try {
          assert.throws(
            /* 在总存储不足的存储中注册设备，检查写入被拒绝并进入降级。 */ () => limited.register('blocked'),
            /storage_degraded/
          )
          assert.equal(limited.health().mode, 'storage_degraded')
        } finally {
          limited.close()
        }
      }
    )
)
test(
  'SQLite managed backup count and fixed expiry enforce cleanup without reviving old content',
  /* 验证托管备份数量限制和固定过期清理生效，过期后才能重新占用备份名额。 */ () =>
    disk(
      /* 创建单名额备份并推进时钟到固定期限，检查额外备份先拒绝、清理后再成功。 */ (root, path) => {
        let now = 100
        const backups = join(root, 'backups')
        mkdirSync(backups, { mode: 0o700 })
        const s = new Store(path, /* 返回用例控制的时间，供验证备份的固定到期边界。 */ () => now, {
          management,
          backupDirectory: backups,
          retention: { backup_max_count: 1, backup_ttl: 10 }
        })
        try {
          connected(s)
          const first = join(backups, 'first')
          s.backup(first)
          assert.throws(
            /* 在首份备份尚未到期时创建第二份备份，检查数量配额会拒绝。 */ () => s.backup(join(backups, 'second')),
            /backup_count_quota/
          )
          assert(existsSync(first))
          now = 110
          s.expire()
          assert(!existsSync(first))
          s.backup(join(backups, 'second'))
        } finally {
          s.close()
        }
      }
    )
)
test(
  'snapshot directory replaced by a symlink at runtime fails expiry closed and deletes nothing outside',
  /* 运行中把固定快照目录换成指向外部目录的软链接：过期清理与再次备份都必须先复核边界并拒绝，外部同名文件与原快照都保留。 */ () =>
    disk(
      /* 登记一份快照后替换目录并推进时钟，检查 expire 抛 invalid_backup_directory 且两侧文件都在。 */ (root, path) => {
        let now = 100
        const backups = join(root, 'backups')
        const moved = join(root, 'backups-moved')
        const outside = join(root, 'outside')
        mkdirSync(backups, { mode: 0o700 })
        mkdirSync(outside, { mode: 0o700 })
        writeFileSync(join(outside, 'first'), 'outside-content')
        const s = new Store(path, /* 返回用例控制的时间，供验证替换发生后的固定到期边界。 */ () => now, {
          management,
          backupDirectory: backups,
          retention: { backup_max_count: 2, backup_ttl: 10 }
        })
        try {
          connected(s)
          s.backup(join(backups, 'first'))
          renameSync(backups, moved)
          symlinkSync(outside, backups, process.platform === 'win32' ? 'junction' : 'dir')
          now = 110
          assert.throws(
            /* 目录边界已被替换，过期清理不能跟随链接删除外部文件。 */ () => s.expire(),
            /invalid_backup_directory/
          )
          assert(existsSync(join(outside, 'first')))
          assert(existsSync(join(moved, 'first')))
          assert.throws(
            /* 写入新快照前同样复核边界，不能把快照落到固定目录之外。 */ () => s.backup(join(backups, 'second')),
            /invalid_backup_directory/
          )
          assert(!existsSync(join(outside, 'second')))
        } finally {
          s.close()
        }
      }
    )
)
test(
  'maintenance scheduler expires durable calls while front-end wait leaves execution deadline untouched',
  /* 验证前端等待不延长执行截止时间，后台维护调度会把已到期调用转为结果未知。 */ async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-scheduler-'))
    let now = 100
    const s = new Store(join(root, 'db'), /* 返回调度测试的时间，由用例推进执行截止而不随前端等待续期。 */ () => now, {
      management,
      maintenanceIntervalMs: 5
    })
    try {
      const d = connected(s)
      const p = { id: 'alice' }
      const r = new Router(s)
      const c = r.create(p, d.target, { method: 'ping' }, options({ timeoutMs: 10 }))
      const waited = await r.wait(p, c.call_id, 1)
      assert.equal(waited.state, 'created')
      assert.equal(waited.deadline, 110)
      s.dispatch('alice', c.call_id, d.epoch)
      now = 110
      await new Promise(
        /* 延迟完成 Promise，留出后台维护定时器处理已到期调用的时间。 */ (resolve) => setTimeout(resolve, 25)
      )
      assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown')
    } finally {
      s.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
test(
  'observed read clock cannot roll back across reopening or renew expired inline content',
  /* 验证读取时观察到的时钟上界跨重启保留，回退时钟不能续活已过期内联内容。 */ () =>
    disk(
      /* 读取触发内容过期后重启并调低时钟，检查再次读取会因时钟不可信被拒绝。 */ (_root, path) => {
        let now = 100
        let s = new Store(path, /* 返回用例时钟，供存储在原文到期读取时记录持久时钟上界。 */ () => now, {
          management,
          retention: { result_ttl: 10 }
        })
        try {
          const d = connected(s)
          const c = s.createCall('alice', d.target, { method: 'ping' }, options())
          respond(s, s.dispatch('alice', c.call_id, d.epoch), { result: {} }, now)
          now = 110
          assert.equal(s.call('alice', c.call_id).response, null)
          s.close()
          now = 105
          s = new Store(path, /* 重开时返回低于持久时钟上界的时间，供验证回拨拒绝。 */ () => now, { management })
          assert.throws(
            /* 在重启后回退时钟再读取原调用，检查持久化的时间上界仍会生效。 */ () => s.call('alice', c.call_id),
            /clock_untrusted/
          )
        } finally {
          s.close()
        }
      }
    )
)

test(
  'writer freezes receipt time while evidence validation crosses a clock tick',
  /* 验证证据校验跨越时钟跳变时，写者仍以固定收件时刻完成当前事务。 */ () =>
    disk(
      /* 在证据规划过程中推进可控时钟，确认当前响应提交成功且之后能观察新时间。 */ (_root, path) => {
        let now = 100
        const s = new Store(path, /* 返回规划阶段可变的时间，核对当前 writer 事务冻结的收件时刻。 */ () => now, {
          management
        })
        try {
          const d = connected(s)
          const c = s.createCall('alice', d.target, { method: 'ping' }, options())
          const b = s.dispatch('alice', c.call_id, d.epoch)
          const result = s.commitEvidence(
            b,
            /* 推进时钟后按写者提供的事务时刻规划响应证据，测试收件时间冻结。 */ () => {
              now = 125
              return planResponseEvidence(
                responseFrame(b, { result: { pong: true } }),
                evidenceContext(s, b),
                s.responseAnchor(b),
                s.clock()
              )
            }
          )
          assert.equal(result.state, 'responded')
          assert.equal(s.clock(), 125)
        } finally {
          s.close()
        }
      }
    )
)
test(
  'default thirty-day tombstone cleanup and scope deletion still reject the original key',
  /* 验证默认去重墓碑和历史范围被清理后，原客户端请求键仍不能重新分配调用。 */ () =>
    disk(
      /* 先跨默认去重期限再跨历史范围期限执行清理，分别检查旧键继续被拒绝。 */ (_root, path) => {
        let now = 100
        const s = new Store(path, /* 返回墓碑清理测试的时间，供用例依次跨越去重与历史作用域期限。 */ () => now, {
          management
        })
        try {
          const d = connected(s)
          const o = options({ client_request_key: 'old-key' })
          s.createCall('alice', d.target, { method: 'ping' }, o)
          const first = s.call('alice', s.createCall('alice', d.target, { method: 'ping' }, o).call_id).call_id
          now = 100 + s.limits.metadata_ttl
          s.expire()
          assert.notEqual(s.createCall('alice', d.target, { method: 'ping' }, o).call_id, first)
        } finally {
          s.close()
        }
      }
    )
)
