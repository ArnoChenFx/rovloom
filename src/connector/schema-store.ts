/**
 * Herdr 与 Luvus 共用同一份原始 schema 落盘约定：内容寻址的单文件、摘要核验、原子发布。
 * 这里只处理字节和引用，不解析或重新序列化 schema，也不编译契约。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { privatePath, publishPrivateBytes, readPrivateBytes } from '../storage/files.js'
import { hash } from '../wire/index.js'
import { ProviderAdapterError } from './provider-error.js'

/** 单份原始 schema 的字节上限；两端在写入和读取时使用同一上限。 */
export const SCHEMA_BYTES_LIMIT = 16_777_216

/** 内容寻址文件名：同一摘要永远对应同一路径，写入不会覆盖不同字节。 */
export function schemaFileName(sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new ProviderAdapterError('schema_digest_invalid')
  }
  return 'schema_' + sha256 + '.json'
}

/** 新布局的固定位置：角色私有 `managed/` 目录内的内容寻址文件。 */
export function schemaReference(directory: string, sha256: string): string {
  return join(directory, 'managed', schemaFileName(sha256))
}

/**
 * 原子发布原始 schema 字节。已有同摘要文件必须是逐字节相同的普通文件：
 * 不同字节意味着摘要冲突，直接拒绝，绝不覆盖或删除已有证据。
 */
export function publishSchema(path: string, bytes: Uint8Array): string {
  const digest = hash(bytes)
  if (!path.endsWith('/' + schemaFileName(digest)) && !path.endsWith('\\' + schemaFileName(digest))) {
    throw new ProviderAdapterError('schema_reference_mismatch')
  }
  privatePath(path)
  if (!bytes.length || bytes.byteLength > SCHEMA_BYTES_LIMIT) {
    throw new ProviderAdapterError('schema_file_invalid')
  }
  if (!existsSync(path)) {
    try {
      publishPrivateBytes(path, bytes)
    } catch (error) {
      // 并发发布只允许同一摘要、同一字节；其它 I/O 失败不被成功读回掩盖。
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ProviderAdapterError('schema_publish_failed')
      }
    }
  }
  if (!Buffer.from(bytes).equals(readPrivateBytes(path, SCHEMA_BYTES_LIMIT))) {
    throw new ProviderAdapterError('schema_digest_conflict')
  }
  return path
}

/**
 * 读取引用文件并核对声明摘要。文件类型、大小和路径沿用共享私有读取器的既有边界；
 * 摘要不符时抛出调用方自己的固定错误码，两端保持各自已发布的公开诊断。
 */
export function readSchema(
  path: string,
  sha256: string,
  mismatchCode: string,
  emptyCode = 'schema_file_invalid'
): Buffer {
  const bytes = readPrivateBytes(path, SCHEMA_BYTES_LIMIT)
  if (!bytes.length) {
    throw new ProviderAdapterError(emptyCode)
  }
  if (hash(bytes) !== sha256) {
    throw new ProviderAdapterError(mismatchCode)
  }
  return bytes
}
