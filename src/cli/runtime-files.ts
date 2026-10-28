// 固定ref只解析到角色私有目录；受保护数据不能选择模块、shell或新的信任来源。
import { join } from 'node:path'
import { readPrivateBytes } from '../storage/files.js'
import { parseJson } from '../json/bounds.js'
import { CliError } from './config.js'

// 引用只构造固定文件名，拒绝路径、URL及目录跳转。
export function runtimeReference(directory: string, reference: unknown, suffix = '.json'): string {
  if (typeof reference !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(reference) || !['.json'].includes(suffix)) {
    throw new CliError('invalid_config')
  }
  return join(directory, 'managed', reference + suffix)
}

// 共用普通跨平台有界文件读取，不以本机权限、所有权或平台作为状态加载门禁。
export function readRuntimeFile(path: string, maximum: number): Buffer {
  try {
    return readPrivateBytes(path, maximum)
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('backend_unavailable', 3)
    }
    throw new CliError('config_unreadable')
  }
}

// 私有JSON同样使用现有重复键/UTF8/深度门禁；不以JSON.parse绕过正式字节契约。
export function readRuntimeJson(path: string, maximum = 16_384): unknown {
  const bytes = readRuntimeFile(path, maximum)
  try {
    const parsed = parseJson(bytes, { object_bytes: maximum, object_depth: 32, object_nodes: 100_000 })
    if (!parsed.ok) {
      throw new CliError('invalid_config')
    }
    return parsed.value
  } finally {
    bytes.fill(0)
  }
}
