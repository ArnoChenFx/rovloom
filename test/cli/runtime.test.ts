// 使用真实双库/角色工厂和HTTP SDK验证CLI组合；身份/管理会话为明确fixture，不连接用户native。
import { configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { startHttpFacade } from '../../src/mcp/http.js'
import { createRuntimeCliRuntime } from '../../src/cli/runtime.js'
import { runCli, type GatewayRuntime } from '../../src/cli/run.js'
import { configTemplate } from '../../src/cli/config.js'
import type { GatewayIdentitySource } from '../../src/mcp/management.js'

// 同时观察监听通知和真实CLI退出；提前退出立即报告其退出码与诊断，不用用例超时替代错误。
function waitForCliListener(
  listening: Promise<string>,
  role: Promise<number>,
  diagnostic: () => string
): Promise<string> {
  return Promise.race([
    listening,
    role.then(
      /* CLI退出前已写完stderr，保留实际结果供失败定位。 */ (code) => {
        assert.fail(`CLI exited before listening: code=${code}; stderr=${diagnostic().trim()}`)
      }
    )
  ])
}

test(
  '唯一CLI实际组合角色双库、MCP查询与管理handler，终止和管理启动失败均释放同一writer',
  { timeout: 30_000 },
  /* 空provider配置只验证真实组合和资源所有权，不伪称已完成原生调用或管理身份交付。 */ async () => {
    for (const mode of [
      'callbacks',
      'session',
      'source_mismatch',
      'notification_failure',
      'listener_failure'
    ] as const) {
      const failedMount = mode === 'source_mismatch' || mode === 'notification_failure'
      const directory = mkdtempSync(join(tmpdir(), 'rovloom-cli-runtime-'))
      const stop = new AbortController()
      let released = 0
      let managementUrl = ''
      let owned: GatewayRuntime | undefined
      let ready!: (url: string) => void
      const listening = new Promise<string>(/* 观察唯一CLI实际监听后才使用SDK连接。 */ (resolve) => (ready = resolve))
      const runtime = createRuntimeCliRuntime({
        gateway: /* 只打开本例临时状态；不注册设备、签发凭据或启动native实例。 */ async (config) => {
          const state = openGatewayState({
            state_directory: config.state_dir,
            changed: /* 没有凭据动作，故不存在需要通知的设备连接。 */ () => {}
          })
          const identities: GatewayIdentitySource = {
            principal: /* 合成caller只在测试HTTP认证后使用，空政策没有native权限。 */ (caller) =>
              caller.principal_id === 'cli_fixture'
                ? { id: 'cli_fixture', policy: { revision: 'one', grants: [] } }
                : null,
            administrator: /* 独立合成管理会话仅允许status读取，没有写权限。 */ (caller, session) =>
              caller.principal_id === 'cli_fixture' && session === 'admin_fixture'
                ? {
                    principal_id: 'cli_fixture',
                    session_ref: 'admin_fixture',
                    assurance: 'administrator',
                    policy_revision: 'one',
                    grants: [{ action: 'gateway_read' }]
                  }
                : null
          }
          return {
            options: {
              lifecycle: state.lifecycle,
              channels: state.channels,
              identities,
              providers: [],
              listener: {
                hostname: '127.0.0.1',
                port: 0,
                developmentLoopback: true,
                offer: { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] }
              },
              release: /* 真实运行宿主结束后释放本例唯一的两库writer，重复关闭不得多次调用。 */ async () => {
                released++
                state.close()
              }
            },
            authentication: {
              authenticate: /* 明确的回环测试认证stub，不是产品默认身份。 */ () => ({ principal_id: 'cli_fixture' })
            },
            management: {
              port: 0,
              ...(mode === 'callbacks'
                ? {
                    http: {
                      authenticate: /* 管理会话另行提供，不从MCP caller或设备连接自动转换。 */ async () => ({
                        caller: { principal_id: 'cli_fixture' },
                        management_session_ref: 'admin_fixture'
                      }),
                      verifyCsrf: /* 仅固定测试header可通过；本例管理员仍没有写权限。 */ async (request: Request) =>
                        request.headers.get('x-rovloom-csrf') === 'fixture'
                    }
                  }
                : {
                    session: {
                      cookie_name: 'rovloom_fixture',
                      sessions: {
                        identities: mode === 'source_mismatch' ? { ...identities } : identities,
                        resolveCookie: /* 合成受保护会话fixture；不签发cookie或注册真实身份。 */ async (
                          cookie: string
                        ) =>
                          cookie === 'SYNTHETIC_SESSION_COOKIE'
                            ? {
                                caller: { principal_id: 'cli_fixture' },
                                session_ref: 'admin_fixture',
                                expires_at: Date.now() + 60_000,
                                csrf_sha256: [createHash('sha256').update('a'.repeat(64)).digest('hex')]
                              }
                            : null
                      }
                    }
                  }),
              listening: /* 观察真实管理listener；通知失败也必须回收已打开的listener和两库。 */ (url) => {
                managementUrl = url
                if (mode === 'notification_failure') {
                  throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')
                }
              }
            }
          }
        }
      })
      const gateway = runtime.gateway!
      runtime.gateway = /* 仅为测试观察runCli监听通知，不替换实际角色或业务服务。 */ async (config) => {
        owned = await gateway(config)
        return { ...owned, listening: ready }
      }
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let output = ''
      let diagnostics = ''
      stdout.on('data', /* 核对运行阶段没有stdout协议或秘密。 */ (chunk) => (output += chunk))
      stderr.on('data', /* 核对失败只报告固定代码。 */ (chunk) => (diagnostics += chunk))
      let role: Promise<number> | undefined
      let client: Client | undefined
      let reservation: ReturnType<typeof startHttpFacade> | undefined
      try {
        reservation = startHttpFacade({
          service: {
            execute: /* 端口预留不执行任何业务动作。 */ async () => {
              throw new Error('unused_port_stub')
            }
          },
          authentication: { authenticate: /* 预留listener拒绝全部身份。 */ () => null },
          port: 0
        })
        const port = Number(new URL(reservation.url).port)
        if (mode !== 'listener_failure') {
          await reservation.close()
          reservation = undefined
        } else {
          assert.throws(
            /* 保留真实预留端口，先核对同一监听器确实得到EADDRINUSE，不伪造CLI或Gateway失败。 */ () =>
              startHttpFacade({
                service: {
                  execute: /* 只验证监听失败，不执行业务。 */ async () => assert.fail()
                },
                authentication: { authenticate: /* 端口冲突fixture没有身份。 */ () => null },
                port
              }),
            { code: 'EADDRINUSE' }
          )
        }
        const path = join(directory, 'gateway.json')
        writeFileSync(
          path,
          JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: directory, mcp_port: port })),
          {
            mode: 0o600
          }
        )
        role = runCli(
          ['gateway', '--config', path],
          {
            stdin: new PassThrough(),
            stdout,
            stderr,
            signal: stop.signal
          },
          runtime
        )
        if (mode === 'listener_failure') {
          await assert.rejects(
            /* 真实CLI启动失败必须立即拒绝监听等待，并保留它的实际错误结果。 */ () =>
              waitForCliListener(listening, role!, /* 读取本例实际CLI诊断。 */ () => diagnostics),
            { message: 'CLI exited before listening: code=1; stderr=runtime_failed' }
          )
          assert.equal(await role, 1)
          assert.equal(diagnostics, 'runtime_failed\n')
        } else if (failedMount) {
          assert.equal(await role, 1)
          assert.equal(diagnostics, 'runtime_failed\n')
        } else {
          const url = await waitForCliListener(listening, role, /* 读取本例实际CLI诊断。 */ () => diagnostics)
          client = new Client({ name: 'cli-runtime-fixture', version: '1' })
          await client.connect(new StreamableHTTPClientTransport(new URL(url)))
          const reply = await client.callTool({ name: 'machines_list', arguments: {} })
          assert.deepEqual(reply.structuredContent, { data: { items: [] } })
          const headers: Record<string, string> =
            mode === 'callbacks'
              ? { 'x-rovloom-csrf': 'fixture' }
              : { cookie: 'rovloom_fixture=SYNTHETIC_SESSION_COOKIE', 'x-rovloom-csrf': 'a'.repeat(64) }
          const status = await fetch(managementUrl + '/admin/v1/status', { headers })
          assert.equal(status.status, 200)
          if (mode === 'session') {
            const anonymous = await fetch(managementUrl + '/admin/v1/status')
            assert.equal(anonymous.status, 401)
          }
          const denied = await fetch(managementUrl + '/admin/v1/actions/history_open', {
            method: 'POST',
            headers: {
              origin: managementUrl,
              ...headers,
              'content-type': 'application/json'
            },
            body: '{}'
          })
          assert.equal(denied.status, 403)
          const oversized = await fetch(managementUrl + '/admin/v1/actions/history_open', {
            method: 'POST',
            headers: { origin: managementUrl, ...headers },
            body: 'x'.repeat(16_385)
          })
          assert.equal(oversized.status, 413)
          const closing = owned!.close()
          await assert.rejects(
            /* close入口同步封锁新准入，不能等管理面或Gateway异步释放。 */ () =>
              owned!.service.execute(
                'runtime_call',
                {
                  target: { machine_id: 'machine', provider_id: 'provider', profile: 'host' },
                  expected_binding_revision: 1,
                  contract_ref: 'a'.repeat(64),
                  native_request: { method: 'unused' },
                  deadline: Date.now() + 1000
                },
                { caller: { principal_id: 'cli_fixture' }, wait_signal: new AbortController().signal }
              ),
            { code: 'unavailable' }
          )
          await closing
          // 实际角色closed而非stdin EOF结束唯一CLI，随后重复close仍只release一次。
          assert.equal(await role, 0)
          // 启动只新增宿主上报的管理页地址行；除此之外不得有任何诊断。
          assert.match(diagnostics, /^dashboard_listening http:\/\/127\.0\.0\.1:\d+\/\n$/)
        }
        assert.equal(output, '')
        assert.equal(released, 1)
        if (managementUrl) {
          await assert.rejects(
            /* 退出或通知失败均关闭本例真实管理端口。 */ () => fetch(managementUrl + '/admin/v1/status')
          )
        }
      } finally {
        stop.abort()
        await client?.close()
        await role
        await reservation?.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }
)
