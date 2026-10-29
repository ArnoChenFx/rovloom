/**
 * Gateway 写锁的内核锁：存活的持有者在任何 PID 命名空间下都不会被接管，持有者死亡（含 PID 被复用）后立即可接管。
 * 容器共享同一卷时各自看不到对方的 PID，只靠“PID + 启动标识”会把另一个容器里存活的 Gateway 当作已死；
 * 容器重启后新进程又常常拿到和旧进程相同的 PID，会被误判为存活而无法启动。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { tryKernelLock } from '../../src/storage/file-lock.js'
import { createHeldLock, recoverStaleLock } from '../../src/storage/lock-recovery.js'
import { currentProcessIdentity } from '../../src/storage/process-identity.js'
import { GATEWAY_LOCK_FORMAT, Store } from '../../src/store.js'

const linux = process.platform === 'linux' && Boolean(process.versions.bun)
// 本命名空间里不存在的 PID：等价于“持有者在另一个容器里，从这里看不见”。
const INVISIBLE_PID = 4_194_000

/* 在私有磁盘目录运行测试回调，并在成功或异常后删除整个临时目录。 */
async function disk(run: (path: string) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-gateway-lock-'))
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  try {
    await run(join(state, 'db'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/* 启动一个持有 Store（并因此持有写锁）的独立进程，等它打印 ready。 */
async function holder(path: string): Promise<ChildProcess> {
  const store = new URL('../../src/store.ts', import.meta.url).pathname
  const script = `import {Store} from ${JSON.stringify(store)};new Store(${JSON.stringify(path)});console.log('ready');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('exit', (code) => reject(new Error('holder_exited_' + String(code))))
  })
  return child
}

async function kill(child: ChildProcess): Promise<void> {
  child.kill('SIGKILL')
  await once(child, 'exit')
}

test('kernel lock excludes other open file descriptions and ends when the holder dies', { skip: !linux }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-file-lock-'))
  const file = join(root, 'lock')
  writeFileSync(file, '', { mode: 0o600 })
  try {
    const first = openSync(file, 'r')
    const second = openSync(file, 'r')
    assert.equal(tryKernelLock(first), 'acquired')
    // 同一进程里另开的文件描述也被排斥：flock 以打开的文件描述为单位。
    assert.equal(tryKernelLock(second), 'held')
    closeSync(first)
    assert.equal(tryKernelLock(second), 'acquired')
    closeSync(second)

    // 另一个进程持锁时这里看到 held；它被 SIGKILL 后内核立即释放。
    const lock = new URL('../../src/storage/file-lock.ts', import.meta.url).pathname
    const script = `import {openSync} from 'node:fs';import {tryKernelLock} from ${JSON.stringify(lock)};console.log(tryKernelLock(openSync(${JSON.stringify(file)},'r')));setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const said = await new Promise<string>((resolve) =>
      child.stdout!.once('data', (bytes) => resolve(String(bytes).trim()))
    )
    assert.equal(said, 'acquired')
    const probe = openSync(file, 'r')
    assert.equal(tryKernelLock(probe), 'held')
    await kill(child)
    assert.equal(tryKernelLock(probe), 'acquired')
    closeSync(probe)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new lock records the owner and the kernel-lock marker, and is exclusive', () =>
  disk((path) => {
    const lock = path + '.lock'
    const fd = createHeldLock(lock, GATEWAY_LOCK_FORMAT)
    try {
      const content = JSON.parse(readFileSync(lock, 'utf8'))
      assert.equal(content.format, GATEWAY_LOCK_FORMAT)
      assert.deepEqual(content.process, currentProcessIdentity())
      // 只有真的取得了内核锁才声明；其它平台沿用进程身份证据，不带标记。
      assert.equal(content.kernel_lock, linux ? true : undefined)
      assert.throws(() => createHeldLock(lock, GATEWAY_LOCK_FORMAT), /EEXIST/)
    } finally {
      closeSync(fd)
      unlinkSync(lock)
    }
  }))

test(
  'a live holder is never taken over even when its PID is invisible here, and a dead one always is',
  { skip: !linux },
  () =>
    disk(async (path) => {
      const lock = path + '.lock'
      const child = await holder(path)
      try {
        const held = JSON.parse(readFileSync(lock, 'utf8'))
        assert.equal(held.kernel_lock, true)
        assert.equal(held.process.pid, child.pid)
        // 另一个 PID 命名空间里的存活持有者：从这里看，锁里记录的 PID 不存在。
        const invisible = JSON.stringify({ ...held, process: { pid: INVISIBLE_PID, start: held.process.start } })
        writeFileSync(lock, invisible, { mode: 0o600 })
        assert.equal(recoverStaleLock(lock, GATEWAY_LOCK_FORMAT), false)
        assert.throws(() => new Store(path), /EEXIST/)
        assert.equal(readFileSync(lock, 'utf8'), invisible)
      } finally {
        await kill(child)
      }
      // 持有者被 SIGKILL：锁文件残留，内核已释放，下一个 Gateway 直接接管。
      assert(existsSync(lock))
      const reopened = new Store(path)
      try {
        assert.equal(JSON.parse(readFileSync(lock, 'utf8')).process.pid, process.pid)
      } finally {
        reopened.close()
      }
      assert.equal(existsSync(lock), false)
    })
)

test('a PID reused by the new process itself does not make a dead owner look alive', { skip: !linux }, () =>
  disk((path) => {
    const lock = path + '.lock'
    // 容器重启后新进程常拿到和旧进程相同的 PID，但启动标识不同；旧进程早已不在。
    const stale = JSON.stringify({
      format: GATEWAY_LOCK_FORMAT,
      process: { pid: process.pid, start: 'previous-incarnation' },
      kernel_lock: true
    })
    writeFileSync(lock, stale, { mode: 0o600 })
    const store = new Store(path)
    try {
      const now = JSON.parse(readFileSync(lock, 'utf8'))
      assert.deepEqual(now.process, currentProcessIdentity())
      assert.equal(now.kernel_lock, true)
    } finally {
      store.close()
    }
    assert.equal(existsSync(lock), false)
  })
)

test('a lock that is empty, unrecognised or corrupt is still never taken over', { skip: !linux }, () =>
  disk((path) => {
    const lock = path + '.lock'
    for (const content of [
      '',
      '{"format":',
      JSON.stringify({ format: 'other-format', process: { pid: INVISIBLE_PID, start: '1' }, kernel_lock: true })
    ]) {
      writeFileSync(lock, content, { mode: 0o600 })
      assert.throws(() => new Store(path), /EEXIST/)
      assert.equal(readFileSync(lock, 'utf8'), content)
      rmSync(lock)
    }
  })
)
