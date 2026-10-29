/** 容器生命周期的单元负例；真实 Docker 回归由显式开关启用，普通全量不要求 Docker。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { alpineRuntime } from '../../scripts/release/alpine.mjs'
import { runSmokeChild, spawnSmokeChild } from '../../scripts/release/smoke-process.mjs'
import { smokeStandalone } from '../../scripts/release/smoke.mjs'

const cwd = process.cwd()

test('spawn 同步失败仍删除已确认的容器，只使用创建返回的完整 ID', () => {
  const calls = []
  const runtime = alpineRuntime({
    runDocker(_file, args) {
      calls.push(args)
      return { status: 0, stdout: 'c'.repeat(64) + '\n' }
    }
  })
  assert.throws(
    () =>
      spawnSmokeChild(
        '/fixture/product',
        [],
        { cwd, env: {} },
        {
          runtime,
          spawnChild() {
            throw new Error('fixture_spawn_failure')
          }
        }
      ),
    /fixture_spawn_failure/u
  )
  assert.equal(calls[0][0], 'create')
  assert.deepEqual(calls[1], ['rm', '--force', 'c'.repeat(64)])
})

test('容器删除失败不交付正常 close，也不删除仍可能挂载的 smoke 目录', async () => {
  let temporary
  const runtime = {
    wrap(_file, _args, options) {
      temporary = dirname(options.cwd)
      return {
        ...options,
        file: process.execPath,
        args: ['--no-env-file', '-e', 'process.exit(0)'],
        cleanup() {
          throw Object.assign(new Error('fixture_cleanup_unknown'), { code: 'smoke_cleanup_unknown' })
        }
      }
    }
  }
  try {
    await assert.rejects(smokeStandalone(process.execPath, undefined, runtime), { code: 'smoke_cleanup_unknown' })
    assert(existsSync(temporary))
  } finally {
    // 本例是本机直接 child，close 已确认；只回收本例自己保留的 fixture。
    if (temporary) {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
})

test('手动发布校验仅捕获容器内产品输出，冷拉取和 apk 日志不污染版本', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-release-version-'))
  try {
    writeFileSync(
      join(root, 'docker'),
      '#!/bin/sh\necho "cold image pull" >&2\nwhile [ "$1" != sh ]; do shift; done\nexec "$@"\n'
    )
    writeFileSync(join(root, 'apk'), '#!/bin/sh\necho "package diagnostic" >&2\n')
    writeFileSync(join(root, 'product'), '#!/bin/sh\necho "Rovloom 0.7.1" >&2\n')
    for (const name of ['docker', 'apk', 'product']) {
      chmodSync(join(root, name), 0o755)
    }
    const workflow = readFileSync('.github/workflows/verify-release.yml', 'utf8')
    const command = workflow.match(/out=\$\(docker run[^\n]+\\\n[^\n]+\)/u)?.[0]
    assert(command, 'maintained musl version command missing')
    const checked = spawnSync('bash', ['-euo', 'pipefail', '-c', command + '\nprintf "%s" "$out"'], {
      cwd: root,
      env: { ...process.env, PATH: root + ':' + process.env.PATH, ASSET: 'product', asset: 'product' },
      encoding: 'utf8'
    })
    assert.equal(checked.status, 0, checked.stderr)
    assert.equal(checked.stdout, 'Rovloom 0.7.1')
    assert.match(checked.stderr, /cold image pull/u)
    assert.match(checked.stderr, /package diagnostic/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const mode of ['normal', 'timeout', 'output_limit', 'client_killed']) {
  test(
    `真实 Alpine 的 ${mode} 路径在结算前确认容器删除`,
    {
      skip: process.env.ROVLOOM_DOCKER_TESTS !== '1',
      timeout: 30_000
    },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rovloom-musl-lifecycle-'))
      const executable = join(root, 'probe')
      const ids = []
      const runtime = alpineRuntime({
        runDocker(file, args, options) {
          const result = spawnSync(file, args, options)
          if (args[0] === 'create' && result.status === 0) {
            ids.push(result.stdout.trim())
          }
          return result
        }
      })
      let killed = false
      try {
        const body =
          mode === 'normal'
            ? 'echo "Rovloom probe" >&2; exit 0'
            : mode === 'output_limit'
              ? '/bin/busybox head -c 2097153 /dev/zero; exec /bin/sleep 300'
              : 'echo READY; exec /bin/sleep 300'
        writeFileSync(executable, '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
        const work = runSmokeChild(
          executable,
          [],
          { cwd: root, env: { PATH: '', HOME: root } },
          {
            runtime,
            timeout: mode === 'timeout' ? 3_000 : 15_000,
            spawnChild(file, args, options) {
              const child = spawn(file, args, options)
              if (mode === 'client_killed') {
                child.stdout.on('data', (bytes) => {
                  if (!killed && bytes.toString().includes('READY')) {
                    killed = true
                    child.kill('SIGKILL')
                  }
                })
              }
              return child
            }
          }
        )
        if (mode === 'timeout' || mode === 'output_limit') {
          await assert.rejects(work, { code: mode === 'timeout' ? 'smoke_timeout' : 'smoke_output_limit' })
        } else {
          const result = await work
          if (mode === 'normal') {
            assert.equal(result.status, 0)
            assert.equal(result.stderr, 'Rovloom probe\n')
          } else {
            assert(killed)
            assert.equal(result.signal, 'SIGKILL')
          }
        }
        assert.equal(ids.length, 1)
        const remaining = spawnSync('docker', ['container', 'ls', '--all', '--quiet', '--filter', 'id=' + ids[0]], {
          encoding: 'utf8'
        })
        assert.equal(remaining.status, 0, remaining.stderr)
        assert.equal(remaining.stdout, '')
      } finally {
        for (const id of ids) {
          spawnSync('docker', ['rm', '--force', id], { stdio: 'ignore', timeout: 5000 })
        }
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
