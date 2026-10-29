/** 隔离验证容器发布的事件、资产来源和不可覆盖边界；不登录或推送真实registry。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  image,
  indexDescriptors,
  inspectTestedImages,
  inspectVersion,
  isLatest,
  matchExistingIndex,
  releaseContext
} from '../../scripts/container/release.mjs'
import { assetName, officialReleasePlatforms } from '../../src/release/contract.ts'

/** 内存元数据严格对应现行发布合同，fake二进制只测字节验证，不作为产品验收。 */
function fixture(npm = false) {
  const context = { tag: 'v0.1.0', version: '0.1.0', commit: 'a'.repeat(40) }
  const run = {
    id: 7,
    name: 'Tagged product release',
    event: 'push',
    conclusion: 'success',
    status: 'completed',
    head_sha: context.commit,
    head_branch: context.tag,
    path: '.github/workflows/release.yml',
    repository: { full_name: 'ArnoChenFx/rovloom' },
    head_repository: { full_name: 'ArnoChenFx/rovloom' }
  }
  const bytes = Buffer.from('synthetic-container-binary')
  const hash = /** 合成内容仍由真实摘要算法核验。 */ (value) => createHash('sha256').update(value).digest('hex')
  // 覆盖资产契约的全部八个平台（Linux x64/arm64 各有 glibc 与 musl），名称由契约生成。
  const assets = officialReleasePlatforms().map(
    /** 不在JSON中引入下载URL。 */ (platform) => ({
      ...platform,
      name: assetName(context.version, platform),
      size: bytes.length,
      sha256: hash(bytes)
    })
  )
  const manifest = Buffer.from(
    JSON.stringify({ schemaVersion: 1, repository: 'ArnoChenFx/rovloom', ...context, bun: '1.4.3', assets }) + '\n'
  )
  const files = new Map(assets.map((asset) => [asset.name, bytes]))
  files.set('release-manifest.json', manifest)
  if (npm) {
    files.set(`rovloom-${context.version}.tgz`, Buffer.from('synthetic-npm-tarball'))
  }
  const sums = Buffer.from([...files].map(([name, data]) => `${hash(data)}  ${name}\n`).join(''))
  files.set('SHA256SUMS', sums)
  const release = {
    draft: false,
    prerelease: false,
    tag_name: context.tag,
    target_commitish: 'main',
    body: `fixture <!-- rovloom-release:1 ${context.tag} ${context.commit} -->`,
    assets: [...files].map(([name, data]) => ({
      name,
      size: data.length,
      digest: `sha256:${hash(data)}`,
      state: 'uploaded',
      browser_download_url: `https://github.com/ArnoChenFx/rovloom/releases/download/${context.tag}/${name}`
    }))
  }
  const event = { repository: { full_name: 'ArnoChenFx/rovloom' }, workflow_run: structuredClone(run) }
  const api = /** 只响应实际验证路径，意外网络路径立即失败。 */ async (path) => {
    if (path.endsWith('/actions/runs/7')) {
      return structuredClone(run)
    }
    if (path.includes('/git/ref/tags/')) {
      return { object: { type: 'commit', sha: run.head_sha } }
    }
    if (path.includes('/releases/')) {
      return structuredClone(release)
    }
    assert.fail('unexpected container metadata path')
  }
  const request = async (url, options) => {
    const base = `https://github.com/ArnoChenFx/rovloom/releases/download/${context.tag}/`
    assert(url.startsWith(base))
    assert.equal(options.headers, undefined, 'Public metadata downloads must not carry credentials')
    const data = files.get(url.slice(base.length))
    assert(data, 'Unexpected metadata download')
    return new Response(data)
  }
  return { context, run, event, api, request, release, manifest, sums, bytes, files, hash }
}

test(
  'container publisher only targets GHCR and accepts the exact successful official tag workflow',
  /** 无真实registry请求。 */ async () => {
    const f = fixture()
    assert.equal(image, 'ghcr.io/arnochenfx/rovloom')
    assert.deepEqual(await releaseContext(f.event, f.api, f.request), f.context)
    for (const mutation of [
      'fork',
      'pull_request',
      'failed',
      'workflow',
      'branch',
      'moved',
      'draft',
      'foreign-asset'
    ]) {
      const changed = fixture()
      if (mutation === 'fork') {
        changed.event.workflow_run.head_repository.full_name = 'fork/Rovloom'
      }
      if (mutation === 'pull_request') {
        changed.event.workflow_run.event = 'pull_request'
      }
      if (mutation === 'failed') {
        changed.event.workflow_run.conclusion = 'failure'
      }
      if (mutation === 'workflow') {
        changed.run.path = '.github/workflows/fake.yml'
      }
      if (mutation === 'branch') {
        changed.event.workflow_run.head_branch = changed.run.head_branch = 'main'
      }
      if (mutation === 'moved') {
        changed.run.head_sha = 'b'.repeat(40)
      }
      if (mutation === 'draft') {
        changed.release.draft = true
      }
      if (mutation === 'foreign-asset') {
        changed.release.assets[0].browser_download_url = 'https://example.invalid/payload'
      }
      await assert.rejects(releaseContext(changed.event, changed.api, changed.request), mutation)
    }
  }
)

