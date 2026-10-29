/** 复制真实单文件产物到隔离目录，验收Gateway/HTTP/MCP/管理面和两个schema工厂；不宣称Connector或跨机通过。 */
import assert from 'node:assert/strict'
import { CLI_ERROR_CODES } from '../../src/cli/config.ts'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { waitHttpReady } from './readiness.mjs'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { openGatewayState } from '../../src/runtime/state.ts'
import { FIXED_LUVUS_SHA256, FIXED_LUVUS_SCHEMA_SHA256 } from '../../src/connector/luvus/host/native-control.ts'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/connector/luvus/host/native-source.ts'
import { fixedHerdrSource } from '../../src/connector/herdr/review.ts'
import { loadManagementAssets } from '../../src/admin/assets.ts'
import { createManagementHttpRead } from '../../src/webui/http-client.ts'
import { createManagementWriteClient } from '../../src/webui/write-client.ts'
import { createDeviceManagementFlow } from '../../src/webui/write-flow.ts'
import { gatewaySmokeFixture, managementProof, mcpProof } from './gateway-fixture.mjs'
import { cleanupSmokeDirectory, runSmokeChild } from './smoke-process.mjs'
import { requestStopPipe, windowsStopPipe } from '../../src/service/windows-control.ts'

/** 固定离线公开schema仅作为受保护测试输入；原生进程、模型及长期设备凭据均不参与。 */
function seed(f) {
  const luvusTarget = { ...f.target, provider_id: 'fixture_luvus' }
  const binding = {
    machine_id: luvusTarget.machine_id,
    provider_id: luvusTarget.provider_id,
    kind: 'luvus',
    config_ref: 'fixture_luvus',
    binding_revision: 1,
    enabled: true
  }
  const luvus = {
    kind: 'luvus',
    authentication: 'remote_connector',
    binding,
    target: luvusTarget,
    contract: {
      binary_version: '0.14.3',
      binary_sha256: FIXED_LUVUS_SHA256,
      schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      schema_bundle_ref: 'fixture_luvus_schema'
    }
  }
  const schema = join(f.refs, 'fixture_herdr_schema.json')
  f.write(schema, readFileSync(new URL('../../test/fixtures/herdr/0.9.5/schema.json', import.meta.url)))
  f.save(join(f.refs, 'fixture_herdr.json'), {
    kind: 'herdr',
    config: {
      version: 1,
      target: f.target,
      binding_revision: 1,
      config_ref: 'fixture_herdr',
      expected_source: fixedHerdrSource(),
      schema_ref: schema
    }
  })
  f.save(join(f.refs, 'fixture_luvus.json'), luvus)
  f.write(
    join(f.refs, 'fixture_luvus_schema.json'),
    readFileSync(new URL('../../test/fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
  )
  f.configureProviders([
    { reference: 'fixture_luvus', value: luvus },
    { reference: 'fixture_herdr', value: JSON.parse(readFileSync(join(f.refs, 'fixture_herdr.json'))) }
  ])
  const policy = {
    revision: 'fixture_policy',
    grants: [
      { target: f.target, methods: ['ping'], actions: ['read'] },
      { target: luvusTarget, methods: ['automation.list'], actions: ['read'] }
    ]
  }
  f.callers.local_policy = policy
  f.callers.callers[0].principal.policy = structuredClone(policy)
  f.save(f.callerPath, f.callers)
  const initial = openGatewayState({
    state_directory: f.state,
    changed: /** 所有设备种子离线，未建立任何原生或远程连接。 */ () => {}
  })
  initial.close()
  const db = new DatabaseSync(join(f.state, 'gateway.db'))
  try {
    db.prepare('INSERT INTO machines(machine_id,name,status,credential_hash) VALUES(?,?,?,?)').run(
      f.target.machine_id,
      'before_fixture',
      'offline',
      createHash('sha256').update('SYNTHETIC_NOT_ISSUED').digest('hex')
    )
    for (const [target, kind, ref] of [
      [f.target, 'herdr', 'fixture_herdr'],
      [luvusTarget, 'luvus', 'fixture_luvus']
    ]) {
      db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)').run(
        target.machine_id,
        target.provider_id,
        kind,
        ref,
        1,
        1
      )
    }
  } finally {
    db.close()
  }
}

