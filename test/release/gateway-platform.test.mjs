// 对真实入口和可选的实际单文件候选验收空 Gateway；仅使用临时 HOME 与回环动态端口。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOrCreateRoleConfig } from '../../src/cli/first-config.ts'
import { configDocument, readConfig } from '../../src/cli/config.ts'
import { createProductionCliRuntime } from '../../src/cli/production.ts'
import { createProductSources } from '../../src/cli/product-sources.ts'
import { runCli } from '../../src/cli/run.ts'
import { smokeRuntime } from '../../scripts/release/runtime.mjs'

// 向内核申请并释放测试端口；不扫描或连接用户的既有监听器。
async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  server.close()
  await once(server, 'close')
  return address.port
}

test(
  '实际 Gateway 首次配置、只读检查、双库启动、401 及退出后重开',
  { timeout: 30_000 },
  /* 原生候选由 CI 提供；本地默认运行同一个正式 main，不生成身份或调用模型。 */ async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-gateway-native-'))
    const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
    const executable = process.env.ROVLOOM_GATEWAY_EXECUTABLE ?? process.execPath
    // musl 候选在 glibc 宿主上无法直接执行；ROVLOOM_MUSL_ALPINE=1 时改由 Alpine 容器启动。
    const runtime = smokeRuntime()
    const prefix = process.env.ROVLOOM_GATEWAY_EXECUTABLE ? [] : ['--no-env-file', main]
    const env = {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH ?? '',
      NO_COLOR: '1',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home } : {})
    }
    const search = join(home, 'search')
    const directory = join(search, 'private')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      chmodSync(search, 0o111)
    }
    const configPath = join(directory, 'gateway.json')
    try {
      const defaults = readOrCreateRoleConfig('gateway', configPath, { home, platform: process.platform })
      const mcp = await port()
      let devices = await port()
      while (devices === mcp) {
        devices = await port()
      }
      const state = join(directory, 'state')
      writeFileSync(
        configPath,
        JSON.stringify(
          configDocument({
            ...defaults,
            state_dir: state,
            mcp_port: mcp,
            device_port: devices,
            management_enabled: false
          })
        )
      )
      for (const action of ['check', 'check-runtime']) {
        const launch =
          runtime.kind === 'alpine'
            ? runtime.wrap(executable, [...prefix, 'config', action, '--config', configPath], {
                cwd: process.cwd(),
                env
              })
            : null
        const checked = spawnSync(
          launch ? launch.file : executable,
          launch ? launch.args : [...prefix, 'config', action, '--config', configPath],
          {
            env: launch ? launch.env : env,
            cwd: launch ? launch.cwd : undefined,
            input: '',
            encoding: 'utf8',
            timeout: 10_000
          }
        )
        assert.equal(checked.error, undefined)
        assert.equal(checked.status, 0, checked.stderr)
        assert.equal(existsSync(state), false)
      }
      const bytes = readFileSync(configPath)
      let generation
      for (let attempt = 0; attempt < 2; attempt++) {
        const gatewayLaunch =
          runtime.kind === 'alpine'
            ? runtime.wrap(executable, [...prefix, 'gateway', '--config', configPath], { cwd: process.cwd(), env })
            : null
        const child = spawn(
          gatewayLaunch ? gatewayLaunch.file : executable,
          gatewayLaunch ? gatewayLaunch.args : [...prefix, 'gateway', '--config', configPath],
          {
            env: gatewayLaunch ? gatewayLaunch.env : env,
            cwd: gatewayLaunch ? gatewayLaunch.cwd : undefined,
            stdio: ['pipe', 'pipe', 'pipe']
          }
        )
        let diagnostic = ''
        let stdout = ''
        const closed = once(child, 'close')
        let ready
        const listening = new Promise(
          /* 只由正式入口的未配对提示唤醒实际 HTTP 检查。 */ (resolve) => {
            ready = resolve
          }
        )
        child.stdout.on(
          'data',
          /* 保存输出以断言不会混入 MCP 协议内容。 */ (chunk) => {
            stdout += chunk
          }
        )
        child.stderr.on(
          'data',
          /* 仅收集固定诊断，失败消息不包含状态文件正文。 */ (chunk) => {
            diagnostic += chunk
            if (diagnostic.includes('pairing_required\n')) {
              ready()
            }
          }
        )
        let timer
        try {
          await Promise.race([
            listening,
            closed.then(
              /* 提前退出立即失败，保留真实诊断以定位平台差异。 */ () => {
                throw new Error('gateway_early_exit: ' + diagnostic)
              }
            ),
            new Promise(
              /* 使用有界启动期限，不延长产品租期或原生编译预算。 */ (_resolve, reject) => {
                timer = setTimeout(
                  /* 到期结束本例等待，不将超时视为 ready。 */ () => reject(new Error('gateway_start_timeout')),
                  10_000
                )
              }
            )
          ])
          const denied = await fetch('http://127.0.0.1:' + mcp + '/mcp', { headers: { Connection: 'close' } })
          assert.equal(denied.status, 401)
          await denied.arrayBuffer()
          assert.equal(existsSync(join(state, 'gateway.db')), true)
          assert.equal(existsSync(join(state, 'managed', 'mcp-callers.json')), false)
          assert.equal(stdout, '')
          const stored = readFileSync(join(state, 'gateway.db'))
            .toString('latin1')
            .match(/recovery_[a-f0-9-]+/u)?.[0]
          assert(stored, 'actual_persisted_generation_missing')
          generation ??= stored
          assert.equal(stored, generation)
        } finally {
          clearTimeout(timer)
          if (child.exitCode === null && child.signalCode === null) {
            child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM')
          }
          const [code, signal] = await closed
          if (process.platform !== 'win32') {
            assert.equal(code, 0, diagnostic)
            assert.equal(signal, null)
          } else {
            // Windows的child.kill是强制结束；只确认真实进程已退出，不把它当作正常关闭。
            assert(code !== null || signal !== null)
          }
        }
        for (const name of ['gateway.db.lock']) {
          const lock = join(state, name)
          assert.equal(existsSync(lock), process.platform === 'win32')
          if (process.platform === 'win32') {
            // 已确认本例子进程退出后，测试所有者清理自己的崩溃锁；产品不自动接管。
            rmSync(lock)
          }
        }
      }
      assert.deepEqual(readFileSync(configPath), bytes)
      assert.equal(readConfig(configPath).state_dir, state)
    } finally {
      if (process.platform !== 'win32') {
        chmodSync(search, 0o700)
      }
      if (process.platform === 'win32') {
        // 子进程已结束后才回收本例临时对象，不影响真实关闭和崩溃锁的前置断言。
        Bun.gc(true)
      }
      rmSync(home, { recursive: true, force: true })
    }
  }
)

