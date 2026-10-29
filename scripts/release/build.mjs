/** 以固定 Bun 编译真实入口及显式 Worker/资源；输出仅为待验收候选，不装配宿主或发布 Release。 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { toolchain } from '../bun/toolchain.mjs'
import { buildWebui } from '../bun/webui.mjs'
import { loadManagementAssets } from '../../src/admin/assets.ts'
import { iconSizes, iconSource, writeWindowsIcon } from './icon.mjs'
import { product } from './product.mjs'

export const root = resolve(import.meta.dir, '../..')

/** 只为产物完整性计算公开源码资源与二进制摘要，不读取用户配置或状态。 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 构建模块只暴露现有 HTTP 桥接受的内存白名单，没有磁盘或 cwd 回退分支。 */
export function managementPlugin(directory, resources, { inline = false } = {}) {
  const imports = []
  const entries = []
  for (const [path, bytes] of resources) {
    const name = `asset${entries.length}`
    if (inline) {
      entries.push(
        `[${JSON.stringify(path)}, new Uint8Array(Buffer.from(${JSON.stringify(Buffer.from(bytes).toString('base64'))}, 'base64'))]`
      )
    } else {
      imports.push(
        `import ${name} from ${JSON.stringify(resolve(directory, path === '/' ? 'index.html' : path.slice(1)))} with { type: 'file' };`
      )
      entries.push(`[${JSON.stringify(path)}, new Uint8Array(readFileSync(${name}))]`)
    }
  }
  const contents = `${imports.join('\n')}
import { readFileSync } from 'node:fs';
// 克隆编译时固定资源，供既有管理桥注入；不从磁盘补包。
export function loadEmbeddedManagementAssets() { return new Map([${entries.join(',')}]); }
export const loadProductManagementAssets = loadEmbeddedManagementAssets;
`
  return {
    name: 'rovloom-management-assets',
    /** 仅解析固定虚拟模块；每份 file import 由 Bun 显式嵌入。 */
    setup(build) {
      build.onLoad(
        { filter: /[/\\]cli[/\\]management-assets\.ts$/u },
        /** 唯一CLI定位器复用同一静态清单；不会读取源码路径或外部目录。 */ () => ({
          contents,
          loader: 'js',
          resolveDir: root
        })
      )
      build.onResolve(
        { filter: /^rovloom:management-assets$/u },
        /* 固定唯一资源模块命名空间。 */ () => ({ path: 'management-assets', namespace: 'rovloom' })
      )
      build.onLoad(
        { filter: /.*/u, namespace: 'rovloom' },
        /* 返回固定构建清单，不能由 HTTP 请求指定文件。 */ () => ({ contents, loader: 'js', resolveDir: root })
      )
    }
  }
}

/** 接受受审查源码入口及附加 Worker；Windows 必须本机构建才能设置品牌图标。 */
export async function buildStandalone({
  entrypoint,
  workers = [],
  assets = [],
  probe = false,
  target = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
}) {
  toolchain()
  if (process.cwd() !== root) {
    throw new Error('Run the release build from the repository root')
  }
  if (!/^bun-(?:linux|darwin|windows)-(?:x64|arm64)$/u.test(target)) {
    throw new Error('Unsupported standalone target')
  }
  if (target.startsWith('bun-windows-') && process.platform !== 'win32') {
    throw new Error('Windows icon requires a native Windows build; cross-compilation is not icon acceptance')
  }
  for (const path of [entrypoint, ...workers, ...assets]) {
    if (!path || !existsSync(resolve(root, path))) {
      throw new Error(`Missing standalone input: ${path}; product wiring is pending, no replacement CLI is generated`)
    }
  }
  const names = [entrypoint, ...workers].map(
    /* 所有入口在 executable 内使用唯一文件名，避免 Worker 相对路径别名冲突。 */ (path) => basename(path, extname(path))
  )
  if (new Set(names).size !== names.length) {
    throw new Error('Standalone entrypoint and Worker names must be unique')
  }
  const directory = resolve(root, 'dist/release', target, probe ? 'probe' : 'candidate')
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  const webui = resolve(directory, 'webui')
  await buildWebui(webui)
  const resources = loadManagementAssets(webui)
  const ico = resolve(directory, 'rovloom.ico')
  writeWindowsIcon(ico)
  const binary = resolve(
    directory,
    `${probe ? 'packaging-probe' : 'rovloom'}${target.startsWith('bun-windows-') ? '.exe' : ''}`
  )
  const embedded = [...assets]
  for (const [path] of resources) {
    embedded.push(relative(root, resolve(webui, path === '/' ? 'index.html' : path.slice(1))))
  }
  const plugins = [managementPlugin(webui, resources)]
  if (
    workers.some(
      /* 两种固定编译 Worker 都复用同一受控内嵌插件。 */ (worker) =>
        ['src/connector/luvus/contract/compiler-worker.ts', 'src/connector/herdr/compiler-herdr-worker.ts'].includes(
          worker
        )
    )
  ) {
    // 复用 schema 工厂自己的受控 Blob 定位插件，不另写 Worker 定位或代码生成逻辑。
    const { compilerWorkerPlugin } = await import('../connector/worker-plugin.mjs')
    plugins.push(await compilerWorkerPlugin())
  }
  const result = await Bun.build({
    entrypoints: [entrypoint, ...workers],
    root,
    naming: { entry: '[name].[ext]' },
    target: 'bun',
    packages: 'bundle',
    env: 'disable',
    minify: true,
    sourcemap: 'inline',
    compile: {
      target,
      outfile: binary,
      assets: embedded,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
      ...(target.startsWith('bun-windows-') ? { windows: { icon: ico, hideConsole: false } } : {})
    },
    plugins
  })
  if (!result.success) {
    throw new AggregateError(result.logs, 'Standalone build failed')
  }
  const manifest = {
    scope: probe === 'native-contract' ? 'native-contract-probe' : probe ? 'packaging-probe' : 'cli-preview-candidate',
    bun: process.versions.bun,
    bunRevision: Bun.revision,
    target,
    entrypoint,
    workers,
    assets: embedded,
    binary: relative(root, binary),
    sha256: sha256(readFileSync(binary)),
    icon: {
      source: iconSource,
      sizes: iconSizes,
      sha256: sha256(readFileSync(iconSource)),
      configured: target.startsWith('bun-windows-') && process.platform === 'win32',
      resourceAcceptance: 'pending'
    },
    runtimeAcceptance: 'pending',
    productWiring: 'pending'
  }
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { binary, manifest, directory }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--probe')) {
    throw new Error('Usage: bun scripts/release/build.mjs [--probe]')
  }
  const probe = args[0] === '--probe'
  const output = await buildStandalone(
    probe
      ? {
          entrypoint: 'test/release/probe.mjs',
          workers: ['test/release/probe-worker.mjs'],
          probe
        }
      : product
  )
  console.log(JSON.stringify(output.manifest, null, 2))
}
