/** 首次空白初始化并重开受保护的持久 native root；控制记录只授权固定配置，不认领任何 PID。 */
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { boundedJson, fields, id, object } from '../../../wire/index.js'
import { pinConfig, verifyInstallation } from '../local.js'
import type { LuvusLocalConfig } from '../types.js'
import { LuvusAdapterError } from '../types.js'
import { ownedPathStamp, OwnedNativeProcess } from './native-process.js'
import { LUVUS_OWNER_FORMAT, lockOwnerFields } from './native-crash-recovery.js'
import {
  createNativeRecord,
  nativeRecordParent,
  nativeRecordStamp,
  readNativeRecord,
  removeNativeRecord
} from '../../../connector/native-record-files.js'

const rootBrand = Symbol('managed-luvus-root')
export interface ManagedLuvusRoot {
  readonly [rootBrand]: true
  readonly root_id: string
  readonly root_revision: number
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly config_digest: string
  close(): void
}
type RootState = { path: string; stamp: string; roots: readonly [string, string][]; closed: boolean }
const roots = new WeakMap<ManagedLuvusRoot, RootState>()

/** 要求彼此分离的管理/native 目录，避免原生程序能够改写控制记录或批准文件。 */
export function assertManagedControlDirectory(config: LuvusLocalConfig, control: string): void {
  ownedPathStamp(control, 'directory')
  const all = [control, config.state_root, config.home, config.cwd]
  for (const first of all) {
    for (const second of all) {
      if (first === second) {
        continue
      }
      const inside = relative(first, second)
      if (!inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside))) {
        throw new LuvusAdapterError('native_root_overlap')
      }
    }
  }
  if (new Set(all).size !== all.length) {
    throw new LuvusAdapterError('native_root_overlap')
  }
}

/** 首次登记只接受空白自有目录，不读取或接管已有用户配置、工作内容与凭据。 */
function assertInitialBlank(config: LuvusLocalConfig): void {
  const xdg = ['config', 'data', 'cache', 'runtime']
  for (const path of [
    config.state_root,
    config.cwd,
    config.home,
    ...xdg.map(/* 固定 XDG 隔离目录。 */ (name) => join(config.home, name))
  ]) {
    ownedPathStamp(path, 'directory')
    if (!isDeepStrictEqual(readdirSync(path).sort(), path === config.home ? [...xdg].sort() : [])) {
      throw new LuvusAdapterError('native_root_not_blank')
    }
  }
}

/** 将真实保护记录变成内存 opaque handle，文件本身不证明运行中实例归属。 */
function rootHandle(path: string, expected: { root_id: string; root_revision: number }): ManagedLuvusRoot {
  const record = readNativeRecord(path)
  const value = object(record.value)
  // custody_policy 是旧版本记录遗留字段：仍可读取，但不再有任何用途，新记录不写入。
  fields(
    value,
    ['format', 'root_id', 'root_revision', 'config', 'config_digest', 'roots', 'created_at'],
    ['custody_policy']
  )
  id(value.root_id)
  if (
    value.format !== 'rovloom-luvus-root-v1' ||
    value.root_id !== expected.root_id ||
    value.root_revision !== expected.root_revision ||
    value.root_revision !== 1 ||
    !Number.isSafeInteger(value.created_at)
  ) {
    throw new LuvusAdapterError('native_root_record_invalid')
  }
  const config = pinConfig(value.config as LuvusLocalConfig)
  if (config.transport !== 'ipc' || !process.versions.bun || process.arch !== 'x64') {
    throw new LuvusAdapterError('native_root_installation_unsupported')
  }
  assertManagedControlDirectory(config, dirname(path))
  const digest = createHash('sha256').update(boundedJson(config)).digest('hex')
  if (value.config_digest !== digest || !Array.isArray(value.roots)) {
    throw new LuvusAdapterError('native_root_record_invalid')
  }
  const directories = [
    config.state_root,
    config.home,
    config.cwd,
    ...['config', 'data', 'cache', 'runtime'].map(/* 固定 XDG 目录身份。 */ (name) => join(config.home, name))
  ]
  const current = directories.map(
    /* 持久身份只使用目录 inode/权限，不把正常内容写入当成替换。 */ (directory) =>
      [directory, ownedPathStamp(directory, 'directory')] as [string, string]
  )
  if (!isDeepStrictEqual(current, value.roots)) {
    throw new LuvusAdapterError('native_root_identity_changed')
  }
  const state: RootState = { path, stamp: record.stamp, roots: current, closed: false }
  const handle: ManagedLuvusRoot = Object.freeze({
    [rootBrand]: true as const,
    root_id: expected.root_id,
    root_revision: expected.root_revision,
    config: config as LuvusLocalConfig & { readonly transport: 'ipc' },
    config_digest: digest,
    /** 关闭记录来源使后续使用拒绝，不假装已经停止仍受控的子进程。 */ close() {
      state.closed = true
    }
  })
  roots.set(handle, state)
  return handle
}

