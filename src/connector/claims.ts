/** 持久保存 Connector 唯一发送墓碑；只做去重和固定期限治理，不替代 Store、Wire 或宿主认证。 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, unlinkSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { createPrivate, privateFile, privatePath, syncParentDirectory } from '../storage/files.js'
import { windowsInspectPath } from '../platform/windows.js'
import { currentProcessIdentity } from '../storage/process-identity.js'
import { boundedJson, id, validateAttempt } from '../wire/index.js'
import type { AttemptBinding } from '../wire/types.js'
import { ProviderAdapterError } from './provider-error.js'
import { ConnectorCapacityError } from './capacity.js'

/**
 * 锁文件里的持久标记，沿用已发布的值：崩溃遗留的锁必须继续被识别为同一格式，
 * 改名只会让旧锁变成未知格式并永久 fail-closed。同理，SQL 表名也是账本落盘格式的一部分。
 */
export const DISPATCH_CLAIMS_LOCK_FORMAT = 'rovloom-luvus-claims-lock-v1'

/** 锁内容带持有者进程身份，崩溃后下次启动才能证明它已死并接管；非 Linux 无此证据则留空。 */
function lockContent(): string {
  const identity = currentProcessIdentity()
  return identity ? JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: identity }) : ''
}

const metadataSql =
  'CREATE TABLE luvus_claim_meta(version INTEGER NOT NULL, ledger_id TEXT NOT NULL, clock INTEGER NOT NULL)'
const claimsSql = `CREATE TABLE luvus_dispatch_claims(call_id TEXT NOT NULL, attempt_id TEXT NOT NULL, binding_digest BLOB NOT NULL CHECK(typeof(binding_digest)='blob' AND length(binding_digest)=32), expires INTEGER NOT NULL, PRIMARY KEY(call_id,attempt_id))`

/** 用 lstat 检查目录项，断链也视为存在，不能让 SQLite 跟随 sidecar 符号链接。 */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export type DispatchClaimLedgerOptions = Readonly<{
  path: string
  // create 只用于明确的首次配置；正常启动必须 open，丢失库不能自动重建。
  mode: 'create' | 'open'
  ledger_id: string
  limits: Readonly<{ entries: number; bytes: number }>
  /** 复用受保护宿主时钟，操作还会核对持久高水位，回拨即拒绝。 */
  now(): number
}>

/** 复制受保护配置并统一坏配置错误；不把调用方对象继续作为活配置。 */
function claimOptions(input: DispatchClaimLedgerOptions): DispatchClaimLedgerOptions {
  try {
    const options = Object.freeze({ ...input, limits: Object.freeze({ ...input.limits }) })
    id(options.ledger_id)
    if (
      !['create', 'open'].includes(options.mode) ||
      typeof options.path !== 'string' ||
      typeof options.now !== 'function' ||
      !Number.isSafeInteger(options.limits.entries) ||
      options.limits.entries < 1 ||
      options.limits.entries > 4096 ||
      !Number.isSafeInteger(options.limits.bytes) ||
      options.limits.bytes < 262_144 ||
      options.limits.bytes > 16_777_216
    ) {
      throw new ProviderAdapterError('claim_config_invalid')
    }
    return options
  } catch {
    throw new ProviderAdapterError('claim_config_invalid')
  }
}

/** 核对路径原有安全规则，再拒绝任何可被其它用户改写的祖先。 */
function protectedPath(path: string): void {
  privatePath(path)
  if (process.platform === 'win32') {
    // Windows：目录链逐级核验属主与 DACL（没有 uid/mode）。
    try {
      windowsInspectPath(dirname(path), 'directory')
    } catch {
      throw new ProviderAdapterError('claim_path_untrusted')
    }
    return
  }
  const uid = process.geteuid!()
  const rootOwner = lstatSync(sep).uid
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const entry = lstatSync(parent)
    if ((entry.mode & 0o022) !== 0 || (entry.uid !== uid && entry.uid !== rootOwner)) {
      throw new ProviderAdapterError('claim_path_untrusted')
    }
    if (parent === sep) {
      break
    }
  }
}

