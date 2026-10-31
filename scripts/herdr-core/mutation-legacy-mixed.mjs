#!/usr/bin/env bun
/**
 * 变异检查（老 mixed 设备）：把 `selectNativeProviders` 改回「要求选择集合与配对集合完全相同」的旧行为，
 * 任务 C 的升级 e2e 必须失败；恢复后必须通过。变异后一定要还原（写回原内容，不用 git checkout）。
 *
 * 用法：bun --no-env-file scripts/herdr-core/mutation-legacy-mixed.mjs \
 *   <v0.9.0 二进制> <候选二进制> <luvus> <herdr> <工作目录> <日志目录>
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [oldBinary, candidate, luvus, herdr, work, logs] = process.argv.slice(2)
if (!oldBinary || !candidate || !luvus || !herdr || !work || !logs) {
  console.error('usage: mutation-legacy-mixed.mjs <old> <candidate> <luvus> <herdr> <work> <logs>')
  process.exit(2)
}
const ROOT = new URL('../..', import.meta.url).pathname
const CONFIG = ROOT + 'src/cli/native-selection.ts'
const from = 'active: paired.filter('
const to = 'active: selected.length !== paired.length ? [] : paired.filter('

/** 构建候选产物并跑一次升级 e2e；返回 {status, tail}。 */
function runScenario(label, workDir) {
  const build = spawnSync('bun', ['--no-env-file', 'run', 'release:build'], { cwd: ROOT, encoding: 'utf8' })
  if (build.status !== 0) {
    return { status: 1, tail: `${label} build failed: ${(build.stderr ?? '').slice(-400)}` }
  }
  const env = { ...process.env, LUVUS_WRITE: '{}' }
  const run = spawnSync(
    'python3',
    [
      'e2e/quickstart.py',
      '--binary',
      candidate,
      '--upgrade-from',
      oldBinary,
      '--luvus',
      luvus,
      '--herdr',
      herdr,
      '--work',
      workDir,
      '--then',
      'bun --no-env-file e2e/mixed-legacy-upgrade.mjs'
    ],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 1200_000 }
  )
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  writeFileSync(`${logs}/${label}.log`, output)
  return { status: run.status ?? 1, tail: output.trim().split('\n').slice(-3).join(' | ') }
}

const original = readFileSync(CONFIG, 'utf8')
if (!original.includes(from)) {
  console.error('SKIP 变异锚点不存在（native-selection.ts 已变化）')
  process.exit(1)
}
let failed = 0
try {
  writeFileSync(CONFIG, original.replace(from, to))
  // 每次用独立的工作目录：失败的一轮会保留状态，复用会让下一轮读到残留配置。
  const red = runScenario('legacy-mutated', `${work}-red`)
  const caught = red.status !== 0 && red.tail.includes('configuration_required')
  console.log(`${caught ? 'RED  ' : 'MISS '} 旧 mixed 分支失效 → ${red.tail}`)
  if (!caught) {
    failed += 1
  }
} finally {
  writeFileSync(CONFIG, original)
}
const green = runScenario('legacy-restored', `${work}-green`)
const ok = green.status === 0 && green.tail.includes('"legacy":true')
console.log(`${ok ? 'GREEN' : 'BROKEN'} 恢复后 → ${green.tail}`)
if (!ok) {
  failed += 1
}
if (failed) {
  console.error(`变异检查失败：${failed} 项`)
  process.exit(1)
}
console.log('变异检查通过：旧 mixed 分支失效时升级场景变红，恢复后变绿')
