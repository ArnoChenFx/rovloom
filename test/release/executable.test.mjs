/** 验证真实编译产物在隔离目录运行，明确区分设施探针与尚未接线的产品候选。 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as wait } from 'node:timers/promises'
import { test } from 'node:test'
import { buildStandalone, requestedTarget, sha256 } from '../../scripts/release/build.mjs'
import { smokeStandalone } from '../../scripts/release/smoke.mjs'
import { loadManagementAssets } from '../../src/admin/assets.ts'
import { cleanupSmokeDirectory, runSmokeChild } from '../../scripts/release/smoke-process.mjs'

/** 单元模型只分开模拟 exit/error/kill/close，不冒充 Windows 内核退出或真实锁故障。 */
function controlledChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let kills = 0
  child.kill = /** 记录请求但不伪造退出或 close。 */ (signal) => {
    assert.equal(signal, 'SIGKILL')
    kills++
    return true
  }
  return {
    child,
    kills: /** 观察自有模型的终止请求数。 */ () => kills,
    close: /** 独立发出代表 stdio 关闭的 close。 */ (status = 0, signal = null) => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', status, signal)
    }
  }
}

test(
  'smoke runner collects a real direct child exit and exact Unicode output without a shell',
  /** 只运行当前固定 Bun 及静态样例源码，不读取用户环境或连接真实服务。 */ async () => {
    const result = await runSmokeChild(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        'process.stdout.write(process.argv[1]);process.stderr.write("fixed-error");process.exit(23)',
        '汉字 $literal `literal`'
      ],
      {
        cwd: process.cwd(),
        env: { PATH: '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }
      }
    )
    assert.equal(result.status, 23)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, '汉字 $literal `literal`')
    assert.equal(result.stderr, 'fixed-error')
  }
)

test(
  'exit alone cannot complete smoke or clean a directory before close',
  /** 真实临时目录、受控事件模型，证明清理顺序依赖 close。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-smoke-close-'))
    const c = controlledChild()
    let cleaned = false
    const result = runSmokeChild(
      '/fixture-owned-child',
      [],
      { env: {}, cwd: directory },
      { spawnChild: /** 不启动任意进程。 */ () => c.child }
    ).then(
      /** 只有真实关闭的结果能力才允许进入清理。 */ async () => {
        cleaned = true
        await cleanupSmokeDirectory(directory)
      }
    )
    try {
      c.child.emit('exit', 0, null)
      await Promise.resolve()
      assert.equal(cleaned, false)
      assert(existsSync(directory))
      c.close()
      await result
      assert.equal(existsSync(directory), false)
    } finally {
      c.close()
      await result
      await rm(directory, { recursive: true, force: true })
    }
  }
)

