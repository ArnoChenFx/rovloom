import { ownerIsDead } from '../storage/process-identity.js'
import { LUVUS_OWNER_FORMAT } from '../connector/luvus/host/native-crash-recovery.js'
import { HERDR_OWNER_FORMAT } from './herdr-crash-recovery.js'
/** Rovloom 控制布局及旧布局迁移；不移动原生 HOME/XDG/状态根。 */
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPrivate, syncParentDirectory } from '../storage/files.js'
import { lockContent, recordedProcess, recoverStaleLock } from '../storage/lock-recovery.js'
import { DISPATCH_CLAIMS_LOCK_FORMAT } from '../connector/claims.js'
import { boundedJson, hash, object } from '../wire/index.js'
import { CliError, type NativeProviderKind } from './config.js'
import { privateDirectory } from './first-config.js'
import { readSetupJson, setupFileStamp, writeSetupFile, writeSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'

const MIGRATION_FORMAT = 'rovloom-control-migration-v1'
export const LEGACY_SETUP = { luvus: 'native-setup', herdr: 'herdr-setup' } as const
export function providerControl(directory: string, kind: NativeProviderKind): string {
  return join(directory, 'control', kind)
}
export function providerSetupPath(directory: string, kind: NativeProviderKind): string {
  return join(providerControl(directory, kind), 'setup.json')
}

type Move = { source: string; target: string; digest: string }
type Document = { path: string; previous: string; staged: string; digest: string }
type Migration = { format: string; moves: Move[]; documents: Document[] }

/** 旧路径只在此处解释；重启恢复使用固定映射，不接受配置指定任意搬移位置。 */
function controlMoves(directory: string): [string, string][] {
  const result: [string, string][] = []
  for (const kind of ['luvus', 'herdr'] as const) {
    const control = providerControl(directory, kind)
    result.push([runtimeReference(directory, LEGACY_SETUP[kind]), join(control, 'setup.json')])
    const old =
      kind === 'luvus' ? join(directory, 'control', 'luvus-claims.db') : join(directory, 'hr', 'control', 'claims.db')
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      result.push([old + suffix, join(control, 'claims.db') + suffix])
    }
  }
  for (const suffix of ['', '.owner.lock']) {
    result.push([
      join(directory, 'control', 'luvus-root.json') + suffix,
      join(providerControl(directory, 'luvus'), 'root.json') + suffix
    ])
  }
  result.push([
    join(directory, 'hr', 'c', '.rovloom-herdr-default.owner.json'),
    join(providerControl(directory, 'herdr'), 'owner.json')
  ])
  return result
}

function rewrite(value: unknown, paths: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return paths.get(value) ?? value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewrite(entry, paths))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, paths)]))
  }
  return value
}

