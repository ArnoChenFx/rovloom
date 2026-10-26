/** 同一真实单文件产物的Gateway→WebSocket Connector→官方Herdr ping及持久结果读取。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createDualRoleFixture } from './dual-role-fixture.mjs'
import { createManagementHttpRead } from '../../src/webui/http-client.ts'

/** Connector 只允许固定、无秘密的运行观察行；未知输出仍让发布验收失败。 */
export function assertConnectorDiagnostics(text) {
  assert.match(
    text,
    /^(?:connector_transport (?:disconnected|connecting|authenticated|ready|stopped) provider_ready=(?:true|false)(?: capacity=[a-z_]+ reclaim_at=\d+)?(?: reason=[a-z_]+)?(?: code=\d+)?(?: close_reason=[a-z_]+)?\n)*$/u,
    'dual_role_connector_stderr'
  )
}

/** 真实close和有界输出共同决定成功；只给当前直接child发信号。 */
export function startDualRoleSmokeProcess(
  binary,
  name,
  configPath,
  cwd,
  env,
  { timeout = 15_000, killAfter = 3000 } = {}
) {
  assert(Number.isInteger(timeout) && timeout > 0 && timeout <= 15_000, 'dual_role_timeout_invalid')
  assert(Number.isInteger(killAfter) && killAfter > 0 && killAfter <= 3000, 'dual_role_shutdown_timeout_invalid')
  const child = spawn(binary, [name, '--config', configPath], {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const chunks = { stdout: [], stderr: [] }
  let closed = false
  let failure
  let size = 0
  let killTimer
  let stopping
  /** 失败也先请求产品正常释放native owner；最后只能强停当前直接product child。 */
  function requestStop() {
    if (closed || killTimer) {
      return
    }
    child.kill('SIGTERM')
    killTimer = setTimeout(
      /** 未在产品清理期限内退出继续判失败；活跃native owner根将保留而非假清理。 */ () => {
        failure ??= new Error('dual_role_shutdown_timeout')
        child.kill('SIGKILL')
      },
      killAfter
    )
  }
  const timer = setTimeout(
    /** 原运行期限到达先请求受监管关闭，失败码不会被后续正常退出抹掉。 */ () => {
      failure ??= new Error('dual_role_smoke_timeout')
      requestStop()
    },
    timeout
  )
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on(
      'data',
      /** 只保留有界输出，超额继续排空但立刻请求受监管关闭。 */ (bytes) => {
        size += bytes.length
        if (size > 2_097_152) {
          failure ??= new Error('dual_role_smoke_output_limit')
          requestStop()
        } else {
          chunks[stream].push(Buffer.from(bytes))
        }
      }
    )
  }
  child.once(
    'error',
    /** spawn或信号错误仍由真实close共同结算。 */ (error) => {
      failure ??= error
    }
  )
  const completion = new Promise(
    /** 生命周期必须等待stdio与进程均关闭。 */ (resolve) =>
      child.once(
        'close',
        /** 原close只结算一次并取消两阶段计时器。 */ (code, signal) => {
          closed = true
          clearTimeout(timer)
          clearTimeout(killTimer)
          resolve({ code, signal })
        }
      )
  )
  return {
    child,
    assertAlive: /** 持续观察自己的直接child与已保存失败，不按程序名探测其它实例。 */ () => {
      if (failure) {
        throw failure
      }
      assert(!closed, `dual_role_${name}_closed:${Buffer.concat(chunks.stderr).toString('utf8')}`)
    },
    /** 同一个stop Promise只请求一次TERM并真实观察退出。 */
    stop() {
      stopping ??= Promise.resolve().then(
        /** 同一角色的重复stop复用真实close与同一断言结果。 */ async () => {
          requestStop()
          const result = await completion
          if (failure) {
            throw failure
          }
          const stderrText = Buffer.concat(chunks.stderr).toString('utf8')
          assert.equal(result.signal, null, `dual_role_${name}_signal`)
          assert.equal(result.code, 0, `dual_role_${name}_exit:${stderrText}`)
          assert.equal(Buffer.concat(chunks.stdout).length, 0, `dual_role_${name}_stdout`)
          // Gateway 公布管理页地址；Connector 只允许固定的 transport 观察行。
          if (name === 'gateway') {
            assert.match(stderrText, /^dashboard_listening http:\/\/127\.0\.0\.1:\d+\/\n$/u, `dual_role_${name}_stderr`)
          } else {
            assertConnectorDiagnostics(stderrText)
          }
        }
      )
      return stopping
    }
  }
}

/** 只观察Connector自己真实创建的直接child；不以发现PID签发来源或补杀native进程。 */
export function nativeChildren(connector, binary) {
  const result = []
  // 部分Linux内核未启用/proc/<pid>/task/<pid>/children；仅按真实PPID筛选本轮子进程。
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/u.test(entry)) {
      continue
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[1]) === connector.child.pid && readlinkSync(`/proc/${entry}/exe`) === binary) {
        result.push({ pid: Number(entry), started: fields[19] })
      }
    } catch {
      // 并发退出或非本例进程不可读不构造native成功来源。
    }
  }
  return result
}

