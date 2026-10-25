// 一机一码的长期配对码账本：管理页或 `rovloom gateway --issue-code` 生成/作废，POST /pairing 消费。
// 子部署方案：码不过期（用掉/作废即终结）；未使用码的明文留在账本里，管理页可随时重显完整加入命令，
// 终结（用掉/作废/失败）时立即抹掉明文，只保留摘要供对账。
import { randomBytes, randomUUID } from 'node:crypto'
import { timingSafeEqual, createHash } from 'node:crypto'
import type { Store } from '../store.js'
import { fields, id, object } from '../wire/index.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'

// 码的三段式沿用既有机器/尝试/秘密形状：machine_id.code_id.secret。
export type PairingCodeEntry = Readonly<{
  schema_version: 1
  code_id: string
  machine_id: string
  name: string
  created_at: number
  status: 'unused' | 'used' | 'revoked' | 'failed'
  secret_hash: string
  // 只有未使用码保留明文（面板重显完整命令用）；终结时由账本写入方抹掉。
  secret?: string
  used_at?: number
}>

export type IssuedPairingCode = Readonly<{
  code: string
  entry: PairingCodeEntry
}>

function secret(): string {
  return randomBytes(32).toString('base64url')
}

// 账本文件只存非秘密字段与秘密摘要；完整命令在生成响应与面板上按需重显。
function parseLedger(value: unknown): PairingCodeEntry[] {
  const row = object(value)
  fields(row, ['schema_version', 'entries'])
  if (row.schema_version !== 1 || !Array.isArray(row.entries)) {
    throw new Error('pairing_codes_unreadable')
  }
  return row.entries.map((entry): PairingCodeEntry => {
    const item = object(entry)
    fields(
      item,
      ['schema_version', 'code_id', 'machine_id', 'name', 'created_at', 'status', 'secret_hash'],
      ['secret', 'used_at']
    )
    id(item.code_id)
    id(item.machine_id)
    if (
      item.schema_version !== 1 ||
      !Number.isSafeInteger(item.created_at) ||
      (item.used_at !== undefined && !Number.isSafeInteger(item.used_at)) ||
      !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(String(item.name)) ||
      !['unused', 'used', 'revoked', 'failed'].includes(String(item.status)) ||
      !/^[0-9a-f]{64}$/.test(String(item.secret_hash)) ||
      (item.secret !== undefined &&
        (typeof item.secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(item.secret))) ||
      (item.status !== 'unused' && item.secret !== undefined)
    ) {
      throw new Error('pairing_codes_unreadable')
    }
    return item as PairingCodeEntry
  })
}

/**
 * 单 Gateway 进程持有的配对码账本；与 Store 的 pending 设备一一对应。
 * 全部操作同步完成（fs 与 SQLite 均无 await 点），单线程内天然串行：同一码的并发兑换只有一个成功。
 */
export class PairingCodes {
  constructor(
    private readonly store: Store,
    private readonly directory: string,
    private readonly now: () => number = Date.now
  ) {}

  private get path(): string {
    return runtimeReference(this.directory, 'pairing-codes')
  }

  private read(): PairingCodeEntry[] {
    const value = readSetupJson(this.path, 262_144)
    return value === undefined ? [] : parseLedger(value)
  }

  private write(entries: readonly PairingCodeEntry[]): void {
    // 首次用排他创建，其后按代次替换；外部改动会让代次核对失败而不是被覆盖。
    const current = readSetupJson(this.path, 262_144)
    writeSetupJson(this.path, { schema_version: 1, entries }, current !== undefined, 262_144)
  }

  /** 生成一码（注册一台 pending 设备并绑定）；重显完整命令由调用方拼接。 */
  create(name?: string): IssuedPairingCode {
    {
      const entries = this.read().filter(/* 终结的条目不无限累积。 */ (entry) => entry.status === 'unused')
      const code_id = randomUUID()
      const label = (name ?? 'connector-' + code_id.slice(0, 8)).toLowerCase()
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(label)) {
        throw new Error('pairing_code_invalid_name')
      }
      const machine = this.store.register(label)
      const value = secret()
      const entry: PairingCodeEntry = {
        schema_version: 1,
        code_id,
        machine_id: machine.machine_id,
        name: label,
        created_at: this.now(),
        status: 'unused',
        secret_hash: createHash('sha256').update(value).digest('hex'),
        secret: value
      }
      this.write([...entries, entry])
      return { code: machine.machine_id + '.' + code_id + '.' + value, entry }
    }
  }

  /** 作废一张未使用的码（同时抹掉明文）；目标 pending 设备一并删除，已用码只能吊销设备。 */
  revoke(code_id: string): void {
    id(code_id)
    const entries = this.read()
    const entry = entries.find((item) => item.code_id === code_id)
    if (!entry || entry.status !== 'unused') {
      throw new Error('pairing_code_not_found')
    }
    const { secret: _wiped, ...revoked } = entry
    this.write(entries.map((item) => (item.code_id === code_id ? { ...revoked, status: 'revoked' } : item)))
    try {
      this.store.deleteDevice(entry.machine_id, 'pairing_code_revoke')
    } catch {
      // 设备行可能已被管理操作移除；账本状态已推进，不阻塞作废。
    }
  }

  /** 面板列表：非秘密字段 + 未使用码的明文（客户端拼接完整加入命令）；终结条目只有摘要。 */
  list(): Readonly<Omit<PairingCodeEntry, 'secret_hash'>>[] {
    return this.read().map((entry) => {
      const { secret_hash: _hash, ...rest } = entry
      return rest
    })
  }

  /** 兑换前置核验：秘密摘要、状态与目标 pending 设备；成功后由调用方推进状态。 */
  verify(machine: string, code_id: string, value: string): PairingCodeEntry {
    id(machine)
    id(code_id)
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
      throw new Error('pairing_code_invalid')
    }
    const entry = this.read().find((item) => item.code_id === code_id && item.machine_id === machine)
    if (!entry) {
      throw new Error('pairing_code_invalid')
    }
    if (entry.status !== 'unused') {
      throw new Error('pairing_code_' + entry.status)
    }
    if (!timingSafeEqual(createHash('sha256').update(value).digest(), Buffer.from(entry.secret_hash, 'hex'))) {
      throw new Error('pairing_code_invalid')
    }
    if (this.store.machine(machine).status !== 'pending') {
      throw new Error('pairing_code_invalid')
    }
    return entry
  }

  /** 兑换结果落账：成功标记 used（抹掉明文），失败标记 failed（面板可见，需生成新码重试）。 */
  settle(code_id: string, used: boolean): void {
    id(code_id)
    const entries = this.read()
    const entry = entries.find((item) => item.code_id === code_id)
    if (!entry || entry.status !== 'unused') {
      return
    }
    this.write(
      entries.map((item) => {
        if (item.code_id !== code_id) {
          return item
        }
        const { secret: _wiped, ...rest } = item
        return { ...rest, status: used ? 'used' : 'failed', used_at: this.now() }
      })
    )
  }
}
