// 用真实设备认证和 Wire 验证远端 Gateway 装配；对端是明确合成 peer，不冒充双机或正式原生执行。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createLuvusCatalog } from '../../src/connector/luvus/index.js'
import { createLuvusProductionSources } from '../../src/connector/luvus/host/production-luvus.js'
import type { LuvusProductionRemoteConfig } from '../../src/connector/luvus/host/remote-luvus.js'
import { luvusCatalogProvider } from '../../src/connector/luvus/catalog-provider.js'
import { createGatewayRuntime } from '../../src/runtime/gateway.js'
import { createHerdrGatewayResources } from '../../src/connector/herdr/provider.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { createProviderConnectorRuntime } from '../../src/runtime/connector-host.js'
import { composeConnectorSessions } from '../../src/runtime/provider-sessions.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { FIXED_LUVUS_SHA256, FIXED_LUVUS_SCHEMA_SHA256 } from '../../src/connector/luvus/host/native-control.js'
import { MANAGED_LUVUS_REVISION, MANAGED_LUVUS_CLASSIFICATION } from '../../src/connector/luvus/host/native-source.js'
import {
  boundedJson,
  contractRef,
  hash,
  encodeWireFrame,
  decodeWireFrame,
  MessageWindow
} from '../../src/wire/index.js'
import type { AuthenticatedEnvelope, ProviderSnapshot, ProviderBinding, Direction } from '../../src/wire/types.js'
import type { Adapter, Connection, ConnectorWireSession } from '../../src/transport/index.js'
import { envelope } from '../../src/transport/common.js'
import { until } from '../transport/helpers.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { httpFixture } from '../mcp/http-fixture.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { SERVICE_ERROR_CODES, type ReplyData, type ServiceErrorCode } from '../../src/mcp/types.js'
import { LUVUS_TABLE_METHODS } from '../../src/connector/luvus/methods.js'
import { LUVUS_OPERATION_METHODS } from '../../src/connector/luvus/operations.js'

