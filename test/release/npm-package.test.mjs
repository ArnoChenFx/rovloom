import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertTarballEntries, npmPackageJson } from '../../scripts/release/npm-package.mjs'
import {
  assertTrustedPublishingNpm,
  npmPublishArgv,
  publishNpm,
  REPOSITORY_URL,
  registryNpmPackageJson
} from '../../scripts/release/registry.mjs'
import {
  assemble,
  assetName,
  encode,
  fileMetadata,
  npmAssetName,
  platforms,
  repository
} from '../../scripts/release/metadata.mjs'
import { publish, publishReleaseAndNpm } from '../../scripts/release/publish.mjs'
import { validateReleaseManifest } from '../../src/release/contract.ts'

const context = { tag: 'v0.1.1', version: '0.1.1', commit: 'a'.repeat(40) }
const source = {
  name: 'rovloom',
  version: '0.1.1',
  description: 'd',
  license: 'Apache-2.0',
  private: true,
  type: 'module',
  engines: { bun: '>=1.4.4' },
  bin: { rovloom: 'dist/src/cli/main.js' },
  files: ['dist/src', 'LICENSE', 'README.md'],
  scripts: { build: 'x' },
  dependencies: { ajv: '^8' },
  devDependencies: { typescript: '^7' }
}

/** 二进制平台目录加 npm 目录，全部是小型测试数据，始终清理。 */
function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'rovloom-npm-release-'))
  const platformsDirectory = resolve(directory, 'platforms')
  const npm = resolve(directory, 'npm')
  mkdirSync(platformsDirectory)
  mkdirSync(npm)
  for (const platform of platforms) {
    const folder = resolve(platformsDirectory, platform.target)
    mkdirSync(folder)
    const name = assetName(context.version, platform)
    writeFileSync(resolve(folder, name), `test-only-${platform.target}`)
    const asset = {
      os: platform.os,
      arch: platform.arch,
      libc: platform.libc,
      name,
      ...fileMetadata(resolve(folder, name))
    }
    writeFileSync(resolve(folder, 'receipt.json'), encode({ ...context, target: platform.target, asset }))
  }
  const name = npmAssetName(context.version)
  writeFileSync(resolve(npm, name), 'test-only-tarball')
  const asset = { name, ...fileMetadata(resolve(npm, name)) }
  writeFileSync(resolve(npm, 'receipt.json'), encode({ ...context, asset }))
  return { platformsDirectory, npm, name, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('npm 包的 package.json 只含运行所需字段，bin 固定指向构建入口', () => {
  const result = npmPackageJson(source)
  assert.deepEqual(result.bin, { rovloom: 'dist/src/cli/main.js' })
  assert.deepEqual(result.dependencies, source.dependencies)
  assert.equal(result.scripts, undefined)
  assert.equal(result.devDependencies, undefined)
  // 不标 private：同一 tarball 也是 npm 注册表发布的字节，注册表拒绝 private 包。
  assert.equal(result.private, undefined)
  assert.equal(result.repository.url, REPOSITORY_URL)
  assert.deepEqual(registryNpmPackageJson(source), result)
  assert.equal(result.version, '0.1.1')
  assert.throws(() => npmPackageJson({ ...source, bin: { rovloom: 'src/cli/main.ts' } }))
  assert.throws(() => npmPackageJson({ ...source, dependencies: {} }))
})

test('tarball 条目白名单拒绝源码、sourcemap、测试和路径逃逸', () => {
  const good = [
    'package/',
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/dist/src/cli/main.js',
    'package/dist/src/chunk-abc.js'
  ]
  assertTarballEntries(good)
  for (const bad of [
    'package/dist/src/cli/main.js.map',
    'package/src/cli/main.ts',
    'package/test/a.js',
    'package/dist/src/../x.js',
    'package/node_modules/x/index.js',
    'other/package.json'
  ]) {
    assert.throws(() => assertTarballEntries([...good, bad]), bad)
  }
  assert.throws(() => assertTarballEntries(good.filter((entry) => !entry.endsWith('cli/main.js'))))
})

test('发布包含 npm tarball：只进 SHA256SUMS，不进 release-manifest.json', () => {
  const files = fixture()
  try {
    const plain = assemble(context, files.platformsDirectory)
    const bundle = assemble(context, files.platformsDirectory, files.npm)
    assert.equal(bundle.manifestBytes, plain.manifestBytes)
    assert(!bundle.manifestBytes.includes('.tgz'))
    validateReleaseManifest(JSON.parse(bundle.manifestBytes), context.tag)
    const sum = createHash('sha256').update('test-only-tarball').digest('hex')
    assert(bundle.checksumsBytes.includes(`${sum}  ${files.name}\n`))
    assert.equal(bundle.npm.name, files.name)
  } finally {
    files.cleanup()
  }
})

test('npm 收据与 tag、提交或字节不符时在任何写入前失败', () => {
  const files = fixture()
  try {
    writeFileSync(resolve(files.npm, files.name), 'changed-after-receipt')
    assert.throws(() => assemble(context, files.platformsDirectory, files.npm), /receipt/u)
    writeFileSync(resolve(files.npm, 'extra.txt'), 'x')
    assert.throws(() => assemble(context, files.platformsDirectory, files.npm))
  } finally {
    files.cleanup()
  }
})

test('publish 上传 tarball 并在全部资产核对后才公开', async () => {
  const files = fixture()
  try {
    const bundle = assemble(context, files.platformsDirectory, files.npm)
    const uploaded = []
    let release
    const api = async (path, { method = 'GET', json, bytes } = {}) => {
      assert(path.startsWith(`/repos/${repository}/`))
      if (path.includes('/git/ref/tags/')) {
        return { object: { type: 'commit', sha: context.commit } }
      }
      if (method === 'GET' && path.includes('/releases?')) {
        return release ? [structuredClone(release)] : []
      }
      if (method === 'GET' && path.endsWith('/assets?per_page=100')) {
        return structuredClone(uploaded)
      }
      if (method === 'POST' && path.endsWith('/releases')) {
        release = { id: 1, ...json }
        return structuredClone(release)
      }
      if (method === 'POST' && path.includes('/assets?name=')) {
        uploaded.push({
          name: decodeURIComponent(path.split('?name=')[1]),
          size: bytes.length,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          state: 'uploaded'
        })
        return {}
      }
      if (method === 'PATCH') {
        assert.equal(uploaded.length, platforms.length + 3)
        release = { ...release, ...json }
        return structuredClone(release)
      }
      throw new Error(`Unexpected mock API call: ${method} ${path}`)
    }
    assert.equal((await publish(context, bundle, api)).status, 'published')
    assert(uploaded.some((asset) => asset.name === files.name))
    assert(release.body.includes(`rovloom-${context.version}.tgz`))
    assert.equal(release.draft, false)
  } finally {
    files.cleanup()
  }
})

const registryEnv = {
  GITHUB_REPOSITORY: repository,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REF: `refs/tags/${context.tag}`,
  GITHUB_SHA: context.commit
}

/** 可编程的本地 npm 客户端：记录 argv，fail 为布尔或惰性函数，按其返回值决定发布成败。 */
function npmRunner(calls, fail = () => false) {
  return (argv) => {
    calls.push(argv)
    if (argv[0] === '--version') {
      return { status: 0, stdout: '11.21.0', stderr: '' }
    }
    if (typeof fail === 'function' ? fail() : fail) {
      return { status: 1, stdout: '', stderr: 'simulated npm failure' }
    }
    return { status: 0, stdout: `+ rovloom@${context.version}\n`, stderr: '' }
  }
}

async function fetchRegistry(packument, status = 200) {
  return async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/rovloom')
    assert.equal(options.headers.Accept, 'application/vnd.npm.install-v1+json')
    return { ok: status < 400, status, json: async () => packument }
  }
}

