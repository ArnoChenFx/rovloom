/** 端到端验收台：真实单文件产品、真实Herdr、真实MCP SDK客户端；每个场景独占一套新状态。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createDualRoleFixture } from '../scripts/release/dual-role-fixture.mjs'
import { nativeChildren, sameNativeChildAlive } from '../scripts/release/dual-role-smoke.mjs'

/** 只保留有界输出；e2e需要观察失败原因，但不让异常进程耗尽内存。 */
function role(executable, name, configPath, cwd, env) {
  const child = spawn(executable, [name, '--config', configPath], {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = { stdout: '', stderr: '' }
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (bytes) => {
      output[stream] = (output[stream] + bytes.toString('utf8')).slice(-65_536)
    })
  }
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  let result
  closed.then((value) => (result = value))
  return {
    child,
    name,
    output,
    closed,
    get alive() {
      return result === undefined
    },
    get exit() {
      return result
    },
    /** 优雅关闭：产品必须自己释放native owner。 */
    async stop(timeout = 8000) {
      if (result) {
        return result
      }
      child.kill('SIGTERM')
      const done = await Promise.race([closed, pause(timeout).then(() => undefined)])
      if (!done) {
        child.kill('SIGKILL')
        await closed
        throw new Error(`e2e_${name}_stop_timeout`)
      }
      return done
    },
    /** 断电式终止：不给产品任何清理机会。 */
    async kill() {
      child.kill('SIGKILL')
      return closed
    }
  }
}

/** MCP工具返回的统一投影；错误不抛出，场景自己断言期望的拒绝。 */
export async function tool(client, name, args) {
  let result
  try {
    result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  } catch (error) {
    throw new Error(`e2e_${name}_protocol:${error.message}:${JSON.stringify(args).slice(0, 400)}`)
  }
  return { isError: result.isError === true, data: result.structuredContent?.data, raw: result.structuredContent }
}

/** 断言成功并返回data。 */
export async function ok(client, name, args) {
  const result = await tool(client, name, args)
  assert.equal(result.isError, false, `e2e_${name}_error:${JSON.stringify(result.raw)}`)
  assert(result.data, `e2e_${name}_data_missing`)
  return result.data
}

/** 轮询直到条件成立；失败时带上最后一次观察，便于判断是否为环境问题。 */
export async function until(label, attempt, { tries = 100, interval = 100 } = {}) {
  let last
  for (let index = 0; index < tries; index++) {
    last = await attempt()
    if (last) {
      return last
    }
    await pause(interval)
  }
  throw new Error(`e2e_timeout:${label}:${JSON.stringify(last)}`)
}

