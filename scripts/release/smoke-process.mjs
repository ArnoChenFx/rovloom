/** 等待自有 smoke 子进程及管道真实 close；仅在此后对私有目录的 Windows 共享冲突做有界重试。 */
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'

/** 启动前取得容器身份；同步启动失败也先清理已创建的自有容器。 */
export function spawnSmokeChild(executable, args, options, { spawnChild = spawn, runtime, timeout = 15_000 } = {}) {
  const launch = runtime ? runtime.wrap(executable, args, { cwd: options.cwd, env: options.env }) : null
  try {
    launch?.prepare?.(timeout)
    const child = spawnChild(launch ? launch.file : executable, launch ? launch.args : args, {
      ...options,
      cwd: launch ? launch.cwd : options.cwd,
      env: launch ? launch.env : options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return {
      child,
      // Docker CLI 收到 SIGTERM 可先退出并返回 context canceled；产品信号必须经已确认的容器 ID 发送。
      stop: (signal) => (launch?.stop ? launch.stop(signal) : child.kill(signal)),
      cleanup: () => launch?.cleanup?.()
    }
  } catch (error) {
    launch?.cleanup?.()
    throw error
  }
}

/**
 * 固定时间/输出上限不放宽；超限只终止本次直接 child，close 前绝不结算或开始目录清理。
 * runtime 只替换启动方式（原生或一次性 Alpine 容器），不改变参数、环境与断言。
 */
export function runSmokeChild(executable, args, options, { spawnChild = spawn, timeout = 15_000, runtime } = {}) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 15_000) {
    throw new Error('invalid_smoke_timeout')
  }
  const input = options.input ?? ''
  if (typeof input !== 'string' && !ArrayBuffer.isView(input)) {
    throw new Error('invalid_smoke_input')
  }
  return new Promise(
    /** 所有失败均等到真实 close，避免 exit/error/kill 请求被误当作文件和管道已释放。 */ (resolve, reject) => {
      const started = performance.now()
      const { child, cleanup } = spawnSmokeChild(executable, args, options, { spawnChild, runtime, timeout })
      const chunks = { stdout: [], stderr: [] }
      let size = 0
      let failure
      let killRequested = false
      /** 一次请求只针对当前 child 对象；失败不寻找名字/PID，也不能伪造 close。 */
      const stop = () => {
        if (!killRequested) {
          killRequested = true
          try {
            child.kill('SIGKILL')
          } catch (error) {
            failure ??= error
          }
        }
      }
      const timer = setTimeout(
        /** 原执行期限到达后仍等待真实 close；无法退出时由原外层 CI 期限失败，不清理活目录。 */ () => {
          failure ??= Object.assign(new Error('standalone_smoke_timeout'), { code: 'smoke_timeout' })
          stop()
        },
        Math.max(1, timeout - (performance.now() - started))
      )
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on(
          'data',
          /** 合计输出最多 2 MiB；超限后继续排空管道，等待当前进程实际退出。 */ (bytes) => {
            size += bytes.length
            if (size > 2_097_152) {
              failure ??= Object.assign(new Error('standalone_smoke_output_limit'), { code: 'smoke_output_limit' })
              stop()
            } else {
              chunks[stream].push(Buffer.from(bytes))
            }
          }
        )
      }
      child.stdin.on('error', /** 早退管道由最终 child 状态与既有输出断言判定。 */ () => {})
      child.once(
        'error',
        /** spawn 失败也等待随后 close，保存最初失败。 */ (error) => {
          failure ??= error
        }
      )
      child.once(
        'close',
        /** close 表示退出与 stdio 关闭；不能使用较早的 exit 或 kill 返回值替代。 */ (status, signal) => {
          clearTimeout(timer)
          try {
            cleanup()
          } catch (error) {
            reject(error)
            return
          }
          if (failure) {
            reject(failure)
          } else {
            resolve({
              status,
              signal,
              stdout: Buffer.concat(chunks.stdout).toString('utf8'),
              stderr: Buffer.concat(chunks.stderr).toString('utf8')
            })
          }
        }
      )
      try {
        child.stdin.end(input)
      } catch (error) {
        failure ??= error
        stop()
      }
    }
  )
}

/** 只清理调用方自建根，Windows 最多六次尝试/750 ms 等待；耗尽或其它错误必须继续失败。 */
export async function cleanupSmokeDirectory(
  directory,
  { platform = process.platform, remove = rm, wait = pause } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(directory, { recursive: true, force: true, maxRetries: 0 })
      return
    } catch (error) {
      if (platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 5) {
        throw error
      }
      await wait((attempt + 1) * 50)
    }
  }
}
