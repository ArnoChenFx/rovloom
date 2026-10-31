/** 用隔离资产和内存 GitHub 验证版本契约与草稿提交，不创建真实 tag 或 Release。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  assemble,
  assertPlatformMatrix,
  assetName,
  encode,
  fileMetadata,
  platforms,
  releaseContext,
  repository,
  validateProductVersion,
  versionFromTag
} from '../../scripts/release/metadata.mjs'
import { productSmokePath } from '../../scripts/release/package.mjs'
import { githubClient, verifyRemoteTag } from '../../scripts/release/github.mjs'
import { publish, releaseBody } from '../../scripts/release/publish.mjs'
import { officialReleaseAssetName, officialReleasePlatforms, releasePlatform } from '../../src/release/contract.ts'

const context = { tag: 'v0.1.1', version: '0.1.1', commit: 'a'.repeat(40) }

/** 只在系统临时目录生成小型假二进制与摘要收据，始终清理，不当作产品验收。 */
function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'rovloom-release-contract-'))
  for (const platform of platforms) {
    const folder = resolve(directory, platform.target)
    mkdirSync(folder)
    const name = assetName(context.version, platform)
    const path = resolve(folder, name)
    writeFileSync(path, `test-only-${platform.target}`)
    const asset = { os: platform.os, arch: platform.arch, libc: platform.libc, name, ...fileMetadata(path) }
    writeFileSync(resolve(folder, 'receipt.json'), encode({ ...context, target: platform.target, asset }))
  }
  return {
    directory,
    cleanup: /** 测试无论通过失败均删除临时数据。 */ () => rmSync(directory, { recursive: true, force: true })
  }
}

