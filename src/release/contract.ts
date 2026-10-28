// 为发布器与自更新共享无 I/O 的版本、平台、资产命名和清单校验；导入不读配置或磁盘。
import { parseJson } from '../json/bounds.js'
export const RELEASE_REPOSITORY = 'ArnoChenFx/rovloom'
export const RELEASE_MANIFEST = 'release-manifest.json'
export const RELEASE_MAX_BINARY_BYTES = 256 * 1024 * 1024
export type ReleaseOs = 'linux' | 'darwin' | 'windows'
export type ReleaseArch = 'x64' | 'arm64'
export type ReleasePlatform = Readonly<{ os: ReleaseOs; arch: ReleaseArch; libc: 'glibc' | null }>
export type ReleaseAsset = Readonly<ReleasePlatform & { name: string; size: number; sha256: string }>
export type ReleaseManifest = Readonly<{
  schemaVersion: 1
  repository: typeof RELEASE_REPOSITORY
  tag: string
  version: string
  commit: string
  /** 构建所用 Bun 版本，仅作记录，不参与校验。 */
  bun: string
  assets: readonly ReleaseAsset[]
}>
export type ReleaseVersion = Readonly<{ core: readonly number[]; prerelease: readonly string[] }>

// 复用与 provider 无关的有界 JSON 解析器，拒绝重复键、损坏 UTF-8、BOM、过深结构和不安全整数。
export function parseReleaseJson(bytes: Uint8Array, limit: number): unknown {
  const parsed = parseJson(bytes, { object_bytes: limit, object_depth: 32, object_nodes: 50_000 })
  if (!parsed.ok) {
    throw new Error('invalid_release_json')
  }
  return parsed.value
}

// 使用单一规范 SemVer 语法，禁止构建别名、数字前导零和不可安全比较的整数。
export function parseReleaseVersion(version: string): ReleaseVersion {
  const match =
    typeof version === 'string' && version.length <= 127
      ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version)
      : null
  if (!match || match[0] !== version) {
    throw new Error('invalid_release_version')
  }
  const core = match.slice(1, 4).map(
    /* 核心数字必须可安全表示。 */ (part) => {
      const value = Number(part)
      if (!Number.isSafeInteger(value)) {
        throw new Error('invalid_release_version')
      }
      return value
    }
  )
  const prerelease = match[4]?.split('.') ?? []
  for (const identifier of prerelease) {
    if (
      /^\d+$/u.test(identifier) &&
      (!/^(?:0|[1-9]\d*)$/u.test(identifier) || !Number.isSafeInteger(Number(identifier)))
    ) {
      throw new Error('invalid_release_version')
    }
  }
  return Object.freeze({ core: Object.freeze(core), prerelease: Object.freeze(prerelease) })
}

// 发行器与更新端共用 tag 转换，不各自接受不同的版本别名。
export function versionFromTag(tag: string): string {
  if (typeof tag !== 'string' || tag[0] !== 'v') {
    throw new Error('invalid_release_version')
  }
  const version = tag.slice(1)
  parseReleaseVersion(version)
  return version
}

// 清单平台必须完整表达 libc，Linux 只有 glibc；未知或 musl 绝不按同名资产接纳。
export function releasePlatform(os: string, arch: string, libc: unknown): ReleasePlatform {
  if (
    !['linux', 'darwin', 'windows'].includes(os) ||
    !['x64', 'arm64'].includes(arch) ||
    (os === 'linux' ? libc !== 'glibc' : libc !== null)
  ) {
    throw new Error('invalid_release_platform')
  }
  return Object.freeze({ os: os as ReleaseOs, arch: arch as ReleaseArch, libc: libc as 'glibc' | null })
}

// 唯一资产名称绑定版本与完整平台元组；返回原始未压缩二进制名。
export function assetName(version: string, platform: ReleasePlatform): string {
  parseReleaseVersion(version)
  releasePlatform(platform.os, platform.arch, platform.libc)
  return `rovloom-${version}-${platform.os}-${platform.arch}${platform.os === 'windows' ? '.exe' : ''}`
}

// 仅判断本版本清单或受支持平台的唯一二进制名，避免网络层再维护一套命名正则。
export function officialReleaseAssetName(version: string, name: string): boolean {
  parseReleaseVersion(version)
  if (name === RELEASE_MANIFEST) {
    return true
  }
  for (const os of ['linux', 'darwin', 'windows']) {
    for (const arch of ['x64', 'arm64']) {
      if (name === assetName(version, releasePlatform(os, arch, os === 'linux' ? 'glibc' : null))) {
        return true
      }
    }
  }
  return false
}

// 封闭清单字段，拒绝未知 URL、脚本、路径或后续版本字段被悄悄忽略。
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_release_manifest')
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length !== fields.length || keys.some(/* 每个字段必须来自既定契约。 */ (key) => !fields.includes(key))) {
    throw new Error('invalid_release_manifest')
  }
  return object
}

// 同时校验发布和消费的 manifest；stableOnly 只约束默认更新，不阻止发布器发布预发行。
export function validateReleaseManifest(input: unknown, tag: string, stableOnly = false): ReleaseManifest {
  const value = record(input, ['schemaVersion', 'repository', 'tag', 'version', 'commit', 'bun', 'assets'])
  const version = versionFromTag(tag)
  if (
    value.schemaVersion !== 1 ||
    value.repository !== RELEASE_REPOSITORY ||
    value.tag !== tag ||
    value.version !== version ||
    typeof value.bun !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.bun) ||
    typeof value.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(value.commit) ||
    (stableOnly && parseReleaseVersion(version).prerelease.length !== 0) ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > 6
  ) {
    throw new Error('invalid_release_manifest')
  }
  const assets: ReleaseAsset[] = []
  const seen = new Set<string>()
  for (const entry of value.assets) {
    const raw = record(entry, ['os', 'arch', 'libc', 'name', 'size', 'sha256'])
    if (typeof raw.os !== 'string' || typeof raw.arch !== 'string') {
      throw new Error('invalid_release_manifest')
    }
    const platform = releasePlatform(raw.os, raw.arch, raw.libc)
    const name = assetName(version, platform)
    if (
      raw.name !== name ||
      seen.has(name) ||
      !Number.isSafeInteger(raw.size) ||
      (raw.size as number) < 1 ||
      (raw.size as number) > RELEASE_MAX_BINARY_BYTES ||
      typeof raw.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256)
    ) {
      throw new Error('invalid_release_manifest')
    }
    seen.add(name)
    assets.push(Object.freeze({ ...platform, name, size: raw.size as number, sha256: raw.sha256 }))
  }
  return Object.freeze({
    schemaVersion: 1,
    repository: RELEASE_REPOSITORY,
    tag,
    version,
    commit: value.commit,
    bun: value.bun,
    assets: Object.freeze(assets)
  })
}
