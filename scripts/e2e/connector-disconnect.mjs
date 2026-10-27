// 真实端到端验收：两个真实进程（rovloom gateway / rovloom connector + 真实 herdr provider）。
// SIGTERM 停网关进程，断言 connector 的 stderr 一定出现 connector_disconnect code=1008 close_reason=transport_closed，
// 并验证网关重启后 connector 回到 ready。
// 用法（先 bun run build）：
//   LUVUS_TEST_ROOT=<非世界可写的父目录> bun --no-env-file scripts/e2e/connector-disconnect.mjs
// 已有固定 pin 的 herdr 时可用 ROVLOOM_HERDR_BIN=<路径> 免下载；未提供则按 fixture 的官方 pin 下载。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { createDualRoleFixture } from '../release/dual-role-fixture.mjs'
import { createConnectorOutput } from './connector-output.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { PRODUCT_VERSION } from '../../src/mcp/version.js'

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
  const output = createConnectorOutput()
  let stdout = ''
  child.stdout.on('data', (b) => (stdout = (stdout + String(b)).slice(-8192)))
  child.stderr.on('data', (b) => output.write(b))
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  return {
    child,
    get stderr() {
      return output.stderr
    },
    get readyCount() {
      return output.readyCount
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

const f = await createDualRoleFixture({ herdrBinary: process.env.ROVLOOM_HERDR_BIN })
/** 用真实 MCP 读取主机报告，ready 相位本身不能证明中性运行时完成了采集和 getter 转发。 */
async function verifyHostProfile() {
  const client = new Client({ name: 'host-profile-e2e', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.resource), {
        requestInit: { headers: { authorization: `Bearer ${f.proof}` } }
      })
    )
    const reply = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: 'machines_get',
          arguments: {
            machine_id: f.target.machine_id
          }
        },
        CallToolResultSchema
      )
    )
    assert(!reply.isError, 'e2e_machine_details_failed')
    const host = reply.structuredContent?.data?.host
    assert(host, 'e2e_host_profile_missing')
    assert.equal(host.source, 'connector_handshake')
    assert.equal(host.agent_version, PRODUCT_VERSION)
    assert.equal(host.os.family, process.platform)
    assert(Number.isSafeInteger(host.reported_at))
    const provider = host.providers.find((item) => item.provider_id === f.target.provider_id)
    assert(provider, 'e2e_herdr_version_missing')
    assert.equal(provider.native_version, f.source.binary_version)
    report('host_profile=present native_version=' + provider.native_version)
    return host.reported_at
  } finally {
    await client.close()
  }
}
/** fixture 两端旧策略只列 ping；有效 MCP token 仍须能发现并调用已暴露的 pane.list。 */
async function verifyExposedMethods() {
  const client = new Client({ name: 'all-exposed-methods-e2e', version: '1' })
  const tool = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args }, CallToolResultSchema)
    assert(!reply.isError, 'e2e_exposed_method_failed:' + name)
    return reply.structuredContent.data
  }
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.resource), {
        requestInit: { headers: { authorization: `Bearer ${f.proof}` } }
      })
    )
    const route = { target: f.target, expected_binding_revision: 1 }
    const catalog = await tool('runtime_discover', { ...route, limit: 100 })
    const method = catalog.items.find((item) => item.method === 'pane.list')
    assert(method, 'e2e_herdr_legacy_method_snapshot_still_filters_catalog')
    let call = await tool('runtime_call', {
      ...route,
      contract_ref: method.contract_ref,
      native_request: { method: 'pane.list', params: {} },
      deadline: Date.now() + 20_000,
      wait_ms: 500
    })
    while (['created', 'dispatching', 'connector_accepted'].includes(call.state)) {
      call = await tool('runtime_call_get', { call_id: call.call_id, wait_ms: 500 })
    }
    assert.equal(call.state, 'responded', 'e2e_herdr_legacy_method_snapshot_still_blocks_dispatch')
    const page = await tool('runtime_result_read', { result_id: call.result.result_id, max_bytes: 16384 })
    assert.equal(page.eof, true)
    const bytes = Buffer.from(page.chunk, 'base64')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), page.sha256)
    assert(!JSON.parse(bytes.toString()).error, 'e2e_herdr_native_pane_list_error')
    report('legacy_herdr_method_scope=ignored native_call=pane.list')
  } finally {
    await client.close()
  }
}
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
    if (connector.readyCount > 0) {
      ready = true
      break
    }
    await pause(25)
  }
  assert(ready, 'e2e_connector_not_ready:' + connector.stderr)
  report('connector=ready')
  const firstReport = await verifyHostProfile()
  await verifyExposedMethods()
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
  const stopLines = connector.stderr.split('\n').filter(Boolean)
  report('connector_stderr=' + JSON.stringify(stopLines.slice(-8)))
  // 停网关瞬间可能在同一采样窗口内收到 1008 与随后的 1006；两者都必须出现且 1008 在前。
  report(
    'stop_window_lines=' +
      JSON.stringify(stopLines.filter((entry) => entry.startsWith('connector_disconnect')).slice(0, 2))
  )
  assert(found, 'e2e_missing_disconnect_line:' + connector.stderr)
  report('disconnect_line=present')

  // 网关重启：同一端口/配置再起一个真实进程，connector 应自动退避重连回到 ready。
  const before = connector.readyCount
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

  // 只接纳重启后新增的完整 ready 行；有界日志的旧行和截断不影响累计计数。
  let reready = false
  for (let attempt = 0; attempt < 800; attempt++) {
    if (connector.readyCount > before) {
      reready = true
      break
    }
    await pause(25)
  }
  report('after_restart_stderr=' + JSON.stringify(connector.stderr.split('\n').filter(Boolean).slice(-8)))
  assert(reready, 'e2e_connector_not_ready_after_restart:' + connector.stderr)
  report('connector=ready_after_restart')
  assert((await verifyHostProfile()) >= firstReport, 'e2e_host_report_not_republished')
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
