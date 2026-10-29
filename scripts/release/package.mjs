/** 仅为真实产品完成原生编译和隔离验收后封装待发布文件；任何探针或缺接线都失败。 */
import assert from 'node:assert/strict'
import { copyFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildStandalone } from './build.mjs'
import { product } from './product.mjs'
import { smokeStandalone, cliChecks } from './smoke.mjs'
import {
  assetName,
  encode,
  fileMetadata,
  nativePlatform,
  releaseContext,
  root,
  validateProductVersion
} from './metadata.mjs'

/** 产品接线必须交付专属验收程序，不能以预览开关、测试入口或临时生成脚本跳过验收。 */
export function productSmokePath(specification = product, directory = root) {
  assert.equal(specification.entrypoint, 'src/cli/main.ts')
  assert(
    specification.workers.includes('src/connector/luvus/contract/compiler-worker.ts'),
    'Real schema Worker is required'
  )
  assert.equal(
    typeof specification.releaseSmoke,
    'string',
    'Product HTTP release smoke is not wired; preview cannot release'
  )
  assert(
    specification.workers.includes('src/connector/herdr/compiler-herdr-worker.ts'),
    'Real Herdr schema Worker is required'
  )
  assert(
    /^scripts\/release\/[a-z][a-z0-9-]*\.mjs$/u.test(specification.releaseSmoke),
    'Expected maintained product smoke script'
  )
  const path = resolve(directory, specification.releaseSmoke)
  assert(lstatSync(path).isFile(), 'Product release smoke is missing')
  return path
}

/** 有界运行维护脚本并让真实失败阻断收据生成，错误只引用固定任务名。 */
function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, stdio: 'inherit', timeout: 180_000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, 'Product release acceptance failed')
}

/** 同一真实入口和插件构建产品，隔离核对版本并执行 HTTP/WebUI/Worker 产品验收。 */
export async function packageProduct(context, destination) {
  await validateProductVersion(context)
  const acceptance = productSmokePath()
  const platform = nativePlatform()
  assert.equal(process.env.RELEASE_TARGET, platform.target, 'Runner must execute the target natively')
  const output = await buildStandalone({ ...product, target: platform.target })
  assert.equal(output.manifest.entrypoint, product.entrypoint)
  assert.equal(output.manifest.scope, 'cli-preview-candidate')
  const checks = cliChecks.map(
    /** 版本检查必须核对完整产品版本及唯一输出通道。 */ (check) =>
      check.args[0] === '--version'
        ? { ...check, stderr: new RegExp(`^Rovloom ${context.version.replaceAll('.', '\\.')}\\r?\\n$`, 'u') }
        : check
  )
  await smokeStandalone(output.binary, checks)
  // 该脚本由产品入口负责：只复制此 binary，在空 cwd/PATH 和隔离用户目录验收真实 HTTP 服务及全部资源。
  run(process.execPath, ['--no-env-file', acceptance, output.binary, context.version])
  if (platform.os === 'windows') {
    run('python', ['scripts/release/verify-windows-icon.py', output.binary])
  }
  const directory = resolve(destination, platform.target)
  mkdirSync(directory, { recursive: false })
  const name = assetName(context.version, platform)
  const binary = resolve(directory, name)
  copyFileSync(output.binary, binary)
  const asset = { os: platform.os, arch: platform.arch, libc: platform.libc, name, ...fileMetadata(binary) }
  writeFileSync(resolve(directory, 'receipt.json'), encode({ ...context, target: platform.target, asset }))
  return asset
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'Usage: bun scripts/release/package.mjs /new-staging-root')
  const destination = resolve(process.argv[2])
  mkdirSync(destination, { recursive: false })
  console.log(encode(await packageProduct(releaseContext(), destination)))
}
