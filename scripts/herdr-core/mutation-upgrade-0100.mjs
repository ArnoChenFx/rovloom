#!/usr/bin/env bun
/**
 * 变异检查（老设备升级）：把 0.10.0 写下的 `herdr-core-tiers-1` 从兼容集合里去掉，
 * v0.10.0 → 候选的升级 e2e 必须以 herdr_core_contract_unreviewed 失败；恢复后必须通过。
 * 变异后写回原内容（不用 git checkout）。
 *
 * 用法：bun --no-env-file scripts/herdr-core/mutation-upgrade-0100.mjs \
 *   <v0.10.0 二进制> <候选二进制> <herdr-core> <工作目录> <日志目录>
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [oldBinary, candidate, core, work, logs] = process.argv.slice(2)
if (!oldBinary || !candidate || !core || !work || !logs) {
  console.error('usage: mutation-upgrade-0100.mjs <old> <candidate> <herdr-core> <work> <logs>')
  process.exit(2)
}
const ROOT = new URL('../..', import.meta.url).pathname
const SOURCE = ROOT + 'src/connector/herdr-core/methods.ts'
const from = "  'herdr-core-tiers-2',\n  'herdr-core-tiers-1'"
const to = "  'herdr-core-tiers-2'"

function runScenario(label, workDir) {
  const build = spawnSync('bun', ['--no-env-file', 'run', 'release:build'], { cwd: ROOT, encoding: 'utf8' })
  if (build.status !== 0) {
    return { status: 1, output: `${label} build failed: ${(build.stderr ?? '').slice(-400)}` }
  }
  const run = spawnSync(
    'python3',
    [
      'e2e/quickstart.py',
      '--binary',
      candidate,
      '--upgrade-from',
      oldBinary,
      '--herdr-core',
      core,
      '--work',
      workDir,
      '--then',
      'bun --no-env-file e2e/herdr-core-host.mjs'
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 1200_000 }
  )
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  writeFileSync(`${logs}/${label}.log`, output)
  return { status: run.status ?? 1, output }
}

const original = readFileSync(SOURCE, 'utf8')
if (!original.includes(from)) {
  console.error('SKIP 变异锚点不存在（methods.ts 已变化）')
  process.exit(1)
}
let failed = 0
try {
  writeFileSync(SOURCE, original.replace(from, to))
  const red = runScenario('upgrade-mutated', `${work}-red`)
  // CLI 把 provider 配置解析失败统一投影成固定码（实测 invalid_config / runtime_failed）；
  // 判据是升级场景确实失败，并把看到的固定码原样写进日志。
  const caught = red.status !== 0 && /invalid_config|runtime_failed|herdr_core_contract_unreviewed/u.test(red.output)
  console.log(`${caught ? 'RED  ' : 'MISS '} 旧分类修订不再被接受 → ${red.output.trim().split('\n').slice(-1)[0]}`)
  if (!caught) {
    failed += 1
  }
} finally {
  writeFileSync(SOURCE, original)
}
const green = runScenario('upgrade-restored', `${work}-green`)
const ok = green.status === 0 && green.output.includes('"provider": "herdr-core"')
console.log(`${ok ? 'GREEN' : 'BROKEN'} 恢复后 → ${green.output.trim().split('\n').slice(-1)[0]}`)
if (!ok) {
  failed += 1
}
if (failed) {
  console.error(`变异检查失败：${failed} 项`)
  process.exit(1)
}
console.log('变异检查通过：旧分类修订被拒时升级场景变红，恢复后变绿')