const integrity = createHash('sha512').update('test-only-tarball').digest('base64')

async function runPublishNpm(files, registry, run) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = registry
  try {
    return await publishNpm(resolve(files.npm, files.name), registryEnv, run)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('注册表版本未发布时上传 Release 同款 tarball，只使用 OIDC 发布而不注入凭据', async () => {
  const files = fixture()
  try {
    const calls = []
    const result = await runPublishNpm(files, await fetchRegistry({ versions: {} }), npmRunner(calls))
    assert.deepEqual(result, { status: 'published', version: context.version, name: files.name })
    assert.deepEqual(calls[0], ['--version'])
    assert.deepEqual(calls[1], [
      'publish',
      resolve(files.npm, files.name),
      '--provenance',
      '--access',
      'public',
      '--loglevel',
      'warn'
    ])
  } finally {
    files.cleanup()
  }
})

test('注册表已存在同版本时只在字节一致时只读成功，不同字节拒绝覆盖', async () => {
  const files = fixture()
  try {
    const calls = []
    const same = await runPublishNpm(
      files,
      await fetchRegistry({ versions: { [context.version]: { dist: { integrity: `sha512-${integrity}` } } } }),
      npmRunner(calls)
    )
    assert.deepEqual(same, { status: 'already-published', version: context.version, name: files.name })
    assert.equal(calls.length, 0)
    writeFileSync(resolve(files.npm, files.name), 'changed-after-publish')
    await assert.rejects(
      runPublishNpm(
        files,
        await fetchRegistry({ versions: { [context.version]: { dist: { integrity: `sha512-${integrity}` } } } }),
        npmRunner([])
      ),
      /different bytes; refusing to overwrite/u
    )
  } finally {
    files.cleanup()
  }
})

test('注册表不可用、包不存在或 npm 发布失败时阻断，不发半套数据', async () => {
  const files = fixture()
  try {
    const calls = []
    await assert.rejects(
      runPublishNpm(files, await fetchRegistry({}, 404), npmRunner(calls)),
      /Package missing from the npm registry/u
    )
    await assert.rejects(
      runPublishNpm(files, await fetchRegistry({}, 500), npmRunner(calls)),
      /npm registry returned 500/u
    )
    await assert.rejects(
      runPublishNpm(files, await fetchRegistry({ versions: {} }), npmRunner(calls, true)),
      /simulated npm failure/u
    )
    assert.equal(calls.length, 2)
  } finally {
    files.cleanup()
  }
})

test('npm 客户端版本必须支持 OIDC trusted publishing，tarball 必须属于本 tag', () => {
  assertTrustedPublishingNpm('11.5.1')
  assertTrustedPublishingNpm('11.21.0')
  assertTrustedPublishingNpm('12.2.0')
  for (const version of ['11.4.1', '10.9.4', '11.5.0']) {
    assert.throws(() => assertTrustedPublishingNpm(version), /11\.5\.1/u)
  }
})

test('稳定版发布到 latest，预发布用独立 dist-tag', () => {
  assert.deepEqual(npmPublishArgv('/tmp/rovloom-0.1.1.tgz', '0.1.1'), [
    'publish',
    '/tmp/rovloom-0.1.1.tgz',
    '--provenance',
    '--access',
    'public',
    '--loglevel',
    'warn'
  ])
  assert(npmPublishArgv('/tmp/x.tgz', '0.1.1-rc.1').includes('--tag'))
})

test('publish 先公开 GitHub Release 再发布 npm，注册表失败时 Release 已公开且重跑只读通过', async () => {
  const files = fixture()
  try {
    const uploaded = []
    let release
    let failNpm = true
    const api = async (path, { method = 'GET', json, bytes } = {}) => {
      if (path.includes('/git/ref/tags/')) {
        return { object: { type: 'commit', sha: context.commit } }
      }
      if (method === 'GET' && path.includes('/releases?')) {
        return release ? [structuredClone(release)] : []
      }
      if (method === 'GET' && path.endsWith('/assets?per_page=100')) {
        return structuredClone(uploaded)
      }
      if (method === 'POST' && path.endsWith('/releases')) {
        release = { id: 1, ...json }
        return structuredClone(release)
      }
      if (method === 'POST' && path.includes('/assets?name=')) {
        uploaded.push({
          name: decodeURIComponent(path.split('?name=')[1]),
          size: bytes.length,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          state: 'uploaded'
        })
        return {}
      }
      if (method === 'PATCH') {
        assert.equal(uploaded.length, platforms.length + 3)
        release = { ...release, ...json }
        return structuredClone(release)
      }
      throw new Error(`Unexpected mock API call: ${method} ${path}`)
    }
    const calls = []
    const run = npmRunner(calls, () => failNpm)
    const bundle = assemble(context, files.platformsDirectory, files.npm)
    const originalFetch = globalThis.fetch
    globalThis.fetch = await fetchRegistry({ versions: {} })
    try {
      await assert.rejects(publishReleaseAndNpm(context, bundle, api, registryEnv, run), /simulated npm failure/u)
      assert.equal(release.draft, false)
      failNpm = false
      const rerun = await publishReleaseAndNpm(context, bundle, api, registryEnv, run)
      assert.equal(rerun.status, 'already-published')
      assert.deepEqual(rerun.npm, { status: 'published', version: context.version, name: files.name })
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    files.cleanup()
  }
})
