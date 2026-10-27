// 使用真实 Store/Wire/WebSocket/HTTP SDK；设备身份、主机声明和 native 宿主均为明确的测试 fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { StoreGatewayService } from '../../src/mcp/store-service.js'
import { validateHostProfile, negotiate } from '../../src/wire/index.js'
import type { HostProfileReport } from '../../src/wire/types.js'
import { fixture, until } from '../transport/helpers.js'
import { httpFixture } from './http-fixture.js'
import { probeHostProfile } from '../../src/platform/host.js'
import type { ReplyData, ToolArguments } from '../../src/mcp/types.js'
import type { Administrator } from '../../src/mcp/management.js'
import { checkManagementReadReply } from '../../src/webui/validate.js'

const offer = { major: 2, minor: 2, capabilities: ['rpc', 'host_profile'], required: ['rpc'] }
const report: HostProfileReport = {
  os: { family: 'linux', distribution: 'debian-12', kernel: '6.1.0-31-amd64' },
  arch: 'x86_64',
  cpus: 4,
  memory_bytes: 17179869184,
  container: 'docker',
  agent_version: '0.6.7',
  providers: [{ provider_id: 'provider', native_version: '0.14.3' }]
}

test('主机声明约束固定字段和边界，系统 API 采集不带路径、网络或环境', () => {
  validateHostProfile(report)
  for (const extra of [
    { reported_at: 1 },
    { source: 'realtime' },
    { hostname: 'secret-host' },
    { env: {} },
    { cpus: -1 },
    { memory_bytes: Number.MAX_SAFE_INTEGER + 1 },
    { agent_version: 'secret\nline' },
    { providers: [...report.providers, ...report.providers] },
    { os: { ...report.os, interfaces: ['secret'] } }
  ]) {
    assert.throws(() => validateHostProfile({ ...report, ...extra }))
  }
  const measured = probeHostProfile('0.6.7')
  assert(measured)
  validateHostProfile(measured)
  assert.deepEqual(Object.keys(measured).sort(), Object.keys(report).sort())
  assert.equal(measured.os.family, process.platform)
  assert.equal(measured.arch, process.arch === 'x64' ? 'x86_64' : 'aarch64')
  assert.equal(measured.container === 'none', false)
  assert.deepEqual(negotiate(offer, { ...offer, minor: 1 }).capabilities, ['rpc'])
})

test(
  'MCP 详情含一次握手的 host 和时间，列表保持摘要，离线不刷新、旧 Connector 重连省略 host',
  { timeout: 20_000 },
  async () => {
    const f = fixture({ offer })
    const paired = f.pair('host_fixture')
    let admin: Administrator = {
      principal_id: 'synthetic',
      session_ref: 'fixture_admin',
      assurance: 'administrator',
      policy_revision: 'admin1',
      grants: [
        { action: 'devices_read', machine_id: paired.machine_id },
        { action: 'providers_read', machine_id: paired.machine_id, provider_id: 'provider' }
      ]
    }
    const hidden = f.store.defineProvider({
      machine_id: paired.machine_id,
      provider_id: 'hidden_provider',
      kind: 'luvus',
      binding_revision: 1,
      config_ref: 'hidden_config',
      enabled: true
    })
    f.localBindings.set(paired.machine_id + '/hidden_provider', hidden)
    const service = new StoreGatewayService({
      store: f.store,
      router: f.router,
      localPolicies: () => f.local,
      identities: {
        principal: () => f.principal,
        administrator: (_caller, ref) => (ref === 'fixture_admin' ? admin : null)
      },
      transportObservations: f.gateway.observations
    })
    const http = httpFixture(service, { authentication: { authenticate: () => ({ principal_id: 'synthetic' }) } })
    let reports = 0
    try {
      const client = f.connector(() => paired.credential, {
        offer,
        hostProfile: () => {
          reports++
          return {
            ...report,
            providers: [...report.providers, { provider_id: 'hidden_provider', native_version: '9.9.99' }]
          }
        }
      })
      const metadataScope = { machine_ids: [paired.machine_id], include_host: true }
      await until(() => !!f.gateway.observations.snapshot(metadataScope).machine_metadata?.[0]?.host)
      await http.client.connect(http.transport, { timeout: 5000 })
      const call = async <K extends 'machines_get' | 'machines_list'>(
        name: K,
        args: ToolArguments[K]
      ): Promise<ReplyData[K]> => {
        const result = CallToolResultSchema.parse(
          await http.client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 5000 })
        )
        assert(!result.isError, JSON.stringify(result.structuredContent))
        return result.structuredContent!.data as ReplyData[K]
      }
      const detail = await call('machines_get', { machine_id: paired.machine_id })
      assert.equal(detail.platform, 'linux/x86_64')
      assert(detail.host)
      assert.deepEqual(detail.host, { ...report, reported_at: 1000, source: 'connector_handshake' })
      assert.equal(detail.last_seen_at, 1000)
      assert.equal(detail.link_since, 1000)
      const list = await call('machines_list', {})
      assert.equal(list.items[0]!.platform, detail.platform)
      assert.equal('host' in list.items[0]!, false)
      f.now += 10
      await until(() => f.gateway.observations.snapshot(metadataScope).machine_metadata?.[0]?.last_seen_at === f.now)
      const later = await call('machines_get', { name: 'host_fixture' })
      assert.equal(later.host!.reported_at, detail.host.reported_at)
      assert.equal(later.last_seen_at, 1010)
      assert.equal(reports, 1)
      const managementContext = {
        caller: { principal_id: 'synthetic' },
        management_session_ref: 'fixture_admin',
        wait_signal: new AbortController().signal
      }
      const visibleGrants = [...f.principal.policy.grants]
      f.principal.policy.grants.length = 0
      const managed = await service.management.execute(
        'devices_get',
        { machine_id: paired.machine_id },
        managementContext
      )
      assert.deepEqual(managed.host, later.host)
      assert.equal(managed.last_seen_at, later.last_seen_at)
      checkManagementReadReply('devices_get', managed, { machine_id: paired.machine_id })
      admin = { ...admin, grants: admin.grants.filter((grant) => grant.action !== 'providers_read') }
      const reduced = await service.management.execute(
        'devices_get',
        { machine_id: paired.machine_id },
        managementContext
      )
      assert.deepEqual(reduced.host!.providers, [])
      f.principal.policy.grants.push(...visibleGrants)
      client.stop()
      await until(() => f.store.machine(paired.machine_id).status === 'offline')
      const offline = await call('machines_get', { machine_id: paired.machine_id })
      assert.equal(offline.host!.reported_at, 1000)
      assert.equal(offline.link_since, null)
      assert.equal(offline.last_seen_at, 1010)
      f.now += 10
      const old = f.connector(() => paired.credential, {
        offer: { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] },
        hostProfile: () => {
          throw new Error('must_not_sample_unnegotiated_report')
        }
      })
      await until(() => old.status().phase === 'ready')
      const legacy = await call('machines_get', { machine_id: paired.machine_id })
      assert.equal('host' in legacy, false)
      assert.equal(legacy.link_since, 1020)
      assert.equal('native_version' in legacy, false)
      f.principal.policy.grants.length = 0
      const denied = await http.client.callTool(
        { name: 'machines_get', arguments: { machine_id: paired.machine_id } },
        CallToolResultSchema
      )
      assert.equal(denied.isError, true)
      assert(!JSON.stringify(denied).includes('debian-12'))
    } finally {
      await http.close()
      service.close()
      f.stop()
    }
  }
)