/** Gateway 只建立自身状态目录；没有 binary、HOME、native root 或 socket 输入。 */
async function fixture(
  options: {
    mixed?: boolean
    isolated?: boolean
    fastObservation?: boolean
    rawGrant?: LuvusProductionRemoteConfig['raw_grant']
    principals?: string[]
  } = {}
) {
  const { mixed = false, isolated = false, fastObservation = false } = options
  let deviceScope: string[] | undefined
  const root = mixed
    ? privateHerdrTestRoot('.remote-gateway-')
    : mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.remote-gateway-'))
  const directory = join(root, 'gateway')
  mkdirSync(directory, { mode: 0o700 })
  const active: { gateway?: Awaited<ReturnType<typeof createGatewayRuntime>> } = {}
  const state = openGatewayState({
    state_directory: directory,
    store: {
      management: /** 仅本轮临时合成设备与 provider 的管理能力。 */ () => ({
        actor: 'remote_fixture_admin',
        confirmation_id: randomUUID()
      })
    },
    changed: /** 原身份更改驱动原通道封锁。 */ (machine) => active.gateway?.transport.disconnect(machine)
  })
  const machine = state.store.register('synthetic_remote_device')
  const credential = {
    ...state.store.redeem(state.store.issueEnrollment(machine.machine_id)),
    recovery_generation: state.store.generation()
  }
  const target = {
    machine_id: machine.machine_id,
    provider_id: 'remote_provider',
    profile: 'session' as const,
    session: 'synthetic_remote'
  }
  const binding = {
    machine_id: target.machine_id,
    provider_id: target.provider_id,
    kind: 'luvus' as const,
    config_ref: 'remote_config',
    binding_revision: 1,
    enabled: true
  }
  state.store.defineProvider(binding)
  const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
  const config: LuvusProductionRemoteConfig = {
    kind: 'luvus',
    authentication: 'remote_connector',
    binding,
    target,
    ...(options.rawGrant ? { raw_grant: options.rawGrant } : {}),
    contract: {
      binary_version: '0.14.3',
      binary_sha256: FIXED_LUVUS_SHA256,
      schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      schema_bundle: schema
    }
  }
  const resources = await createLuvusProductionSources().gateway({ state_dir: directory }, [
    { reference: binding.config_ref, value: config }
  ])
  let herdr: Awaited<ReturnType<typeof createHerdrGatewayResources>> | undefined
  if (mixed) {
    try {
      const herdrTarget = { ...target, provider_id: 'herdr_snapshot' }
      const schema = join(root, 'herdr-schema.json')
      writeFileSync(schema, readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url)), {
        mode: 0o600
      })
      herdr = await createHerdrGatewayResources({
        config: {
          version: 1,
          target: herdrTarget,
          binding_revision: 1,
          config_ref: 'herdr_snapshot',
          expected_source: fixedHerdrSource(),
          schema_ref: schema
        }
      })
      state.store.defineProvider(herdr.providers[0]!.binding)
    } catch (error) {
      try {
        await herdr?.release()
      } finally {
        try {
          await resources.release()
        } finally {
          state.close()
          rmSync(root, { recursive: true, force: true })
        }
      }
      throw error
    }
  }
  const caps = JSON.parse(
    readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
  )
  caps.result.session = target.session
  caps.result.server_generation = 'a'.repeat(32)
  const snapshot: ProviderSnapshot = {
    binding,
    target,
    source: {
      provider_kind: 'luvus',
      protocol_family: 'uhp',
      binary_version: '0.14.3',
      binary_sha256: FIXED_LUVUS_SHA256,
      schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
      schema_origin: 'installed_cli',
      schema_command: 'luvus uhp schema',
      server_version: '0.14.3',
      native_protocol_version: '1.0',
      runtime_generation: caps.result.server_generation,
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      support_basis: 'live_catalog'
    },
    capabilities: caps,
    capability_revision: hash(boundedJson(caps.result))
  }
  const gateway = await createGatewayRuntime({
    lifecycle: state.lifecycle,
    channels: state.channels,
    identities: {
      principal: /** 合成 caller 与设备身份独立。 */ (identity) =>
        (options.principals ?? ['remote_reader']).includes(identity.principal_id)
          ? {
              id: identity.principal_id,
              ...(deviceScope ? { device_scope: { mode: 'selected' as const, machine_ids: deviceScope } } : {})
            }
          : null,
      administrator: /** 普通读取不取得管理身份。 */ () => null
    },
    providers: resources.providers,
    ...(herdr ? { hosted: [herdr] } : {}),
    listener: {
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      ...(isolated
        ? {
            offer: {
              major: 2,
              minor: 0,
              capabilities: ['rpc', ...(isolated ? ['provider_fence' as const] : [])],
              required: ['rpc', ...(isolated ? ['provider_fence' as const] : [])]
            },
            // 仅心跳/生命周期观察显式使用加速计时；隔离协商本身不改变连接租期。
            ...(fastObservation ? { limits: { heartbeat_ms: 30, idle_ms: 3000 } } : {})
          }
        : {})
    },
    release: /** listener 停止后释放来源和唯一状态 writer。 */ async () => {
      await resources.release()
      await herdr?.release()
      state.close()
    }
  })
  active.gateway = gateway
  const runtime = gateway
  const sockets = new Set<WebSocket>()
  let writes = 0
  let hold = false
  /** 此合成 peer 只测试 Gateway；没有生产 Connector、本机 native 权限或正式 claims 的证明效力。 */
  async function peer() {
    const socket = new WebSocket(runtime.transport.url)
    sockets.add(socket)
    let connection: Connection | undefined
    let sequence = 0
    const requests: Extract<AuthenticatedEnvelope, { type: 'request' }>[] = []
    socket.onopen = /** 凭本轮真实签发的临时设备凭据走原认证握手。 */ () =>
      socket.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'authenticate',
          message_id: randomUUID(),
          payload: {
            machine_id: credential.machine_id,
            recovery_generation: credential.recovery_generation,
            device_credential: credential.credential,
            connector_instance_id: randomUUID(),
            offer: {
              major: 2,
              minor: 0,
              capabilities: ['rpc', 'provider_snapshot', ...(isolated ? ['provider_fence'] : [])],
              required: ['rpc', ...(isolated ? ['provider_fence'] : [])]
            }
          }
        })
      )
    /** 测试只按当前 welcome 的私有连接发送数据，不自建或覆盖 Store epoch。 */
    function send(type: AuthenticatedEnvelope['type'], payload: unknown) {
      assert(connection)
      socket.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type,
          message_id: randomUUID(),
          machine_id: connection.machine_id,
          recovery_generation: connection.recovery_generation,
          connection_epoch: connection.connection_epoch,
          payload
        })
      )
    }
    socket.onmessage = /** 合成响应保留原 attempt/native ID，Gateway 必须通过其原结果门禁。 */ (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.type === 'welcome') {
        const { in_reply_to: _reply, selected, ...identity } = frame.payload
        connection = { ...identity, negotiated: selected, authenticated: true, active: true }
      } else if (frame.type === 'heartbeat') {
        send('heartbeat', { sequence: sequence++ })
      } else if (frame.type === 'request') {
        requests.push(frame)
        writes++
        send('accepted', { attempt: frame.payload.attempt })
        if (!hold) {
          send('response', {
            attempt: frame.payload.attempt,
            native_response: {
              id: frame.payload.attempt.native_request_id,
              result:
                frame.payload.attempt.provider_kind === 'herdr'
                  ? { type: 'pong', protocol: 22, version: '0.9.5' }
                  : { panes: [] }
            }
          })
        }
      }
    }
    await until(/** 实际身份宿主完成握手才交付测试 socket。 */ () => !!connection)
    return {
      socket,
      connection: connection!,
      requests,
      reply: /** 只完成本测试原请求，不冒充真实 native；回包仍经实际 Gateway 原 Wire。 */ (
        request: (typeof requests)[number]
      ) =>
        send('response', {
          attempt: request.payload.attempt,
          native_response: {
            id: request.payload.attempt.native_request_id,
            result:
              request.payload.attempt.provider_kind === 'herdr'
                ? { type: 'pong', protocol: 22, version: '0.9.5' }
                : { panes: [] }
          }
        }),
      fence: /** 合成对端只声明原配置失效，仍须通过实际认证 Wire 的完整 binding 检查。 */ (binding: ProviderBinding) =>
        send('provider_fenced', { binding }),
      snapshot: /** 每次测试消息仍经同一认证通道。 */ (value = snapshot) => send('provider_snapshot', value)
    }
  }
  return {
    runtime,
    /** 与 CLI 相同：把远端 Luvus 注册表包装成 provider 目录端口。 */
    catalog: luvusCatalogProvider({
      store: runtime.store,
      provider: runtime.catalog
    }),
    setScope: (scope?: string[]) => {
      deviceScope = scope
    },
    state,
    databasePath: join(directory, 'gateway.db'),
    config,
    target,
    peer,
    snapshot,
    credential,
    herdr,
    writes: /** 仅统计合成 peer 收到的 Wire request，不宣称 native 已执行。 */ () => writes,
    hold: /** 允许制造真实断连后的可能执行未知状态。 */ () => {
      hold = true
    },
    close: /** 全部测试 socket 与 Gateway 都关闭后才清理本轮唯一私有目录。 */ async () => {
      for (const socket of sockets) {
        socket.close()
      }
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  '旧契约经真实 MCP 返回 contract_unavailable，保留 mixed epoch、请求 key 和原幂等调用',
  { timeout: 45000 },
  async () => {
    const f = await fixture({ mixed: true })
    const service = new RuntimeGatewayService({
      runtime: f.runtime,
      identities: {
        principal: () => ({ id: 'remote_reader' }),
        administrator: () => null
      }
    })
    const http = httpFixture(service, {
      authentication: { authenticate: () => ({ principal_id: 'remote_reader' }) }
    })
    try {
      const peer = await f.peer()
      peer.snapshot()
      await until(() => f.runtime.transport.status().devices[0]?.ready === true)
      await http.client.connect(http.transport, { timeout: 5000 })
      const reader = new DatabaseSync(f.databasePath, { readOnly: true })
      try {
        const herdr = f.herdr!.providers[0]!
        for (const route of [
          { target: f.target, reference: contractRef(f.snapshot.source), method: 'pane.list' },
          { target: herdr.target, reference: herdr.contract_ref!, method: 'ping' }
        ]) {
          const args = {
            target: route.target,
            expected_binding_revision: 1,
            contract_ref: '0'.repeat(64),
            native_request: { method: route.method, params: {} },
            deadline: f.state.store.clock() + 30000,
            client_request_key: 'contract_' + route.method.replaceAll('.', '_'),
            wait_ms: 2000
          }
          const invoke = (input = args) =>
            http.client.callTool({ name: 'runtime_call', arguments: input }, CallToolResultSchema, { timeout: 5000 })
          const rows = reader.prepare('SELECT count(*) AS n FROM calls').get()!.n
          const writes = f.writes()
          f.setScope([])
          const forbidden = await invoke()
          assert.deepEqual(forbidden.structuredContent, { gateway_error: { code: 'forbidden' } })
          f.setScope()
          const revision = await invoke({ ...args, expected_binding_revision: 99 })
          assert.deepEqual(revision.structuredContent, { gateway_error: { code: 'binding_revision_conflict' } })
          const refused = await invoke()
          assert.equal(refused.isError, true)
          assert.deepEqual(refused.structuredContent, { gateway_error: { code: 'contract_unavailable' } })
          assert.equal(reader.prepare('SELECT count(*) AS n FROM calls').get()!.n, rows)
          assert.equal(f.writes(), writes)
          assert.equal(peer.socket.readyState, WebSocket.OPEN)
          assert.equal(
            f.runtime.transport.currentConnection(f.target.machine_id)!.connection_epoch,
            peer.connection.connection_epoch
          )
          const acceptedArgs = { ...args, contract_ref: route.reference }
          const accepted = await invoke(acceptedArgs)
          assert(!accepted.isError, JSON.stringify(accepted.structuredContent))
          const call = (accepted.structuredContent as { data: ReplyData['runtime_call'] }).data
          assert.equal(call.state, 'responded')
          const duplicate = await invoke(acceptedArgs)
          assert.equal((duplicate.structuredContent as { data: ReplyData['runtime_call'] }).data.call_id, call.call_id)
          const changed = await invoke()
          assert.deepEqual(changed.structuredContent, { gateway_error: { code: 'conflict' } })
          assert.equal(f.writes(), writes + 1)
        }
        const legacyArgs = {
          target: f.target,
          expected_binding_revision: 1,
          contract_ref: '0'.repeat(64),
          native_request: { method: 'pane.list', params: {} },
          deadline: f.state.store.clock() + 30000,
          client_request_key: 'legacy_unknown_contract'
        }
        const old = await f.runtime.runAuthenticated({ principal_id: 'remote_reader' }, () => {
          // 通过原账本构造旧版本留下的 unknown 历史；不发送 Wire，不声称原生已执行。
          const principal = f.runtime.principal()
          const admitted = f.runtime.router.admit(principal, f.target, legacyArgs.native_request, {
            binding_revision: 1,
            contract_ref: legacyArgs.contract_ref,
            deadline: legacyArgs.deadline,
            client_request_key: legacyArgs.client_request_key
          })
          f.runtime.router.dispatch(principal, admitted.call.call_id, peer.connection.connection_epoch)
          return f.state.store.stop(principal.id, admitted.call.call_id)
        })
        assert.equal(old.state, 'outcome_unknown')
        const writes = f.writes()
        const repeated = await http.client.callTool(
          { name: 'runtime_call', arguments: legacyArgs },
          CallToolResultSchema,
          { timeout: 5000 }
        )
        assert(!repeated.isError, JSON.stringify(repeated.structuredContent))
        const history = (repeated.structuredContent as { data: ReplyData['runtime_call'] }).data
        assert.equal(history.call_id, old.call_id)
        assert.equal(history.state, 'outcome_unknown')
        assert.equal(f.writes(), writes)
      } finally {
        reader.close()
      }
    } finally {
      await http.close()
      service.close()
      await f.close()
    }
  }
)

test('直接 MCP 调用不能绕过 provider 暴露面，原生广告不额外开放静态表方法', { timeout: 45000 }, async () => {
  const f = await fixture()
  const service = new RuntimeGatewayService({
    runtime: f.runtime,
    identities: {
      principal: () => ({ id: 'remote_reader' }),
      administrator: () => null
    }
  })
  const http = httpFixture(service, { authentication: { authenticate: () => ({ principal_id: 'remote_reader' }) } })
  try {
    const peer = await f.peer()
    peer.snapshot()
    await until(() => f.runtime.transport.status().devices[0]?.ready === true)
    await http.client.connect(http.transport, { timeout: 5000 })
    const reader = new DatabaseSync(f.databasePath, { readOnly: true })
    try {
      const rows = reader.prepare('SELECT count(*) AS n FROM calls').get()!.n
      const outside = LUVUS_TABLE_METHODS.filter((method) => !LUVUS_OPERATION_METHODS.includes(method))
      assert(outside.includes('task.delete'))
      assert(outside.includes('terminal.backend.close'))
      for (const method of [...outside, 'automation.run', 'automation.delete', 'module.load', 'module.unload']) {
        const result = await http.client.callTool(
          {
            name: 'runtime_call',
            arguments: {
              target: f.target,
              expected_binding_revision: 1,
              contract_ref: contractRef(f.snapshot.source),
              native_request: { method, params: {} },
              deadline: f.state.store.clock() + 30_000,
              client_request_key: 'unexposed_' + method.replaceAll('.', '_')
            }
          },
          CallToolResultSchema
        )
        assert.equal(result.isError, true, JSON.stringify({ method, response: result.structuredContent }))
        assert.deepEqual(result.structuredContent, { gateway_error: { code: 'forbidden' } }, method)
      }
      assert.equal(reader.prepare('SELECT count(*) AS n FROM calls').get()!.n, rows)
      assert.equal(f.writes(), 0)
      assert.equal(peer.socket.readyState, WebSocket.OPEN)
      assert.equal(
        f.runtime.transport.currentConnection(f.target.machine_id)!.connection_epoch,
        peer.connection.connection_epoch
      )
      // 拒绝不消耗请求 key；同一连接仍可正常调用暴露方法。
      const healthy = await http.client.callTool(
        {
          name: 'runtime_call',
          arguments: {
            target: f.target,
            expected_binding_revision: 1,
            contract_ref: contractRef(f.snapshot.source),
            native_request: { method: 'pane.list', params: {} },
            deadline: f.state.store.clock() + 30_000,
            client_request_key: 'unexposed_task_delete',
            wait_ms: 2000
          }
        },
        CallToolResultSchema
      )
      assert(!healthy.isError, JSON.stringify(healthy.structuredContent))
      assert.equal((healthy.structuredContent as { data: ReplyData['runtime_call'] }).data.state, 'responded')
      assert.equal(f.writes(), 1)
    } finally {
      reader.close()
    }
  } finally {
    await http.client.close()
    await f.close()
  }
})

test('无静态 raw 清单也能派发，mixed 通道保留并发 Herdr 调用', { timeout: 45000 }, async () => {
  const f = await fixture({ mixed: true, isolated: true })
  try {
    const peer = await f.peer()
    peer.snapshot()
    await until(() => f.runtime.transport.status().devices[0]?.ready === true)
    f.hold()
    const herdr = f.herdr!.providers[0]!
    const first = await f.runtime.runAuthenticated({ principal_id: 'remote_reader' }, () =>
      f.runtime.admit({
        target: herdr.target,
        native_request: { method: 'ping', params: {} },
        options: {
          binding_revision: 1,
          contract_ref: herdr.contract_ref!,
          deadline: f.state.store.clock() + 30000
        }
      })
    )
    await until(() => f.state.store.call('remote_reader', first.call.call_id).state === 'connector_accepted')
    const epoch = peer.connection.connection_epoch
    const second = await f.runtime.runAuthenticated({ principal_id: 'remote_reader' }, () =>
      f.runtime.admit({
        target: f.target,
        native_request: { method: 'workspace.rename', params: { workspace_id: 'synthetic', name: 'literal' } },
        options: {
          binding_revision: 1,
          contract_ref: contractRef(f.snapshot.source),
          deadline: f.state.store.clock() + 30000
        }
      })
    )
    await until(() => f.state.store.call('remote_reader', second.call.call_id).state === 'connector_accepted')
    assert.equal(f.writes(), 2)
    assert.equal(f.runtime.transport.currentConnection(f.target.machine_id)!.connection_epoch, epoch)
    assert.equal(f.state.store.call('remote_reader', first.call.call_id).state, 'connector_accepted')
    peer.reply(peer.requests[0]!)
    peer.reply(peer.requests[1]!)
    await until(() => f.state.store.call('remote_reader', second.call.call_id).state === 'responded')
    await until(() => f.state.store.call('remote_reader', first.call.call_id).state === 'responded')
    await f.runtime.runAuthenticated({ principal_id: 'remote_reader' }, () => {
      const result = f.runtime.results.open(first.call.call_id)
      const page = f.runtime.results.read(result.result_id, 0, 4096)
      assert.equal(JSON.parse(Buffer.from(page.data, 'base64').toString()).result.type, 'pong')
    })
  } finally {
    await f.close()
  }
})

test('remote Gateway 策略 raw 授权允许多个 caller，调用和结果继续各自归属真实主体', { timeout: 45000 }, async () => {
  const principals = ['remote_reader', 'test', 'admin']
  const f = await fixture({
    principals,
    rawGrant: { methods: ['workspace.rename'] }
  })
  try {
    const peer = await f.peer()
    peer.snapshot()
    await until(() => f.runtime.transport.status().devices[0]?.ready === true)
    for (const principal_id of principals) {
      const admitted = await f.runtime.runAuthenticated({ principal_id }, () =>
        f.runtime.admit({
          target: f.target,
          native_request: { method: 'workspace.rename', params: { workspace_id: 'synthetic', name: 'literal' } },
          options: {
            binding_revision: 1,
            contract_ref: contractRef(f.snapshot.source),
            deadline: f.state.store.clock() + 30000
          }
        })
      )
      await until(() => f.state.store.call(principal_id, admitted.call.call_id).state === 'responded')
      await f.runtime.runAuthenticated({ principal_id }, () => {
        const result = f.runtime.results.open(admitted.call.call_id)
        assert.equal(f.runtime.results.read(result.result_id, 0, 4096).eof, true)
      })
      const other = principals.find((id) => id !== principal_id)!
      await assert.rejects(
        f.runtime.runAuthenticated({ principal_id: other }, () => f.runtime.results.open(admitted.call.call_id))
      )
    }
    assert.equal(f.writes(), principals.length)
    assert.equal(
      f.runtime.transport.currentConnection(f.target.machine_id)!.connection_epoch,
      peer.connection.connection_epoch
    )
  } finally {
    await f.close()
  }
})

/** 非空快照只使用真实Wire治理codec；所有native端口是明确拒绝执行的测试stub。 */
function snapshotSession(
  connection: Connection,
  route: Pick<ProviderSnapshot, 'binding' | 'target'>
): ConnectorWireSession {
  let closed = false
  const windows = new Map<Direction, MessageWindow>()
  const context = /** 原codec独立核对真实welcome及完整canonical provider，不接纳其它组。 */ (direction: Direction) => ({
    phase: 'authenticated' as const,
    direction,
    connection,
    resolveProvider: /** 完整目标匹配，不能只按kind或provider名称授权。 */ (target: ProviderSnapshot['target']) =>
      boundedJson(target) === boundedJson(route.target) ? route.binding : undefined
  })
  const native = /** 此测试没有native backend，意外业务调用始终失败。 */ () => {
    throw new Error('snapshot_test_native_unavailable')
  }
  const adapter: Adapter = {
    encode: /** 原encoder核对快照完整形状、协商能力与epoch。 */ (frame, direction) =>
      encodeWireFrame(frame, context(direction)),
    decode: /** 原decoder收到真实通道字节后再次验证全部原字段。 */ (raw, direction) =>
      decodeWireFrame(raw, context(direction)),
    observeMessage: /** 原组保持真实Wire消息窗口，组合窗口不能替代它。 */ (frame, direction) => {
      let window = windows.get(direction)
      if (!window) {
        window = new MessageWindow()
        windows.set(direction, window)
      }
      return window.observe(frame, context(direction), Date.now())
    },
    checkResult: native,
    checkResultRetention: native,
    planEvidence: native,
    release: native,
    stats: /** 没有native上下文，关闭状态只属于本测试端口。 */ () => ({ closed, executions: 0, responses: 0 }),
    close: /** 原codec所有者记录实际关闭，组合层仍负责全部组。 */ () => {
      closed = true
    }
  }
  return {
    adapter,
    readiness: /** 只有本组的受保护配置；不宣称原生执行就绪。 */ () => ({
      providers: [{ expected: route.binding, local: route.binding, native_ready: true }]
    }),
    executeWire: /** 该合成Connector仅发布快照，没有业务成功stub。 */ async () => native(),
    close: /** 本例没有额外原生owner，adapter关闭由原角色执行。 */ () => {}
  }
}

for (const isolated of [false, true]) {
  test(
    `mixed Connector publishes original sources through one channel (provider isolation: ${isolated})`,
    { timeout: 45_000 },
    /** 实际角色transport、组合codec和远端pin接纳均执行；不配对真实设备或调用native/model。 */ async () => {
      const f = await fixture({ mixed: true, isolated, fastObservation: isolated })
      let connector: Awaited<ReturnType<typeof createProviderConnectorRuntime>> | undefined
      let combined: ConnectorWireSession | undefined
      let connected: Connection | undefined
      let publicationFailure: unknown
      let snapshotEncodes = 0
      let releases = 0
      let luvusReady = true
      let heartbeats = 0
      try {
        const nativeSnapshots = structuredClone([f.snapshot])
        /** 原transport要求稳定深冻结快照，测试不通过空数组绕过实际编码。 */
        function freeze(value: unknown): void {
          if (value && typeof value === 'object') {
            for (const child of Object.values(value)) {
              freeze(child)
            }
            Object.freeze(value)
          }
        }
        freeze(nativeSnapshots)
        connector = await createProviderConnectorRuntime({
          provider_snapshot: true,
          transport: {
            ...(isolated
              ? {
                  offer: {
                    major: 2,
                    minor: 0,
                    capabilities: ['rpc', 'provider_fence'],
                    required: ['rpc', 'provider_fence']
                  },
                  limits: { heartbeat_ms: 30, idle_ms: 3000 }
                }
              : {}),
            url: f.runtime.transport.url,
            developmentLoopback: true,
            credential: /** 仅使用本fixture原有的短期合成身份，不读取用户凭据。 */ () => f.credential
          },
          session: /** 原host在实际认证welcome后建立一个组合会话。 */ (connection) => {
            connected = connection
            const luvus = snapshotSession(connection, f.snapshot)
            const readiness = luvus.readiness
            luvus.readiness = /** 显式模拟单个原安装来源失效，不影响 Herdr 或认证通道。 */ () => {
              const state = readiness()
              return {
                ...state,
                providers: state.providers.map(
                  /** 只撤去本组原生可用事实。 */ (provider) => ({
                    ...provider,
                    native_ready: provider.native_ready && luvusReady
                  })
                )
              }
            }
            luvus.providerSnapshot = /** 交付同一份非空原始快照，不复制或刷新generation。 */ () => nativeSnapshots
            const hosted = f.herdr!.providers[0]!
            const herdr = snapshotSession(connection, hosted)
            combined = composeConnectorSessions(
              connection,
              [
                { providers: [f.snapshot], session: luvus },
                { providers: [hosted], session: herdr }
              ],
              Date.now
            )
            const original = combined
            return {
              ...original,
              adapter: {
                ...original.adapter,
                encode: /** 仅观察实际transport发布失败，仍调用原组合encoder且保留其拒绝。 */ (frame, direction) => {
                  try {
                    const bytes = original.adapter.encode(frame, direction)
                    if (frame.type === 'heartbeat') {
                      heartbeats++
                    }
                    if (frame.type === 'provider_snapshot') {
                      snapshotEncodes++
                    }
                    return bytes
                  } catch (error) {
                    if (frame.type === 'provider_snapshot') {
                      publicationFailure = error
                    }
                    throw error
                  }
                }
              }
            }
          },
          release: /** 原Connector关闭后只释放本例长期资源一次。 */ async () => {
            releases++
          }
        })
        await until(
          /** Gateway原remote owner接纳非空快照后，原provider健康才会变ready。 */ () =>
            f.runtime.transport
              .status()
              .devices.some(
                /** Herdr单独ready不能代替Luvus实际快照已接纳。 */ (device) =>
                  device.providers.some(
                    /** 指定原Luvus provider，避免把任一其它组就绪当成通过。 */ (provider) =>
                      provider.provider_id === f.target.provider_id && provider.ready
                  )
              )
        )
        assert.equal(f.runtime.transport.status().devices.length, 1)
        assert(['authenticated', 'ready'].includes(connector.transport.status().phase))
        assert.equal(combined!.providerSnapshot!().length, 1)
        assert.equal(publicationFailure, undefined)
        assert.equal(snapshotEncodes, 1)
        await f.runtime.runAuthenticated(
          { principal_id: 'remote_reader' },
          /** Gateway组合decoder、observe和accept均已执行，目录来源必须与原快照完全一致。 */ () => {
            const resolved = f.runtime.catalog.resolve(f.target, f.runtime.principal())!
            assert(resolved)
            assert.deepEqual(resolved.record.wire.source, f.snapshot.source)
            assert.deepEqual(resolved.record.capabilities, f.snapshot.capabilities)
            assert(f.herdr!.catalog.resolve(f.herdr!.providers[0]!.target, f.runtime.principal()))
          }
        )
        const frame = envelope(connected!, 'provider_snapshot', f.snapshot)
        assert.equal(Object.hasOwn(frame.payload, 'attempt'), false)
        assert.throws(
          /** 错kind不能选择其它组的原codec。 */ () =>
            combined!.adapter.encode(
              { ...frame, payload: { ...f.snapshot, binding: { ...f.snapshot.binding, kind: 'herdr' } } },
              'connector_to_gateway'
            )
        )
        assert.throws(
          /** 同名provider的其它session没有受保护路由。 */ () =>
            combined!.adapter.encode(
              { ...frame, payload: { ...f.snapshot, target: { ...f.target, session: 'foreign' } } },
              'connector_to_gateway'
            )
        )
        assert.throws(
          /** 同一路由的陈旧binding仍拒绝，不能只比较kind。 */ () =>
            combined!.adapter.encode(
              { ...frame, payload: { ...f.snapshot, binding: { ...f.snapshot.binding, binding_revision: 2 } } },
              'connector_to_gateway'
            )
        )
        assert.throws(
          /** 选中正确组以后，原codec仍拒绝错误连接epoch。 */ () =>
            combined!.adapter.encode({ ...frame, connection_epoch: 'foreign_epoch' }, 'connector_to_gateway')
        )
        if (isolated) {
          const epoch = connected!.connection_epoch
          luvusReady = false
          await until(
            /** Gateway 原来源撤回必须只影响 Luvus，Herdr 保留同一原资源。 */ () => {
              const providers = f.runtime.transport.status().devices[0]?.providers ?? []
              return (
                providers.find(/** 失败实例不再就绪。 */ (provider) => provider.provider_id === f.target.provider_id)
                  ?.ready === false &&
                providers.find(
                  /** 健康 Herdr 不随其它来源关闭。 */ (provider) => provider.provider_id === 'herdr_snapshot'
                )?.ready === true
              )
            }
          )
          assert.equal(f.runtime.transport.status().connections, 1)
          assert.equal(connector.transport.status().connection_epoch, epoch)
          assert.equal(connector.transport.status().reconnects, 0)
          assert.equal(combined!.providerSnapshot!().length, 0)
          await f.runtime.runAuthenticated(
            { principal_id: 'remote_reader' },
            /** 实际 RemoteLuvus pin 失效且健康 Herdr schema 目录仍可读，不用元数据代替原来源。 */ () => {
              assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
              assert(f.herdr!.catalog.resolve(f.herdr!.providers[0]!.target, f.runtime.principal()))
            }
          )
          luvusReady = true
          const before = heartbeats
          await until(/** 恢复两轮原连接心跳也不能复活旧来源。 */ () => heartbeats >= before + 2)
          assert.equal(combined!.providerSnapshot!().length, 0)
          assert.equal(snapshotEncodes, 1)
          assert.equal(connector.transport.status().connection_epoch, epoch)
          await f.runtime.runAuthenticated(
            { principal_id: 'remote_reader' },
            /** 原 epoch 的固定撤回继续生效，不重新打开旧 pin。 */ () => {
              assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
              assert(f.herdr!.catalog.resolve(f.herdr!.providers[0]!.target, f.runtime.principal()))
            }
          )
        }
        assert.equal(f.writes(), 0)
      } catch (error) {
        throw publicationFailure ?? error
      } finally {
        await connector?.close()
        await f.close()
      }
      assert.equal(releases, 1)
    }
  )
}

test(
  'Herdr 启动前不可用声明经真实通道撤回，Gateway 的健康 Luvus pin 仍在同 epoch 就绪',
  { timeout: 45_000 },
  /** Herdr 没有构造替代session；Luvus合成peer只发布原快照，不执行native或模型。 */ async () => {
    const f = await fixture({ mixed: true, isolated: true, fastObservation: true })
    let connector: Awaited<ReturnType<typeof createProviderConnectorRuntime>> | undefined
    try {
      const snapshots = structuredClone([f.snapshot])
      /** 与正式快照来源相同的固定深冻结数据要求。 */
      function freeze(value: unknown): void {
        if (value && typeof value === 'object') {
          for (const child of Object.values(value)) {
            freeze(child)
          }
          Object.freeze(value)
        }
      }
      freeze(snapshots)
      connector = await createProviderConnectorRuntime({
        provider_snapshot: true,
        transport: {
          url: f.runtime.transport.url,
          developmentLoopback: true,
          offer: { major: 2, minor: 0, capabilities: ['rpc', 'provider_fence'], required: ['rpc', 'provider_fence'] },
          limits: { heartbeat_ms: 30, idle_ms: 3000 },
          credential: /** 仅使用本轮合成设备身份。 */ () => f.credential
        },
        session: /** 实际welcome后仅建立健康原会话，不为Herdr生成adapter或来源。 */ (connection) => {
          const luvus = snapshotSession(connection, f.snapshot)
          luvus.providerSnapshot = /** 原稳定快照不刷新generation。 */ () => snapshots
          return composeConnectorSessions(
            connection,
            [{ providers: [f.snapshot], session: luvus }],
            Date.now,
            f.herdr!.providers
          )
        },
        release: /** 此合成peer没有额外安装或child资源。 */ async () => {}
      })
      await until(
        /** 两个实例都须有明确状态，不能把缺项当作已隔离。 */ () => {
          const providers = f.runtime.transport.status().devices[0]?.providers ?? []
          return (
            connector!.transport.status().phase === 'ready' &&
            providers.find(/** 健康原Luvus来源仍ready。 */ (provider) => provider.provider_id === f.target.provider_id)
              ?.ready === true &&
            providers.find(
              /** 无原生backend的Herdr明确不可用。 */ (provider) => provider.provider_id === 'herdr_snapshot'
            )?.ready === false
          )
        }
      )
      assert.equal(f.runtime.transport.status().connections, 1)
      assert.equal(connector.transport.status().reconnects, 0)
      assert.equal(
        connector.transport
          .status()
          .providers.find(
            /** 原失败配置也在Connector健康中明确报告。 */ (provider) => provider.provider_id === 'herdr_snapshot'
          )!.ready,
        false
      )
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 仍读取实际Gateway pin创建的原Luvus目录，不以元数据stub自证来源。 */ () => {
          const resolved = f.runtime.catalog.resolve(f.target, f.runtime.principal())!
          assert(resolved)
          assert.deepEqual(resolved.record.wire.source, f.snapshot.source)
        }
      )
      assert.equal(f.writes(), 0)
    } finally {
      await connector?.close()
      await f.close()
    }
  }
)

