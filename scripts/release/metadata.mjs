/** 维护发行版本、平台和确定性资产契约；只允许固定官方仓库，不载入用户配置。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  RELEASE_REPOSITORY,
  RELEASE_MANIFEST,
  assetName,
  officialReleasePlatforms,
  versionFromTag,
  validateReleaseManifest
} from '../../src/release/contract.ts'
import { runtimeLibc } from './libc.mjs'
export { assetName, versionFromTag }
export const repository = RELEASE_REPOSITORY
export const manifestName = RELEASE_MANIFEST
export const checksumsName = 'SHA256SUMS'
export const platforms = JSON.parse(readFileSync(new URL('./platforms.json', import.meta.url), 'utf8'))
export const root = resolve(import.meta.dir, '../..')

/** 校验事件必须绑定官方仓库的完整 tag ref 与确切提交 SHA。 */
export function releaseContext(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, repository, 'Release repository mismatch')
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Only tag push events can publish')
  assert.equal(env.GITHUB_REF_TYPE, 'tag')
  const tag = env.GITHUB_REF?.slice('refs/tags/'.length)
  assert.equal(env.GITHUB_REF, `refs/tags/${tag}`)
  const version = versionFromTag(tag)
  assert(/^[0-9a-f]{40}$/u.test(env.GITHUB_SHA), 'Expected full event commit SHA')
  return { tag, version, commit: env.GITHUB_SHA }
}

/** 产品版本只从受审源码导出读取，必须与包版本和 tag 三者完全一致，不在构建时偷偷改号。 */
export async function validateProductVersion(context, directory = root) {
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  assert.equal(pkg.version, context.version, 'Tag and package.json version differ')
  const source = resolve(directory, 'src/mcp/version.ts')
  assert(lstatSync(source).isFile(), 'Product version module missing')
  const { PRODUCT_VERSION } = await import(source)
  assert.equal(PRODUCT_VERSION, context.version, 'Tag and PRODUCT_VERSION differ')
}

/** 公开平台字段使用 Node/Bun 命名；归档中的 aarch64 只属于官方工具链下载名。 */
export function nativePlatform() {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const libc = runtimeLibc()
  const platform = platforms.find(
    /** 精确选择运行中的 OS/arch/libc，禁止模拟交叉验收或把 musl 目标当 glibc 运行。 */ (item) =>
      item.os === os && item.arch === process.arch && item.libc === libc
  )
  assert(platform, 'Unsupported native release platform')
  return platform
}

/** 矩阵与契约的官方平台集合必须逐项一致，避免 CI 或资产清单出现未声明的平台。 */
export function assertPlatformMatrix() {
  assert.deepEqual(
    platforms.map(
      /** 只比较公开平台元组，runner 与编译目标属于设施字段。 */ (item) => ({
        os: item.os,
        arch: item.arch,
        libc: item.libc
      })
    ),
    officialReleasePlatforms().map((item) => ({ os: item.os, arch: item.arch, libc: item.libc })),
    'Release matrix does not match the asset contract'
  )
  for (const item of platforms) {
    assert.equal(
      item.target,
      `bun-${item.os}-${item.arch}${item.libc === 'musl' ? '-musl' : ''}`,
      'Target must be the Bun compile target for its platform'
    )
  }
  return platforms
}

/** 读取普通文件的完整字节计算公开长度和 SHA-256，拒绝目录、符号链接及空产物。 */
export function fileMetadata(path) {
  const stat = lstatSync(path)
  assert(stat.isFile() && stat.size > 0, 'Expected nonempty regular asset')
  const bytes = readFileSync(path)
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** 使用固定键顺序和 LF 序列化，构建时间、用户目录和 runner 名称不进入更新契约。 */
export function encode(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

/** npm tarball 的唯一资产名；与 bun pm pack 的输出同名，只由版本决定。 */
export function npmAssetName(version) {
  return `rovloom-${version}.tgz`
}

/**
 * 校验 npm 包目录恰好含 tarball 与同 tag/提交/字节的收据。tarball 不进 release-manifest.json：
 * 已发布客户端对清单字段是封闭校验，新增字段会让它们无法自更新；摘要只进入 SHA256SUMS。
 */
function assembleNpm(context, directory) {
  const name = npmAssetName(context.version)
  assert.deepEqual(readdirSync(directory).sort(), [name, 'receipt.json'].sort())
  const path = resolve(directory, name)
  const asset = { name, ...fileMetadata(path) }
  assert(lstatSync(resolve(directory, 'receipt.json')).isFile())
  const receipt = JSON.parse(readFileSync(resolve(directory, 'receipt.json'), 'utf8'))
  assert.deepEqual(receipt, { ...context, asset }, 'npm receipt does not match tag, commit or bytes')
  return { ...asset, path }
}

/** 聚合每项验收后的最小收据，检查恰好完整矩阵及全部原始文件摘要；npm 包目录可选（发布流程必填）。 */
export function assemble(context, directory, npmDirectory = undefined) {
  const entries = readdirSync(directory).sort()
  assert.deepEqual(entries, platforms.map(/** 每个平台只占一个固定目录。 */ (item) => item.target).sort())
  const assets = []
  const files = new Map()
  for (const platform of platforms) {
    const folder = resolve(directory, platform.target)
    assert(lstatSync(folder).isDirectory() && !lstatSync(folder).isSymbolicLink())
    const name = assetName(context.version, platform)
    assert.deepEqual(readdirSync(folder).sort(), [name, 'receipt.json'].sort())
    const path = resolve(folder, name)
    const asset = { os: platform.os, arch: platform.arch, libc: platform.libc, name, ...fileMetadata(path) }
    assert(lstatSync(resolve(folder, 'receipt.json')).isFile())
    const receipt = JSON.parse(readFileSync(resolve(folder, 'receipt.json'), 'utf8'))
    assert.deepEqual(
      receipt,
      { ...context, target: platform.target, asset },
      'Receipt does not match tag, commit or bytes'
    )
    assets.push(asset)
    files.set(name, path)
  }
  const manifest = validateReleaseManifest(
    { schemaVersion: 1, repository, ...context, bun: process.versions.bun, assets },
    context.tag
  )
  const manifestBytes = encode(manifest)
  const sums = assets.map(/** 按矩阵固定顺序输出每个二进制摘要。 */ (asset) => `${asset.sha256}  ${asset.name}`)
  const npm = npmDirectory === undefined ? undefined : assembleNpm(context, npmDirectory)
  if (npm) {
    sums.push(`${npm.sha256}  ${npm.name}`)
  }
  sums.push(`${createHash('sha256').update(manifestBytes).digest('hex')}  ${manifestName}`)
  return { manifest, manifestBytes, checksumsBytes: sums.join('\n') + '\n', files, ...(npm ? { npm } : {}) }
}

if (import.meta.main) {
  assert.deepEqual(process.argv.slice(2), ['matrix'])
  console.log(JSON.stringify({ include: platforms }))
}