/** 子进程固定15秒期限与2MiB输出上限；失败及关闭均等待直接child的真实close。 */
async function withGateway(binary, f, cwd, env, inspect, prefix = [], runtime = undefined) {
  // Windows复用既有角色关停管道；标识仅绑定本轮自有启动，不登记系统任务或声称服务验收。
  const controlId =
    process.platform === 'win32'
      ? createHash('sha256')
          .update(JSON.stringify([binary, f.configPath, cwd]))
          .digest('hex')
      : undefined
  const started = performance.now()
  const args = [
    ...prefix,
    'gateway',
    '--config',
    f.configPath,
    ...(controlId ? ['--non-interactive', '--service-id', controlId] : [])
  ]
  // runtime 只替换启动方式（原生或一次性 Alpine 容器）；argv、环境与断言完全相同。
  const launch = runtime ? runtime.wrap(binary, args, { cwd, env }) : null
  const child = spawn(launch ? launch.file : binary, launch ? launch.args : args, {
    cwd: launch ? launch.cwd : cwd,
    env: launch ? launch.env : env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let failure
  let closed = false
  const lifecycle = {}
  child.once('spawn', () => {
    lifecycle.spawnMs = Math.round(performance.now() - started)
  })
  child.once('exit', (code, signal) => {
    lifecycle.exitMs = Math.round(performance.now() - started)
    lifecycle.exitCode = code
    lifecycle.signal = signal
  })
  const completion = new Promise(
    /** close包含stdio关闭，不以exit/kill返回值代替。 */ (complete) => {
      child.once(
        'error',
        /** 保存启动失败但仍等待close。 */ (error) => {
          failure ??= error
        }
      )
      child.once(
        'close',
        /** 只在真实退出后交付状态。 */ (code, signal) => {
          closed = true
          complete({ code, signal })
        }
      )
    }
  )
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on(
      'data',
      /** 有界收集本次合成运行输出，超限即终止原child。 */ (bytes) => {
        if (stream === 'stdout') {
          stdout += bytes
        } else {
          stderr += bytes
        }
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2_097_152) {
          failure ??= new Error('product_smoke_output_limit')
          child.kill('SIGKILL')
        }
      }
    )
  }
  child.stdin.end()
  const timeout = setTimeout(
    /** 不延长产品或测试执行预算。 */ () => {
      failure ??= new Error('product_smoke_timeout')
      child.kill('SIGKILL')
    },
    15_000
  )
  try {
    await inspect(/** 启动等待只观察自己的child，不按PID或程序名寻找进程。 */ () => !closed, started)
    if (failure) {
      throw failure
    }
    if (controlId) {
      await requestStopPipe(windowsStopPipe('gateway', realpathSync(binary), f.configPath, controlId))
    } else {
      child.kill('SIGTERM')
    }
    const result = await completion
    assert.equal(result.signal, null, 'product_gateway_signal')
    assert.equal(result.code, 0, 'product_gateway_exit')
    assert.equal(stdout, '', 'product_gateway_stdout')
    // 启动只公布宿主上报的管理页地址；除此之外不得有任何诊断。
    assert.match(stderr, /^dashboard_listening http:\/\/127\.0\.0\.1:\d+\/\n$/u, 'product_gateway_stderr')
  } catch (error) {
    // 只记录自有 child 的阶段与固定产品错误行；不把未知正文（可能含秘密）写入公开日志。
    const allowed = new Set([...CLI_ERROR_CODES, 'runtime_failed', 'pairing_required'])
    process.stderr.write(
      JSON.stringify({
        scope: 'disposable-gateway-failure',
        platform: process.platform,
        arch: process.arch,
        elapsedMs: Math.round(performance.now() - started),
        childAlive: !closed,
        lifecycle,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        errors: stderr.split(/\r?\n/u).filter((line) => allowed.has(line)),
        outputSha256: createHash('sha256').update(stdout).update(stderr).digest('hex')
      }) + '\n'
    )
    throw error
  } finally {
    if (!closed) {
      child.kill('SIGKILL')
    }
    await completion
    clearTimeout(timeout)
  }
}