test(
  '实际生产Gateway通过Abort正常关闭并重开，双库和原代次保留且写锁释放',
  { timeout: 30_000 },
  /* 与单文件进程验收互补，六平台均运行真实生产工厂及HTTP/WS，不生成身份。 */ async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-gateway-runtime-'))
    try {
      const path = join(home, 'gateway.json')
      const defaults = readOrCreateRoleConfig('gateway', path, { home, platform: process.platform })
      const ports = new Set()
      while (ports.size < 2) {
        ports.add(await port())
      }
      const [mcp, devices] = [...ports]
      const state = join(home, 'state')
      writeFileSync(
        path,
        JSON.stringify(
          configDocument({
            ...defaults,
            state_dir: state,
            mcp_port: mcp,
            device_port: devices,
            management_enabled: false
          })
        )
      )
      let generation
      for (let attempt = 0; attempt < 2; attempt++) {
        const stop = new AbortController()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        let diagnostic = ''
        let ready
        let timer
        const listening = new Promise(
          /* 只由真实入口就绪诊断唤醒。 */ (resolve) => {
            ready = resolve
          }
        )
        stderr.on(
          'data',
          /* 不读取或输出身份正文。 */ (chunk) => {
            diagnostic += chunk
            if (diagnostic.includes('pairing_required\n')) {
              ready()
            }
          }
        )
        const running = runCli(
          ['gateway', '--config', path],
          { stdin, stdout, stderr, signal: stop.signal },
          createProductionCliRuntime(createProductSources())
        )
        try {
          await Promise.race([
            listening,
            running.then(
              /* 提前退出不能被视为就绪。 */ (code) => {
                throw new Error('gateway_early_exit_' + code + ': ' + diagnostic)
              }
            ),
            new Promise(
              /* 有界等待真实监听器。 */ (_resolve, reject) => {
                timer = setTimeout(/* 超时只使本例失败。 */ () => reject(new Error('gateway_start_timeout')), 10_000)
              }
            )
          ])
          const denied = await fetch('http://127.0.0.1:' + mcp + '/mcp', { headers: { Connection: 'close' } })
          assert.equal(denied.status, 401)
          await denied.arrayBuffer()
          assert.equal(existsSync(join(state, 'managed', 'mcp-callers.json')), false)
          assert.equal(stdout.read(), null)
        } finally {
          clearTimeout(timer)
          stop.abort()
          assert.equal(await running, 0, diagnostic)
          stdin.destroy()
          stdout.destroy()
          stderr.destroy()
        }
        const stored = readFileSync(join(state, 'gateway.db'))
          .toString('latin1')
          .match(/recovery_[a-f0-9-]+/u)?.[0]
        assert(stored, 'actual_persisted_generation_missing')
        generation ??= stored
        assert.equal(stored, generation)
        for (const name of ['gateway.db.lock']) {
          assert.equal(existsSync(join(state, name)), false)
        }
      }
    } finally {
      // 生产关闭接口及写锁释放已断言，再释放Bun延迟回收的statement包装以删除自有fixture。
      if (process.platform === 'win32') {
        Bun.gc(true)
      }
      rmSync(home, { recursive: true, force: true })
    }
  }
)
