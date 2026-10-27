/** 生产 Herdr 资源工厂的组件回归；真实 Store/编译器/通道由合成身份驱动，不计 native 安装证据。 */
import assert from 'node:assert/strict'
import { phaseTiming } from '../../support/phase-timing.js'
import { HERDR_COMPILE_TIMEOUT } from '../../../src/connector/herdr/compiler-protocol.js'
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createHerdrConnectorResources,
  createHerdrGatewayResources,
  parseHerdrProviderRefConfig,
  readHerdrProviderRefConfig
} from '../../../src/connector/herdr/provider.js'
import { createHerdrGatewaySourceOwner, isAuthenticatedHerdrSource } from '../../../src/connector/herdr/source.js'
import { createHerdrReadonlyAdapter } from '../../../src/connector/herdr/readonly.js'
import { ChannelRegistry } from '../../../src/transport/index.js'
import type { Connection } from '../../../src/transport/index.js'
import { Store } from '../../../src/store.js'
import { Router } from '../../../src/router.js'
import { boundedJson, contractRef } from '../../../src/wire/index.js'
import type { JsonObject, ProviderBinding } from '../../../src/wire/types.js'
import { backendFixture, fixture, raw, source } from './helpers.js'
import { privateHerdrTestRoot } from './private-root.js'
import { connected, management, responseFrame } from '../../storage/helpers.js'

/** 配置只含当前工厂要求的公开 pin 与受保护路径，不创建私有凭据或进程。 */
function config(root: string) {
  const target = { machine_id: 'owned-machine', provider_id: 'herdr', profile: 'session' as const, session: 'owned' }
  const shared = {
    version: 1,
    target,
    binding_revision: 1,
    config_ref: 'owned-herdr',
    expected_source: { ...source },
    schema_path: join(root, 'schema.json')
  }
  return {
    ...shared,
    connector: {
      principal_id: 'principal1',
      local: {
        target,
        binding_revision: 1,
        config_ref: 'owned-herdr',
        binary: join(root, 'herdr'),
        home: join(root, 'home'),
        config_home: join(root, 'config'),
        state_home: join(root, 'state'),
        cache_home: join(root, 'cache'),
        temporary_home: join(root, 'temporary'),
        cwd: join(root, 'cwd')
      },
      claims: {
        path: join(root, 'claims', 'claims.sqlite'),
        mode: 'open',
        ledger_id: 'owned_claims',
        limits: { entries: 256, bytes: 1_048_576 }
      }
    }
  }
}

test(
  'public Herdr ref parser pins complete tuples and leaves filesystem and native ownership to factories',
  /** 配置归一化不启动进程或新 writer，也不把配置字符串变成来源证明。 */ () => {
    const input = config('/workspace/synthetic-herdr-ref')
    const parsed = parseHerdrProviderRefConfig(input)
    const local = {
      ...input.connector.local,
      agent_bin_dirs: ['/home/synthetic/Agent Tools/bin'],
      allow_terminal_execution: false
    }
    const installed = parseHerdrProviderRefConfig({ ...input, connector: { ...input.connector, local } }).connector!
      .local
    assert.deepEqual(installed.agent_bin_dirs, local.agent_bin_dirs)
    assert.equal(installed.allow_terminal_execution, false)
    assert.throws(
      /** 受保护 ref 不能把非规范安装目录传入 native 环境。 */ () =>
        parseHerdrProviderRefConfig({
          ...input,
          connector: { ...input.connector, local: { ...local, agent_bin_dirs: ['relative/bin'] } }
        }),
      /agent_bin_dirs_invalid/
    )
    for (const enabled of [true, false]) {
      const local = { ...input.connector.local, allow_terminal_execution: enabled }
      assert.equal(
        parseHerdrProviderRefConfig({ ...input, connector: { ...input.connector, local } }).connector!.local
          .allow_terminal_execution,
        enabled
      )
    }
    assert.throws(
      /** 本地开关必须是布尔值，不把字符串转成执行许可。 */ () =>
        parseHerdrProviderRefConfig({
          ...input,
          connector: { ...input.connector, local: { ...input.connector.local, allow_terminal_execution: 'true' } }
        }),
      /terminal_execution_config_invalid/
    )
    assert.equal(parsed.connector!.claims.mode, 'open')
    input.expected_source.server_version = 'mutated'
    assert.equal(parsed.expected_source.server_version, '0.9.5')
    const clean = config('/workspace/synthetic-herdr-ref')
    for (const patch of [
      { version: 2 },
      { config_ref: '' },
      { schema_path: 'relative/schema.json' },
      { extra: true },
      { target: { machine_id: 'owned-machine', provider_id: 'herdr', profile: 'host' } },
      { connector: { ...clean.connector, local: { ...clean.connector.local, binding_revision: 2 } } },
      { connector: { ...clean.connector, claims: { ...clean.connector.claims, mode: 'automatic' } } }
    ]) {
      assert.throws(
        /** 任何漂移都不能变成等价本机配置或来源 pin。 */ () => parseHerdrProviderRefConfig({ ...clean, ...patch })
      )
    }
  }
)