/** 新引用发布之前先保留可恢复 journal；每次启动在读取 provider 配置前完成同一批次。 */
export function migrateConnectorControls(directory: string): void {
  const journal = runtimeReference(directory, 'control-migration')
  const fixed = controlMoves(directory)
  if (!existsSync(journal) && !fixed.some(([source]) => existsSync(source))) {
    return
  }
  privateDirectory(join(directory, 'managed'))
  const lock = journal + '.lock'
  recoverStaleLock(lock, MIGRATION_FORMAT)
  createPrivate(lock, lockContent(MIGRATION_FORMAT))
  try {
    // 不迁移仍可能被使用的 SQLite 文件，也不按锁龄或空锁猜测进程已死。
    for (const old of [
      join(directory, 'control', 'luvus-claims.db'),
      join(directory, 'hr', 'control', 'claims.db'),
      ...['luvus', 'herdr'].map((kind) => join(providerControl(directory, kind as NativeProviderKind), 'claims.db'))
    ]) {
      if (existsSync(old + '.lock') && !recoverStaleLock(old + '.lock', DISPATCH_CLAIMS_LOCK_FORMAT)) {
        throw new CliError('configuration_required')
      }
    }
    for (const [path, format] of [
      [join(directory, 'control/luvus-root.json.owner.lock'), LUVUS_OWNER_FORMAT],
      [join(providerControl(directory, 'luvus'), 'root.json.owner.lock'), LUVUS_OWNER_FORMAT],
      [join(directory, 'hr/c/.rovloom-herdr-default.owner.json'), HERDR_OWNER_FORMAT]
    ]) {
      if (!existsSync(path!)) {
        continue
      }
      const recorded = recordedProcess(readSetupJson(path!, 8192), format!)
      if (!recorded || !ownerIsDead(recorded)) {
        throw new CliError('configuration_required')
      }
    }
    let plan = readSetupJson(journal, 1_048_576) as Migration | undefined
    if (!plan) {
      const paths = new Map(fixed)
      const moves = fixed
        .filter(([source]) => existsSync(source))
        .map(([source, target]) => ({ source, target, digest: hash(readFileSync(source)) }))
      for (const move of moves) {
        if (existsSync(move.target)) {
          throw new CliError('configuration_required')
        }
      }
      const documents: Document[] = []
      for (const path of [
        runtimeReference(directory, 'providers'),
        ...['luvus', 'herdr'].map((kind) => runtimeReference(directory, LEGACY_SETUP[kind as NativeProviderKind]))
      ]) {
        const value = readSetupJson(path, 1_048_576)
        if (value === undefined) {
          continue
        }
        const bytes = boundedJson(rewrite(value, paths), 1_048_576)
        const staged = 'control-migration-' + documents.length
        const stagedPath = runtimeReference(directory, staged)
        if (!existsSync(stagedPath)) {
          writeSetupFile(stagedPath, bytes)
        } else if (setupFileStamp(stagedPath) !== hash(bytes)) {
          throw new CliError('config_changed')
        }
        syncParentDirectory(stagedPath)
        documents.push({ path: paths.get(path) ?? path, previous: setupFileStamp(path), staged, digest: hash(bytes) })
      }
      plan = { format: MIGRATION_FORMAT, moves, documents }
      writeSetupJson(journal, plan, false, 1_048_576)
      syncParentDirectory(journal)
    }
    const allowed = new Map(fixed)
    const documentPaths = new Set([
      runtimeReference(directory, 'providers'),
      providerSetupPath(directory, 'luvus'),
      providerSetupPath(directory, 'herdr')
    ])
    const row = object(plan)
    if (row.format !== MIGRATION_FORMAT || !Array.isArray(row.moves) || !Array.isArray(row.documents)) {
      throw new CliError('configuration_required')
    }
    for (const move of plan.moves) {
      if (allowed.get(move.source) !== move.target || !/^[a-f0-9]{64}$/.test(move.digest)) {
        throw new CliError('configuration_required')
      }
    }
    for (const doc of plan.documents) {
      if (
        !documentPaths.has(doc.path) ||
        !/^control-migration-[0-2]$/.test(doc.staged) ||
        !/^[a-f0-9]{64}$/.test(doc.digest) ||
        !/^[a-f0-9]{64}$/.test(doc.previous)
      ) {
        throw new CliError('configuration_required')
      }
    }
    for (const move of plan.moves) {
      privateDirectory(dirname(dirname(move.target)))
      privateDirectory(dirname(move.target))
      const expected = plan.documents.find((doc) => doc.path === move.target)
      if (existsSync(move.source)) {
        if (existsSync(move.target) || setupFileStamp(move.source) !== move.digest) {
          throw new CliError('configuration_required')
        }
        renameSync(move.source, move.target)
        syncParentDirectory(move.target)
        syncParentDirectory(move.source)
      } else if (
        !existsSync(move.target) ||
        ![move.digest, ...(expected ? [expected.digest] : [])].includes(setupFileStamp(move.target))
      ) {
        throw new CliError('configuration_required')
      }
    }
    for (const doc of plan.documents) {
      const current = setupFileStamp(doc.path)
      if (current === doc.digest) {
        continue
      }
      if (current !== doc.previous) {
        throw new CliError('config_changed')
      }
      const bytes = readFileSync(runtimeReference(directory, doc.staged))
      if (hash(bytes) !== doc.digest) {
        throw new CliError('config_changed')
      }
      writeSetupFile(doc.path, bytes, true, current)
      syncParentDirectory(doc.path)
    }
    for (const doc of plan.documents) {
      const staged = runtimeReference(directory, doc.staged)
      if (existsSync(staged)) {
        unlinkSync(staged)
        syncParentDirectory(staged)
      }
    }
    unlinkSync(journal)
    syncParentDirectory(journal)
  } finally {
    unlinkSync(lock)
    syncParentDirectory(lock)
  }
}
