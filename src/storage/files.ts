// 普通跨平台文件读写：检查路径、文件类型及字节预算，保留排他创建和落盘，不附加所有权/权限门禁。
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { GatewayError } from '../contracts.js'

// 固定存储位置须为规范绝对路径且父级是目录；访问能力遵循操作系统正常文件权限。
export function privatePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    throw new GatewayError('invalid_storage_path')
  }
  if (!statSync(dirname(path)).isDirectory()) {
    throw new GatewayError('invalid_storage_path')
  }
}
// 只读取普通文件；正常文件链接按平台文件系统规则解析。
export function privateFile(path: string): void {
  if (!statSync(path).isFile()) {
    throw new GatewayError('invalid_storage_file')
  }
}
// SQLite的数据库、journal及写锁须使用同一实际文件名；硬链接没有唯一sidecar路径，不能作为数据库入口。
export function databasePath(path: string): string {
  privatePath(path)
  // 只解析文件软链接；父目录别名本就指向同一锁文件，不额外要求列举祖先或父目录。
  for (let links = 0; links < 40; links++) {
    let file
    try {
      file = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      return path
    }
    if (file.isSymbolicLink()) {
      path = resolve(dirname(path), readlinkSync(path))
      continue
    }
    if (!file.isFile()) {
      throw new GatewayError('invalid_storage_file')
    }
    if (file.nlink !== 1) {
      throw new GatewayError('database_hardlink_unsupported')
    }
    // Windows的实际文件名也统一短文件名和大小写；POSIX无需为普通目录重新计算祖先路径。
    return process.platform === 'win32' ? realpathSync(path) : path
  }
  throw new GatewayError('database_symlink_loop')
}
// 排他创建并写完、同步同一文件；默认权限只用于新文件，不修改任何已有对象。
export function createPrivate(path: string, content: string | Uint8Array = ''): void {
  privatePath(path)
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
/** 完整同步临时内容后排他发布；已有目标交由调用方核对，不覆盖其它发布者。 */
export function publishPrivateBytes(path: string, bytes: Uint8Array): void {
  privatePath(path)
  const temporary = join(dirname(path), '.rovloom-publish-' + randomUUID() + '.tmp')
  try {
    createPrivate(temporary, bytes)
    linkSync(temporary, path)
    syncParentDirectory(path)
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary)
      syncParentDirectory(temporary)
    }
  }
}
// 同步父目录项，使创建、rename 与删除进入持久边界；Windows 不允许对目录句柄 fsync，NTFS 对元数据自带日志，故不做。
export function syncParentDirectory(path: string, followLink = false): void {
  if (process.platform === 'win32') {
    return
  }
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | (followLink ? 0 : constants.O_NOFOLLOW)
  const fd = openSync(dirname(path), flags)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
// 从实际文件描述符有界读取，防止增长中的文件突破预算；不比较UID、mode、ACL或路径封印。
export function readPrivateBytes(path: string, maximum: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16_777_216) {
    throw new GatewayError('invalid_storage_limit')
  }
  privatePath(path)
  privateFile(path)
  const fd = openSync(path, 'r')
  const bytes = Buffer.alloc(maximum + 1)
  let keep = false
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maximum) {
      throw new GatewayError('invalid_storage_file')
    }
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) {
        break
      }
      length += count
    }
    if (length > maximum) {
      throw new GatewayError('invalid_storage_file')
    }
    keep = true
    return bytes.subarray(0, length)
  } finally {
    if (!keep) {
      bytes.fill(0)
    }
    closeSync(fd)
  }
}
// 只创建缺失目录，已有目录沿用其正常权限与内容。
export function ensurePrivateDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    throw new GatewayError('invalid_storage_path')
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!statSync(path).isDirectory()) {
    throw new GatewayError('invalid_storage_path')
  }
}
// 统计自身普通文件和目录；文件链接计入目标大小，目录链接不递归以免遍历成环。
export function managedBytes(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const st = lstatSync(path)
    if (st.isSymbolicLink()) {
      try {
        const target = statSync(path)
        if (target.isFile()) {
          total += target.size
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    } else if (st.isDirectory()) {
      total += managedBytes(path)
    } else if (st.isFile()) {
      total += st.size
    }
  }
  return total
}