/** 新建一套Gateway + Connector + 官方Herdr；返回可重复启停的句柄。 */
export async function createStack({ binary, herdrBinary, methods = ['ping'], connectorSettings = {}, attach = false }) {
  const f = await createDualRoleFixture({ herdrBinary, methods, connectorSettings, attach })
  const cwd = join(f.root, 'empty-cwd')
  const home = join(f.root, 'empty-home')
  const emptyPath = join(f.root, 'empty-path')
  for (const path of [cwd, home, emptyPath]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const executable = join(f.root, 'rovloom')
  copyFileSync(binary, executable)
  const env = { PATH: emptyPath, HOME: home, TMPDIR: f.root, LANG: 'C.UTF-8', NO_COLOR: '1' }
  const roles = new Set()
  const clients = new Set()
  let started = false
  const stack = {
    f,
    roles,
    target: f.target,
    /** 启动Gateway并等待MCP端点以401应答。 */
    async startGateway() {
      const gateway = role(executable, 'gateway', f.gatewayConfigPath, cwd, env)
      roles.add(gateway)
      await until('gateway_listening', async () => {
        assert(gateway.alive, `e2e_gateway_exited:${gateway.output.stderr}`)
        try {
          return (await fetch(f.resource, { signal: AbortSignal.timeout(500) })).status === 401
        } catch {
          return false
        }
      })
      stack.gateway = gateway
      return gateway
    },
    /** 启动Connector；Herdr由Connector自己的managed native owner拉起。 */
    startConnector() {
      // 安装阶段以create建立持久claim账本，之后每次启动只open；这里复现同一生命周期。
      if (started) {
        const path = join(f.connectorState, 'managed', 'providers.json')
        const providers = JSON.parse(readFileSync(path, 'utf8'))
        providers.providers[0].value.config.connector.claims.mode = 'open'
        writeFileSync(path, JSON.stringify(providers))
      }
      started = true
      const connector = role(executable, 'connector', f.connectorConfigPath, cwd, env)
      roles.add(connector)
      stack.connector = connector
      return connector
    },
    /** 真实MCP SDK客户端，Bearer来自令牌注册表。 */
    async connect() {
      const client = new Client({ name: 'rovloom-e2e', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(f.resource), {
          requestInit: { headers: { authorization: `Bearer ${f.proof}` } }
        })
      )
      clients.add(client)
      return client
    },
    /** 读取持久设备状态；online只表示认证已提交。 */
    async device(client) {
      const result = await tool(client, 'machines_get', { machine_id: f.target.machine_id })
      return result.isError ? undefined : result.data
    },
    /** 等到Connector认证并让Herdr可达：以一次真实ping成功为准。 */
    async waitReady(client, { tries = 150 } = {}) {
      return until(
        'ready',
        async () => {
          const result = await stack
            .invoke(client, { method: 'ping', params: {} }, { wait_ms: 200 })
            .catch(() => undefined)
          return result?.state === 'responded' ? result : undefined
        },
        { tries, interval: 200 }
      )
    },
    /** 提交原生调用并等待终态；返回最后一次call_get视图，不断言成功。 */
    async invoke(client, native_request, extra = {}, { settle = true, patience = 5000 } = {}) {
      const submitted = await tool(client, 'runtime_call', {
        target: f.target,
        expected_binding_revision: 1,
        contract_ref: f.contractRef,
        native_request,
        deadline: Date.now() + 30_000,
        wait_ms: 500,
        ...extra
      })
      if (submitted.isError) {
        return { submit_error: submitted.raw }
      }
      let view = submitted.data
      const finished = new Set(['responded', 'not_dispatched', 'outcome_unknown'])
      const stop = Date.now() + patience
      while (settle && !finished.has(view.state) && Date.now() < stop) {
        const next = await tool(client, 'runtime_call_get', { call_id: view.call_id, wait_ms: 200 })
        if (next.isError) {
          return { call_id: view.call_id, get_error: next.raw }
        }
        view = next.data
      }
      return view
    },
    /** 读取保留结果并按摘要校验后解析为JSON。 */
    async readResult(client, view) {
      assert(view.result?.result_id, `e2e_result_missing:${JSON.stringify(view)}`)
      const page = await ok(client, 'runtime_result_read', { result_id: view.result.result_id, max_bytes: 16_384 })
      assert.equal(page.eof, true)
      return JSON.parse(Buffer.from(page.chunk, 'base64').toString('utf8'))
    },
    /** Gateway已停止时经正式Store撤销设备；等同管理员离线撤销。 */
    async revokeOffline() {
      const { openGatewayState } = await import('../src/runtime/state.ts')
      const state = openGatewayState({
        state_directory: f.gatewayState,
        store: { management: () => ({ actor: 'e2e_admin', confirmation_id: randomUUID() }) },
        changed: () => {}
      })
      try {
        state.store.revoke(f.target.machine_id)
      } finally {
        state.close()
      }
    },
    /** 本例所有以夹具 herdr 为可执行文件的进程（含 Connector 自建后放手的、用户式启动的）。 */
    herdrProcesses() {
      const result = []
      for (const entry of readdirSync('/proc')) {
        if (!/^[0-9]+$/u.test(entry)) {
          continue
        }
        try {
          if (readlinkSync(`/proc/${entry}/exe`) === f.nativeBinary) {
            const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
            result.push({ pid: Number(entry), started: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] })
          }
        } catch {
          // 并发退出或不可读的进程不属于本例。
        }
      }
      return result
    },
    /** 像用户那样先自己运行一个 herdr 服务端（Connector 之外），返回 PID。 */
    async startUserHerdr() {
      const child = spawn(f.nativeBinary, ['--session', f.target.session, 'server'], {
        cwd: f.native.cwd,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: f.native.home,
          XDG_CONFIG_HOME: f.native.config_home,
          XDG_STATE_HOME: f.native.state_home,
          XDG_CACHE_HOME: f.native.cache_home,
          TMPDIR: f.native.temporary_home,
          LANG: 'C.UTF-8'
        },
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      await until('user_herdr_endpoint', async () => existsSync(f.endpoint), { tries: 100, interval: 100 })
      return child.pid
    },
    /** 本例Connector的直接native子进程。 */
    natives() {
      return nativeChildren(stack.connector, f.nativeBinary)
    },
    alive: sameNativeChildAlive,
    /** 与Connector无关的诊断输出，失败时附在错误里。 */
    diagnostics() {
      return Object.fromEntries([...roles].map((item) => [item.name, item.output.stderr.slice(-2000)]))
    },
    /** 尽力清理：先客户端，再Connector，再Gateway；返回清理遇到的问题。 */
    async close() {
      const problems = []
      for (const client of clients) {
        await client.close().catch(() => {})
      }
      for (const item of [...roles].reverse()) {
        if (item.alive) {
          await item.stop().catch((error) => problems.push(String(error.message)))
        }
      }
      // 附着模式下 Connector 自建的实例会在其退出后继续运行（设计如此），夹具负责最终回收。
      for (const item of stack.herdrProcesses()) {
        try {
          process.kill(item.pid, 'SIGKILL')
        } catch {
          // 已退出。
        }
      }
      await pause(300)
      try {
        f.close()
      } catch (error) {
        problems.push(String(error.message))
      }
      return problems
    }
  }
  return stack
}

/** 版本与环境记录，写入结果JSON。 */
export function environment(binary) {
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8').trim()
    } catch {
      return 'unknown'
    }
  }
  return {
    kernel: read('/proc/version').split(' ').slice(0, 3).join(' '),
    arch: process.arch,
    bun: process.versions.bun ?? process.version,
    product: binary
  }
}