test(
  'container release identity follows the remote tag and contract rather than the creation target hint',
  /** 创建提示可以是分支或旧提交，但真实标签与说明中的提交必须始终匹配成功的工作流。 */ async () => {
    const f = fixture()
    for (const hint of ['main', 'release/0.1', f.context.commit, 'b'.repeat(40)]) {
      f.release.target_commitish = hint
      assert.deepEqual(await releaseContext(f.event, f.api, f.request), f.context)
    }
    await assert.rejects(
      releaseContext(
        f.event,
        /** 单独移动远端标签，保留工作流与 Release 创建提示，确认仍拒绝错误提交。 */ async (path) =>
          path.includes('/git/ref/tags/') ? { object: { type: 'commit', sha: 'b'.repeat(40) } } : f.api(path),
        f.request
      ),
      /Remote tag moved from the event commit/u
    )
    f.release.body = `fixture <!-- rovloom-release:1 ${f.context.tag} ${'b'.repeat(40)} -->`
    await assert.rejects(releaseContext(f.event, f.api, f.request))
  }
)

test(
  'container latest follows the current official stable Release',
  /** 补发旧版本与预发行不抢latest。 */ async () => {
    const f = fixture()
    assert.equal(await isLatest(f.context, f.api), true)
    f.release.tag_name = 'v0.2.0'
    assert.equal(await isLatest(f.context, f.api), false)
    assert.equal(await isLatest({ ...f.context, version: '0.2.0-rc.1' }, f.api), false)
  }
)

test('container publisher accepts legacy assets and a checksummed same-version npm tarball', async () => {
  for (const npm of [false, true]) {
    const f = fixture(npm)
    // 八项二进制 + 清单 + 校验和，npm tarball 可选。
    assert.equal(f.release.assets.length, officialReleasePlatforms().length + 2 + (npm ? 1 : 0))
    assert.deepEqual(await releaseContext(f.event, f.api, f.request), f.context)
  }
})

test('container publisher rejects extra, duplicate, incomplete or mismatched release bytes', async () => {
  for (const mutation of [
    'extra',
    'duplicate',
    'missing',
    'tarball-name',
    'tarball-digest',
    'size',
    'digest',
    'checksum',
    'manifest',
    'manifest-commit',
    'download',
    'oversize'
  ]) {
    const f = fixture(true)
    const npm = f.release.assets.find((asset) => asset.name.endsWith('.tgz'))
    if (mutation === 'extra') {
      f.release.assets.push({ ...npm, name: 'unexpected.tgz' })
    }
    if (mutation === 'duplicate') {
      f.release.assets.push({ ...npm })
    }
    if (mutation === 'missing') {
      f.release.assets.shift()
    }
    if (mutation === 'tarball-name') {
      npm.name = 'rovloom-9.9.9.tgz'
    }
    if (mutation === 'tarball-digest') {
      npm.digest = 'sha256:' + 'f'.repeat(64)
    }
    if (mutation === 'size') {
      f.release.assets[0].size++
    }
    if (mutation === 'digest') {
      f.release.assets[0].digest = null
    }
    if (mutation === 'checksum') {
      f.files.set('SHA256SUMS', Buffer.from('corrupt'))
    }
    if (mutation === 'manifest') {
      f.files.set('release-manifest.json', Buffer.from('corrupt'))
    }
    if (mutation === 'manifest-commit') {
      const bytes = Buffer.from(f.manifest.toString().replace(f.context.commit, 'b'.repeat(40)))
      f.files.set('release-manifest.json', bytes)
      const asset = f.release.assets.find((value) => value.name === 'release-manifest.json')
      asset.size = bytes.length
      asset.digest = 'sha256:' + f.hash(bytes)
    }
    const request =
      mutation === 'download'
        ? async () => new Response('', { status: 503 })
        : mutation === 'oversize'
          ? async () => new Response(new Uint8Array(1_048_577))
          : f.request
    await assert.rejects(releaseContext(f.event, f.api, request), mutation)
  }
})

test('manual recovery resolves an official successful run and rechecks its tag and assets', async () => {
  const f = fixture(true)
  const event = { repository: f.event.repository, inputs: { release_run_id: '7' } }
  assert.deepEqual(await releaseContext(event, f.api, f.request), f.context)
  for (const id of ['', '0', '-1', '7.0', '7/payload', '9007199254740992']) {
    await assert.rejects(releaseContext({ ...event, inputs: { release_run_id: id } }, f.api, f.request))
  }
  f.run.conclusion = 'failure'
  await assert.rejects(releaseContext(event, f.api, f.request))
})

