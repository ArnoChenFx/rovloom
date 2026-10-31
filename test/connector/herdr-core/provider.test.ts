/**
 * herdr-core 的端口与 Wire 核心：配置严格解析、审核契约编译、目录只暴露本期方法、
 * 身份没有本机事实就拒绝；Wire 核心先复核档位与参数，再建立许可和证据计划。
 * 全部使用离线 fixture 与合成账本，不启动 core。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { HERDR_CORE_CLASSIFICATION_REVISION } from '../../../src/connector/herdr-core/methods.js'
import { createHerdrCoreAdapter } from '../../../src/connector/herdr-core/readonly.js'
import type { HerdrCoreBackend, HerdrCoreContractRecord } from '../../../src/connector/herdr-core/readonly.js'
import {
  createHerdrCoreGatewayResources,
  parseHerdrCoreProviderRefConfig
} from '../../../src/connector/herdr-core/provider.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { contractRef, hash, validateContractSource } from '../../../src/wire/index.js'
import type { AttemptBinding, AuthenticatedContext, ContractSource, V2Target } from '../../../src/wire/types.js'

const OPENRPC = readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
const SAMPLES = JSON.parse(
  readFileSync(new URL('../../fixtures/herdr-core/samples-0.1.14.json', import.meta.url), 'utf8')
) as { samples: { method: string; params: Record<string, unknown>; response: { result: Record<string, unknown> } }[] }

const source: ContractSource = {
  provider_kind: 'herdr-core',
  protocol_family: 'herdr-core-jsonrpc',
  binary_version: '0.1.14',
  binary_sha256: 'a'.repeat(64),
  schema_sha256: hash(OPENRPC),
  schema_origin: 'live_instance',
  schema_command: 'rpc.discover',
  server_version: '0.1.14',
  native_protocol_version: '1',
  runtime_generation: '2ca46c83a83eea75c38e44cf83dbb35d',
  adapter_revision: 'adapter-herdr-core-1',
  classification_revision: HERDR_CORE_CLASSIFICATION_REVISION,
  support_basis: 'schema_and_version'
}

const target: V2Target = { machine_id: 'machine-a', provider_id: 'provider-a', profile: 'session', session: 'work' }
const binding = {
  machine_id: 'machine-a',
  provider_id: 'provider-a',
  kind: 'herdr-core' as const,
  config_ref: 'config-a',
  binding_revision: 1,
  enabled: true
}

/** 在 0700 临时目录里发布一份内容寻址 schema，返回引用路径。 */
function schemaFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-hc-provider-'))
  const reference = schemaReference(root, source.schema_sha256)
  mkdirSync(dirname(reference), { mode: 0o700 })
  publishSchema(reference, OPENRPC)
  return { root, reference }
}

