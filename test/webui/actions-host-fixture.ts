/** 仅显式本地页面验收使用：真实临时 Store/写服务/会话 handler，读观测标为合成且不连用户设备。 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagementResources } from '../../src/cli/management-resources.js'
import { configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { writeAdminFiles } from '../../src/cli/admin-command.js'
import { createHash, randomUUID } from 'node:crypto'
import { setup } from '../admin/write-helpers.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { fixtureReply, fixtureDevice } from './fixtures.js'
import type {
  GatewayManagementService,
  DeviceSnapshot,
  ManagementArguments,
  OperationReceipt
} from '../../src/mcp/management.js'

const actionFixtureCsrf = 'd'.repeat(43)
const cookie = 'SYNTHETIC_PAGE_COOKIE_' + 'c'.repeat(40)

/** 构造一次测试拥有的真实后端；不会从磁盘或生产身份读取任何材料。 */
export function createActionsHostFixture(origin: string) {
  const f = setup(undefined, {
    management: /** 仅允许自建临时设备的受保护测试签发。 */ () => ({
      actor: 'fixture_admin',
      confirmation_id: randomUUID()
    })
  })
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-dashboard-resources-'))
  mkdirSync(join(directory, 'managed'))
  const config = { ...configTemplate('gateway'), state_dir: directory } as GatewayConfig
  writeAdminFiles(config, 'fixture_admin', Date.now())
  const devices = [f.store.register('owned_page_a'), f.store.register('owned_page_b')]
  for (const device of devices) {
    const enrollment = f.store.issueEnrollment(device.machine_id)
    const paired = f.store.redeem(enrollment)
    f.store.connect(device.machine_id, paired.credential)
    f.store.defineProvider({
      machine_id: device.machine_id,
      provider_id: 'fixture-provider',
      kind: 'luvus',
      config_ref: 'synthetic',
      binding_revision: 1,
      enabled: true
    })
    f.grant(
      { action: 'devices_read', machine_id: device.machine_id },
      { action: 'permissions_read', machine_id: device.machine_id },
      { action: 'providers_read', machine_id: device.machine_id, provider_id: 'fixture-provider' },
      { action: 'providers_manage', machine_id: device.machine_id, provider_id: 'fixture-provider' },
      ...(['devices_rename', 'devices_disconnect', 'devices_revoke'] as const).map(
        /** 精确授予本次临时设备操作。 */ (action) => ({ action, machine_id: device.machine_id })
      )
    )
  }
  const pending = f.store.register('owned_pending')
  f.grant(
    { action: 'devices_read', machine_id: pending.machine_id },
    { action: 'devices_revoke', machine_id: pending.machine_id },
    { action: 'permissions_read', machine_id: pending.machine_id }
  )
  devices.push(pending)
  f.grant({ action: 'gateway_read' })
  let time = 1000
  let offset = 0
  const pairingClaims = new Map<string, string>()
  let mode = 'normal'
  const calls: string[] = []
  const requests: (ManagementArguments['operations_get'] & { operation: string })[] = []
  const receipts: (Pick<
    OperationReceipt,
    'request_id' | 'history_epoch' | 'recovery_generation' | 'evidence' | 'operation_state' | 'observed_at'
  > & { operation: string })[] = []
  const correlated = new Set([
    'devices_rename',
    'devices_disconnect',
    'devices_revoke',
    'providers_disable',
    'pairings_create',
    'pairings_cancel',
    'operations_get'
  ])
  let confirmationExpiresAt: number | undefined
  let release: (() => void) | undefined
  /** 合成后端使用同一单调推进的时钟，过期只由明确测试命令提前推进。 */
  function sync(): void {
    const next = Date.now() + offset
    f.advance(next - time)
    time = next
  }
  sync()
  const expiry = time + 900_000
  const adapter = createManagementSessionAdapter({
    identities: f.identities,
    origin,
    cookie_name: 'fixture_admin',
    now: /** 同一临时后端时间。 */ () => f.store.clock(),
    sessions: {
      identities: f.identities,
      /** 只识别当前fixture cookie，不从浏览器身份字段制造管理员。 */
      async resolveCookie(value) {
        return value === cookie && mode !== '401'
          ? {
              caller: { principal_id: 'fixture_admin' },
              session_ref: 'fixture_session',
              expires_at: expiry,
              csrf_sha256: createHash('sha256').update(actionFixtureCsrf).digest('hex')
            }
          : null
      }
    }
  })
  const reads: GatewayManagementService = {
    /** 读投影明确为测试数据；写入结果和 revision/epoch 来自同一真实 Store。 */
    async execute(operation, args, context) {
      sync()
      const result: any = fixtureReply(operation as never, args as never)
      const generation = f.store.health().generation
      if (operation === 'status') {
        return { ...result, server_time: time, observed_at: time, recovery_generation: generation } as never
      }
      /** 只投影持久事实，未接真实transport/native的字段保持未知。 */
      async function device(id: string): Promise<DeviceSnapshot> {
        const row = f.store.machine(id)
        const fence = await service.execute('write_state_get', { machine_id: id }, context)
        return {
          ...fixtureDevice(id),
          name: row.name,
          persisted_state: row.status as DeviceSnapshot['persisted_state'],
          resource_revision: fence.resource_revision,
          observed_at: mode === 'stale_device' ? time - 60_000 : time,
          connection: { verification: 'unverified', reason_code: 'backend_unavailable' },
          authentication: { verification: 'unverified', reason_code: 'backend_unavailable' }
        }
      }
      if (operation === 'devices_list') {
        return {
          items: await Promise.all(f.store.resources().map(/** 当前临时设备列表。 */ (d) => device(d.machine_id)))
        } as never
      }
      if (operation === 'devices_get') {
        return (await device((args as { machine_id: string }).machine_id)) as never
      }
      if (operation === 'providers_list') {
        const machine = (args as { machine_id: string }).machine_id
        const binding = f.store.provider(machine, 'fixture-provider')
        return {
          items: binding
            ? [
                {
                  ...binding,
                  observed_at: time,
                  readiness: 'unverified',
                  runtime: { verification: 'unverified', reason_code: 'backend_unavailable' }
                }
              ]
            : []
        } as never
      }
      if (operation === 'permissions_get') {
        return {
          ...result,
          recovery_generation: generation,
          observed_at: time,
          expires_at: time + 30_000,
          decisions: ['devices_read', 'devices_rename', 'devices_disconnect', 'devices_revoke'].map(
            /** 只提示fixture已经授予的范围。 */ (action) => ({ action, allowed: true, reason_code: 'allowed' })
          )
        } as never
      }
      return result
    }
  }
  const service = new StoreManagementWriteService({
    store: f.store,
    identities: adapter.identities,
    reads,
    /** 测试策略仅允许fixture_policy，不签发真实凭据或补devices_read。 */
    pairingPolicy: (ref) => ref === 'fixture_policy',
    transport: { /** 没有真实socket，回执必须保守保留物理效果未确认。 */ refresh() {} }
  })
  const handler = createManagementHandler({
    origin,
    service,
    authenticate: adapter.authenticate,
    verifyCsrf: adapter.verifyCsrf,
    resources: createManagementResources({
      config,
      store: f.store,
      authorize: () => mode !== '401' && mode !== '403',
      disconnect: () => {}
    })
  })
  return {
    cookie: 'fixture_admin=' + cookie + '; HttpOnly; SameSite=Strict; Path=/',
    bootstrap: { csrf: actionFixtureCsrf, expires_at: expiry },
    /** 实际请求走同一现有会话/CSRF handler；网络故障只注入在受控边界。 */
    async fetch(request: Request) {
      sync()
      const operation = new URL(request.url).pathname.split('/').at(-1)!
      calls.push(operation)
      if (request.method === 'POST' && correlated.has(operation)) {
        const args = (await request.clone().json()) as ManagementArguments['operations_get']
        requests.push({
          operation,
          request_id: args.request_id,
          history_epoch: args.history_epoch,
          recovery_generation: args.recovery_generation
        })
      }
      if (mode === 'prepare_error' && operation === 'confirmations_create') {
        return new Response('{"error":"backend_unavailable"}', {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (
        (mode === 'hold_confirm' && operation === 'confirmations_confirm') ||
        (mode === 'hold_write' &&
          (operation.startsWith('devices_') ||
            operation === 'providers_disable' ||
            operation === 'pairings_create' ||
            operation === 'pairings_cancel'))
      ) {
        await new Promise<void>(
          /** 迟到交付由测试明确释放。 */ (resolve) => {
            release = resolve
          }
        )
      }
      const response = await handler.fetch(request)
      if (response.status === 200 && operation === 'pairings_create') {
        const receipt = (await response.clone().json()) as { machine_id: string }
        f.grant(
          { action: 'devices_read', machine_id: receipt.machine_id },
          { action: 'devices_revoke', machine_id: receipt.machine_id }
        )
      }
      if (response.status === 200 && operation === 'confirmations_create') {
        confirmationExpiresAt = ((await response.clone().json()) as { expires_at: number }).expires_at
      }
      if (response.status === 200 && correlated.has(operation)) {
        const receipt = (await response.clone().json()) as OperationReceipt
        receipts.push({
          operation,
          request_id: receipt.request_id,
          history_epoch: receipt.history_epoch,
          recovery_generation: receipt.recovery_generation,
          evidence: receipt.evidence,
          operation_state: receipt.operation_state,
          observed_at: receipt.observed_at
        })
      }
      if (mode === 'hold_read' && request.method === 'GET' && /\/devices\/[^/]+$/.test(new URL(request.url).pathname)) {
        mode = 'normal'
        await new Promise<void>(
          /** 暂缓一次旧设备快照，后续新读不受阻。 */ (resolve) => {
            release = resolve
          }
        )
      }
      if (
        (mode === 'hold_reply' &&
          (operation.startsWith('devices_') ||
            operation === 'providers_disable' ||
            operation === 'pairings_create' ||
            operation === 'pairings_cancel')) ||
        (mode === 'hold_lookup' && operation === 'operations_get')
      ) {
        await new Promise<void>(
          /** 提交或查询后暂缓实际回执，验证截止与取消不会丢失原关联。 */ (resolve) => {
            release = resolve
          }
        )
      }
      if (
        mode === 'lost_reply' &&
        (operation.startsWith('devices_') ||
          operation === 'providers_disable' ||
          operation === 'pairings_create' ||
          operation === 'pairings_cancel')
      ) {
        return new Response('lost', { status: 503 })
      }
      return response
    },
    /** 测试控制仅在显式fixture服务可达；不提供任何生产管理端点。 */
    async control(request: Request) {
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== origin) {
          return new Response('forbidden', { status: 403 })
        }
        const value = (await request.json()) as { mode?: string; advance?: number; pairing_id?: string }
        if (value.mode) {
          mode = value.mode
          if (mode === 'deliver_claim') {
            const application = f.store.pairingApplication(value.pairing_id!)!
            const claim = f.store.startPairingClaim(
              application.machine_id,
              value.pairing_id!,
              'a'.repeat(64),
              'CHECK234'
            )
            f.store.approvePairingClaim(claim.claim_id, claim.user_code, 'fixture_admin')
            f.store.completePairingClaim(claim.claim_id)
            pairingClaims.set(value.pairing_id!, claim.claim_id)
            mode = 'normal'
          }
          if (mode === 'activate_claim') {
            f.store.activatePairingClaim(pairingClaims.get(value.pairing_id!)!, 'a'.repeat(64))
            mode = 'normal'
          }
          if (mode === 'complete_pairing') {
            // 仅兑换自建临时pending设备的合成证明，原值不离开fixture。
            f.store.redeem(f.store.issuePairingEnrollment(pending.machine_id, value.pairing_id!, 'fixture_policy'))
            mode = 'normal'
          }
        }
        if (value.advance) {
          offset += value.advance
          sync()
        }
        if (mode === 'release') {
          mode = 'normal'
          release?.()
          release = undefined
        }
      }
      return Response.json({
        devices: devices
          .filter((device) => f.store.resources().some((entry) => entry.machine_id === device.machine_id))
          .map(
            /** 只输出公开字段，凭据及其摘要也不进入测试页面。 */ (d) => {
              const row = f.store.machine(d.machine_id)
              return { machine_id: row.machine_id, name: row.name, status: row.status }
            }
          ),
        providers: devices.flatMap(
          /** 只输出自有fixture实例的公开状态。 */ (d) => {
            const p = f.store.provider(d.machine_id, 'fixture-provider')
            return p ? [p] : []
          }
        ),
        calls,
        requests,
        receipts,
        confirmation_expires_at: confirmationExpiresAt,
        now: time,
        held: !!release,
        mode
      })
    },
    /** 只销毁本进程的临时Store/等待，不影响用户Gateway或设备。 */
    close() {
      release?.()
      handler.stop()
      f.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