/** 内核启动tick区别已退出子进程与后来复用同一PID的无关进程。 */
export function sameNativeChildAlive(child) {
  try {
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === child.started
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/** 仅在smoke的fetch拒绝时附加安全诊断，页面原失败分类与请求期限保持不变。 */
export function createDualRoleManagementRead(fetcher) {
  const codes = new Set([
    'ABORT_ERR',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET'
  ])
  return /* 每次读取独占诊断，不把此前失败附加到后续请求。 */ async (operation, args, signal) => {
    let diagnostic
    const read = createManagementHttpRead(
      /* 不记录URL、headers、正文或原始异常；只投影固定错误码和单调耗时。 */ async (path, init) => {
        const started = performance.now()
        try {
          return await fetcher(path, init)
        } catch (error) {
          diagnostic = {
            elapsed_ms: Math.round(performance.now() - started),
            aborted: signal.aborted,
            code: codes.has(error?.code) ? error.code : codes.has(error?.cause?.code) ? error.cause.code : null
          }
          throw error
        }
      }
    )
    try {
      return await read(operation, args, signal)
    } catch (error) {
      if (diagnostic) {
        Object.assign(error, { smoke_fetch: diagnostic })
      }
      throw error
    }
  }
}

/** runtime调用与结果必须来自真实MCP；错误不能变成合成pong或绕过保留许可。 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  assert.equal(result.isError, undefined, `dual_role_${name}_error:${JSON.stringify(result.structuredContent)}`)
  assert(result.structuredContent?.data, `dual_role_${name}_data_missing`)
  return result.structuredContent.data
}

/** 隔离运行同一单文件真实双角色；唯一实际ping和保留pong验证跨完整生产链路。 */
export async function smokeDualRoleProduct(binary, options = {}) {
  const f = await createDualRoleFixture(options)
  let gateway
  let connector
  let client
  let failure
  let result
  const cleanupErrors = []
  const nativePids = []
  try {
    const cwd = join(f.root, 'empty-cwd')
    const home = join(f.root, 'empty-home')
    const emptyPath = join(f.root, 'empty-path')
    for (const path of [cwd, home, emptyPath]) {
      mkdirSync(path, { mode: 0o700 })
    }
    const executable = join(f.root, 'rovloom')
    copyFileSync(binary, executable)
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
    assert.equal(createHash('sha256').update(readFileSync(executable)).digest('hex'), digest)
    const env = { PATH: emptyPath, HOME: home, TMPDIR: f.root, LANG: 'C.UTF-8', NO_COLOR: '1' }
    gateway = startDualRoleSmokeProcess(executable, 'gateway', f.gatewayConfigPath, cwd, env)
    let listening = false
    for (let attempt = 0; attempt < 200; attempt++) {
      gateway.assertAlive()
      try {
        const response = await fetch(f.resource, { signal: AbortSignal.timeout(500) })
        assert.equal(response.status, 401)
        listening = true
        break
      } catch {
        await pause(25)
      }
    }
    assert(listening, 'dual_role_gateway_not_listening')
    connector = startDualRoleSmokeProcess(executable, 'connector', f.connectorConfigPath, cwd, env)
    client = new Client({ name: 'synthetic-dual-role-smoke', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.resource), {
        requestInit: { headers: { authorization: `Bearer ${f.proof}` } }
      })
    )
    const management = await fetch(f.managementOrigin, {
      headers: { authorization: f.managementAuthorization },
      signal: AbortSignal.timeout(1000)
    })
    assert.equal(management.status, 200)
    const cookie = /^rovloom_management=[\w-]{43}/u.exec(management.headers.get('set-cookie'))?.[0]
    assert(cookie, 'dual_role_management_cookie_missing')
    await management.body?.cancel()
    const read = createDualRoleManagementRead(
      /** 与真实页面复用同源cookie，绝不注入管理员对象。 */ (path, init) =>
        fetch(f.managementOrigin + path, {
          ...init,
          headers: { ...init.headers, cookie, origin: f.managementOrigin }
        })
    )
    let device
    for (let attempt = 0; attempt < 12; attempt++) {
      gateway.assertAlive()
      connector.assertAlive()
      device = await read(
        'devices_get',
        {
          machine_id: f.target.machine_id
        },
        AbortSignal.timeout(1000)
      )
      // 持久online只等待认证提交，不冒称现场ready；真实ping结果才是完整链路证据。
      if (device.persisted_state === 'online') {
        break
      }
      await pause(500)
    }
    assert.equal(device.persisted_state, 'online', 'dual_role_connector_authentication_not_committed')
    assert.equal(existsSync(f.ownerPath), true, 'dual_role_native_owner_missing')
    assert(lstatSync(f.endpoint).isSocket(), 'dual_role_native_socket_missing')
    nativePids.push(...nativeChildren(connector, f.nativeBinary))
    assert.equal(nativePids.length, 1, 'dual_role_native_direct_child_missing')
    const description = await call(client, 'runtime_describe', {
      target: f.target,
      expected_binding_revision: 1,
      method: 'ping'
    })
    assert.equal(description.method, 'ping')
    const admitted = await call(client, 'runtime_call', {
      target: f.target,
      expected_binding_revision: 1,
      contract_ref: f.contractRef,
      native_request: { method: 'ping', params: {} },
      deadline: Date.now() + 5000,
      wait_ms: 1000
    })
    let retained = admitted
    for (let attempt = 0; attempt < 100 && retained.state !== 'responded'; attempt++) {
      connector.assertAlive()
      retained = await call(client, 'runtime_call_get', { call_id: admitted.call_id, wait_ms: 50 })
    }
    assert.equal(retained.state, 'responded', `dual_role_native_ping_state:${retained.state}`)
    assert.equal(retained.content_status, 'available', 'dual_role_native_ping_not_retained')
    assert(retained.result?.result_id, 'dual_role_native_result_missing')
    const page = await call(client, 'runtime_result_read', { result_id: retained.result.result_id, max_bytes: 4096 })
    assert.equal(page.eof, true)
    assert.equal(page.encoding, 'base64')
    const bytes = Buffer.from(page.chunk, 'base64')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), page.sha256)
    const response = JSON.parse(bytes.toString('utf8'))
    assert.equal(response.result?.type, 'pong')
    assert.equal(response.result.version, '0.9.5')
    assert.equal(response.result.protocol, 22)
    await client.close()
    client = undefined
    await connector.stop()
    connector = undefined
    assert.equal(existsSync(f.ownerPath), false, 'dual_role_native_owner_not_released')
    for (const child of nativePids) {
      assert.equal(sameNativeChildAlive(child), false, 'dual_role_native_child_not_reaped')
    }
    await gateway.stop()
    gateway = undefined
    result = {
      platform: 'linux-x64',
      gateway: 'passed',
      connector: 'passed',
      transport: 'real-loopback-websocket',
      native: 'herdr-0.9.5',
      operation: 'ping',
      result: 'pong',
      retained_result: 'passed',
      shutdown: 'passed',
      product_sha256: digest
    }
  } catch (error) {
    failure = error
  } finally {
    for (const close of [
      /** 关闭本例MCP会话不结束Gateway角色。 */ () => client?.close(),
      /** Connector先撤去原native与provider owner。 */ () => connector?.stop(),
      /** Gateway最后释放唯一writer和listener。 */ () => gateway?.stop(),
      /** 任何已观察的原生child仍存活时保留整个自有根。 */ () => {
        for (const child of nativePids) {
          if (sameNativeChildAlive(child)) {
            throw Object.assign(new Error('dual_role_native_child_still_alive'), { retained_directory: f.root })
          }
        }
        f.close()
      }
    ]) {
      try {
        await close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'dual_role_smoke_cleanup_failed')
  }
  if (failure) {
    throw failure
  }
  return result
}