/** 只比较稳定文件身份；SQLite 正常写入会改变 size/ctime，不能据此误认替换。 */
function fileIdentity(path: string): string {
  privateFile(path)
  const value = lstatSync(path, { bigint: true })
  return [value.dev, value.ino, value.uid, value.mode, value.nlink].join(':')
}

/** 持久 Connector 发送账本；关闭不清除墓碑，崩溃锁须经受保护恢复处理，不能自动接管。 */
export class DispatchClaims {
  readonly ledgerId: string
  readonly #options: DispatchClaimLedgerOptions
  #db: DatabaseSync | undefined
  #identity = ''
  #lockIdentity = ''
  #closed = false
  #busy = false
  #degraded = false

  /** 显式创建或打开独占库，校验 schema、归属、固定 ledger ID 和实际资源上限。 */
  constructor(input: DispatchClaimLedgerOptions) {
    const options = claimOptions(input)
    this.#options = options
    this.ledgerId = options.ledger_id
    try {
      protectedPath(options.path)
      if (options.mode === 'open' && !present(options.path)) {
        throw new ProviderAdapterError('claim_ledger_missing')
      }
      if (options.mode === 'create' && present(options.path)) {
        throw new ProviderAdapterError('claim_ledger_exists')
      }
      createPrivate(options.path + '.lock', lockContent())
      this.#lockIdentity = fileIdentity(options.path + '.lock')
      syncParentDirectory(options.path)
      if (options.mode === 'create') {
        createPrivate(options.path)
      }
      this.#identity = fileIdentity(options.path)
      const databaseBytes = lstatSync(options.path).size
      const journalBytes = this.#sidecars()
      // 启动时也须容纳未来 rollback journal；降低配额不能靠 SQLite 自动缩库。
      if (databaseBytes > (options.limits.bytes - 65_536) / 2 || databaseBytes + journalBytes > options.limits.bytes) {
        throw new ConnectorCapacityError('claim_bytes', null)
      }
      this.#db = new DatabaseSync(options.path)
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0')
      // 给 rollback journal 留出库大小及页头余量；SQLite 自身也限制增长，不能只在写后统计。
      const pageSize = Number(this.#db.prepare('PRAGMA page_size').get()!.page_size)
      const maximumPages = Math.floor((options.limits.bytes - 65_536) / (2 * pageSize))
      const actualMaximum = Number(this.#db.prepare('PRAGMA max_page_count=' + maximumPages).get()!.max_page_count)
      if (
        actualMaximum !== maximumPages ||
        Number(this.#db.prepare('PRAGMA page_count').get()!.page_count) > maximumPages
      ) {
        throw new ConnectorCapacityError('claim_bytes', null)
      }
      if (options.mode === 'create') {
        this.#db.exec('BEGIN IMMEDIATE; ' + metadataSql + '; ' + claimsSql)
        this.#db.prepare('INSERT INTO luvus_claim_meta VALUES(2,?,0)').run(this.ledgerId)
        this.#db.exec('COMMIT')
        syncParentDirectory(options.path)
      }
      const schema = this.#db
        .prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
        .all()
      if (schema.length !== 2 || schema[0]!.sql !== metadataSql || schema[1]!.sql !== claimsSql) {
        throw new ProviderAdapterError('claim_ledger_invalid')
      }
      this.#meta()
      this.#budget()
      const check = this.#db.prepare('PRAGMA quick_check').get()
      if (check?.quick_check !== 'ok') {
        throw new ProviderAdapterError('claim_ledger_invalid')
      }
    } catch (error) {
      let closed = true
      try {
        this.#db?.close()
      } catch {
        // 关闭未完成就保留独占锁，不能让另一实例接管仍可能持有的 SQLite 句柄。
        closed = false
      } finally {
        this.#db = undefined
        if (closed) {
          this.#unlock()
        }
      }
      throw error instanceof ProviderAdapterError ? error : new ProviderAdapterError('claim_storage_unavailable')
    }
  }

  /** 读取唯一的持久元数据行，不能把空库或其它业务数据库当作新的发送账本。 */
  #meta() {
    const rows = this.#db!.prepare('SELECT version,ledger_id,clock FROM luvus_claim_meta').all()
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0]!.clock) || Number(rows[0]!.clock) < 0) {
      throw new ProviderAdapterError('claim_ledger_invalid')
    }
    if (rows[0]!.version !== 2 || rows[0]!.ledger_id !== this.ledgerId) {
      throw new ProviderAdapterError('claim_ledger_mismatch')
    }
    return rows[0]!
  }

  /** 同步复核文件和锁身份，替换、权限改变或降级后不继续写旧 inode。 */
  #guard(): void {
    if (this.#closed || !this.#db || this.#degraded || this.#busy) {
      throw new ProviderAdapterError('claim_ledger_unavailable')
    }
    protectedPath(this.#options.path)
    if (
      fileIdentity(this.#options.path) !== this.#identity ||
      fileIdentity(this.#options.path + '.lock') !== this.#lockIdentity
    ) {
      throw new ProviderAdapterError('claim_ledger_identity_changed')
    }
  }

  /** 计入已分配数据库页及当前 rollback journal，并限制未回收墓碑的行数。 */
  #budget(candidate?: AttemptBinding): void {
    const pages = Number(this.#db!.prepare('PRAGMA page_count').get()!.page_count)
    const size = Number(this.#db!.prepare('PRAGMA page_size').get()!.page_size)
    const bytes = Math.max(pages * size, lstatSync(this.#options.path).size) + this.#sidecars()
    const count = Number(this.#db!.prepare('SELECT count(*) AS n FROM luvus_dispatch_claims').get()!.n)
    if (bytes > this.#options.limits.bytes) {
      throw new ConnectorCapacityError('claim_bytes', null)
    }
    if (count > this.#options.limits.entries) {
      const first = this.#db!
        .prepare('SELECT min(expires) AS deadline FROM luvus_dispatch_claims WHERE call_id<>? OR attempt_id<>?')
        .get(candidate?.call_id ?? '', candidate?.attempt_id ?? '')!.deadline
      throw new ConnectorCapacityError('claim_entries', Number.isSafeInteger(first) ? Number(first) : null)
    }
  }

  /** 在 SQLite 打开/恢复之前也校验 sidecar，禁止跟随额外链接或混入 WAL 模式文件。 */
  #sidecars(): number {
    if (present(this.#options.path + '-wal') || present(this.#options.path + '-shm')) {
      throw new ProviderAdapterError('claim_ledger_invalid')
    }
    const journal = this.#options.path + '-journal'
    if (!present(journal)) {
      return 0
    }
    privateFile(journal)
    const size = lstatSync(journal).size
    if (size > this.#options.limits.bytes) {
      throw new ConnectorCapacityError('claim_bytes', null)
    }
    return size
  }

  /** 保存唯一发送墓碑；expires 是宿主已核验的锚点上限，墓碑固定保留至原执行 deadline。 */
  claim(binding: AttemptBinding, expires: number): void {
    try {
      this.#claim(binding, expires)
    } catch (error) {
      throw error instanceof ProviderAdapterError ? error : new ProviderAdapterError('claim_storage_unavailable')
    }
  }

  /** 在完整校验后开启唯一事务；所有数据库失败都阻止派发。 */
  #claim(binding: AttemptBinding, expires: number): void {
    this.#guard()
    const snapshot = JSON.parse(boundedJson(binding, 16_384)) as AttemptBinding
    const { machine_id, recovery_generation, connection_epoch, ...attempt } = snapshot
    for (const value of [machine_id, recovery_generation, connection_epoch]) {
      id(value)
    }
    validateAttempt(attempt)
    const now = this.#options.now()
    if (
      !Number.isSafeInteger(now) ||
      now < Number(this.#meta().clock) ||
      !Number.isSafeInteger(expires) ||
      expires <= now ||
      expires < snapshot.registration.deadline ||
      now >= snapshot.registration.deadline
    ) {
      throw new ProviderAdapterError('claim_deadline_invalid')
    }
    let committed = false
    let begun = false
    this.#busy = true
    try {
      this.#db!.exec('BEGIN IMMEDIATE')
      begun = true
      if (
        this.#db!
          .prepare('SELECT 1 FROM luvus_dispatch_claims WHERE call_id=? AND attempt_id=?')
          .get(snapshot.call_id, snapshot.attempt_id)
      ) {
        throw new ProviderAdapterError('dispatch_already_claimed')
      }
      // schema v2 的 expires 固定为原 deadline；摘要不能恢复绑定或 native 许可。
      // 清理、插入及持久时钟推进共用事务；重启或时钟回退不能复活已回收的意图。
      this.#db!.prepare('DELETE FROM luvus_dispatch_claims WHERE expires<=?').run(now)
      const digest = createHash('sha256').update(boundedJson(snapshot, 16_384)).digest()
      this.#db!
        .prepare('INSERT INTO luvus_dispatch_claims VALUES(?,?,?,?)')
        .run(snapshot.call_id, snapshot.attempt_id, digest, snapshot.registration.deadline)
      this.#db!.prepare('UPDATE luvus_claim_meta SET clock=?').run(now)
      this.#budget(snapshot)
      this.#db!.exec('COMMIT')
      committed = true
      const reader = new DatabaseSync(this.#options.path, { readOnly: true })
      try {
        const row = reader
          .prepare('SELECT binding_digest,expires FROM luvus_dispatch_claims WHERE call_id=? AND attempt_id=?')
          .get(snapshot.call_id, snapshot.attempt_id)
        if (
          !(row?.binding_digest instanceof Uint8Array) ||
          !Buffer.from(row.binding_digest).equals(digest) ||
          row.expires !== snapshot.registration.deadline
        ) {
          throw new ProviderAdapterError('claim_commit_unverified')
        }
      } finally {
        reader.close()
      }
    } catch (error) {
      if (!committed && begun) {
        try {
          this.#db!.exec('ROLLBACK')
        } catch {
          this.#degraded = true
        }
      } else if (committed) {
        this.#degraded = true
      }
      if ((error as NodeJS.ErrnoException)?.code === 'SQLITE_FULL') {
        throw new ConnectorCapacityError('claim_bytes', null)
      }
      throw error instanceof ProviderAdapterError ? error : new ProviderAdapterError('claim_storage_unavailable')
    } finally {
      this.#busy = false
    }
  }

  /** 只删除本实例仍独占持有的锁，不清库或自动接管其它进程的崩溃锁。 */
  #unlock(): void {
    // 身份已变化时留下锁供受保护恢复，不覆盖原异常，也不删除其它进程的文件。
    try {
      if (this.#lockIdentity && fileIdentity(this.#options.path + '.lock') === this.#lockIdentity) {
        unlinkSync(this.#options.path + '.lock')
        syncParentDirectory(this.#options.path)
      }
    } catch {
      /* 不能确认锁身份或目录持久性时保守留下恢复缺项。 */
    }
    this.#lockIdentity = ''
  }

  /** 幂等关闭自己的句柄；持久唯一墓碑跨 adapter/epoch/正常进程重启保留。 */
  close(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    try {
      this.#db?.close()
      this.#db = undefined
    } catch {
      this.#degraded = true
      throw new ProviderAdapterError('claim_storage_unavailable')
    }
    this.#unlock()
  }
}
