/** 验证受控 native 的有界停止、真实 errno 和退出事实；只启动本测试拥有的隔离 child。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownedPathStamp } from '../../src/connector/luvus/host/native-process.js'
import {
  OwnedProcessShutdownError,
  signalOwnedPidfd,
  stopOwnedProcess
} from '../../src/connector/luvus/host/native-process.js'
import type {
  OwnedProcessSignal,
  OwnedProcessSignalAttempt,
  OwnedProcessStopPort
} from '../../src/connector/luvus/host/native-process.js'

const limits = { grace_ms: 5, exit_ms: 20 }

test(
  'owned path rejects relative and noncanonical inputs before traversing a parent chain',
  /** 独立自有 Bun 进程受父进程硬截止保护，回归时坏路径不能卡住主测试事件循环。 */ () => {
    const module = new URL('../../src/connector/luvus/host/native-process.ts', import.meta.url).href
    const errors = new URL('../../src/connector/luvus/types.ts', import.meta.url).href
    const code = `
      import assert from 'node:assert/strict';
      import { ownedPathStamp } from ${JSON.stringify(module)};
      import { LuvusAdapterError } from ${JSON.stringify(errors)};
      const paths = ['.', '..', 'control/approvals', '../control', '', '/workspace/..', '/workspace/', '//workspace', '/invalid\\0path', null, undefined, 1, {}];
      let checks = 0;
      for (const path of paths) {
        for (const kind of ['directory', 'binary', 'socket']) {
          assert.throws(() => ownedPathStamp(path, kind), (error) => error instanceof LuvusAdapterError && error.code === 'owned_path_untrusted');
          checks++;
        }
      }
      for (const kind of ['directory', 'binary', 'socket']) {
        assert.throws(() => ownedPathStamp('/', kind), (error) => error instanceof LuvusAdapterError && error.code === 'owned_path_untrusted');
        checks++;
      }
      process.stdout.write(JSON.stringify({ checks }));
    `
    const result = spawnSync(process.execPath, ['--no-env-file', '--eval', code], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4096
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { checks: 42 })
  }
)

