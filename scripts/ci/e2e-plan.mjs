// Select native acceptance from the actual PR diff; errors run the suite rather than silently omit coverage.
import { readFileSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const suites = ['two-host', 'macos', 'windows', 'herdr-core']

/** Classify maintained product/build inputs separately from documentation-only changes. */
export function needsE2e(suite, files) {
  if (!suites.includes(suite)) {
    throw new Error('unknown_e2e_suite')
  }
  return files.some(
    (file) =>
      file.startsWith('src/') ||
      file.startsWith('e2e/') ||
      file.startsWith('.github/actions/') ||
      file.startsWith('scripts/ci/') ||
      file.startsWith('scripts/release/') ||
      file.startsWith('scripts/bun/') ||
      ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json'].includes(file) ||
      file === `.github/workflows/${suite === 'two-host' ? 'two-host' : suite + '-e2e'}.yml` ||
      (suite !== 'two-host' && /^(test\/(platform|connector|runtime|cli)\/)/.test(file))
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const suite = process.argv[2]
  if (!suites.includes(suite)) {
    throw new Error('unknown_e2e_suite')
  }
  let run = true
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
      const base = event.pull_request.base.sha
      const head = event.pull_request.head.sha
      if (![base, head].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) {
        throw new Error('invalid_pr_commits')
      }
      const diff = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 8_388_608
      })
      if (diff.error || diff.status !== 0) {
        throw new Error('diff_unavailable')
      }
      run = needsE2e(suite, diff.stdout.split('\0').filter(Boolean))
    } catch {
      // Missing history or malformed metadata must not turn a required acceptance check green by omission.
      console.error('e2e_diff_unavailable: running acceptance')
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`)
  console.log(`${suite}: ${run ? 'run' : 'unchanged'}`)
}
