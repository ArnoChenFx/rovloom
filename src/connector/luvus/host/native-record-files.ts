/** 为 native 控制记录提供无链接、固定权限、同步落盘与完整路径身份复核，不保存原生 secret。 */
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { syncParentDirectory } from '../../../storage/files.js'
import { boundedJson } from '../../../wire/index.js'
import { parseNativeJson } from '../contract/index.js'
import { LuvusAdapterError } from '../types.js'
import { ownedPathStamp } from './native-process.js'

/** 记录路径必须规范且父目录为可信私有目录，不能跟随 symlink 或使用可写祖先。 */
export function nativeRecordParent(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    throw new LuvusAdapterError('native_record_path_invalid')
  }
  return ownedPathStamp(dirname(path), 'directory')
}

/** 对单链接 0600 小文件固定真实 inode、权限与内容版本，防止记录被原位修改或替换。 */
export function nativeRecordStamp(path: string, maximum = 32_768): string {
  try {
    const parent = nativeRecordParent(path)
    const info = lstatSync(path, { bigint: true })
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.uid !== BigInt(process.geteuid!()) ||
      (info.mode & 0o777n) !== 0o600n ||
      info.size > BigInt(maximum)
    ) {
      throw new LuvusAdapterError('native_record_untrusted')
    }
    return [parent, info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.ctimeNs].join(':')
  } catch (error) {
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_record_unavailable')
  }
}

/** 从 no-follow fd 有界读取 JSON，并前后复核同一个真实文件，返回冻结的原始记录快照。 */
export function readNativeRecord(path: string, maximum = 32_768): Readonly<{ value: unknown; stamp: string }> {
  const before = nativeRecordStamp(path, maximum)
  let fd = -1
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    if (info.dev !== named.dev || info.ino !== named.ino || info.size > BigInt(maximum)) {
      throw new LuvusAdapterError('native_record_changed')
    }
    const buffer = Buffer.alloc(maximum + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null)
      if (!count) {
        break
      }
      bytes += count
    }
    if (bytes > maximum) {
      throw new LuvusAdapterError('native_record_untrusted')
    }
    const result = parseNativeJson(buffer.subarray(0, bytes), { object_bytes: maximum })
    const after = fstatSync(fd, { bigint: true })
    if (
      !result.ok ||
      nativeRecordStamp(path, maximum) !== before ||
      info.ctimeNs !== after.ctimeNs ||
      info.size !== after.size
    ) {
      throw new LuvusAdapterError('native_record_changed')
    }
    return Object.freeze({ value: result.value, stamp: before })
  } catch (error) {
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_record_unavailable')
  } finally {
    if (fd >= 0) {
      closeSync(fd)
    }
  }
}

/** 排他创建小型安全元数据并同步文件及目录，部分失败保留记录并拒绝自动接管。 */
export function createNativeRecord(path: string, value: unknown, maximum = 32_768): string {
  const parent = nativeRecordParent(path)
  const bytes = boundedJson(value, maximum)
  let fd = -1
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    if (nativeRecordParent(path) !== parent) {
      throw new LuvusAdapterError('native_record_changed')
    }
    closeSync(fd)
    fd = -1
    syncParentDirectory(path)
    return nativeRecordStamp(path, maximum)
  } catch (error) {
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_record_create_failed')
  } finally {
    if (fd >= 0) {
      closeSync(fd)
    }
  }
}

/** 只移除本轮仍完全匹配的控制记录；替代文件、遗留锁和未知状态永不自动删除。 */
export function removeNativeRecord(path: string, expected: string): void {
  if (nativeRecordStamp(path) !== expected) {
    throw new LuvusAdapterError('native_record_changed')
  }
  try {
    unlinkSync(path)
    syncParentDirectory(path)
  } catch {
    throw new LuvusAdapterError('native_record_remove_failed')
  }
}