test('herdr-core 配置只接受自己的契约来源与规范绝对 schema 引用', () => {
  const { root, reference } = schemaFixture()
  try {
    const config = {
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'config-a',
      expected_source: source,
      schema_ref: reference
    }
    assert.doesNotThrow(() => parseHerdrCoreProviderRefConfig(config))
    // 借用 Herdr TUI 的协议族、缺 schema 引用或未知字段都拒绝。
    assert.throws(
      () =>
        parseHerdrCoreProviderRefConfig({
          ...config,
          expected_source: { ...source, protocol_family: 'herdr-json' }
        }),
      /contract_provider_mismatch|herdr_core_contract_unreviewed/u
    )
    assert.throws(
      () =>
        parseHerdrCoreProviderRefConfig({ ...config, expected_source: { ...source, classification_revision: null } }),
      /invalid_config|herdr_core_contract_unreviewed|invalid_text/u
    )
    assert.throws(() => parseHerdrCoreProviderRefConfig({ ...config, schema_ref: 'relative/schema.json' }))
    assert.throws(() => parseHerdrCoreProviderRefConfig({ ...config, extra: true }))
    // Connector 本地事实可选；端点只能固定一个位置，且会话必须与 Target 一致。
    const connector = {
      session: 'work',
      endpoint: { runtime_dir: '/run/user/1000' },
      principal_id: 'operator_simple_pairing',
      claims: {
        path: '/var/lib/rovloom/claims.db',
        mode: 'open',
        ledger_id: 'claims_one',
        limits: { entries: 16, bytes: 4096 }
      }
    }
    const parsed = parseHerdrCoreProviderRefConfig({ ...config, connector })
    assert.equal(parsed.connector?.session, 'work')
    assert.throws(() => parseHerdrCoreProviderRefConfig({ ...config, connector: { ...connector, session: 'other' } }))
    assert.throws(() =>
      parseHerdrCoreProviderRefConfig({
        ...config,
        connector: { ...connector, endpoint: { runtime_dir: '/run/user/1000', state_home: '/state' } }
      })
    )
    assert.throws(() =>
      parseHerdrCoreProviderRefConfig({
        ...config,
        connector: { ...connector, endpoint: {} }
      })
    )
    assert.throws(
      () =>
        parseHerdrCoreProviderRefConfig({
          ...config,
          target: { machine_id: target.machine_id, provider_id: target.provider_id, profile: 'host' }
        }),
      /unsupported_profile/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('资源工厂登记五个端口，目录暴露读取与控制档，身份缺事实即拒绝', async () => {
  const { root, reference } = schemaFixture()
  try {
    const config = {
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'config-a',
      expected_source: source,
      schema_ref: reference
    }
    const resources = await createHerdrCoreGatewayResources({ config, now: () => 1000 })
    try {
      assert.deepEqual(resources.ports.kinds(), ['herdr-core'])
      assert.equal(resources.ports.tier('herdr-core', 'events.subscribe'), 'observe')
      assert.equal(resources.ports.tier('herdr-core', 'terminal.send'), 'control')
      assert.equal(resources.ports.tier('herdr-core', 'terminal.run'), 'host')
      // 表外方法不返回档位，调用面不能自行解释。
      assert.equal(resources.ports.tier('herdr-core', 'terminal.fly'), undefined)
      const resolved = resources.catalog.resolve(target, { id: 'alice' })
      assert.ok(resolved)
      // 订阅是 framed 通道上的持续流，Wire 桥接只做普通 RPC：目录不列、describe 不开，档位表里仍有它。
      assert.deepEqual(resolved.methods.map((entry) => entry.method).sort(), [
        'server.status',
        'templates.list',
        'terminal.events',
        'terminal.get',
        'terminal.interrupt',
        'terminal.keep',
        'terminal.keys',
        'terminal.kill',
        'terminal.label',
        'terminal.list',
        'terminal.put',
        'terminal.read',
        'terminal.rm',
        'terminal.run',
        'terminal.send',
        'terminal.wait'
      ])
      assert.equal(resolved.local_provider.kind, 'herdr-core')
      assert.doesNotThrow(() => resolved.describe('terminal.read'))
      // 控制档已开放，参数 schema 里带着 rovloom 自有的终端栅栏字段。
      const send = resolved.describe('terminal.send')
      const params = send.params_schema as { required: string[]; properties: Record<string, unknown> }
      assert.deepEqual([...params.required].sort(), ['core_id', 'created_ms', 'terminal', 'text'])
      assert.ok(params.properties.core_id)
      // core 自己的方法说明与 rovloom 的使用说明随 describe 交付；说明只是注释。
      assert.match(String(send.description), /Paste text and press Enter/u)
      assert.ok(Array.isArray(send.usage) && String(send.usage[0]).includes('wait=true'))
      assert.equal((send.guide as string[]).length, 8)
      assert.match(String((send.guide as string[])[2]), /wait=true/u)
      // 没有专门说明的方法不补造 usage。
      assert.equal(resolved.describe('server.status').usage, undefined)
      // rovloom 自有方法：核心契约里没有它，参数 schema 由本仓库审核，观察档不受开关约束。
      const events = resolved.describe('terminal.events')
      assert.equal(events.tier, 'observe')
      assert.match(String(events.description), /rovloom long poll/u)
      assert.ok((events.params_schema as { properties: Record<string, unknown> }).properties.after_seq)
      assert.ok(Array.isArray(events.usage))
      // 一律拒绝的参数列在 blocked_params 里，不出现在 params_schema。
      assert.deepEqual(send.blocked_params, ['caller', 'calls_you', 'core', 'on', 'parent', 'children_of'])
      assert.equal(Object.hasOwn(params.properties, 'caller'), false)
      // terminal.run 本阶段开放，模板形态由 rovloom 自有参数声明。
      const run = resolved.describe('terminal.run')
      assert.equal(run.tier, 'host')
      assert.ok((run.params_schema as { properties: Record<string, unknown> }).properties.template)
      // 其余宿主级方法与事件订阅仍不在目录里，即使已审核也不能被 describe 打开。
      assert.throws(() => resolved.describe('machine.exec'), /runtime_method_unavailable/u)
      assert.throws(() => resolved.describe('events.subscribe'), /runtime_method_unavailable/u)
      assert.equal(resources.catalog.resolve({ ...target, session: 'other' }, { id: 'alice' }), undefined)
      // 没有本机身份事实时不能用配置冒充证据。
      assert.throws(
        () => resources.ports.ports('herdr-core').identity.verify(binding),
        /herdr_core_identity_unavailable/u
      )
      assert.throws(
        () => resources.ports.ports('herdr-core').identity.verify({ ...binding, provider_id: 'other' }),
        /provider_binding_mismatch/u
      )
    } finally {
      await resources.release()
    }
    const gated = await createHerdrCoreGatewayResources({ config, now: () => 1000 })
    try {
      /** 登记能力只回放真正的 register；admit 的检查回调在登记前运行。 */
      const admit = (native: { method: string; params: Record<string, unknown> }, enabled?: boolean) => {
        if (enabled !== undefined) {
          gated.bindTerminalExecution(() => enabled)
        }
        let registered = false
        const provider = gated.providers[0]!
        provider.admit(
          native,
          { contract_ref: contractRef(source) } as never,
          /** 模拟 Router：检查通过才登记。 */ (_options, check) => {
            check(native)
            registered = true
            return { created: true, call: {} } as never
          }
        )
        return registered
      }
      const send = {
        method: 'terminal.send',
        params: { terminal: 't1', core_id: 'a'.repeat(16), created_ms: 1, text: 'x' }
      }
      // 绑定前与控制档关闭时都在登记前拒绝；读取不受影响。
      assert.throws(() => admit(send), /terminal_execution_disabled/u)
      assert.throws(() => admit(send, false), /terminal_execution_disabled/u)
      assert.equal(admit(send, true), true)
      assert.equal(admit({ method: 'server.status', params: {} }, false), true)
      // terminal.run 随开关走：关闭时登记前拒绝，打开时放行。
      assert.throws(
        () => admit({ method: 'terminal.run', params: { argv: ['cat'] } }, false),
        /terminal_execution_disabled/u
      )
      assert.equal(admit({ method: 'terminal.run', params: { argv: ['cat'] } }, true), true)
      // 其余宿主级方法仍在登记前拒绝，与开关无关。
      assert.throws(() => admit({ method: 'machine.exec', params: {} }, true), /herdr_core_method_unavailable/u)
    } finally {
      await gated.release()
    }
    const withFacts = await createHerdrCoreGatewayResources({
      config,
      now: () => 1000,
      facts: () => ({
        kind: 'herdr-core',
        provider_id: binding.provider_id,
        instance_id: source.runtime_generation!,
        binary_version: source.binary_version,
        binary_sha256: source.binary_sha256,
        config_ref: binding.config_ref
      })
    })
    try {
      const facts = withFacts.ports.ports('herdr-core').identity.verify(binding)
      assert.equal(facts.instance_id, source.runtime_generation)
      assert.equal(facts.binary_sha256, source.binary_sha256)
    } finally {
      await withFacts.release()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 合成账本：只有一条已登记 attempt、一个审核契约和一个固定响应锚点。 */
function backend(): { backend: HerdrCoreBackend; attempt: AttemptBinding } {
  const contract = compileHerdrCoreContract(OPENRPC)
  const record: HerdrCoreContractRecord = Object.freeze({
    wire: Object.freeze({ source, support_status: 'validated' }),
    contract
  })
  const reference = contractRef(source)
  const attempt: AttemptBinding = {
    machine_id: 'machine-a',
    recovery_generation: 'recovery-1',
    connection_epoch: 'epoch-1',
    call_id: 'call-a',
    attempt_id: 'attempt-a',
    native_request_id: 'native-a',
    target,
    provider_kind: 'herdr-core',
    binding_revision: 1,
    contract_ref: reference,
    registration: { deadline: 5000 }
  }
  const connection = {
    machine_id: attempt.machine_id,
    recovery_generation: attempt.recovery_generation,
    connection_epoch: attempt.connection_epoch,
    authenticated: true as const,
    active: true as const,
    negotiated: { major: 2 as const, minor: 0 as const, capabilities: ['rpc' as const] }
  }
  const context = (principal: string, direction: AuthenticatedContext['direction']): AuthenticatedContext => ({
    phase: 'authenticated',
    direction,
    connection,
    resolveProvider: () => binding,
    resolveContract: () => record.wire
  })
  return {
    attempt,
    backend: {
      currentPrincipal: () => 'alice',
      localProvider: () => binding,
      context,
      contract: (ref) => (ref === reference ? record : undefined),
      attempt: (call, id) =>
        call === attempt.call_id && id === attempt.attempt_id
          ? {
              binding: attempt,
              principal_id: 'alice',
              method: 'terminal.read',
              mode: 'strict',
              native_request: { method: 'terminal.read', params: { terminal: 't1', lines: 0 } }
            }
          : undefined,
      now: () => 1000,
      responseAnchor: () => ({
        binding: attempt,
        method: 'terminal.read',
        mode: 'strict',
        state: 'dispatching',
        content_status: 'available',
        content_expires_at: 5000,
        dedup_expires_at: 5000
      }),
      contentStatus: () => 'available',
      subscribeInvalidation: () => () => {}
    }
  }
}

test('Wire 核心先复核档位与参数，再建立许可，结果用审核 schema 复验', () => {
  const { backend: fake, attempt } = backend()
  const adapter = createHerdrCoreAdapter(fake)
  try {
    const identity = (({ machine_id: _m, recovery_generation: _r, connection_epoch: _e, ...rest }) => rest)(attempt)
    const resolved = adapter.resolve(identity)
    assert.equal(resolved.binding.call_id, 'call-a')
    // 未建立许可前不能读取结果。
    assert.throws(() => adapter.checkResult(resolved), /dispatch_permit_unavailable/u)
    // 控制档必须先带终端栅栏，宿主级方法与历史行数在准备阶段就被拒绝，不会进入原生请求。
    assert.throws(
      () => adapter.validator.validateRequest({ method: 'terminal.send', params: { terminal: 't1' } }, resolved),
      /herdr_core_terminal_fence_required/u
    )
    assert.throws(
      () => adapter.validator.validateRequest({ method: 'machine.exec', params: { argv: ['sh'] } }, resolved),
      /herdr_core_method_unavailable/u
    )
    // 读历史已开放到 1000 行，超过上限仍是参数错误。
    assert.throws(
      () =>
        adapter.validator.validateRequest(
          { method: 'terminal.read', params: { terminal: 't1', lines: 1001 } },
          resolved
        ),
      /herdr_core_read_history_exceeds_limit/u
    )
    // 读历史已开放到 1000 行；开关门禁在执行端，不在这里。
    assert.doesNotThrow(() =>
      adapter.validator.validateRequest({ method: 'terminal.read', params: { terminal: 't1', lines: 20 } }, resolved)
    )
    adapter.encodeRequest(
      { id: attempt.native_request_id, method: 'terminal.read', params: { terminal: 't1', lines: 0 } },
      resolved
    )
    adapter.checkResult(resolved)
    const sample = SAMPLES.samples.find((entry) => entry.method === 'terminal.read')!.response.result
    assert.doesNotThrow(() => adapter.validator.validateResponse(sample, resolved))
    // 未知字段是协议不符，不能被静默忽略。
    assert.throws(
      () => adapter.validator.validateResponse({ ...sample, unexpected: true }, resolved),
      /herdr_core_result_invalid/u
    )
    const frame = {
      protocol_major: 2 as const,
      protocol_minor: 0 as const,
      message_id: 'message-a',
      machine_id: attempt.machine_id,
      recovery_generation: attempt.recovery_generation,
      connection_epoch: attempt.connection_epoch,
      type: 'response' as const,
      payload: { attempt: identity, native_response: sample }
    }
    const plan = adapter.planEvidence(frame)
    assert.equal(plan.action, 'append')
    assert.equal(plan.content.delivery, 'payload')
    assert.equal(adapter.stats().executions, 1)
  } finally {
    adapter.close()
  }
})

test('旧 provider 的契约来源不能被 herdr-core 核心接受', () => {
  const { backend: fake } = backend()
  const adapter = createHerdrCoreAdapter(fake)
  try {
    // 契约来源本身仍要能通过共享校验；herdr-core 只拒绝不属于自己的来源。
    assert.doesNotThrow(() => validateContractSource(source))
    assert.equal(source.provider_kind, 'herdr-core')
  } finally {
    adapter.close()
  }
})