/** 受信本机管理 API 首次登记空白 native root；不启动 server，也不发行或保存 token。 */
export async function initializeManagedLuvusRoot(
  options: Readonly<{
    record_path: string
    root_id?: string
    config: LuvusLocalConfig
  }>
): Promise<ManagedLuvusRoot> {
  const config = pinConfig(options.config)
  if (config.transport !== 'ipc') {
    throw new LuvusAdapterError('native_root_installation_unsupported')
  }
  nativeRecordParent(options.record_path)
  assertManagedControlDirectory(config, dirname(options.record_path))
  assertInitialBlank(config)
  const rootId = options.root_id ?? randomUUID()
  id(rootId)
  await verifyInstallation(config)
  assertInitialBlank(config)
  const captured = [
    config.state_root,
    config.home,
    config.cwd,
    ...['config', 'data', 'cache', 'runtime'].map(/* 固定根目录与 XDG 身份。 */ (name) => join(config.home, name))
  ].map(/* 只保存非秘密目录身份，不写 PID、endpoint 或凭据。 */ (path) => [path, ownedPathStamp(path, 'directory')])
  createNativeRecord(options.record_path, {
    format: 'rovloom-luvus-root-v1',
    root_id: rootId,
    root_revision: 1,
    config,
    config_digest: createHash('sha256').update(boundedJson(config)).digest('hex'),
    roots: captured,
    created_at: Date.now()
  })
  return rootHandle(options.record_path, { root_id: rootId, root_revision: 1 })
}

/** 重开既有模块登记的持久 root；拒绝同形 JSON、未知目录和记录替换，不自动启动或认领实例。 */
export function openManagedLuvusRoot(
  options: Readonly<{ record_path: string; expected_root_id: string; expected_root_revision: number }>
): ManagedLuvusRoot {
  return rootHandle(options.record_path, {
    root_id: options.expected_root_id,
    root_revision: options.expected_root_revision
  })
}

/** 内部每次验证真实记录与持久目录身份，opaque handle 或相同 id 不能跳过当前保护事实。 */
export function assertManagedRoot(root: ManagedLuvusRoot): Readonly<{ record_path: string }> {
  const state = roots.get(root)
  if (!state || state.closed || nativeRecordStamp(state.path) !== state.stamp) {
    throw new LuvusAdapterError('native_root_unavailable')
  }
  for (const [path, stamp] of state.roots) {
    if (ownedPathStamp(path, 'directory') !== stamp) {
      throw new LuvusAdapterError('native_root_identity_changed')
    }
  }
  return Object.freeze({ record_path: state.path })
}

/** 排他拥有锁没有 PID 认领语义，退出失败时保留，确认真实子进程已结束后才允许释放。 */
export function claimManagedRoot(root: ManagedLuvusRoot) {
  const path = assertManagedRoot(root).record_path + '.owner.lock'
  const stamp = createNativeRecord(path, {
    root_id: root.root_id,
    root_revision: root.root_revision,
    config_digest: root.config_digest,
    // 带上持有者进程身份，崩溃后下一次启动才能证明它已死并接管；非 Linux 无此证据则省略。
    ...(lockOwnerFields() ? { format: LUVUS_OWNER_FORMAT, ...lockOwnerFields() } : {})
  })
  let released = false
  return Object.freeze({
    /** 当前实例持续依赖同一根记录和排他拥有锁。 */
    assert() {
      assertManagedRoot(root)
      if (released || nativeRecordStamp(path) !== stamp) {
        throw new LuvusAdapterError('native_owner_lock_changed')
      }
    },
    /** 没有启动 child 或收到该真实拥有者的退出确认后才清理锁，不处理未知 PID。 */
    release(child?: OwnedNativeProcess) {
      if (released) {
        return
      }
      if (child && !child.terminationState().exit_confirmed) {
        throw new LuvusAdapterError('native_owner_cleanup_pending')
      }
      removeNativeRecord(path, stamp)
      released = true
    }
  })
}
