import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoverWorkingDirectory } from '../../src/cli/working-directory.js'

const gone = Object.assign(new Error('ENOENT: process.cwd failed with error no such file or directory'), {
  code: 'ENOENT'
})

test('当前目录可用时不切换；取不到时切到家目录；家目录也切不过去则保持原状且不抛错', () => {
  const moves: string[] = []
  const record = (path: string): void => void moves.push(path)
  const present = recoverWorkingDirectory({
    cwd: () => '/work',
    chdir: record,
    home: () => '/home/u'
  })
  assert.equal(present, 'present')
  assert.equal(moves.length, 0)

  const reset = recoverWorkingDirectory({
    cwd: () => {
      throw gone
    },
    chdir: record,
    home: () => '/home/u'
  })
  assert.equal(reset, 'reset')
  assert.deepEqual(moves, ['/home/u'])

  const unavailable = recoverWorkingDirectory({
    cwd: () => {
      throw gone
    },
    chdir: () => {
      throw gone
    },
    home: () => '/home/u'
  })
  assert.equal(unavailable, 'unavailable')

  const noHome = recoverWorkingDirectory({
    cwd: () => {
      throw gone
    },
    chdir: () => undefined,
    home: () => {
      throw new Error('no home')
    }
  })
  assert.equal(noHome, 'unavailable')
})

test('真实入口：终端 stdin 且当前目录已被删除时，--version 仍正常输出并提示 working_directory_reset', () => {
  // 复现只在标准输入是终端时出现；用 util-linux 的 script 提供伪终端，缺少时明确跳过。
  const script = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).stdout.trim()
  if (process.platform !== 'linux' || script === '') {
    return
  }
  const entry = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'rovloom-cwd-'))
  try {
    const launcher = join(dir, 'launch.sh')
    // 先进入子目录再把它删掉，然后用 exec 换成入口进程，使入口继承一个已不存在的 cwd。
    writeFileSync(
      launcher,
      `#!/bin/sh\nmkdir "$1/gone" && cd "$1/gone" && rmdir "$1/gone" && exec "$2" --no-env-file "$3" --version\n`
    )
    chmodSync(launcher, 0o700)
    const run = spawnSync(script, ['-qec', `${launcher} ${dir} ${process.execPath} ${entry}`, '/dev/null'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    assert.equal(existsSync(join(dir, 'gone')), false)
    const output = `${run.stdout}${run.stderr}`.replaceAll('\r', '')
    assert.equal(run.status, 0, output)
    assert.match(output, /working_directory_reset\n/u)
    assert.match(output, /Rovloom \d+\.\d+\.\d+/u)
    assert.doesNotMatch(output, /ENOENT|process\.cwd/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
