/** 仅复制单个可执行文件到临时目录，以空 PATH 和隔离用户目录验证启动及协议通道。 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { cleanupSmokeDirectory, runSmokeChild } from './smoke-process.mjs'

/** CLI 只核对已交付的帮助、版本、模板和拒绝码，不把缺后端入口当作服务验收。 */
export const cliChecks = [
  { args: ['--help'], code: 0, stdout: /^$/u, stderr: /Rovloom/u },
  { args: ['--version'], code: 0, stdout: /^$/u, stderr: /^Rovloom /u },
  { args: ['config', 'template', 'gateway'], code: 0, stdout: /"role": "gateway"/u, stderr: /^$/u },
  { args: ['--invalid-packaging-smoke'], code: 2, stdout: /^$/u, stderr: /^invalid_arguments\r?\n$/u }
]

/** 清洁工作目录不包含源码、node_modules 或 bun；只传递 Windows 加载器所需的系统路径。 */
export async function smokeStandalone(binary, checks = cliChecks, runtime = undefined) {
  const temporary = mkdtempSync(join(tmpdir(), 'rovloom-standalone-'))
  let primaryFailure
  let failed = false
  const results = []
  try {
    const cwd = join(temporary, 'cwd')
    const home = join(temporary, 'home')
    const emptyPath = join(temporary, 'empty-path')
    for (const path of [cwd, home, emptyPath]) {
      mkdirSync(path)
    }
    const executable = join(temporary, basename(binary))
    copyFileSync(binary, executable)
    const env = {
      PATH: emptyPath,
      HOME: home,
      USERPROFILE: home,
      TMP: temporary,
      TEMP: temporary,
      TMPDIR: temporary,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {})
    }
    for (const check of checks) {
      // runtime 是第四个启动选项，不属于子进程环境。
      const result = await runSmokeChild(
        executable,
        check.args,
        { cwd, env, input: check.input ?? '' },
        runtime ? { runtime } : {}
      )
      assert.equal(result.signal, null)
      assert.equal(result.status, check.code, `Unexpected exit for ${JSON.stringify(check.args)}: ${result.stderr}`)
      if (check.stdout) {
        assert.match(result.stdout, check.stdout)
      }
      if (check.stderr) {
        assert.match(result.stderr, check.stderr)
      }
      results.push({ args: check.args, code: result.status, stdout: result.stdout, stderr: result.stderr })
    }
  } catch (error) {
    primaryFailure = error
    failed = true
  }
  try {
    await cleanupSmokeDirectory(temporary)
  } catch (error) {
    if (failed) {
      throw new AggregateError([primaryFailure, error], 'standalone_smoke_and_cleanup_failed')
    }
    throw error
  }
  if (failed) {
    throw primaryFailure
  }
  return results
}

if (import.meta.main) {
  const [binary] = process.argv.slice(2)
  if (!binary || process.argv.length !== 3) {
    throw new Error('Usage: bun scripts/release/smoke.mjs /absolute/candidate-binary')
  }
  const { smokeRuntime } = await import('./runtime.mjs')
  const results = await smokeStandalone(resolve(binary), cliChecks, smokeRuntime())
  console.log(JSON.stringify({ scope: 'cli-preview', isolatedRuntime: 'pass', checks: results }, null, 2))
}
