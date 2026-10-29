/** Gateway 私有 schema 的后台回收；引用事实来自当前 registry/Store，不维护第二份引用计数。 */
import { lstatSync, opendirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parseHerdrProviderRefConfig } from '../connector/herdr/provider.js'
import { checkedRemoteLuvusConfig } from '../connector/luvus/host/remote-luvus.js'
import { readSchema, SCHEMA_BYTES_LIMIT } from '../connector/schema-store.js'
import { syncParentDirectory } from '../storage/files.js'
import { fields, object } from '../wire/index.js'
import { CliError, type GatewayConfig } from './config.js'
import { readRuntimeConfig, type ManagedProviderEntry } from './runtime-config.js'
import { runtimeReference } from './runtime-files.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'

export const SCHEMA_GC_INTERVAL = 3_600_000
export const SCHEMA_GC_GRACE = 7 * 24 * SCHEMA_GC_INTERVAL
const MAX_CANDIDATES = 4096
const MAX_ENTRIES = 65_536
const MAX_DELETIONS = 32
const FILE = /^schema_([a-f0-9]{64})\.json$/u
type Candidate = { file: string; unreferenced_at: number }
type Progress = { version: 1; checked_at: number; candidates: Candidate[] }

/** 只解析已有 provider 配置，不重新编译；未知或损坏来源阻止整轮回收。禁用的 provider 仍是引用。 */
function referencedDigests(entries: readonly ManagedProviderEntry[]): Set<string> {
  const result = new Set<string>()
  for (const entry of entries) {
    const value = object(entry.value)
    if (value.kind === 'luvus') {
      result.add(checkedRemoteLuvusConfig(entry.reference, value).contract.schema_sha256)
    } else if (value.kind === 'herdr') {
      fields(value, ['kind', 'config'])
      const config = parseHerdrProviderRefConfig(value.config)
      if (config.config_ref !== entry.reference) {
        throw new CliError('invalid_config')
      }
      result.add(config.expected_source.schema_sha256)
    } else {
      throw new CliError('invalid_config')
    }
  }
  return result
}

/** 进度只保存候选文件名和观察时间；损坏时保留文件，不把损坏进度当作可删除依据。 */
function progress(input: unknown): Progress | undefined {
  if (input === undefined) {
    return undefined
  }
  const value = object(input)
  fields(value, ['version', 'checked_at', 'candidates'])
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.checked_at) ||
    (value.checked_at as number) < 0 ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_CANDIDATES
  ) {
    throw new CliError('invalid_config')
  }
  const names = new Set<string>()
  for (const candidate of value.candidates) {
    const entry = object(candidate)
    fields(entry, ['file', 'unreferenced_at'])
    if (
      typeof entry.file !== 'string' ||
      !FILE.test(entry.file) ||
      names.has(entry.file) ||
      !Number.isSafeInteger(entry.unreferenced_at) ||
      (entry.unreferenced_at as number) < 0 ||
      (entry.unreferenced_at as number) > (value.checked_at as number)
    ) {
      throw new CliError('invalid_config')
    }
    names.add(entry.file)
  }
  return value as Progress
}

export type GatewaySchemaGcOptions = Readonly<{
  /** 包含仍被当前 Store 使用的启动时配置；磁盘配置另外在每轮重新读取。 */
  retained(): readonly ManagedProviderEntry[]
  /** 配对从发布 schema 到提交 registry 之间，以及关闭期间，不允许回收。 */
  busy(): boolean
  deferred?(): void
  now?: () => number
}>

/** 必须属于持有 Gateway Store writer 的宿主；同步扫描/删除不让配对提交在引用快照中间插入。 */
export class GatewaySchemaGc {
  #timer: ReturnType<typeof setInterval> | undefined
  #closed = false
  #failed = false

  constructor(
    private readonly config: GatewayConfig,
    private readonly options: GatewaySchemaGcOptions
  ) {}

  start(): void {
    if (this.#closed || this.#timer) {
      return
    }
    this.sweep()
    this.#timer = setInterval(() => this.sweep(), SCHEMA_GC_INTERVAL)
    this.#timer.unref()
  }

  close(): void {
    this.#closed = true
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** 返回 false 表示本轮延期；维护失败不影响 Gateway 服务，也不打印私有路径/异常。 */
  sweep(): boolean {
    if (this.#closed || this.options.busy()) {
      return false
    }
    try {
      this.collect()
      this.#failed = false
      return true
    } catch {
      if (!this.#failed) {
        this.options.deferred?.()
      }
      this.#failed = true
      return false
    }
  }

  private collect(): void {
    const now = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new CliError('invalid_config')
    }
    for (const pending of ['control-migration', 'retirement']) {
      if (readSetupJson(runtimeReference(this.config.state_dir, pending), 1_048_576) !== undefined) {
        throw new CliError('configuration_required')
      }
    }
    const roots = referencedDigests([...readRuntimeConfig(this.config).providers, ...this.options.retained()])
    const journal = runtimeReference(this.config.state_dir, 'schema-gc')
    const previous = progress(readSetupJson(journal, 1_048_576))
    // 长时间停机/维护失败或时钟跳变后重新观察，不能把未观察的时间计入七天宽限期。
    const continuous = previous && now >= previous.checked_at && now - previous.checked_at <= 2 * SCHEMA_GC_INTERVAL
    const observed = new Map(
      (continuous ? previous.candidates : []).map((entry) => [entry.file, entry.unreferenced_at])
    )
    const managed = join(this.config.state_dir, 'managed')
    const names: string[] = []
    const directory = opendirSync(managed)
    try {
      let count = 0
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++count > MAX_ENTRIES) {
          throw new CliError('configuration_required')
        }
        if (FILE.test(entry.name) && entry.isFile()) {
          names.push(entry.name)
        }
      }
    } finally {
      directory.closeSync()
    }
    const candidates: Candidate[] = []
    let deleted = 0
    let bytes = 0
    for (const file of names.sort()) {
      const digest = FILE.exec(file)![1]!
      if (roots.has(digest)) {
        continue
      }
      const path = join(managed, file)
      const before = lstatSync(path)
      // 不处理链接、未知文件、旧 schema_path 或目录外文件；损坏文件保留供诊断。
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > SCHEMA_BYTES_LIMIT) {
        continue
      }
      const since = observed.get(file) ?? now
      if (now - since >= SCHEMA_GC_GRACE && deleted < MAX_DELETIONS && bytes + before.size <= SCHEMA_BYTES_LIMIT) {
        readSchema(path, digest, 'schema_digest_conflict')
        const after = lstatSync(path)
        if (
          !after.isFile() ||
          after.nlink !== 1 ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        ) {
          throw new CliError('config_changed')
        }
        unlinkSync(path)
        syncParentDirectory(path)
        deleted++
        bytes += before.size
        continue
      }
      if (candidates.length < MAX_CANDIDATES) {
        candidates.push({ file, unreferenced_at: since })
      }
    }
    const next: Progress = { version: 1, checked_at: now, candidates }
    if (previous || candidates.length) {
      writeSetupJson(journal, next, previous !== undefined, 1_048_576)
      syncParentDirectory(journal)
    }
  }
}
