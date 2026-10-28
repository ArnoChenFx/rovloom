// 从空状态走正式 production 装配、Basic/Cookie/CSRF 与单码直连配对：面板生成一机一码，POST /pairing 一次完成配对。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { hash } from '../../src/wire/index.js'
import { SIMPLE_SETUP_ACTOR, setupReference, setupTarget } from '../../src/cli/setup-targets.js'
import type { GatewayConfig } from '../../src/cli/config.js'
import { initializeRoleConfig } from '../../src/cli/config-init.js'
import { writeAdminFiles } from '../../src/cli/admin-command.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { createProductSources } from '../../src/cli/product-sources.js'
import { readRuntimeJson, runtimeReference } from '../../src/cli/runtime-files.js'
import { parseRegistry, REGISTRY_MAX_BYTES } from '../../src/cli/token-registry.js'
import { buildManagementAssets } from './management-assets-fixture.js'

before(buildManagementAssets)

/** 内核分配本例端口，不探测用户服务。 */
async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  server.close()
  await once(server, 'close')
  return address.port
}

for (const lan of [false, true]) {
  test(
    `production single-code pairing completes via ${lan ? 'LAN' : 'loopback'} management HTTP`,
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rovloom-web-first-http-'))
      const ports = new Set<number>()
      while (ports.size < 3) {
        ports.add(await availablePort())
      }
      const [mcp, devices, management] = [...ports] as [number, number, number]
      // 使用真实初始化结果验证容器默认值，不在夹具里补管理页 LAN 标志。
      const initialized = initializeRoleConfig(['config', 'init', 'gateway', ...(lan ? ['--container'] : [])], {
        home: root,
        platform: process.platform
      })
      assert(initialized.role === 'gateway')
      const config: GatewayConfig = {
        ...initialized,
        state_dir: root,
        mcp_port: mcp,
        device_port: devices,
        management_port: management
      }
      const host = (lan ? '192.0.2.10:' : '127.0.0.1:') + management
      const origin = 'http://' + host
      const network = 'http://127.0.0.1:' + management
      let active: Awaited<ReturnType<NonNullable<ReturnType<typeof createProductionCliRuntime>['gateway']>>> | undefined
      const runtime = createProductionCliRuntime(createProductSources())
      try {
        active = await runtime.gateway!(config)
        const shell = await fetch(network + '/', { headers: { host } })
        assert.equal(shell.status, 200)
        assert(!(await shell.text()).includes('rovloom-management-bootstrap'))
        // 正在运行的未配对 Gateway 热读新管理员，身份与策略不通过 fixture 注入。
        const issued = writeAdminFiles(config, 'admin', Date.now())
        assert.equal((await fetch(network + '/', { headers: { host } })).status, 401)
        const page = await fetch(network + '/', {
          headers: { host, authorization: 'Basic ' + Buffer.from('admin:' + issued.secret).toString('base64') }
        })
        assert.equal(page.status, 200)
        const cookie = page.headers.get('set-cookie')!.split(';')[0]!
        const csrf = /name="rovloom-management-bootstrap" content="([\w-]{43})"/.exec(await page.text())![1]!
        assert(cookie && csrf)
        const actionHeaders = { host, origin, cookie, 'content-type': 'application/json', 'x-rovloom-csrf': csrf }
        for (const [overrides, status] of [
          [{ origin: 'http://cross-site.invalid', 'sec-fetch-site': 'cross-site' }, 403],
          [{ cookie: '' }, 401],
          [{ 'x-rovloom-csrf': 'wrong' }, 403]
        ] as const) {
          const denied = await fetch(network + '/admin/v1/actions/history_open', {
            method: 'POST',
            headers: { ...actionHeaders, ...overrides },
            body: '{}'
          })
          assert.equal(denied.status, status)
        }
        const resource = async (operation: string, args = {}) => {
          await new Promise((resolve) => setTimeout(resolve, 300)) // replenish the shared write budget between scripted requests
          const response = await fetch(network + '/admin/v1/resources/' + operation, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify(args)
          })
          assert.equal(response.status, 200, operation)
          assert.equal(response.headers.get('cache-control'), 'no-store')
          return response.json()
        }
        await resource('tokens_create', { principal: 'dashboard-client', days: 365 })
        const createdToken = (await resource('tokens_list')).items[0].token
        assert.match(createdToken, /^[A-Za-z0-9_-]{43}$/)

        const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
        /** 模拟设备端的单码直连配对：一次 POST 换取设备凭据与 MCP Bearer。 */
        const devicePost = async (path: string, body: unknown) => {
          const response = await fetch('http://127.0.0.1:' + devices + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          return { status: response.status, value: (await response.json().catch(() => undefined)) as any }
        }
        const installationFor = (machine_id: string, attempt: string) => {
          const reference = setupReference(attempt, 'herdr')
          return {
            installations: [
              {
                reference,
                value: {
                  kind: 'herdr',
                  schema_bundle: raw,
                  config: {
                    version: 1,
                    target: setupTarget(machine_id, 'herdr'),
                    binding_revision: 1,
                    config_ref: reference,
                    expected_source: {
                      ...fixedHerdrSource(),
                      binary_version: 'synthetic-future',
                      server_version: 'synthetic-future',
                      binary_sha256: 'f'.repeat(64),
                      schema_sha256: hash(raw)
                    }
                  }
                }
              }
            ]
          }
        }
        // 面板生成一机一码：完整码值 machine.code_id.secret 与设备端口一起返回。
        const first = await resource('pairing_codes_create', { name: 'workstation' })
        assert.match(first.code, /^[A-Za-z0-9_-]+\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
        assert.equal(first.device_port, devices)
        const [machine_id, attempt] = first.code.split('.')
        const listed = await resource('pairing_codes_list')
        assert.equal(listed.items.length, 1)
        assert.equal(listed.items[0].code, first.code)
        assert.equal(listed.items[0].status, 'unused')
        // 单端点配对：凭据、恢复代次与首台设备的 MCP Bearer 同一响应交付。
        const paired = await devicePost('/pairing', {
          code: first.code,
          installation: installationFor(machine_id, attempt)
        })
        assert.equal(paired.status, 200)
        assert.equal(paired.value.state, 'paired')
        assert.equal(paired.value.machine_id, machine_id)
        assert.match(paired.value.credential, /^[A-Za-z0-9_-]{32,256}$/)
        assert.match(paired.value.mcp.token, /^[A-Za-z0-9_-]{43}$/)
        await active.reconfigure
        // 模拟 runCli 真正关闭旧 listener/Store 并以同一进程运行时重开，而非只等待重载通知。
        await active.close()
        active = await runtime.gateway!(config)
        const refreshedPage = await fetch(network + '/', {
          headers: { host, authorization: 'Basic ' + Buffer.from('admin:' + issued.secret).toString('base64') }
        })
        assert.equal(refreshedPage.status, 200)
        actionHeaders.cookie = refreshedPage.headers.get('set-cookie')!.split(';')[0]!
        actionHeaders['x-rovloom-csrf'] = /name="rovloom-management-bootstrap" content="([\w-]{43})"/.exec(
          await refreshedPage.text()
        )![1]!
        // 同码重放：真实重载后仍返回同一凭据。
        const replay = await devicePost('/pairing', {
          code: first.code,
          installation: installationFor(machine_id, attempt)
        })
        assert.equal(replay.status, 200)
        assert.equal(replay.value.credential, paired.value.credential)
        assert.equal(replay.value.replayed, true)
        // 面板列表：码已终结，明文消失。
        const used = await resource('pairing_codes_list')
        assert.equal(used.items[0].status, 'used')
        assert.equal(used.items[0].code, undefined)
        // 新码可作废；作废后的码不能兑换。
        const second = await resource('pairing_codes_create', {})
        const secondAttempt = second.code.split('.')[1]!
        await resource('pairing_codes_revoke', { code_id: secondAttempt })
        assert.equal(
          (await resource('pairing_codes_list')).items.filter((entry: any) => entry.status === 'unused').length,
          0
        )
        const revoked = await devicePost('/pairing', {
          code: second.code,
          installation: installationFor(second.machine_id, secondAttempt)
        })
        assert.notEqual(revoked.status, 200)
        // 已发布 caller：主体是固定常量；删除后首台 Bearer 立即失效。
        const registry = parseRegistry(readRuntimeJson(runtimeReference(root, 'mcp-callers'), REGISTRY_MAX_BYTES))
        assert(registry.callers.some((entry) => entry.principal.id === SIMPLE_SETUP_ACTOR))
        assert.equal(
          (await resource('tokens_list')).items.find((entry: any) => entry.principal === 'dashboard-client').token,
          createdToken
        )
        await resource('tokens_delete', { principal: SIMPLE_SETUP_ACTOR })
        assert.equal(
          await active.authentication.authenticate(
            new Request('http://127.0.0.1:' + mcp + '/mcp', {
              headers: { authorization: 'Bearer ' + paired.value.mcp.token }
            }),
            new AbortController().signal
          ),
          null
        )
        await resource('devices_delete', { machine_id })
        assert.notEqual(
          (
            await devicePost('/pairing', {
              code: first.code,
              installation: installationFor(machine_id, attempt)
            })
          ).status,
          200
        )
        assert.equal(
          (readRuntimeJson(runtimeReference(root, 'providers'), 1_048_576) as { providers: unknown[] }).providers
            .length,
          0
        )
        await active.close()
        active = await runtime.gateway!(config)
        const reloaded = await fetch(network + '/', {
          headers: { host, authorization: 'Basic ' + Buffer.from('admin:' + issued.secret).toString('base64') }
        })
        assert.equal(reloaded.status, 200)
        const currentCookie = reloaded.headers.get('set-cookie')!.split(';')[0]!
        const devicesAfterRestart = await fetch(network + '/admin/v1/devices', {
          headers: { host, cookie: currentCookie }
        })
        assert.equal(devicesAfterRestart.status, 200)
        assert.equal((await devicesAfterRestart.json()).items.length, 0)
      } finally {
        await active?.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