/** 合成registry只交付固定manifest/config摘要；不会构建或推送真实镜像。 */
function registryFixture(mode = 'matching') {
  const context = fixture().context
  const stem = `build-${context.commit}-9-1`
  const configurations = { amd64: 'sha256:' + 'c'.repeat(64), arm64: 'sha256:' + 'd'.repeat(64) }
  const mediaType = 'application/vnd.docker.distribution.manifest.v2+json'
  const bodies = Object.fromEntries(
    ['amd64', 'arm64'].map(
      /** 字节决定descriptor，不手填无关联digest。 */ (arch) => [
        arch,
        JSON.stringify({ schemaVersion: 2, mediaType, config: { digest: configurations[arch] } })
      ]
    )
  )
  const index = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
    manifests: ['amd64', 'arm64'].map(
      /** 两个原生平台各占唯一项。 */ (arch) => ({
        mediaType,
        size: Buffer.byteLength(bodies[arch]),
        digest: 'sha256:' + createHash('sha256').update(bodies[arch]).digest('hex'),
        platform: { os: 'linux', architecture: arch }
      })
    )
  }
  if (mode === 'different') {
    index.manifests[0].digest = 'sha256:' + 'e'.repeat(64)
  }
  if (mode === 'extra') {
    index.manifests.push(structuredClone(index.manifests[0]))
  }
  const requests = []
  const request = /** 认证和manifest读取全部在内存，无外部凭据。 */ async (url, options) => {
    requests.push({ url, options })
    if (url.startsWith('https://ghcr.io/token?')) {
      return Response.json({ token: 'synthetic-registry-token' }, { status: mode === 'auth' ? 403 : 200 })
    }
    if (url.endsWith('/manifests/0.1.0')) {
      if (mode === 'absent') {
        return Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status: 404 })
      }
      if (mode === 'forbidden' || mode === 'unavailable') {
        return new Response('', { status: mode === 'forbidden' ? 403 : 503 })
      }
      if (mode === 'unknown-error') {
        return Response.json({ errors: [{ code: 'DENIED' }] }, { status: 404 })
      }
      return Response.json(index)
    }
    for (const arch of ['amd64', 'arm64']) {
      if (url.endsWith('/manifests/' + stem + '-' + arch)) {
        return new Response(
          mode === 'config' ? bodies[arch].replace(configurations[arch], 'sha256:' + 'f'.repeat(64)) : bodies[arch]
        )
      }
    }
    assert.fail('unexpected synthetic registry path')
  }
  return { context, stem, configurations, index, requests, request }
}

test(
  'GHCR preflight accepts absence or a valid index; authorization and uncertain lookups fail',
  /** 不把网络失败当作未发布。 */ async () => {
    for (const mode of ['absent', 'matching', 'forbidden', 'unavailable', 'unknown-error', 'auth', 'extra']) {
      const r = registryFixture(mode)
      const work = inspectVersion('0.1.0', 'synthetic-actor', 'synthetic-github-token', r.request)
      if (mode === 'absent') {
        assert.equal(await work, null)
      } else if (mode === 'matching') {
        assert.deepEqual(await work, indexDescriptors(r.index))
      } else {
        await assert.rejects(work)
      }
      assert(
        r.requests.every(
          /** 凭据只发固定GHCR，禁止跳转。 */ ({ url, options }) =>
            url.startsWith('https://ghcr.io/') && options.redirect === 'error'
        )
      )
    }
  }
)

test(
  'a published version resumes latest only for the exact two tested image manifests',
  /** 已公开版本不因恢复latest被重写。 */ async () => {
    for (const mode of ['matching', 'absent', 'different', 'extra', 'config']) {
      const r = registryFixture(mode)
      const work = inspectTestedImages(
        r.context,
        'synthetic-actor',
        'synthetic-github-token',
        r.stem,
        r.configurations,
        r.request
      )
      if (mode === 'matching') {
        assert.equal(await work, true)
      } else if (mode === 'absent') {
        assert.equal(await work, false)
      } else {
        await assert.rejects(work)
      }
    }
    const r = registryFixture()
    const expected = indexDescriptors(r.index)
    assert.equal(matchExistingIndex(null, expected), false)
    assert.equal(matchExistingIndex(expected, expected), true)
    const variant = structuredClone(r.index)
    variant.manifests[1].platform.variant = 'v8'
    assert.deepEqual(indexDescriptors(variant), expected)
    variant.manifests[1].platform.variant = 'v9'
    assert.throws(/** 未验收架构变体不得假装同一平台。 */ () => indexDescriptors(variant))
  }
)