for (const { isolated, disconnectBeforeRead } of [
  { isolated: false, disconnectBeforeRead: false },
  { isolated: true, disconnectBeforeRead: false },
  { isolated: false, disconnectBeforeRead: true }
]) {
  test(
    `真实 MCP SDK ${disconnectBeforeRead ? '结果元数据不替代断连后读取许可' : '非法 agent.wait 拒绝保留原连接和健康调用'}（Herdr隔离组合: ${isolated}）`,
    { timeout: 45_000 },
    /** 真实 pinned schema、双库、Gateway、Wire 和 HTTP SDK；peer 仅为明确合成回包，无 native/model。 */ async () => {
      const f = await fixture({ mixed: isolated, isolated })
      let http: ReturnType<typeof httpFixture> | undefined
      let service: RuntimeGatewayService | undefined
      try {
        const peer = await f.peer()
        peer.snapshot()
        await until(
          /** 原 pin 必须先接纳实际认证快照。 */ () => f.runtime.transport.status().devices[0]?.ready === true
        )
        if (isolated) {
          const unavailable = f.herdr!.providers[0]!.binding
          assert.equal(
            f.runtime.transport.status().devices[0]!.providers.find(
              /** 先证明原配置曾可用，再等待真实失效声明完成，避免把缺项误当成已隔离。 */
              (provider) => provider.provider_id === unavailable.provider_id
            )!.ready,
            true
          )
          peer.fence(unavailable)
          await until(
            /** 原认证失效帧只撤回 Herdr；健康 Luvus 仍保留实际快照。 */ () => {
              const providers = f.runtime.transport.status().devices[0]?.providers ?? []
              return (
                providers.find(
                  /** 只观察已声明失效的原 Herdr。 */ (provider) => provider.provider_id === unavailable.provider_id
                )?.ready === false &&
                providers.find(
                  /** 独立观察仍健康的原 Luvus。 */ (provider) => provider.provider_id === f.target.provider_id
                )?.ready === true
              )
            }
          )
        }
        f.hold()
        service = new RuntimeGatewayService({
          runtime: f.runtime,
          catalog: f.catalog,
          identities: {
            principal: /** 沿用原 runtime 的当前 caller 来源。 */ (caller) =>
              caller.principal_id === 'remote_reader' ? { id: 'remote_reader' } : null,
            administrator: /** 本例不提供管理员会话。 */ () => null
          }
        })
        http = httpFixture(service, {
          authentication: {
            authenticate: /** 仅本例 listener 的合成身份。 */ () => ({ principal_id: 'remote_reader' })
          }
        })
        await http.client.connect(http.transport)
        let toolCursor: string | undefined
        let foundCall = false
        for (let page = 0; page < 10 && !foundCall; page++) {
          const tools = await http.client.listTools(toolCursor ? { cursor: toolCursor } : {})
          foundCall = tools.tools.some(
            /** 真实 SDK 按标准分页读取当前工具输出 schema。 */ (tool) => tool.name === 'runtime_call'
          )
          toolCursor = tools.nextCursor
          if (!toolCursor) {
            break
          }
        }
        assert(foundCall)
        const input = {
          target: f.target,
          expected_binding_revision: 1,
          contract_ref: contractRef(f.snapshot.source),
          native_request: { method: 'pane.list', params: { all_tabs: true } },
          deadline: f.state.store.clock() + 30000
        }
        const healthy = CallToolResultSchema.parse(
          await http.client.callTool({ name: 'runtime_call', arguments: input })
        )
        assert.equal(healthy.isError, undefined)
        const healthyId = (healthy.structuredContent!.data as { call_id: string }).call_id
        await until(
          /** 原健康调用确实已到对端并 accepted。 */ () =>
            f.state.store.call('remote_reader', healthyId).state === 'connector_accepted'
        )
        const epoch = peer.connection.connection_epoch
        const before = f.writes()
        const client_request_key = 'correctable_bad_wait'
        const bad = CallToolResultSchema.parse(
          await http.client.callTool({
            name: 'runtime_call',
            arguments: {
              ...input,
              native_request: { method: 'agent.wait', params: { target: '1', until: 'idle' } },
              client_request_key
            }
          })
        )
        assert.equal(bad.isError, true)
        const error = bad.structuredContent!.gateway_error as {
          code: string
          outcome: string
          details: { issues: unknown[]; parameter_help: { source: string; required: string[] } }
        }
        assert.equal(error.code, 'native_request_invalid')
        assert.equal(error.outcome, 'not_dispatched')
        assert.deepEqual(error.details.issues, [
          { path: '/params/pane', rule: 'required' },
          { path: '/params/statuses', rule: 'one_of' }
        ])
        assert.equal(error.details.parameter_help.source, 'rovloom_reviewed_subset')
        assert.deepEqual(error.details.parameter_help.required, ['pane'])
        const described = CallToolResultSchema.parse(
          await http.client.callTool({
            name: 'runtime_describe',
            arguments: {
              target: f.target,
              expected_binding_revision: 1,
              method: 'agent.wait'
            }
          })
        )
        assert.equal(described.isError, undefined)
        assert.deepEqual(
          (described.structuredContent!.data as { parameter_help: unknown }).parameter_help,
          error.details.parameter_help
        )
        const nativeDescription = described.structuredContent!.data as {
          params_schema: unknown
          schema_annotations: { pointer: string; text: string }[]
        }
        assert(nativeDescription.params_schema)
        assert(
          nativeDescription.schema_annotations.some(
            (note) => note.pointer === '#/$comment' && note.text.includes('new working or blocked transition')
          )
        )
        assert.deepEqual(JSON.parse((bad.content[0] as { text: string }).text), bad.structuredContent)
        assert.equal(f.writes(), before)
        assert.equal(f.state.store.call('remote_reader', healthyId).state, 'connector_accepted')
        assert.equal(f.runtime.transport.currentConnection(f.target.machine_id)!.connection_epoch, epoch)
        assert.equal(f.runtime.transport.status().connections, 1)
        peer.reply(
          peer.requests.find(/** 只完成原健康请求。 */ (request) => request.payload.attempt.call_id === healthyId)!
        )
        await until(
          /** schema 拒绝未夺走健康调用的原响应许可。 */ () =>
            f.state.store.call('remote_reader', healthyId).state === 'responded'
        )
        const retained = CallToolResultSchema.parse(
          await http.client.callTool({ name: 'runtime_call_get', arguments: { call_id: healthyId } })
        )
        assert.equal(retained.isError, undefined)
        const retainedData = retained.structuredContent!.data as { result: { result_id: string; expires_at: number } }
        assert(retainedData.result.expires_at > f.state.store.clock())
        if (disconnectBeforeRead) {
          peer.socket.close()
          await until(
            /** 真实旧连接消失，不能用结果元数据代替原读取许可。 */ () =>
              f.runtime.transport.currentConnection(f.target.machine_id) === undefined
          )
          assert.equal(f.state.store.call('remote_reader', healthyId).state, 'responded')
          assert.equal(f.state.store.call('remote_reader', healthyId).content_status, 'available')
          assert(input.deadline > f.state.store.clock())
        }
        const page = CallToolResultSchema.parse(
          await http.client.callTool({
            name: 'runtime_result_read',
            arguments: { result_id: retainedData.result.result_id, max_bytes: 4096 }
          })
        )
        if (disconnectBeforeRead) {
          assert.equal(page.isError, undefined)
          assert((page.structuredContent!.data as { chunk: string }).chunk)
          const afterLoss = CallToolResultSchema.parse(
            await http.client.callTool({ name: 'runtime_call_get', arguments: { call_id: healthyId } })
          )
          assert.equal(afterLoss.isError, undefined)
          assert.equal((afterLoss.structuredContent!.data as { state: string }).state, 'responded')
          assert.equal(f.writes(), before)
          return
        }
        const code = (page.structuredContent?.gateway_error as { code?: unknown })?.code
        const reason =
          typeof code === 'string' && SERVICE_ERROR_CODES.includes(code as ServiceErrorCode)
            ? code
            : 'unexpected_tool_error'
        assert.equal(page.isError, undefined, reason)
        const delivered = page.structuredContent!.data as ReplyData['runtime_result_read']
        assert.equal(delivered.eof, true)
        assert.equal(delivered.encoding, 'base64')
        assert.deepEqual(JSON.parse(Buffer.from(delivered.chunk, 'base64').toString()).result, { panes: [] })
        if (isolated) {
          assert.equal(
            f.runtime.transport.status().devices[0]!.providers.find(
              /** 参数拒绝及结果读取都不能复活已隔离的原 Herdr 配置。 */
              (provider) => provider.provider_id === 'herdr_snapshot'
            )!.ready,
            false
          )
        }
        const corrected = CallToolResultSchema.parse(
          await http.client.callTool({ name: 'runtime_call', arguments: { ...input, client_request_key } })
        )
        assert.equal(corrected.isError, undefined)
        const correctedId = (corrected.structuredContent!.data as { call_id: string }).call_id
        await until(
          /** 非法登记已回滚，其 key 未被坏请求占用；明确的新合法意图才发送。 */ () =>
            peer.requests.some(
              /** 对照真实收到的 call。 */ (request) => request.payload.attempt.call_id === correctedId
            )
        )
        assert.equal(f.writes(), before + 1)
        peer.reply(
          peer.requests.find(
            /** 按新意图原 call 回复。 */ (request) => request.payload.attempt.call_id === correctedId
          )!
        )
        await until(
          /** 后续合法请求仍沿原 epoch 正常完成。 */ () =>
            f.state.store.call('remote_reader', correctedId).state === 'responded'
        )
        assert.equal(f.runtime.transport.currentConnection(f.target.machine_id)!.connection_epoch, epoch)
        const oldRequest = { method: 'agent.wait', params: { target: '1', until: 'idle' } }
        const oldKey = 'legacy_unknown_bad_wait'
        const old = await f.runtime.runAuthenticated(
          { principal_id: 'remote_reader' },
          /** 人工构造旧版本已登记 unknown 的合成历史；只走原 Router/Store，不发送任何 Wire 或 native。 */ () => {
            const principal = f.runtime.principal()
            const admitted = f.runtime.router.admit(principal, f.target, oldRequest, {
              binding_revision: 1,
              contract_ref: input.contract_ref,
              deadline: input.deadline,
              client_request_key: oldKey
            })
            f.runtime.router.dispatch(principal, admitted.call.call_id, epoch)
            return f.state.store.stop(principal.id, admitted.call.call_id)
          }
        )
        assert.equal(old.state, 'outcome_unknown')
        const writes = f.writes()
        const repeated = CallToolResultSchema.parse(
          await http.client.callTool({
            name: 'runtime_call',
            arguments: {
              ...input,
              native_request: oldRequest,
              client_request_key: oldKey
            }
          })
        )
        assert.equal(repeated.isError, undefined)
        assert.equal((repeated.structuredContent!.data as { call_id: string }).call_id, old.call_id)
        assert.equal((repeated.structuredContent!.data as { state: string }).state, 'outcome_unknown')
        assert.equal(f.writes(), writes)
        assert.equal(f.runtime.transport.currentConnection(f.target.machine_id)!.connection_epoch, epoch)
      } finally {
        await http?.close()
        service?.close()
        await f.close()
      }
    }
  )
}