test(
  'owned path completes a canonical protected parent chain with the same identity',
  /** 合法私有目录保留既有身份戳；规范校验不认领 native 实例或读取配置。 */ () => {
    const root = mkdtempSync(
      join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.owned-path-')
    )
    try {
      const first = ownedPathStamp(root, 'directory')
      assert.equal(ownedPathStamp(root, 'directory'), first)
      assert(first.includes(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

/** 构造只含合成关闭观察的内部测试端口；不能创建 OwnedNativeProcess 或任何 native 来源。 */
function observedChild(send: (signal: OwnedProcessSignal) => OwnedProcessSignalAttempt) {
  let gone = false
  let complete!: () => void
  const exited = new Promise<void>(
    /* 保存退出事件的独立结算口。 */ (resolve) => {
      complete = resolve
    }
  )
  return {
    port: {
      exited,
      /* 是否退出只由独立观察口更新，不从 signal 返回值或等待期限推断。 */ hasExited: () => gone,
      send
    } satisfies OwnedProcessStopPort,
    /** 模拟独立的真实 child 退出通知。 */
    exit() {
      gone = true
      complete()
    }
  }
}

/** 生成受限 syscall 观察；sent 和 errno 独立于实际退出事实。 */
function attempt(signal: OwnedProcessSignal, errno: number | null = null): OwnedProcessSignalAttempt {
  return {
    operation: 'pidfd_send_signal',
    signal,
    sent: errno === null,
    errno,
    os_code: errno === 1 ? 'EPERM' : errno === 3 ? 'ESRCH' : errno === 9 ? 'EBADF' : errno === 13 ? 'EACCES' : null
  }
}

/** 检查安全错误及全部真实发送观察，不允许把本地拒绝当作退出确认。 */
function failure(code: string, expected: readonly OwnedProcessSignalAttempt[]) {
  return /* 只比较安全元数据，不输出 child PID、环境或路径。 */ (error: unknown) => {
    assert(error instanceof OwnedProcessShutdownError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.equal(error.exit_confirmed, false)
    assert.equal(error.cleanup_pending, true)
    assert.deepEqual(error.attempts, expected)
    assert.equal(error.errno, expected.at(-1)?.errno ?? null)
    assert.equal(error.os_code, expected.at(-1)?.os_code ?? null)
    assert(Object.isFrozen(error.attempts))
    return true
  }
}

test(
  'owned stop preserves TERM and KILL permission errors and returns without an exit notification',
  /** 两次发送都失败时有界拒绝，独立退出事实仍保持未确认。 */ async () => {
    const attempts: OwnedProcessSignalAttempt[] = []
    const child = observedChild(
      /* TERM/KILL 的真实结果分别保留。 */ (signal) => {
        const result = attempt(signal, signal === 'SIGTERM' ? 1 : 13)
        attempts.push(result)
        return result
      }
    )
    await assert.rejects(
      stopOwnedProcess(child.port, limits),
      failure('owned_process_signal_failed', [attempt('SIGTERM', 1), attempt('SIGKILL', 13)])
    )
    assert.equal(child.port.hasExited(), false)
    assert.equal(attempts.length, 2)
  }
)

test(
  'owned stop checks a failed KILL after a successful TERM instead of waiting forever',
  /** TERM 已发送不保证退出，宽限后 KILL 的真实 errno 必须传回。 */ async () => {
    const child = observedChild(
      /* 模拟 TERM 成功但 KILL 被拒绝。 */ (signal) => attempt(signal, signal === 'SIGKILL' ? 1 : null)
    )
    await assert.rejects(
      stopOwnedProcess(child.port, limits),
      failure('owned_process_signal_failed', [attempt('SIGTERM'), attempt('SIGKILL', 1)])
    )
    assert.equal(child.port.hasExited(), false)
  }
)

test(
  'owned stop reaches a final deadline even when both signal syscalls report success',
  /** 发送成功仍必须等真实退出；最终等待结束不能改写物理状态。 */ async () => {
    const child = observedChild(/* 内核接受信号但尚未观察到退出。 */ (signal) => attempt(signal))
    await assert.rejects(
      stopOwnedProcess(child.port, limits),
      failure('owned_process_exit_timeout', [attempt('SIGTERM'), attempt('SIGKILL')])
    )
    assert.equal(child.port.hasExited(), false)
  }
)

test(
  'owned stop treats ESRCH as a race requiring the actual child exit observation',
  /** ESRCH 不是退出确认，只有随后真正的观察完成才可成功。 */ async () => {
    const child = observedChild(/* 模拟目标退出与通知到达之间的 ESRCH。 */ (signal) => attempt(signal, 3))
    const timer = setTimeout(/* 独立通知稍后才确认退出。 */ () => child.exit(), 2)
    try {
      await stopOwnedProcess(child.port, limits)
    } finally {
      clearTimeout(timer)
    }
    assert.equal(child.port.hasExited(), true)
    const unobserved = observedChild(/* 同样 ESRCH 没有独立通知时必须拒绝。 */ (signal) => attempt(signal, 3))
    await assert.rejects(
      stopOwnedProcess(unobserved.port, limits),
      failure('owned_process_signal_failed', [attempt('SIGTERM', 3), attempt('SIGKILL', 3)])
    )
    assert.equal(unobserved.port.hasExited(), false)
  }
)

test(
  'owned stop sends no KILL when a real exit notification arrives during the TERM grace period',
  /** 已确认退出后不再发信号，避免根据先前的活状态继续操作。 */ async () => {
    const sent: OwnedProcessSignal[] = []
    const child = observedChild(
      /* TERM 后由独立微任务观察实际退出。 */ (signal) => {
        sent.push(signal)
        queueMicrotask(/* 代表 child 的独立退出回调。 */ () => child.exit())
        return attempt(signal)
      }
    )
    await stopOwnedProcess(child.port, limits)
    assert.deepEqual(sent, ['SIGTERM'])
  }
)

test(
  'owned stop can be explicitly retried after a denied signal without inventing an exit',
  /** 恢复发送权限后重用相同拥有者端口；第一次失败不会把真实退出事实置为成功。 */ async () => {
    let denied = true
    const child = observedChild(
      /* 仅改变 signal 结果，退出通知仍由独立回调提供。 */ (signal) => {
        if (denied) {
          return attempt(signal, 1)
        }
        queueMicrotask(/* 真正成功的第二次停止才产生退出观察。 */ () => child.exit())
        return attempt(signal)
      }
    )
    await assert.rejects(
      stopOwnedProcess(child.port, limits),
      failure('owned_process_signal_failed', [attempt('SIGTERM', 1), attempt('SIGKILL', 1)])
    )
    assert.equal(child.port.hasExited(), false)
    denied = false
    await stopOwnedProcess(child.port, limits)
    assert.equal(child.port.hasExited(), true)
  }
)

test(
  'owned pidfd signal captures a real Linux EBADF without touching any process',
  /** 无效 fd 由真实 syscall 拒绝，errno 不能由测试或错误消息猜测。 */ () => {
    if (process.platform !== 'linux' || !process.versions.bun) {
      assert.throws(/* 其它平台必须保持不可用，不合成内核成功。 */ () => signalOwnedPidfd(-1, 'SIGTERM'))
      return
    }
    assert.deepEqual(signalOwnedPidfd(-1, 'SIGTERM'), attempt('SIGTERM', 9))
  }
)

test(
  'owned stop rejects real syscall failure then cleans the same isolated child through its continuously held pidfd',
  /** 失败回归只触及自建 child；测试结束恢复同一持有 pidfd 的发送，绝不遗留 child 或按 PID 补杀。 */ async () => {
    if (process.platform !== 'linux' || !process.versions.bun) {
      assert.throws(/* 不支持的环境保持失败关闭。 */ () => signalOwnedPidfd(-1, 'SIGKILL'))
      return
    }
    const ffi = createRequire(import.meta.url)('bun:ffi') as {
      dlopen(
        path: string,
        symbols: Record<string, { args: string[]; returns: string }>
      ): { symbols: { pidfd_open(pid: number, flags: number): number; close(fd: number): number } }
    }
    const libc = ffi.dlopen('libc.so.6', {
      pidfd_open: { args: ['int', 'u32'], returns: 'int' },
      close: { args: ['int'], returns: 'int' }
    })
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),3000);process.stdout.write("ready\\n");setInterval(()=>{},1000)'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], env: {} }
    )
    let gone = false
    let invalid = true
    const exited = new Promise<void>(
      /* 只通过该直接 child 的 exit 或确定未 spawn 的失败确认清理完成。 */ (resolve) => {
        child.once(
          'exit',
          /* 更新独立的真实退出事实。 */ () => {
            gone = true
            resolve()
          }
        )
        child.once(
          'error',
          /* 无 child PID 的启动失败不会遗留待清理进程。 */ () => {
            if (!Number.isInteger(child.pid)) {
              gone = true
              resolve()
            }
          }
        )
      }
    )
    let fd = -1
    const port: OwnedProcessStopPort = {
      exited,
      /* 检查独立的真实 child 退出通知。 */ hasExited: () => gone,
      /* 初次只对无效 fd 产生真实 EBADF；重试仍使用从 spawn 起持续持有的原 pidfd。 */ send: (signal) =>
        signalOwnedPidfd(invalid ? -1 : fd, signal)
    }
    try {
      fd = libc.symbols.pidfd_open(child.pid!, 0)
      assert(fd >= 0)
      await new Promise<void>(
        /* 等待隔离 child 安装 TERM 处理器，不使用任意时长猜测就绪。 */ (resolve, reject) => {
          const timer = setTimeout(
            /* 有界拒绝未就绪的测试 child。 */ () => reject(new Error('isolated_child_start_timeout')),
            2000
          )
          child.stdout!.once(
            'data',
            /* 只消费固定就绪字节，不记录任何 native 数据。 */ () => {
              clearTimeout(timer)
              resolve()
            }
          )
          child.once(
            'error',
            /* 测试启动失败时同样结束等待。 */ () => {
              clearTimeout(timer)
              reject(new Error('isolated_child_spawn_failed'))
            }
          )
        }
      )
      await assert.rejects(
        stopOwnedProcess(port, limits),
        failure('owned_process_signal_failed', [attempt('SIGTERM', 9), attempt('SIGKILL', 9)])
      )
      assert.equal(gone, false)
      assert.equal(child.exitCode, null)
      invalid = false
      await stopOwnedProcess(port, { grace_ms: 5, exit_ms: 2000 })
      assert.equal(gone, true)
      assert.equal(child.signalCode, 'SIGKILL')
    } finally {
      if (!gone && fd >= 0) {
        invalid = false
        try {
          await stopOwnedProcess(port, { grace_ms: 5, exit_ms: 2000 })
        } catch {
          // 测试环境拒绝 signal 时仍等待 fixture 自己的最终退出，不以 PID 补杀。
        }
      }
      if (!gone) {
        await new Promise<void>(
          /* pidfd_open 失败时也有独立自退出，最终等待仍须有界。 */ (resolve, reject) => {
            const timer = setTimeout(
              /* 未收到真实退出时准确报告，不能伪造清理成功。 */ () =>
                reject(new Error('isolated_child_exit_unconfirmed')),
              4000
            )
            void exited.then(
              /* 真实退出后才允许释放持有的 pidfd。 */ () => {
                clearTimeout(timer)
                resolve()
              }
            )
          }
        )
      }
      if (fd >= 0) {
        libc.symbols.close(fd)
      }
    }
  }
)
