// 从空状态走正式 production 装配、Basic/Cookie/CSRF 与在线激活；只使用本例临时设备及合成安装清单。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest } from '../../src/contracts.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { DEFAULT_PAIRING_POLICY_REF } from '../../src/pairing-policy.js'
import { hash } from '../../src/wire/index.js'
import { createManagementWriteClient } from '../../src/webui/write-client.js'
import { createPairingManagementFlow } from '../../src/webui/pairing-flow.js'
import type { GatewayConfig } from '../../src/cli/config.js'
import { initializeRoleConfig } from '../../src/cli/config-init.js'
import { writeAdminFiles } from '../../src/cli/admin-command.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { writeSetupFile } from '../../src/cli/setup-files.js'
import { readRuntimeJson, runtimeReference } from '../../src/cli/runtime-files.js'
import { parseRegistry, REGISTRY_MAX_BYTES } from '../../src/cli/token-registry.js'
import { setupReference, setupTarget } from '../../src/cli/setup-policy.js'
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
    `production web-first pairing completes via ${lan ? 'LAN' : 'loopback'} management HTTP`,
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
      let client: ReturnType<typeof createManagementWriteClient> | undefined
      try {
        active = await createProductionCliRuntime().gateway!(config)
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
          [{ origin: 'http://cross-site.invalid' }, 403],
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
        client = createManagementWriteClient({
          csrf: async () => csrf,
          fetcher: (path, init) => {
            const headers = new Headers(init.headers)
            headers.set('host', host)
            headers.set('origin', origin)
            headers.set('cookie', cookie)
            return fetch(network + path, { ...init, headers })
          }
        })
        const unknown = createPairingManagementFlow({ transport: client })
        assert.deepEqual(
          await unknown.prepare({ action: 'pairing_create', name: 'refused', policy_ref: 'unapproved', labels: [] }),
          {
            phase: 'failed',
            problem: 'outcome_unconfirmed'
          }
        )
        unknown.dispose()
        const create = createPairingManagementFlow({ transport: client })
        assert.equal(
          (
            await create.prepare({
              action: 'pairing_create',
              name: 'web_first',
              policy_ref: DEFAULT_PAIRING_POLICY_REF,
              labels: []
            })
          ).phase,
          'awaiting_confirmation'
        )
        const created = await create.confirm()
        assert.equal(created.phase, 'committed')
        assert(created.phase === 'committed')
        const { machine_id, pairing_id } = created.receipt as typeof created.receipt & {
          machine_id: string
          pairing_id: string
        }
        create.dispose()
        /** 模拟设备端的认领协议，不替代管理页确认或 Store 认证。 */
        const devicePost = async (path: string, body: unknown) => {
          const response = await fetch('http://127.0.0.1:' + devices + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          assert.equal(response.status, 200, path)
          return response.json()
        }
        const secret = 'synthetic-owned-claim-secret-123456'
        const claim = await devicePost('/pairing/claim', { pairing_id, secret_hash: digest(secret) })
        const progress = await client.execute('pairings_get', { machine_id, pairing_id }, new AbortController().signal)
        assert.equal(progress.claim!.user_code, claim.user_code)
        const approve = createPairingManagementFlow({ transport: client })
        assert.equal(
          (
            await approve.prepare({
              action: 'pairing_claim_approve',
              machine_id,
              pairing_id,
              claim_id: claim.claim_id,
              user_code: progress.claim!.user_code
            })
          ).phase,
          'awaiting_confirmation'
        )
        assert.equal((await approve.confirm()).phase, 'committed')
        approve.dispose()
        const delivered = await devicePost('/pairing/claim/status', { claim_id: claim.claim_id, secret })
        assert.equal(delivered.status, 'approved')
        await devicePost('/pairing/claim/ack', { claim_id: claim.claim_id, secret })
        const authentication = {
          machine_id,
          credential: delivered.credential,
          recovery_generation: delivered.recovery_generation
        }
        const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
        const reference = setupReference(claim.claim_id, 'herdr')
        const installation = {
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
                  peer_policy_revision: 'setup_local_' + claim.claim_id,
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
        const activated = await devicePost('/pairing/claim/activation/native', {
          attempt_id: claim.claim_id,
          authentication,
          installation
        })
        assert.equal(activated.state, 'configured')
        await active.reconfigure
        const registry = parseRegistry(readRuntimeJson(runtimeReference(root, 'mcp-callers'), REGISTRY_MAX_BYTES))
        assert.deepEqual(registry.callers.find((entry) => entry.principal.id === 'admin')!.principal.policy.grants, [])
        assert(registry.callers.some((entry) => entry.principal.id === 'caller_' + claim.claim_id))
        assert.equal(
          (await resource('tokens_list')).items.find((entry: any) => entry.principal === 'dashboard-client').token,
          createdToken
        )
        await resource('tokens_delete', { principal: 'caller_' + claim.claim_id })
        const clientPath = runtimeReference(root, 'mcp-client')
        const lineage = readRuntimeJson(clientPath) as { issued_at: number; expires_at: number }
        writeSetupFile(clientPath, JSON.stringify({ ...lineage, expires_at: lineage.issued_at + 1 }), true)
        const activationStatus = await devicePost('/pairing/claim/activation/status', {
          attempt_id: claim.claim_id,
          authentication,
          providers: ['herdr']
        })
        assert.equal(activationStatus.phase, 'configured')
        assert.equal(
          parseRegistry(readRuntimeJson(runtimeReference(root, 'mcp-callers'), REGISTRY_MAX_BYTES)).callers.some(
            (entry) => entry.principal.id === 'caller_' + claim.claim_id
          ),
          false
        )
        await resource('pairings_delete', { pairing_id })
        assert.equal((await resource('pairings_list')).items.length, 0)
        assert.equal(
          (await fetch(network + '/admin/v1/devices/' + machine_id, { headers: { host, cookie } })).status,
          200
        )
        await resource('tokens_delete', { principal: 'dashboard-client' })
        assert.equal(
          await active.authentication.authenticate(
            new Request('http://127.0.0.1:' + mcp + '/mcp', { headers: { authorization: 'Bearer ' + createdToken } }),
            new AbortController().signal
          ),
          null
        )
        await resource('devices_delete', { machine_id })
        assert.equal(
          (readRuntimeJson(runtimeReference(root, 'providers'), 1_048_576) as { providers: unknown[] }).providers
            .length,
          0
        )
        await active.close()
        active = await createProductionCliRuntime().gateway!(config)
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

        assert.equal(
          await active.authentication.authenticate(
            new Request('http://127.0.0.1:' + mcp + '/mcp', { headers: { authorization: 'Bearer ' + issued.secret } }),
            new AbortController().signal
          ),
          null
        )
      } finally {
        client?.close()
        await active?.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
