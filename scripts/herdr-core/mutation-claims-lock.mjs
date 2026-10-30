#!/usr/bin/env bun
/**
 * 变异检查（强杀后接管 claim 账本锁）：把 herdr-core 的 `recoverDispatchClaimsLock` 改成不生效，
 * `--herdr-core --crash` 必须以 claim_storage_unavailable 失败；恢复后必须通过并出现
 * claims_lock_recovered。变异后写回原内容（不用 git checkout）。
 *
 * 用法：bun --no-env-file scripts/herdr-core/mutation-claims-lock.mjs \
 *   <候选二进制> <herdr-core 二进制> <工作目录前缀> <日志目录>
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [candidate, core, work, logs] = process.argv.slice(2)
if (!candidate || !core || !work || !logs) {
  console.error('usage: mutation-claims-lock.mjs <candidate> <herdr-core> <work-prefix> <logs>')
  process.exit(2)
}
const ROOT = new URL('../..', import.meta.url).pathname
const SOURCE = ROOT + 'src/connector/herdr-core/connector.ts'
const from = "    if (recoverDispatchClaimsLock(connector.claims.path + '.lock')) {"
const to = "    if (false && recoverDispatchClaimsLock(connector.claims.path + '.lock')) {"

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
      '--herdr-core',
      core,
      '--crash',
      '--work',
      workDir,
      '--then',
      'bun --no-env-file e2e/herdr-core-session.mjs'
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 1200_000 }
  )
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  writeFileSync(`${logs}/${label}.log`, output)
  return { status: run.status ?? 1, output }
}

const original = readFileSync(SOURCE, 'utf8')
if (!original.includes(from)) {
  console.error('SKIP 变异锚点不存在（connector.ts 已变化）')
  process.exit(1)
}
let failed = 0
try {
  writeFileSync(SOURCE, original.replace(from, to))
  const red = runScenario('claims-mutated', `${work}-red`)
  const caught = red.status !== 0 && red.output.includes('claim_storage_unavailable')
  console.log(`${caught ? 'RED  ' : 'MISS '} 不接管 claim 锁 → ${red.output.trim().split('\n').slice(-1)[0]}`)
  if (!caught) {
    failed += 1
  }
} finally {
  writeFileSync(SOURCE, original)
}
const green = runScenario('claims-restored', `${work}-green`)
const ok = green.status === 0 && green.output.includes('HERDR_CORE_CLAIMS_RECOVERED True')
console.log(`${ok ? 'GREEN' : 'BROKEN'} 恢复后 → ${green.output.trim().split('\n').slice(-3).join(' | ')}`)
if (!ok) {
  failed += 1
}
if (failed) {
  console.error(`变异检查失败：${failed} 项`)
  process.exit(1)
}
console.log('变异检查通过：不接管 claim 锁时强杀重启失败，恢复后通过并写出 claims_lock_recovered')