for (const reason of ['error', 'timeout', 'output_limit']) {
  test(
    `smoke ${reason} cannot settle or release its directory until close`,
    /** 终止请求/错误不是物理退出；直到 close 才让失败到达清理层。 */ async () => {
      const directory = mkdtempSync(join(tmpdir(), 'rovloom-smoke-failure-'))
      const c = controlledChild()
      let settled = false
      const work = runSmokeChild(
        '/fixture-owned-child',
        [],
        { env: {}, cwd: directory },
        {
          spawnChild: /** 当前测试只控制自己的模型。 */ () => c.child,
          timeout: reason === 'timeout' ? 10 : 15_000
        }
      )
      const observed = work.finally(
        /** 模拟外层 finally 的清理触发时机。 */ async () => {
          settled = true
          await cleanupSmokeDirectory(directory)
        }
      )
      const expected = reason === 'error' ? 'EACCES' : reason === 'timeout' ? 'smoke_timeout' : 'smoke_output_limit'
      const rejected = assert.rejects(observed, { code: expected })
      try {
        if (reason === 'error') {
          c.child.emit('error', Object.assign(new Error('fixture spawn failure'), { code: 'EACCES' }))
        } else if (reason === 'output_limit') {
          c.child.stdout.write(Buffer.alloc(2_097_153))
        } else {
          await wait(25)
        }
        await Promise.resolve()
        assert.equal(settled, false)
        assert(existsSync(directory))
        assert.equal(c.kills(), reason === 'error' ? 0 : 1)
        c.close(1)
        await rejected
        assert.equal(existsSync(directory), false)
      } finally {
        c.close(1)
        await rejected
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
}

test(
  'post-close Windows sharing conflicts retry briefly, and permanent conflicts remain failures',
  /** 对自有目录注入 EBUSY，真实删除只在允许的一次成功尝试发生；不是 OS 锁根因实测。 */ async () => {
    for (const permanent of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), 'rovloom-smoke-retry-'))
      const waits = []
      let attempts = 0
      try {
        const cleanup = cleanupSmokeDirectory(directory, {
          platform: 'win32',
          remove: /** 前几次或全部尝试模拟 Windows 共享冲突。 */ async (path, options) => {
            assert.equal(path, directory)
            assert.equal(options.maxRetries, 0)
            attempts++
            if (permanent || attempts < 3) {
              throw Object.assign(new Error('fixture sharing violation'), { code: 'EBUSY' })
            }
            await rm(path, options)
          },
          wait: /** 只核对有界等待预算，不在模型中重复实际等待。 */ async (ms) => {
            waits.push(ms)
          }
        })
        if (permanent) {
          await assert.rejects(cleanup, { code: 'EBUSY' })
          assert.equal(attempts, 6)
          assert.deepEqual(waits, [50, 100, 150, 200, 250])
          assert(existsSync(directory))
        } else {
          await cleanup
          assert.equal(attempts, 3)
          assert.deepEqual(waits, [50, 100])
          assert.equal(existsSync(directory), false)
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
)

test(
  'unexpected cleanup errors and non-Windows failures do not retry',
  /** 不能用重试掩盖非共享冲突或其它平台的错误。 */ async () => {
    for (const [platform, code] of [
      ['win32', 'EINVAL'],
      ['linux', 'EBUSY']
    ]) {
      let attempts = 0
      await assert.rejects(
        cleanupSmokeDirectory('/fixture-not-used', {
          platform,
          remove: /** 不触及磁盘，只报告确定错误。 */ async () => {
            attempts++
            throw Object.assign(new Error('fixture failure'), { code })
          },
          wait: /** 此分支不允许延长清理。 */ async () => assert.fail('unexpected retry')
        }),
        { code }
      )
      assert.equal(attempts, 1)
    }
  }
)

test(
  'single executable embeds Worker, controlled helper, management assets and SQLite without external Bun',
  { timeout: 60_000 },
  /** 本机实际运行 binary 并核对原资源字节，不能从 checkout 补包。 */ async () => {
    const incomplete = await buildStandalone({ entrypoint: 'test/release/probe.mjs', probe: true })
    await assert.rejects(
      /* 故意漏掉 Worker 后隔离启动必须失败，不能从工作目录找到源码。 */ () =>
        smokeStandalone(incomplete.binary, [{ args: [], code: 0 }]),
      /ModuleNotFound/u
    )
    const output = await buildStandalone({
      entrypoint: 'test/release/probe.mjs',
      workers: ['test/release/probe-worker.mjs'],
      probe: true
    })
    const [result] = await smokeStandalone(output.binary, [{ args: [], code: 0, stderr: /^$/u }])
    const report = JSON.parse(result.stdout)
    assert.equal(report.scope, 'packaging-probe')
    assert.equal(report.helper, 'embedded-worker-helper')
    assert.equal(report.sqlite, 'pass')
    const paths = new Map(
      report.assets.map(/* 将探针实际读到的嵌入资源映射到摘要以逐项比对。 */ (asset) => [asset.path, asset.sha256])
    )
    assert(paths.has('/theme.js'))
    const resources = loadManagementAssets(`${output.directory}/webui`)
    assert.deepEqual([...paths.keys()].sort(), [...resources.keys()].sort())
    for (const [path, bytes] of resources) {
      assert.equal(paths.get(path), sha256(bytes))
    }
    assert.equal(
      paths.get('/rovloom-mark-transparent.png'),
      sha256(readFileSync('docs/assets/brand/rovloom-mark-transparent.png'))
    )
    // 程序图标是已提交的透明多尺寸 ICO，构建目录里是同一份原字节。
    assert.deepEqual(
      readFileSync(`${output.directory}/rovloom.ico`),
      readFileSync('docs/assets/brand/rovloom-icon.ico')
    )
    assert.equal(output.manifest.runtimeAcceptance, 'pending')
    assert.equal(output.manifest.productWiring, 'pending')
  }
)

test(
  'missing product/Worker inputs fail explicitly, and Windows icon cannot be accepted by Linux cross build',
  /** 输入缺失必须失败，不能临时生成替代 CLI 或忽略附加 Worker。 */ async () => {
    await assert.rejects(buildStandalone({ entrypoint: 'src/missing-product-cli.ts' }), /Missing standalone input/u)
    await assert.rejects(
      buildStandalone({ entrypoint: 'test/release/probe.mjs', workers: ['src/missing-worker.ts'] }),
      /Missing standalone input/u
    )
    if (process.platform !== 'win32') {
      await assert.rejects(
        buildStandalone({ entrypoint: 'test/release/probe.mjs', target: 'bun-windows-x64' }),
        /native Windows build/u
      )
    }
    // CI 声明的目标必须精确匹配受支持集合，不能被宿主平台悄悄覆盖。
    for (const target of [
      'bun-linux-x64-musl',
      'bun-linux-arm64-musl',
      'bun-linux-x64',
      'bun-darwin-arm64',
      'bun-windows-x64'
    ]) {
      assert.equal(requestedTarget({ TARGET: target }), target)
      assert.equal(requestedTarget({ RELEASE_TARGET: target }), target)
    }
    // 未声明（或空值）时回退到宿主平台；非空声明必须精确受支持。
    assert.equal(requestedTarget({}), undefined)
    assert.equal(requestedTarget({ TARGET: '' }), undefined)
    for (const declared of ['bun-linux-x64-glibc', 'bun-linux-x64-musl-extra', 'linux-x64-musl']) {
      assert.throws(() => requestedTarget({ TARGET: declared }), /Unsupported standalone target/u)
    }
    // musl 只有 Linux 提供，且后缀必须精确；其余写法在编译前就被拒绝。
    for (const target of [
      'bun-darwin-x64-musl',
      'bun-windows-x64-musl',
      'bun-linux-x64-musl-extra',
      'bun-linux-x64-glibc',
      'bun-linux-x86',
      'linux-x64-musl'
    ]) {
      await assert.rejects(
        buildStandalone({ entrypoint: 'test/release/probe.mjs', target }),
        /Unsupported standalone target/u
      )
    }
  }
)
