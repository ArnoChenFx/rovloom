/** 全矩阵资产校验后先组装草稿再公开，已存在的不同资产从不覆盖或删除。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assemble, checksumsName, manifestName, releaseContext, repository } from './metadata.mjs'
import { publishNpm } from './registry.mjs'
import { findRelease, githubClient, verifyRemoteTag } from './github.mjs'

/** 生成公开版本、升级提示和提交说明，固定标记用于阻止借用不属于此契约的已有 Release。 */
function releaseBody(context) {
  return `Rovloom ${context.version}\n\nCommit: ${context.commit}\n\n**Upgrade note:** Remove \`mcp.public_url\` from existing Gateway configuration before upgrading. Keeping this removed field causes \`config check\` and Gateway startup to fail with \`invalid_config\`; the old value is not ignored. Set the proxy HTTPS \`/mcp\` address in the AI client.\n\nBinaries are not publisher-signed or notarized. Verify release-manifest.json and SHA256SUMS.\n\nWith Bun installed you can also run the npm package from this release: \`bunx --package <url of rovloom-${context.version}.tgz> rovloom --version\`.\n\n<!-- rovloom-release:1 ${context.tag} ${context.commit} -->`
}

/** 在每次恢复和公开前核对资产集合、长度和 GitHub 存储端摘要；不允许同名覆盖。 */
function verifyAssets(actual, expected, complete) {
  assert(Array.isArray(actual) && actual.length <= expected.size, 'Unexpected release assets')
  const seen = new Set()
  for (const asset of actual) {
    assert(!seen.has(asset.name), 'Duplicate release asset')
    seen.add(asset.name)
    const wanted = expected.get(asset.name)
    assert(wanted, 'Unknown release asset; refusing to overwrite')
    assert.equal(asset.state, 'uploaded', 'Incomplete remote asset; inspect draft before retry')
    assert.equal(asset.size, wanted.size, 'Remote asset size differs; refusing to overwrite')
    assert.equal(asset.digest, `sha256:${wanted.sha256}`, 'Remote asset digest differs; refusing to overwrite')
  }
  if (complete) {
    assert.equal(seen.size, expected.size, 'Release assets are incomplete')
  }
  return seen
}

/** 仅在完整组装及产品收据一致后允许写操作；可恢复同字节草稿，完整已发版本只读成功。 */
export async function publish(context, bundle, api) {
  const files = new Map()
  for (const asset of bundle.manifest.assets) {
    files.set(asset.name, { ...asset, path: bundle.files.get(asset.name) })
  }
  if (bundle.npm) {
    files.set(bundle.npm.name, { ...bundle.npm })
  }
  for (const [name, contents] of [
    [manifestName, bundle.manifestBytes],
    [checksumsName, bundle.checksumsBytes]
  ]) {
    const bytes = Buffer.from(contents)
    files.set(name, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
  }
  await verifyRemoteTag(api, context)
  let release = await findRelease(api, context.tag)
  const body = releaseBody(context)
  const prerelease = context.version.includes('-')
  if (!release) {
    release = await api(`/repos/${repository}/releases`, {
      method: 'POST',
      json: {
        tag_name: context.tag,
        target_commitish: context.commit,
        name: context.tag,
        body,
        draft: true,
        prerelease
      }
    })
  }
  assert.equal(release.tag_name, context.tag)
  // 已存在 tag 时 GitHub 忽略 target_commitish；提交身份由远端 tag、说明和资产合同校验。
  assert.equal(release.body, body, 'Existing release does not belong to this contract')
  assert.equal(release.prerelease, prerelease)
  assert(Number.isSafeInteger(release.id) && release.id > 0)
  const path = `/repos/${repository}/releases/${release.id}`
  const assetsPath = `${path}/assets?per_page=100`
  const actual = await api(assetsPath)
  const present = verifyAssets(actual, files, !release.draft)
  if (!release.draft) {
    return { status: 'already-published', tag: context.tag, commit: context.commit }
  }
  for (const [name, file] of files) {
    if (present.has(name)) {
      continue
    }
    const bytes = file.bytes ?? readFileSync(file.path)
    assert.equal(bytes.length, file.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, 'Local asset changed')
    await api(`${path}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', bytes })
  }
  verifyAssets(await api(assetsPath), files, true)
  await verifyRemoteTag(api, context)
  // GitHub 按语义版本选择稳定 latest，避免后补旧 tag 强行成为最新；预发布永不设为 latest。
  const published = await api(path, {
    method: 'PATCH',
    json: { draft: false, make_latest: prerelease ? 'false' : 'legacy' }
  })
  assert.equal(published.draft, false)
  assert.equal(published.tag_name, context.tag)
  return { status: 'published', tag: context.tag, commit: context.commit }
}

/** GitHub Release 公开且字节齐全后，把同一 tag 的 tarball 发布到 npm 注册表；失败时 Release 已公开，重跑走只读路径后重试。 */
export async function publishReleaseAndNpm(context, bundle, api, env = process.env, run = undefined) {
  const release = await publish(context, bundle, api)
  if (!bundle.npm) {
    return release
  }
  return { ...release, npm: await publishNpm(bundle.npm.path, env, run) }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 4, 'Usage: bun scripts/release/publish.mjs /staged-platforms /staged-npm')
  const context = releaseContext()
  const bundle = assemble(context, resolve(process.argv[2]), resolve(process.argv[3]))
  console.log(JSON.stringify(await publishReleaseAndNpm(context, bundle, githubClient(process.env.GITHUB_TOKEN))))
}
