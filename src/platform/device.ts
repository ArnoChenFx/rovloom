/**
 * 本机平台标识：os / arch 直接取运行时真实值，Linux 发行版标识只从 /etc/os-release 读取。
 * 读不到发行版就缺省为 null，不猜、不从其它文件拼凑，也不把路径或文件内容带进错误。
 */
import { readFileSync } from 'node:fs'

/** Wire 允许的 os 取值：与运行时 `process.platform` 的已支持集合一致。 */
export type PlatformOs = 'linux' | 'darwin' | 'win32'
/** Wire 允许的 arch 取值；未知架构不上报，避免编造。 */
export type PlatformArch = 'x64' | 'arm64'

export type DevicePlatform = Readonly<{
  os: PlatformOs
  arch: PlatformArch
  /** Linux 发行版：os-release 的 ID 与 VERSION_ID；非 Linux 或读不到时为 null。 */
  distribution: Readonly<{ id: string; version_id: string | null }> | null
}>

const OS = new Set<PlatformOs>(['linux', 'darwin', 'win32'])
const ARCH = new Set<PlatformArch>(['x64', 'arm64'])
/** os-release 的 ID / VERSION_ID 只允许小写字母数字与 . _ -，长度受限，避免任意文本进入协议。 */
const DISTRIBUTION_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/u
const DISTRIBUTION_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/u
const OS_RELEASE_LIMIT = 16_384

/** 运行时平台是否属于协议允许集合；不属于时不产生平台声明。 */
export function supportedOs(value: string): value is PlatformOs {
  return OS.has(value as PlatformOs)
}

/** 运行时架构是否属于协议允许集合；不属于时不产生平台声明。 */
export function supportedArch(value: string): value is PlatformArch {
  return ARCH.has(value as PlatformArch)
}

/**
 * 解析 os-release 内容，只取 ID 与 VERSION_ID。
 * 支持 shell 风格的行、引号与行内注释；重复键以最后一次为准（与 systemd 行为一致）。
 */
export function parseOsRelease(raw: string): { id: string; version_id: string | null } | null {
  const values = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/u.exec(line)
    if (!match) {
      continue
    }
    const key = match[1]!
    if (key !== 'ID' && key !== 'VERSION_ID') {
      continue
    }
    let value = match[2]!.trim()
    // 去掉成对的引号；未加引号时允许行尾注释。
    const quoted = /^(['"])(.*)\1$/u.exec(value)
    if (quoted) {
      value = quoted[2]!
    } else {
      const comment = value.search(/\s#/u)
      if (comment >= 0) {
        value = value.slice(0, comment).trim()
      }
    }
    values.set(key, value)
  }
  const id = values.get('ID')
  if (!id || !DISTRIBUTION_ID.test(id)) {
    return null
  }
  const version = values.get('VERSION_ID')
  return {
    id,
    version_id: version && DISTRIBUTION_VERSION.test(version) ? version : null
  }
}

/** 只读一次固定路径的 os-release；任何失败都当作"没有发行版标识"，不反射错误正文。 */
function linuxDistribution(): { id: string; version_id: string | null } | null {
  let raw: string
  try {
    raw = readFileSync('/etc/os-release', { encoding: 'utf8', flag: 'r' })
  } catch {
    return null
  }
  if (Buffer.byteLength(raw) > OS_RELEASE_LIMIT) {
    return null
  }
  try {
    return parseOsRelease(raw)
  } catch {
    return null
  }
}

/**
 * 采集本机平台。只读固定系统文件，不执行外部命令、不读取环境变量、不返回路径。
 * 返回 undefined 表示当前运行时平台或架构不在协议允许集合内，调用方不得自行编造。
 */
export function probePlatform(
  runtime: Readonly<{ platform: string; arch: string }> = { platform: process.platform, arch: process.arch }
): DevicePlatform | undefined {
  if (!supportedOs(runtime.platform) || !supportedArch(runtime.arch)) {
    return undefined
  }
  return Object.freeze({
    os: runtime.platform,
    arch: runtime.arch,
    // 只有 Linux 有发行版标识；macOS/Windows 明确缺省，不借用其它来源。
    distribution: runtime.platform === 'linux' ? linuxDistribution() : null
  })
}