/** 内存模拟只接受本仓库固定 API；逐次记录所有写入，供原子公开和重跑断言。 */
function remote() {
  const state = {
    release: undefined,
    assets: [],
    writes: [],
    tagReads: 0,
    tagCommit: context.commit,
    failUpload: 0,
    moveTag: false,
    omitDigest: false
  }
  /** 按真实 Release API 的路径分发，上传失败保留草稿而非制造已公开结果。 */
  const api = async (path, options = {}) => {
    assert(path.startsWith(`/repos/${repository}/`))
    const { method = 'GET', json, bytes } = options
    if (method !== 'GET') {
      state.writes.push({ method, path, json })
    }
    if (path.includes('/git/ref/tags/')) {
      state.tagReads++
      return { object: { type: 'commit', sha: state.moveTag && state.tagReads > 1 ? 'b'.repeat(40) : state.tagCommit } }
    }
    if (method === 'GET' && path.includes('/releases?')) {
      return state.release ? [structuredClone(state.release)] : []
    }
    if (method === 'GET' && path.endsWith('/assets?per_page=100')) {
      return structuredClone(state.assets)
    }
    if (method === 'POST' && path.endsWith('/releases')) {
      assert.equal(json.draft, true)
      state.release = { id: 1, ...json, target_commitish: 'main' }
      return structuredClone(state.release)
    }
    if (method === 'POST' && path.includes('/assets?name=')) {
      if (state.failUpload && state.assets.length === state.failUpload) {
        throw new Error('simulated upload failure')
      }
      const name = decodeURIComponent(path.split('?name=')[1])
      assert(!state.assets.some(/** 模拟 GitHub 同名资产不可覆盖。 */ (asset) => asset.name === name))
      const digest = state.omitDigest ? null : `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      const asset = { id: state.assets.length + 1, name, size: bytes.length, digest, state: 'uploaded' }
      state.assets.push(asset)
      return structuredClone(asset)
    }
    if (method === 'PATCH' && path.endsWith('/releases/1')) {
      assert.equal(state.assets.length, platforms.length + 2)
      state.release = { ...state.release, ...json }
      return structuredClone(state.release)
    }
    throw new Error(`Unexpected mock API call: ${method} ${path}`)
  }
  return { state, api }
}

test(
  'canonical SemVer rejects aliases, unsafe numbers, path input and leading zeros',
  /** 覆盖真实 tag 边界。 */ () => {
    for (const tag of ['v0.1.1', 'v1.0.0-rc.1', 'v1.2.3-0', 'v10.2.3-alpha-1']) {
      assert.equal(versionFromTag(tag), tag.slice(1))
    }
    for (const tag of [
      '',
      '0.1.1',
      'v01.1.1',
      'v1.1.1+build',
      'v1.0',
      'v1.0.0-01',
      'v1.0.0-a..b',
      'v1.0.0-',
      'v1.0.0\n',
      'v1.0.0/other',
      'v9007199254740992.0.0',
      'v1.0.0-9007199254740992'
    ]) {
      assert.throws(/** 非规范或不能准确比较的版本必须失败。 */ () => versionFromTag(tag))
    }
  }
)

test(
  'release context binds official repository, tag push ref and full commit',
  /** 分支与其它仓库不具备发行资格。 */ () => {
    const env = {
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF: `refs/tags/${context.tag}`,
      GITHUB_SHA: context.commit
    }
    assert.deepEqual(releaseContext(env), context)
    for (const override of [
      { GITHUB_REPOSITORY: 'fork/Rovloom' },
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
      { GITHUB_REF_TYPE: 'branch' },
      { GITHUB_REF: 'refs/heads/v0.1.1' },
      { GITHUB_SHA: 'aaaaaaa' }
    ]) {
      assert.throws(/** 任一来源字段不匹配即拒绝。 */ () => releaseContext({ ...env, ...override }))
    }
  }
)

test(
  'tag, package version and actual exported PRODUCT_VERSION must all match',
  /** 读取真实模块导出，不凭文本匹配伪造版本。 */ async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'rovloom-version-'))
    try {
      mkdirSync(resolve(directory, 'src/mcp'), { recursive: true })
      writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ version: context.version }))
      writeFileSync(resolve(directory, 'src/mcp/version.ts'), `export const PRODUCT_VERSION = '${context.version}'\n`)
      await validateProductVersion(context, directory)
      await assert.rejects(
        validateProductVersion({ ...context, version: '0.1.2' }, directory),
        /package.json version differ/u
      )
      writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ version: '0.1.2' }))
      await assert.rejects(
        validateProductVersion({ ...context, version: '0.1.2' }, directory),
        /PRODUCT_VERSION differ/u
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  'eight platform names identify native target and libc without ambiguous aliases',
  /** 固定支持矩阵与下载名：Linux 每种架构各有 glibc 与 musl，两者不能共用同名资产。 */ () => {
    assert.equal(platforms.length, 8)
    assert.equal(
      new Set(platforms.map(/** 每个 OS/arch/libc 只能出现一次。 */ (item) => `${item.os}-${item.arch}-${item.libc}`))
        .size,
      8
    )
    for (const platform of platforms) {
      assert.equal(platform.target, `bun-${platform.os}-${platform.arch}${platform.libc === 'musl' ? '-musl' : ''}`)
      assert.equal(platform.libc, platform.os === 'linux' ? platform.libc : null)
      assert(['glibc', 'musl'].includes(platform.libc) || platform.libc === null)
      const name = assetName(context.version, platform)
      assert.match(name, /^rovloom-0\.1\.1-(?:linux|darwin|windows)-(?:x64|arm64)(?:-musl)?(?:\.exe)?$/u)
      // musl 后缀只属于 Linux，Windows 的 .exe 只属于 Windows，二者不会互相污染。
      assert.equal(name.includes('-musl'), platform.os === 'linux' && platform.libc === 'musl')
      assert.equal(name.endsWith('.exe'), platform.os === 'windows')
      assert(officialReleaseAssetName(context.version, name))
    }
    assertPlatformMatrix()
    // glibc 与 musl 在相同版本/OS/arch 下必须得到不同资产名，否则发行会撞名。
    assert.notEqual(
      assetName(context.version, { os: 'linux', arch: 'x64', libc: 'glibc' }),
      assetName(context.version, { os: 'linux', arch: 'x64', libc: 'musl' })
    )
    assert.deepEqual(
      officialReleasePlatforms().map((item) => `${item.os}-${item.arch}-${item.libc}`),
      [
        'linux-x64-glibc',
        'linux-x64-musl',
        'linux-arm64-glibc',
        'linux-arm64-musl',
        'darwin-x64-null',
        'darwin-arm64-null',
        'windows-x64-null',
        'windows-arm64-null'
      ]
    )
    for (const bad of [
      /** 未知 libc、非 Linux 携带 libc、非规范 os/arch 一律拒绝。 */ { os: 'linux', arch: 'x64', libc: 'uclibc' },
      { os: 'linux', arch: 'x64', libc: null },
      { os: 'darwin', arch: 'x64', libc: 'musl' },
      { os: 'linux', arch: 'armv7', libc: 'glibc' }
    ]) {
      assert.throws(() => assetName(context.version, bad))
      assert.throws(() => releasePlatform(bad.os, bad.arch, bad.libc))
    }
    assert(!officialReleaseAssetName(context.version, `rovloom-0.1.1-linux-x64-uclibc`))
  }
)

test(
  'real product hook is mandatory; preview, probe and omitted Worker cannot release',
  /** 无产品接线时必须阻断。 */ () => {
    const specification = {
      entrypoint: 'src/cli/main.ts',
      workers: ['src/connector/luvus/contract/compiler-worker.ts', 'src/connector/herdr/compiler-herdr-worker.ts'],
      releaseSmoke: null
    }
    assert.throws(/** 当前未接线产品不能发行。 */ () => productSmokePath(specification), /preview cannot release/u)
    assert.throws(
      /** 测试入口不能成为产品。 */ () => productSmokePath({ ...specification, entrypoint: 'test/release/probe.mjs' })
    )
    assert.throws(/** 禁止省略真实 schema Worker。 */ () => productSmokePath({ ...specification, workers: [] }))
    assert.throws(
      /** 只带Luvus工厂不能交付真实Herdr双角色验收。 */ () =>
        productSmokePath({
          ...specification,
          workers: ['src/connector/luvus/contract/compiler-worker.ts'],
          releaseSmoke: 'scripts/release/product-smoke.mjs'
        }),
      /Real Herdr schema Worker is required/u
    )
    assert.throws(
      /** 验收脚本必须属于维护的发行工具目录。 */ () =>
        productSmokePath({ ...specification, releaseSmoke: 'test/release/probe.mjs' }),
      /Expected maintained product smoke script/u
    )
    assert.equal(productSmokePath(), resolve('scripts/release/product-smoke.mjs'))
  }
)

test(
  'manifest and SHA256SUMS are deterministic, complete and derived from actual bytes',
  /** 元数据只承载公开字段。 */ () => {
    const temporary = fixture()
    try {
      const bundle = assemble(context, temporary.directory)
      assert.equal(bundle.manifestBytes, assemble(context, temporary.directory).manifestBytes)
      assert.equal(bundle.checksumsBytes, assemble(context, temporary.directory).checksumsBytes)
      assert.equal(bundle.manifest.assets.length, platforms.length)
      assert.equal(bundle.manifest.assets.length, 8)
      assert.deepEqual(Object.keys(bundle.manifest), [
        'schemaVersion',
        'repository',
        'tag',
        'version',
        'commit',
        'bun',
        'assets'
      ])
      for (const asset of bundle.manifest.assets) {
        assert.deepEqual(Object.keys(asset), ['os', 'arch', 'libc', 'name', 'size', 'sha256'])
        assert.equal(readFileSync(bundle.files.get(asset.name)).length, asset.size)
        assert(bundle.checksumsBytes.includes(`${asset.sha256}  ${asset.name}\n`))
      }
      assert(bundle.checksumsBytes.endsWith(`  release-manifest.json\n`))
    } finally {
      temporary.cleanup()
    }
  }
)

test(
  'aggregation rejects missing targets, foreign files, wrong-version receipts and truncated binaries',
  /** 不完整矩阵不可能进入发布。 */ () => {
    for (const mutation of ['missing', 'extra', 'receipt', 'binary']) {
      const temporary = fixture()
      try {
        const platform = platforms[0]
        const folder = resolve(temporary.directory, platform.target)
        if (mutation === 'missing') {
          rmSync(folder, { recursive: true })
        }
        if (mutation === 'extra') {
          writeFileSync(resolve(folder, 'private-config.json'), '{}')
        }
        if (mutation === 'receipt') {
          const path = resolve(folder, 'receipt.json')
          writeFileSync(path, encode({ ...JSON.parse(readFileSync(path)), commit: 'b'.repeat(40) }))
        }
        if (mutation === 'binary') {
          writeFileSync(resolve(folder, assetName(context.version, platform)), 'truncated')
        }
        assert.throws(/** 所有变更都必须在任何网络写入之前失败。 */ () => assemble(context, temporary.directory))
      } finally {
        temporary.cleanup()
      }
    }
  }
)

test(
  'publication uploads exact full set as draft then publishes; identical rerun writes nothing',
  /** 验证原子公开与幂等重跑。 */ async () => {
    const temporary = fixture()
    try {
      const bundle = assemble(context, temporary.directory)
      const { api, state } = remote()
      assert.equal((await publish(context, bundle, api)).status, 'published')
      assert.equal(state.writes[0].json.draft, true)
      assert.equal(state.writes[0].json.target_commitish, context.commit)
      assert.equal(state.release.target_commitish, 'main')
      assert.equal(state.writes.at(-1).method, 'PATCH')
      assert.equal(state.writes.at(-1).json.make_latest, 'legacy')
      const writes = state.writes.length
      assert.equal((await publish(context, bundle, api)).status, 'already-published')
      assert.equal(state.writes.length, writes)
    } finally {
      temporary.cleanup()
    }
  }
)

test(
  'interrupted upload remains draft and resumes only missing identical assets',
  /** 不删除已验证资产或覆盖同名内容。 */ async () => {
    const temporary = fixture()
    try {
      const bundle = assemble(context, temporary.directory)
      const { api, state } = remote()
      state.failUpload = 2
      await assert.rejects(publish(context, bundle, api), /simulated upload failure/u)
      assert.equal(state.release.draft, true)
      assert.equal(state.assets.length, 2)
      state.failUpload = 0
      await publish(context, bundle, api)
      assert.equal(state.release.draft, false)
      // 八项二进制 + 清单 + 校验和（无 npm tarball 时）。
      assert.equal(state.assets.length, platforms.length + 2)
    } finally {
      temporary.cleanup()
    }
  }
)

test(
  'draft resume and published rerun ignore creation target hints after verifying the actual tag',
  /** 分支头变化或无关创建提示不能替代真实标签身份，也不能破坏同字节草稿恢复及只读重跑。 */ async () => {
    const temporary = fixture()
    try {
      const bundle = assemble(context, temporary.directory)
      for (const hint of ['release/0.1', context.commit, 'b'.repeat(40)]) {
        const { api, state } = remote()
        state.failUpload = 2
        await assert.rejects(publish(context, bundle, api), /simulated upload failure/u)
        state.failUpload = 0
        state.release.target_commitish = hint
        assert.equal((await publish(context, bundle, api)).status, 'published')
        const writes = state.writes.length
        assert.equal((await publish(context, bundle, api)).status, 'already-published')
        assert.equal(state.writes.length, writes)
      }
    } finally {
      temporary.cleanup()
    }
  }
)

test(
  'conflicting published or draft bytes, digest absence and foreign release are never overwritten',
  /** 冲突后零新增写入。 */ async () => {
    for (const mutation of ['size', 'digest', 'unknown', 'body', 'commit', 'published']) {
      const temporary = fixture()
      try {
        const bundle = assemble(context, temporary.directory)
        const { api, state } = remote()
        state.failUpload = 2
        await assert.rejects(publish(context, bundle, api))
        state.failUpload = 0
        if (mutation === 'size') {
          state.assets[0].size++
        }
        if (mutation === 'digest') {
          state.assets[0].digest = null
        }
        if (mutation === 'unknown') {
          state.assets[0].name = 'foreign-file'
        }
        if (mutation === 'body') {
          state.release.body = 'manual release'
        }
        if (mutation === 'commit') {
          state.tagCommit = 'b'.repeat(40)
        }
        if (mutation === 'published') {
          state.release.draft = false
        }
        const writes = state.writes.length
        await assert.rejects(publish(context, bundle, api))
        assert.equal(state.writes.length, writes)
      } finally {
        temporary.cleanup()
      }
    }
  }
)

test(
  'a tag moved during uploads or missing server digests never publishes the draft',
  /** 最终远端检查失败保留草稿。 */ async () => {
    for (const mutation of ['tag', 'digest']) {
      const temporary = fixture()
      try {
        const { api, state } = remote()
        state.moveTag = mutation === 'tag'
        state.omitDigest = mutation === 'digest'
        await assert.rejects(publish(context, assemble(context, temporary.directory), api))
        assert.equal(state.release.draft, true)
        assert(!state.writes.some(/** 没有任何公开草稿的 PATCH。 */ (write) => write.method === 'PATCH'))
      } finally {
        temporary.cleanup()
      }
    }
  }
)

test(
  'annotated tag peeling is bounded and must resolve to the event commit',
  /** 标签对象不能替代提交身份。 */ async () => {
    const calls = []
    await verifyRemoteTag(
      /** 只允许一次标签对象解引用。 */ async (path) => {
        calls.push(path)
        return {
          object: calls.length === 1 ? { type: 'tag', sha: 'c'.repeat(40) } : { type: 'commit', sha: context.commit }
        }
      },
      context
    )
    assert.equal(calls.length, 2)
    await assert.rejects(
      verifyRemoteTag(
        /** 循环标签必须有界失败。 */ async () => ({ object: { type: 'tag', sha: 'c'.repeat(40) } }),
        context
      )
    )
    await assert.rejects(
      verifyRemoteTag(
        /** 移动的轻量标签必须在创建草稿前失败。 */ async () => ({ object: { type: 'commit', sha: 'b'.repeat(40) } }),
        context
      )
    )
  }
)

test(
  'GitHub transport fixes official hosts, disables redirects and redacts HTTP errors',
  /** 短期凭据不进入自定义源或错误原文。 */ async () => {
    const requests = []
    const api = githubClient(
      'test-only-token',
      /** 记录请求而不发送网络数据。 */ async (url, options) => {
        requests.push({ url, options })
        return new Response('{}', { status: 200 })
      }
    )
    await api(`/repos/${repository}/releases`)
    await api(`/repos/${repository}/releases/1/assets?name=test`, { method: 'POST', bytes: Buffer.from('test') })
    assert.equal(requests[0].url, `https://api.github.com/repos/${repository}/releases`)
    assert.equal(requests[1].url, `https://uploads.github.com/repos/${repository}/releases/1/assets?name=test`)
    assert(requests.every(/** 所有凭据请求禁止自动跳转。 */ ({ options }) => options.redirect === 'error'))
    await assert.rejects(api('/repos/foreign/repo/releases'))
    const failed = githubClient(
      'test-only-token',
      /** 模拟含秘密的失败响应，外部错误不能泄漏。 */ async () => new Response('private-raw-body', { status: 403 })
    )
    await assert.rejects(
      failed(`/repos/${repository}/releases`),
      /** 只允许固定 HTTP 状态诊断。 */ (error) => {
        assert.match(error.message, /GitHub API GET failed \(403\)/u)
        assert(!error.message.includes('private-raw-body'))
        return true
      }
    )
  }
)

test('Release 说明按版本生成：没有该版本条目就不带升级提示，不同版本不沿用彼此要点', () => {
  // 0.6.7 是真正删除 public_url 的版本，提示只属于它。
  const legacy = releaseBody({ tag: 'v0.6.7', version: '0.6.7', commit: 'a'.repeat(40) })
  assert.match(legacy, /Upgrade note:\*\* Remove `mcp\.public_url`/u)
  assert(!legacy.includes('wait.output'))
  // 0.6.8 不再重复 public_url 提示，改说自己版本的变更。
  const current = releaseBody({ tag: 'v0.6.8', version: '0.6.8', commit: 'a'.repeat(40) })
  assert(!current.includes('mcp.public_url'))
  assert.match(current, /wait\.output/u)
  assert.match(current, /host_profile/u)
  assert.match(current, /35-method Luvus grants keep their original scope/u)
  // 0.6.9 只讲自己的变更：设备范围、契约拒绝、逻辑 CPU 语义；不沿用 0.6.8 的要点。
  const latest = releaseBody({ tag: 'v0.6.9', version: '0.6.9', commit: 'c'.repeat(40) })
  assert(!latest.includes('wait.output'))
  assert(!latest.includes('35-method Luvus grants'))
  assert(!latest.includes('mcp.public_url'))
  assert.match(latest, /token scope/u)
  assert.match(latest, /logical CPU count/u)
  assert.match(latest, /does not convert old reports/u)
  // 0.7.0 是授权模型替换与 schema 自动回收的版本，只讲自己的变更与真正的回滚边界。
  const major = releaseBody({ tag: 'v0.7.0', version: '0.7.0', commit: 'd'.repeat(40) })
  assert(!major.includes('wait.output'))
  assert(!major.includes('35-method Luvus grants'))
  assert(!major.includes('mcp.public_url'))
  assert(!major.includes('logical CPU count'))
  assert.match(major, /token device scope/u)
  assert.match(major, /schema v2/u)
  assert.match(major, /control\/<provider>\//u)
  assert.match(major, /no re-pairing is needed/u)
  assert.match(major, /runtime_response_discard/u)
  assert.match(major, /restoring the same pre-upgrade backup/u)
  // 0.7.1 只讲审核参数 schema、subset_revision 与 CPU 配额；不沿用 0.7.0 的授权模型提示。
  const minor = releaseBody({ tag: 'v0.7.1', version: '0.7.1', commit: 'e'.repeat(40) })
  assert(!minor.includes('token device scope'))
  assert(!minor.includes('schema v2'))
  assert(!minor.includes('control/<provider>/'))
  assert.match(minor, /x-maxUtf8Bytes/u)
  assert.match(minor, /subset_revision/u)
  assert.match(minor, /cpu_quota_status/u)
  assert.match(minor, /never proof of unlimited capacity/u)
  // 0.8.0 只讲 musl 资产与安装器；不沿用 0.7.1 的审核参数与 CPU 配额提示。
  const musl = releaseBody({ tag: 'v0.8.0', version: '0.8.0', commit: 'f'.repeat(40) })
  assert(!musl.includes('x-maxUtf8Bytes'))
  assert(!musl.includes('subset_revision'))
  assert(!musl.includes('cpu_quota_status'))
  assert(!musl.includes('token device scope'))
  assert.match(musl, /linux-x64-musl/u)
  assert.match(musl, /linux-arm64-musl/u)
  assert.match(musl, /glibc, macOS and Windows asset names and bytes are unchanged/u)
  assert.match(musl, /apk add libstdc\+\+/u)
  assert.match(musl, /owned_pidfd_unavailable/u)
  assert.match(musl, /pidfd_open/u)
  // 0.8.1 只讲参数诊断、写锁与依赖修复；不沿用 0.8.0 的 musl 要点。
  const patch = releaseBody({ tag: 'v0.8.1', version: '0.8.1', commit: 'e'.repeat(40) })
  assert.match(patch, /details\.issues/u)
  assert.match(patch, /params_schema_source: rovloom_reviewed_subset/u)
  assert.match(patch, /kernel `flock`/u)
  assert.match(patch, /never run two Gateways on the same data/u)
  assert(!patch.includes('linux-x64-musl'))
  assert(!patch.includes('owned_pidfd_unavailable'))
  assert(!patch.includes('x-maxUtf8Bytes'))
  // 0.8.2 只讲 Luvus 参数校验收敛为审核 schema 一份；不沿用 0.8.1 的诊断、写锁与依赖要点。
  const single = releaseBody({ tag: 'v0.8.2', version: '0.8.2', commit: 'd'.repeat(40) })
  assert.match(single, /single definition/u)
  assert.match(single, /162,300/u)
  assert.match(single, /luvus_operation_params_invalid/u)
  assert.match(single, /Nothing to migrate and no behaviour change is expected/u)
  assert(!single.includes('kernel `flock`'))
  assert(!single.includes('details.issues'))
  assert(!single.includes('never run two Gateways on the same data'))
  // 0.9.0 只讲终端执行开关默认开启与升级影响；不沿用 0.8.2 的 Luvus 参数校验要点。
  const switchOn = releaseBody({ tag: 'v0.9.0', version: '0.9.0', commit: 'e'.repeat(40) })
  assert.match(switchOn, /allow_terminal_execution/u)
  assert.match(switchOn, /now defaults to on/u)
  assert.match(switchOn, /only the literal `false`/u)
  assert.match(switchOn, /"allow_terminal_execution": false/u)
  assert.match(switchOn, /already contains `allow_terminal_execution` explicitly/u)
  assert(!switchOn.includes('single definition'))
  assert(!switchOn.includes('162,300'))
  assert(!switchOn.includes('luvus_operation_params_invalid'))
  assert(!switchOn.includes('Nothing to migrate and no behaviour change is expected'))
  // 0.10.0 只讲 herdr-core 与 mixed 的变化；不沿用 0.9.0 的终端开关要点。
  const core = releaseBody({ tag: 'v0.10.0', version: '0.10.0', commit: 'f'.repeat(40) })
  assert.match(core, /herdr-core is a third runtime/u)
  assert.match(core, /16 methods/u)
  assert.match(core, /no limit on the core version or protocol generation/u)
  assert.match(core, /`mixed` now means every provider the platform supports/u)
  assert.match(core, /do not need to pair again/u)
  assert.match(core, /herdr_core_installation_changed/u)
  assert(!core.includes('now defaults to on'))
  assert(!core.includes('already contains `allow_terminal_execution` explicitly'))
  assert(!core.includes('single definition'))
  // 未登记的版本不继承任何旧提示，只保留固定的公共段落与契约标记。
  const future = releaseBody({ tag: 'v0.9.9', version: '0.9.9', commit: 'b'.repeat(40) })
  assert(!future.includes('Upgrade note'))
  assert(!future.includes('mcp.public_url'))
  assert.match(future, /Binaries are not publisher-signed or notarized/u)
  assert.match(future, /rovloom-0\.9\.9\.tgz/u)
  assert(future.trimEnd().endsWith('<!-- rovloom-release:1 v0.9.9 ' + 'b'.repeat(40) + ' -->'))
})
