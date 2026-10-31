// Exercise PR diff planning against a real repository; missing history must retain native coverage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../../scripts/ci/e2e-plan.mjs', import.meta.url))

test('native acceptance planning covers core changes, deletions and missing history while skipping prose', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-e2e-plan-'))
  // All commands use this isolated repository and local objects, without credentials or remote access.
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: root,
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const plan = (suite, base, head, eventName = 'pull_request') => {
    const event = join(root, 'event.json')
    const output = join(root, 'output')
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }))
    writeFileSync(output, '')
    const result = spawnSync(process.execPath, ['--no-env-file', script, suite], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }
    })
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(output, 'utf8').trim()
  }
  try {
    git('init', '-q')
    writeFileSync(join(root, '.gitignore'), 'event.json\noutput\n')
    writeFileSync(join(root, 'README.md'), 'initial')
    let previous = commit()
    const cases = [
      ['docs/OPERATIONS.md', [false, false, false, false]],
      ['src/runtime/connector.ts', [true, true, true, true]],
      ['src/storage/lock-recovery.ts', [true, true, true, true]],
      ['bun.lock', [true, true, true, true]],
      ['test/platform/windows.test.ts', [false, true, true, true]],
      ['.github/workflows/two-host.yml', [true, false, false, false]],
      ['scripts/ci/e2e-plan.mjs', [true, true, true, true]],
      ['.github/workflows/herdr-core-e2e.yml', [false, false, false, true]]
    ]
    for (const [path, expected] of cases) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), 'fixture')
      const head = commit()
      for (const [index, suite] of ['two-host', 'macos', 'windows', 'herdr-core'].entries()) {
        assert.equal(plan(suite, previous, head), `run=${expected[index]}`, path + ':' + suite)
      }
      previous = head
    }
    rmSync(join(root, 'src/runtime/connector.ts'))
    const deleted = commit()
    assert.equal(plan('two-host', previous, deleted), 'run=true')
    assert.equal(plan('two-host', '0'.repeat(40), deleted), 'run=true')
    assert.equal(plan('two-host', 'not-a-sha', deleted), 'run=true')
    assert.equal(plan('two-host', deleted, deleted, 'workflow_dispatch'), 'run=true')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