test(
  'remote Gateway starts without Luvus paths, waits for authenticated snapshot, and reads original Wire result',
  // 集成总预算覆盖真实认证、持久写与原结果读取；不改变产品编译、业务 deadline 或阶段等待上限。
  { timeout: 45_000 },
  /** 真实认证、目录、dispatch 与结果分页均复用生产 Gateway，合成 peer 明确只作为协议回归。 */ async () => {
    const f = await fixture()
    try {
      assert.equal(f.config.authentication, 'remote_connector')
      assert.equal('native' in f.config, false)
      const p = await f.peer()
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 快照到达前，设备已认证仍没有目录来源。 */ () => {
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
        }
      )
      assert.equal(f.runtime.transport.status().devices[0]?.ready, false)
      p.snapshot()
      await until(
        /** 当前认证 epoch 的有效快照接纳后才标 provider 就绪。 */ () =>
          f.runtime.transport.status().devices.some(/** 仅观察本轮唯一设备。 */ (device) => device.ready)
      )
      const ref = await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 使用既有目录实现发现、描述并取得实际契约引用。 */ () => {
          const resolved = f.runtime.catalog.resolve(f.target, f.runtime.principal())!
          assert(resolved)
          const catalog = createLuvusCatalog(resolved.record.compiled, resolved.record.capabilities, resolved.source, {
            now: Date.now,
            expires_at: resolved.expires_at,
            current: /** 每次读取都重验当前 caller、Store 与原真实 epoch。 */ () =>
              f.runtime.catalog.resolve(f.target, f.runtime.principal())!.source
          })
          assert(
            catalog
              .list({ query: 'pane.list' })
              .methods.some(/** 固定方法来自原能力视图。 */ (method) => method.method === 'pane.list')
          )
          assert.equal(catalog.describe('pane.list').schema_status, 'conditional_branch')
          return contractRef(resolved.record.wire.source)
        }
      )
      const admitted = await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 只对本次明确原请求准入一次。 */ () =>
          f.runtime.admit({
            target: f.target,
            native_request: { method: 'pane.list', params: { all_tabs: true } },
            options: { binding_revision: 1, contract_ref: ref, validation: 'strict', deadline: Date.now() + 30000 }
          })
      )
      assert.equal(admitted.created, true)
      await until(
        /** 原 Store 合规响应提交后才读取正文。 */ () =>
          f.state.store.call('remote_reader', admitted.call.call_id).state === 'responded'
      )
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 原结果句柄和原 Wire 读门禁必须交付完整未改写 native frame。 */ () => {
          const opened = f.runtime.results.open(admitted.call.call_id)
          const page = f.runtime.results.read(opened.result_id, 0, 4096)
          assert.equal(page.eof, true)
          assert.deepEqual(JSON.parse(Buffer.from(page.data, 'base64').toString()).result, { panes: [] })
        }
      )
      assert.equal(f.writes(), 1)
      p.socket.close()
      await until(
        /** 旧实际通道移除后目录不得继续返回快照来源。 */ () =>
          !f.runtime.transport.currentConnection(f.target.machine_id)
      )
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 失效旧 epoch 不从 pin 自动恢复 live 目录。 */ () =>
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
      )
    } finally {
      await f.close()
    }
  }
)