test(
  'ref loader reads ordinary JSON and Gateway compilation refuses changed schema bytes',
  /** 只创建本测试自有配置和官方公开 schema 文件；没有 socket 或 native 命令。 */ async () => {
    const root = privateHerdrTestRoot('.herdr-provider-ref-')
    const input = config(root)
    const file = join(root, 'ref.json')
    try {
      writeFileSync(file, JSON.stringify(input), { mode: 0o600 })
      assert.deepEqual(readHerdrProviderRefConfig(file), parseHerdrProviderRefConfig(input))
      chmodSync(file, 0o644)
      assert.deepEqual(readHerdrProviderRefConfig(file), parseHerdrProviderRefConfig(input))
      chmodSync(file, 0o600)
      writeFileSync(input.schema_path, Buffer.concat([raw, Buffer.from(' ')]), { mode: 0o600 })
      await assert.rejects(createHerdrGatewayResources({ config: input }), /herdr_schema_unreviewed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'authenticated Connector source branding rejects invented objects and permanently fences epoch, close and revision drift',
  /** 使用真实通道注册表的合成认证上下文测试品牌机制，不冒充远端 native 测量。 */ () => {
    const state = backendFixture()
    const connection = state.context.connection
    const registry = new ChannelRegistry()
    const channel = registry.open({}, /** 合成 socket 关闭不触碰任何真实设备。 */ () => {})
    channel.bind(connection)
    let revision = 1
    const owner = createHerdrGatewaySourceOwner({
      channel,
      connection,
      target: state.binding.target,
      binding_revision: 1,
      contract_ref: state.binding.contract_ref,
      assertCurrent: /** 受保护本地绑定变更会永久撤销原 owner。 */ () => {
        if (revision !== 1) {
          throw new Error('synthetic_binding_changed')
        }
      }
    })
    const branded = owner.source(state.binding)!
    assert.equal(branded.role, 'authenticated_connector')
    assert.equal(isAuthenticatedHerdrSource(branded), true)
    assert.equal(isAuthenticatedHerdrSource({ ...branded }), false)
    assert.equal(owner.source({ ...state.binding, binding_revision: 2 }), undefined)
    revision = 2
    assert.equal(isAuthenticatedHerdrSource(branded), false)
    revision = 1
    assert.equal(isAuthenticatedHerdrSource(branded), false)
    channel.close()
    const next = registry.open({}, /** 新 socket 只是此组件独立的下一 epoch。 */ () => {})
    const current: Connection = { ...connection, connection_epoch: 'next-epoch' }
    next.bind(current)
    const replacement = createHerdrGatewaySourceOwner({
      channel: next,
      connection: current,
      target: state.binding.target,
      binding_revision: 1,
      contract_ref: state.binding.contract_ref,
      assertCurrent: /** 本轮配置固定有效，失效由真实通道关闭触发。 */ () => {}
    })
    const proof = replacement.source({ ...state.binding, connection_epoch: 'next-epoch' })!
    assert.equal(isAuthenticatedHerdrSource(proof), true)
    assert.throws(
      /** 新 epoch 不接受旧完整 binding。 */ () => replacement.source(state.binding),
      /attempt_binding_mismatch/
    )
    replacement.close()
    assert.equal(isAuthenticatedHerdrSource(proof), false)
    next.close()
    state.backend.nativeSource = /** 调用方自造 role/token 不能伪装成 Gateway 内部品牌。 */ () => ({
      role: 'authenticated_connector',
      binding: state.binding,
      token: {}
    })
    const core = createHerdrReadonlyAdapter(state.backend)
    try {
      assert.throws(
        /** 真实 core 在创建 permit 之前拒绝未发行品牌。 */ () => core.resolve(state.identity),
        /native_source_untrusted/
      )
    } finally {
      core.close()
    }
  }
)

test(
  'production Gateway resources use the real Store and Wire while keeping remote provenance distinct',
  // 编译自身最多10秒，外层不能在5秒先结束并把仍在途的共享 Worker 留给下一例。
  { timeout: HERDR_COMPILE_TIMEOUT + 5000 },
  /** 合成身份只用于当前认证通道；真正的 Store/compiled schema/普通 RPC 提交仍走生产资源工厂。 */ async () => {
    const root = privateHerdrTestRoot('.herdr-provider-gateway-')
    mkdirSync(join(root, 'store'), { mode: 0o700 })
    const store = new Store(join(root, 'store', 'gateway.sqlite'), /** 本测试可信时钟固定不回拨。 */ () => 100, {
      management
    })
    const device = connected(store)
    const input = config(root)
    input.target.machine_id = device.machine_id
    writeFileSync(input.schema_path, raw, { mode: 0o600 })
    let catalogTime = 100
    let resources: Awaited<ReturnType<typeof createHerdrGatewayResources>>
    try {
      resources = await phaseTiming('herdr.gateway.production.compile', () =>
        createHerdrGatewayResources({
          config: input,
          now: /** 目录视图时钟不影响 Store 原截止。 */ () => catalogTime
        })
      )
    } catch (error) {
      store.close()
      rmSync(root, { recursive: true, force: true })
      throw error
    }
    const expected = resources.providers[0]!.binding
    store.defineProvider(expected)
    const policy: ProviderPolicies = {
      caller: {
        revision: 'caller1',
        grants: [{ target: input.target, methods: ['ping'], actions: ['dispatch', 'read'] }]
      },
      local: {
        revision: 'local1',
        grants: [{ target: input.target, methods: ['ping'], actions: ['dispatch', 'read'] }]
      }
    }
    const value = store.createCall(
      'principal1',
      input.target,
      { method: 'ping', params: {} },
      {
        binding_revision: 1,
        contract_ref: contractRef(source),
        timeoutMs: 100
      }
    )
    const binding = store.dispatch('principal1', value.call_id, device.epoch)
    const registry = new ChannelRegistry()
    const channel = registry.open({}, /** 组件 socket 关闭由原 registry 所有。 */ () => {})
    const connection: Connection = {
      machine_id: device.machine_id,
      connection_epoch: device.epoch,
      recovery_generation: store.generation(),
      authenticated: true,
      active: true,
      negotiated: { major: 2, minor: 0, capabilities: ['rpc'] }
    }
    channel.bind(connection)
    let local: ProviderBinding = { ...expected }
    const session = resources.session(connection, channel, {
      store,
      router: new Router(store),
      localProvider: /** 与唯一 Store 独立的固定本机配置，可验证 revision 漂移。 */ () => local,
      currentPrincipal: /** 组件原读者由宿主提供，不能由 Wire 参数覆盖。 */ () => 'principal1'
    })
    channel.attach(session)
    try {
      assert.equal(resources.kind, 'provider')
      const described = resources.describe()
      assert.equal(described.source_basis, 'configured_connector_contract')
      assert.equal(described.methods.length, 65)
      assert.equal('schemas' in described, false)
      const principal = { id: 'principal1', policy: policy.caller }
      const catalog = resources.catalog.resolve(input.target, principal)!
      assert.equal(catalog.expires_at, 5100)
      assert.deepEqual(catalog.local_provider, expected)
      assert.equal(catalog.contract_ref, contractRef(source))
      assert(catalog.methods.some((entry) => entry.method === 'ping'))
      assert(catalog.methods.some((entry) => entry.method === 'pane.list'))
      assert.equal(catalog.methods[0]!.params_schema, undefined)
      assert.equal((catalog.methods[0]!.limits as JsonObject).response_frame_bytes, 65_536)
      assert.equal((catalog.describe('ping').limits as JsonObject).response_pagination, 'unavailable')
      assert.equal(typeof catalog.describe('ping').params_schema, 'object')
      assert.equal(catalog.describe('agent.prompt').method, 'agent.prompt')
      assert.equal(resources.catalog.resolve({ ...input.target, session: 'another' }, principal), undefined)
      policy.caller.grants = []
      assert.equal(resources.catalog.resolve(input.target, principal)!.describe('agent.list').method, 'agent.list')
      assert.equal(catalog.describe('ping').method, 'ping')
      assert.equal(Object.hasOwn(catalog.methods[0]!, 'caller_actions'), false)
      catalogTime = 5100
      assert.throws(
        /** 五秒目录视图到期需要重新 resolve，不延长实际调用期限。 */ () => catalog.describe('ping'),
        /catalog_view_expired/
      )
      assert.equal('executeWire' in session, false)
      const frame = responseFrame(binding, { result: fixture().response.result })
      const request = {
        ...frame,
        type: 'request' as const,
        message_id: 'gateway-request',
        payload: {
          attempt: frame.payload.attempt,
          expected_binding_revision: 1,
          native_request: { method: 'ping', params: {} },
          validation: 'strict' as const
        }
      }
      const rawRequest = session.adapter.encode(request, 'gateway_to_connector')
      assert.deepEqual(session.adapter.decode(rawRequest, 'gateway_to_connector'), request)
      const rawResponse = session.adapter.encode(frame, 'connector_to_gateway')
      assert.deepEqual(session.adapter.decode(rawResponse, 'connector_to_gateway'), frame)
      const result = store.commitEvidence(
        binding,
        /** 同一原 Store 事务内取得原 Wire 证据。 */ () => session.adapter.planEvidence(frame)
      )
      assert.equal(result.state, 'responded')
      assert.deepEqual(JSON.parse(result.response!), frame.payload.native_response)
      local = { ...local, binding_revision: 2 }
      assert.throws(
        /** revision 漂移立即撤销此认证通道来源。 */ () => session.adapter.decode(rawResponse, 'connector_to_gateway'),
        /provider_binding_mismatch|native_source_untrusted/
      )
      local = { ...expected }
      assert.throws(
        /** 恢复旧配置也不复活已 fence 的 token。 */ () => session.adapter.decode(rawResponse, 'connector_to_gateway'),
        /native_source_untrusted/
      )
      const replacement = join(root, 'replacement.json')
      writeFileSync(replacement, raw, { mode: 0o600 })
      renameSync(replacement, input.schema_path)
      assert.equal(resources.providers[0]!.ready(), true)
      assert.throws(
        /** 文件变化不复活已被网络代次隔离的旧token。 */ () =>
          session.adapter.decode(rawResponse, 'connector_to_gateway'),
        /native_source_untrusted/
      )
      await resources.release()
      assert.equal(session.adapter.stats().closed, true)
      assert.equal(store.health().mode, 'active')
    } finally {
      channel.close()
      await resources.release()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'Connector production resources require an actual installation before opening independent writers',
  /** 普通对象不能冒充安装 owner；配置错误不启动进程、不消费释放 owner 或创建 receipt/claim 文件。 */ async () => {
    const root = privateHerdrTestRoot('.herdr-provider-connector-')
    let released = 0
    try {
      const input = config(root)
      await assert.rejects(
        createHerdrConnectorResources({
          config: input,
          installation: JSON.parse('{}'),
          now: Date.now,
          releaseOwner: /** 未交付合法安装时资源 ownership 保持在原调用者。 */ async () => {
            released++
          }
        }),
        /herdr_connector_owner_required/
      )
      assert.equal(released, 0)
      assert.deepEqual(readdirSync(root), [])
      assert.equal(boundedJson(parseHerdrProviderRefConfig(input).target), boundedJson(input.target))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

import type { ProviderPolicies } from '../../legacy-policy.js'
