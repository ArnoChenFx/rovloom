// 真实端到端验收：两个真实进程（rovloom gateway / rovloom connector + 真实 herdr provider）。
// SIGTERM 停网关进程，断言 connector 的 stderr 一定出现 connector_disconnect code=1008 close_reason=transport_closed，
// 并验证网关重启后 connector 回到 ready。
// 用法（先 bun run build）：
//   LUVUS_TEST_ROOT=<非世界可写的父目录> bun --no-env-file scripts/e2e/connector-disconnect.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { createDualRoleFixture } from '../release/dual-role-fixture.mjs'

setTimeout(() => {
  process.stderr.write('E2E_TIMEOUT\n')
  process.exit(2)
}, 240_000).unref()

const report = (line) => process.stdout.write(line + '\n')

/** 启动一个真实角色进程，按块收集 stderr（有界）。 */
function start(executable, args, name, configPath, cwd, env) {
  const child = spawn(executable, [...args, name, '--config', configPath], {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  let stdout = ''
  child.stdout.on('data', (b) => (stdout = (stdout + String(b)).slice(-8192)))
  child.stderr.on('data', (b) => (stderr = (stderr + String(b)).slice(-16384)))
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  return {
    child,
    get stderr() {
      return stderr
    },
    get stdout() {
      return stdout
    },
    closed,
    /** 只给本轮直接 child 发 SIGTERM，模拟运维停网关。 */
    term() {
      child.kill('SIGTERM')
    },
    /** 强制回收本轮直接 child，避免遗留进程。 */
    kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
  }
}

const f = await createDualRoleFixture({ herdrBinary: '/opt/minibox/tools/bin/herdr' })
let gateway
let connector
try {
  const { mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = join(f.root, 'empty-cwd')
  const home = join(f.root, 'empty-home')
  const emptyPath = join(f.root, 'empty-path')
  for (const path of [cwd, home, emptyPath]) {
    mkdirSync(path, { mode: 0o700 })
  }
  // 用本分支刚 build 出的真实 CLI 入口跑两个真实角色进程。
  // 显式用运行时二进制 + 入口文件，避免空 PATH 下依赖 shebang 找 bun。
  const executable = process.execPath
  const args = [join(process.cwd(), 'dist/src/cli/main.js')]
  const env = { PATH: emptyPath, HOME: home, TMPDIR: f.root, LANG: 'C.UTF-8', NO_COLOR: '1' }

  gateway = start(executable, args, 'gateway', f.gatewayConfigPath, cwd, env)
  const resource = f.resource
  let listening = false
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const response = await fetch(resource, { signal: AbortSignal.timeout(500) })
      assert.equal(response.status, 401)
      listening = true
      break
    } catch {
      await pause(25)
    }
  }
  assert(listening, 'e2e_gateway_not_listening:' + gateway.stderr)
  report('gateway=listening')

  connector = start(executable, args, 'connector', f.connectorConfigPath, cwd, env)
  // 等 connector 真实 ready（stderr 的固定相位行）。
  let ready = false
  for (let attempt = 0; attempt < 600; attempt++) {
    if (connector.stderr.includes('connector_transport ready provider_ready=true')) {
      ready = true
      break
    }
    await pause(25)
  }
  assert(ready, 'e2e_connector_not_ready:' + connector.stderr)
  report('connector=ready')
  report('baseline_stderr=' + JSON.stringify(connector.stderr.split('\n').filter(Boolean)))

  // SIGTERM 停网关进程：这是运维真实停服路径。
  gateway.term()
  const stopped = await gateway.closed
  report('gateway=stopped code=' + String(stopped.code) + ' signal=' + String(stopped.signal))

  const line = 'connector_disconnect code=1008 close_reason=transport_closed'
  let found = false
  for (let attempt = 0; attempt < 400; attempt++) {
    if (connector.stderr.includes(line)) {
      found = true
      break
    }
    await pause(25)
  }
  report('connector_stderr=' + JSON.stringify(connector.stderr.split('\n').filter(Boolean).slice(-8)))
  assert(found, 'e2e_missing_disconnect_line:' + connector.stderr)
  report('disconnect_line=present')

  // 网关重启：同一端口/配置再起一个真实进程，connector 应自动退避重连回到 ready。
  const before = connector.stderr.length
  gateway = start(executable, args, 'gateway', f.gatewayConfigPath, cwd, env)
  let relistening = false
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const response = await fetch(resource, { signal: AbortSignal.timeout(500) })
      assert.equal(response.status, 401)
      relistening = true
      break
    } catch {
      await pause(25)
    }
  }
  assert(relistening, 'e2e_gateway_restart_failed:' + gateway.stderr)
  report('gateway=restarted')

  // connector 的新 ready 行必须在重启之后出现（截取重启后的新增 stderr）。
  let reready = false
  for (let attempt = 0; attempt < 800; attempt++) {
    const tail = connector.stderr.slice(Math.max(0, connector.stderr.length - 4096))
    if (connector.stderr.length > before && tail.includes('connector_transport ready provider_ready=true')) {
      reready = true
      break
    }
    await pause(25)
  }
  report('after_restart_stderr=' + JSON.stringify(connector.stderr.split('\n').filter(Boolean).slice(-8)))
  assert(reready, 'e2e_connector_not_ready_after_restart:' + connector.stderr)
  report('connector=ready_after_restart')
} finally {
  gateway?.term()
  connector?.term()
  await pause(300)
  gateway?.kill()
  connector?.kill()
  await Promise.allSettled([gateway?.closed, connector?.closed])
  try {
    f.close()
  } catch {
    // 原生 owner 仍存在时 fixture 会保留自有根：不在这里强删，只报告。
    report('fixture_root_retained')
  }
}
process.stdout.write('E2E_OK\n')