test(
  'remote Gateway loses old epoch on rebind and keeps unanswered dispatch unknown without replay',
  // 两次真实认证与持久状态门禁在 strace 下需要独立测试总预算，不能误用 Bun 默认五秒。
  { timeout: 45_000 },
  /** 断连后重新认证也不迁移 snapshot 或自动重派原请求；canonical重绑同步阻止目录。 */ async () => {
    const f = await fixture()
    try {
      const p = await f.peer()
      p.snapshot()
      await until(
        /** 等待原认证快照完成。 */ () =>
          f.runtime.transport.status().devices.some(/** 观察固定设备就绪。 */ (device) => device.ready)
      )
      f.hold()
      const admitted = await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 原 call 只派发一次，合成对端故意不回响应。 */ () =>
          f.runtime.admit({
            target: f.target,
            native_request: { method: 'pane.list', params: {} },
            options: {
              binding_revision: 1,
              contract_ref: contractRef(f.snapshot.source),
              validation: 'strict',
              deadline: Date.now() + 30000
            }
          })
      )
      await until(/** 对端已收到原 request，不能再声称确定未执行。 */ () => f.writes() === 1)
      p.socket.close()
      await until(
        /** 原断连处理把可能执行的调用固定为 unknown。 */ () =>
          f.state.store.call('remote_reader', admitted.call.call_id).state === 'outcome_unknown'
      )
      const next = await f.peer()
      assert.notEqual(next.connection.connection_epoch, p.connection.connection_epoch)
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 新连接没有继承旧快照。 */ () =>
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
      )
      next.snapshot()
      await until(
        /** 新 epoch 独立接纳自己的快照。 */ () =>
          f.runtime.transport.status().devices.some(/** 只检查实际设备。 */ (device) => device.ready)
      )
      assert.equal(f.writes(), 1)
      assert.equal(f.state.store.call('remote_reader', admitted.call.call_id).state, 'outcome_unknown')
      f.state.store.setProviderEnabled(f.target.machine_id, f.target.provider_id, 1, false)
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 当前canonical binding已变，旧pin/live来源不能继续使用。 */ () =>
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
      )
      assert.equal(f.writes(), 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'provider host carries current terminal state to real SDK discovery for Luvus and Herdr',
  { timeout: 45_000 },
  /** 真实角色、认证 Wire、双原生目录与 SDK；安装来源和执行端口为明确合成 fixture，不执行终端命令。 */ async () => {
    const f = await fixture({ mixed: true, isolated: true })
    let connector: Awaited<ReturnType<typeof createProviderConnectorRuntime>> | undefined
    let service: RuntimeGatewayService | undefined
    let http: ReturnType<typeof httpFixture> | undefined
    let enabled = true
    let nativeRequests = 0
    let observations = 0
    const hosted = f.herdr!.providers[0]!
    const routes = [f.snapshot, hosted]
    const methods = ['pane.run', 'pane.send_text']
    const snapshots = structuredClone([f.snapshot])
    /** 快照沿用生产固定深冻结要求，测试只更改独立布尔观察，不替换来源。 */
    function freeze(value: unknown): void {
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
          freeze(item)
        }
        Object.freeze(value)
      }
    }
    freeze(snapshots)
    try {
      connector = await createProviderConnectorRuntime({
        provider_snapshot: true,
        transport: {
          url: f.runtime.transport.url,
          developmentLoopback: true,
          offer: {
            major: 2,
            minor: 0,
            capabilities: ['rpc', 'provider_fence', 'terminal_execution_state'],
            required: ['rpc', 'provider_fence']
          },
          credential: /** 只用本例临时状态中的合成身份。 */ () => f.credential
        },
        session: /** 实际生产中性 owner 包装同样的多 provider 原会话，不能绕过该层测试 getter。 */ (connection) =>
          composeConnectorSessions(
            connection,
            routes.map(
              /** 各原目录保持自己的完整 binding，布尔值不生成能力或执行许可。 */ (route, index) => {
                const current: ConnectorWireSession = {
                  ...snapshotSession(connection, route),
                  /** 只有本例来源 getter 可以报告对应原配置，且保留原方法接收对象。 */
                  terminalExecutionState() {
                    assert.equal(this, current)
                    observations++
                    return [{ binding: route.binding, enabled }]
                  },
                  /** 本例不得调用 native，意外派发始终拒绝而非返回合成成功。 */
                  async executeWire() {
                    nativeRequests++
                    throw new Error('terminal_catalog_native_unavailable')
                  },
                  ...(index === 0 ? { providerSnapshot: /** 原 Luvus 来源仅发布既有非空快照。 */ () => snapshots } : {})
                }
                return { providers: [route], session: current }
              }
            ),
            Date.now
          ),
        release: /** 只释放本测试创建的长期角色资源。 */ async () => {}
      })
      await until(
        /** 原角色确认两端目录来源已就绪，不能用设备认证代替实际快照接纳。 */ () =>
          f.runtime.transport
            .status()
            .devices[0]?.providers.every(/** 两个原 provider 都必须独立 ready。 */ (provider) => provider.ready) ===
          true
      )
      await until(
        /** welcome 后的元数据必须实际到达 Gateway，readiness 不能替代开关观察。 */ () =>
          routes.every(
            /** 每个 provider 都必须收到自己的开启状态。 */ (route) =>
              f.runtime.terminalExecutionState(route.binding) === true
          )
      )
      for (const route of routes) {
        assert.equal(f.runtime.terminalExecutionState(route.binding), true)
      }
      const epoch = connector.transport.status().connection_epoch
      service = new RuntimeGatewayService({
        runtime: f.runtime,
        identities: {
          principal: /** 与实际 runtime 使用同一合成 caller 和政策，不从参数取得身份。 */ (caller) =>
            caller.principal_id === 'remote_reader' ? { id: 'remote_reader' } : null,
          administrator: /** 本例没有管理员会话。 */ () => null
        },
        catalog: {
          kind: 'mixed',
          select: /** 委托两种真实原生目录，不自造描述或参数 schema。 */ (target) =>
            target.provider_id === hosted.binding.provider_id ? f.herdr!.catalog : f.catalog
        }
      })
      http = httpFixture(service, {
        authentication: {
          authenticate: /** 仅本例私有 HTTP listener 的测试身份。 */ () => ({ principal_id: 'remote_reader' })
        }
      })
      await http.client.connect(http.transport, { timeout: 5000 })
      for (const [index, route] of routes.entries()) {
        const page = await http.client.callTool(
          {
            name: 'runtime_discover',
            arguments: {
              target: route.target,
              expected_binding_revision: 1,
              limit: 100
            }
          },
          CallToolResultSchema,
          { timeout: 5000 }
        )
        assert.equal(page.isError, undefined)
        const data: { items: { method: string }[] } = (
          page.structuredContent as { data: { items: { method: string }[] } }
        ).data
        assert(
          data.items.some(/** 开启时相应直接输入必须在真实 MCP 目录出现。 */ (item) => item.method === methods[index])
        )
        const description = await http.client.callTool(
          {
            name: 'runtime_describe',
            arguments: {
              target: route.target,
              expected_binding_revision: 1,
              method: methods[index]!
            }
          },
          CallToolResultSchema,
          { timeout: 5000 }
        )
        assert.equal(description.isError, undefined)
        assert.deepEqual(
          (description.structuredContent as { data: { terminal_execution: object } }).data.terminal_execution,
          { local_state: 'enabled' }
        )
      }
      const first = await http.client.callTool(
        {
          name: 'runtime_discover',
          arguments: {
            target: f.target,
            expected_binding_revision: 1,
            limit: 1
          }
        },
        CallToolResultSchema,
        { timeout: 5000 }
      )
      const cursor = (first.structuredContent as { data: { next_cursor?: string } }).data.next_cursor
      assert(cursor)
      enabled = false
      await until(
        /** 本机当前值改变后原连接发布关闭观察，不换 epoch。 */ () =>
          routes.every(
            /** 独立核对两个原 binding 的实际观察值。 */ (route) =>
              f.runtime.terminalExecutionState(route.binding) === false
          )
      )
      for (const [index, route] of routes.entries()) {
        const page = await http.client.callTool(
          {
            name: 'runtime_discover',
            arguments: {
              target: route.target,
              expected_binding_revision: 1,
              limit: 100
            }
          },
          CallToolResultSchema,
          { timeout: 5000 }
        )
        assert.equal(page.isError, undefined)
        assert(
          !(page.structuredContent as { data: { items: { method: string }[] } }).data.items.some(
            /** 关闭仍只隐藏该实例直接输入，不能沿用开启时的目录结果。 */ (item) => item.method === methods[index]
          )
        )
      }
      const stale = await http.client.callTool(
        {
          name: 'runtime_discover',
          arguments: {
            target: f.target,
            expected_binding_revision: 1,
            limit: 1,
            cursor
          }
        },
        CallToolResultSchema,
        { timeout: 5000 }
      )
      assert.deepEqual(stale.structuredContent, { gateway_error: { code: 'invalid_cursor' } })
      assert.equal(connector.transport.status().connection_epoch, epoch)
      assert(observations >= 4)
      assert.equal(nativeRequests, 0)
      await connector.close()
      await until(
        /** 实际认证连接关闭后不能保留上一 epoch 的本机开关。 */ () =>
          f.runtime.transport.currentConnection(f.target.machine_id) === undefined
      )
      for (const route of routes) {
        assert.equal(f.runtime.terminalExecutionState(route.binding), undefined)
      }
    } finally {
      try {
        await http?.close()
      } finally {
        service?.close()
        try {
          await connector?.close()
        } finally {
          await f.close()
        }
      }
    }
  }
)