/**
 * 六平台均以实际产品验收Gateway；Windows通过既有管道请求正常关闭，不用强杀充当成功。
 * launch 用于 npm 包：由绝对路径的 bun 直接运行已安装入口（不复制文件），identity 记录被验收包的摘要。
 */
export async function smokeGatewayProduct(
  binary,
  version,
  assets = loadManagementAssets(join(dirname(binary), 'webui')),
  launch = undefined,
  runtime = undefined
) {
  assert(['linux', 'darwin', 'win32'].includes(process.platform), 'product_gateway_storage_platform_unsupported')
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version), 'product_smoke_version_required')
  const f = await gatewaySmokeFixture()
  let client
  let writer
  let flow
  try {
    seed(f)
    if (process.platform === 'win32') {
      // 只释放已close的夹具statement包装，产品尚未启动，不参与其正常关闭判定。
      Bun.gc(true)
    }
    const cwd = join(f.root, 'empty-cwd')
    const home = join(f.root, 'empty-home')
    const emptyPath = join(f.root, 'empty-path')
    for (const path of [cwd, home, emptyPath]) {
      mkdirSync(path, { mode: 0o700 })
    }
    const prefix = launch ? [launch.entry] : []
    const executable = launch ? binary : join(f.root, basename(binary))
    if (!launch) {
      copyFileSync(binary, executable)
    }
    const productSha256 = launch ? launch.identity : createHash('sha256').update(readFileSync(executable)).digest('hex')
    const env = {
      PATH: emptyPath,
      HOME: home,
      TMPDIR: f.root,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      ...(process.platform === 'win32'
        ? { USERPROFILE: home, TEMP: f.root, TMP: f.root, SystemRoot: process.env.SystemRoot }
        : {})
    }
    const checked = await runSmokeChild(executable, [...prefix, '--version'], { cwd, env }, { runtime })
    assert.equal(checked.status, 0)
    assert.equal(checked.stdout, '')
    assert.equal(checked.stderr, `Rovloom ${version}\n`)
    await withGateway(
      executable,
      f,
      cwd,
      env,
      /** 只访问本次回环端口及合成测试身份。 */ async (alive, started) => {
        // 两个 listener 共用 10 秒冷启动预算；快速拒绝连接不再提前耗尽 200 次轮询。
        const deadline = started + 10_000
        const page = await waitHttpReady(f.origin, alive, deadline)
        assert(
          page,
          `product_gateway_not_listening elapsed_ms=${Math.round(performance.now() - started)} child_alive=${alive()}`
        )
        assert.equal(page.status, 401)
        assert.equal(page.headers.get('set-cookie'), null)
        const unauthenticated = await waitHttpReady(f.callers.resource, alive, deadline)
        assert(
          unauthenticated,
          `product_mcp_not_listening elapsed_ms=${Math.round(performance.now() - started)} child_alive=${alive()}`
        )
        assert.equal(unauthenticated.status, 401)
        const auth = 'Basic ' + Buffer.from(f.lease.caller.principal_id + ':' + managementProof).toString('base64')
        const accepted = await fetch(f.origin, { headers: { authorization: auth } })
        assert.equal(accepted.status, 200)
        const html = await accepted.text()
        const cookie = /^rovloom_management=[\w-]{43}/u.exec(accepted.headers.get('set-cookie'))?.[0]
        const csrf = /name="rovloom-management-bootstrap" content="([\w-]{43})"/u.exec(html)?.[1]
        assert(cookie && csrf)
        const metadata = /<meta name="rovloom-management-bootstrap" content="[\w-]{43}" data-expires-at="[0-9]+">/gu
        assert.equal([...html.matchAll(metadata)].length, 1, 'product_page_bootstrap_count')
        assert.equal(html.replace(metadata, ''), new TextDecoder().decode(assets.get('/')), 'product_root_html_changed')
        for (const privateValue of [managementProof, mcpProof, cookie, f.lease.management_session_ref]) {
          assert(!html.includes(privateValue), 'product_page_secret_disclosure')
        }
        for (const [path, bytes] of assets) {
          if (path === '/') {
            continue
          }
          const response = await fetch(f.origin + path)
          assert.equal(response.status, 200, 'product_embedded_asset_missing')
          assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes, 'product_embedded_asset_changed')
        }
        assert.equal((await fetch(f.origin + '/package.json')).status, 404)
        client = new Client({ name: 'synthetic-release-smoke', version: '1' })
        await client.connect(
          new StreamableHTTPClientTransport(new URL(f.callers.resource), {
            requestInit: { headers: { authorization: `Bearer ${mcpProof}` } }
          })
        )
        const tools = await client.listTools()
        assert(tools.tools.some(/** 必须经过真实产品目录而不是包装探针。 */ (tool) => tool.name === 'machines_list'))
        const result = await client.callTool(
          {
            name: 'runtime_describe',
            arguments: {
              target: f.target,
              expected_binding_revision: 1,
              method: 'ping'
            }
          },
          CallToolResultSchema
        )
        assert.equal(result.isError, undefined)
        assert.equal(result.structuredContent?.data?.method, 'ping')
        const fetcher = /** 复用真实同源cookie/Origin，不注入AdminContext或授权函数。 */ (path, init) => {
          const headers = new Headers(init.headers)
          headers.set('cookie', cookie)
          headers.set('origin', f.origin)
          return fetch(f.origin + path, { ...init, headers })
        }
        const read = createManagementHttpRead(fetcher)
        writer = createManagementWriteClient({ csrf: /** 只复用页面实际交付的临时证明。 */ async () => csrf, fetcher })
        flow = createDeviceManagementFlow({ transport: writer })
        assert.equal(
          (await flow.prepare({ action: 'device_rename', machine_id: f.target.machine_id, name: 'after_fixture' }))
            .phase,
          'awaiting_confirmation'
        )
        assert.equal((await flow.confirm()).phase, 'committed')
        assert.equal(
          (await read('devices_get', { machine_id: f.target.machine_id }, new AbortController().signal)).name,
          'after_fixture'
        )
        f.save(f.sourcePath, {
          ...f.source,
          sessions: [{ ...f.source.sessions[0], credential_sha256: '2'.repeat(64) }]
        })
        await assert.rejects(
          read('devices_get', { machine_id: f.target.machine_id }, new AbortController().signal),
          /unauthenticated/u
        )
        await client.close()
        client = undefined
        flow.dispose()
        flow = undefined
        writer.close()
        writer = undefined
      },
      prefix,
      runtime
    )
    for (const name of ['gateway.db.lock']) {
      assert.equal(existsSync(join(f.state, name)), false, 'product_gateway_lock_not_released')
    }
    const database = new DatabaseSync(join(f.state, 'gateway.db'), { readOnly: true })
    try {
      assert.equal(
        database.prepare('SELECT name FROM machines WHERE machine_id=?').get(f.target.machine_id).name,
        'after_fixture'
      )
    } finally {
      database.close()
    }
    return {
      scope: 'product-gateway',
      platform: `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
      version,
      product_sha256: productSha256,
      isolatedBinary: true,
      emptyPath: true,
      mcp: true,
      management: true,
      embeddedAssets: assets.size,
      schemaFactories: ['luvus', 'herdr'],
      gracefulShutdown: true,
      connector: 'pending'
    }
  } finally {
    flow?.dispose()
    writer?.close()
    await client?.close()
    if (process.platform === 'win32') {
      // 产品退出和写锁释放已断言，仅回收父进程已close的只读SQLite包装后清理自有目录。
      Bun.gc(true)
    }
    await cleanupSmokeDirectory(f.root)
  }
}

if (import.meta.main) {
  const [binary, version] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, 'Usage: bun scripts/release/gateway-smoke.mjs /built/product-binary version')
  const { smokeRuntime } = await import('./runtime.mjs')
  const runtime = smokeRuntime()
  console.log(
    JSON.stringify(
      await smokeGatewayProduct(
        resolve(binary),
        version,
        undefined,
        undefined,
        runtime.kind === 'alpine' ? runtime : undefined
      )
    )
  )
}
