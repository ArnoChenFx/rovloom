// 用真实原生校验器验证 Wire 的授权、流状态、证据、回滚及预算边界；宿主和消息均为合成，不连接原生进程。
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuvusWireAdapter } from '../../src/connector/luvus/wire.js'
import type { NativeWireBackend } from '../../src/connector/luvus/backend.js'
import type { TrustedAttempt } from '../../src/wire/backend.js'
import { contractRef, LIMITS } from '../../src/wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope, ContractSource, Payloads } from '../../src/wire/types.js'
import type { NativeBinding } from '../../src/connector/luvus/contract/index.js'
import { clone, compiled, G, identity, json, request, T, view } from '../connector/luvus/contract/helpers.js'

const adapters = new Set<ReturnType<typeof createLuvusWireAdapter>>()

// 集中登记所有测试adapter，包括预算边界用例额外创建的实例，避免遗漏维护计时器。
function testAdapter(...args: Parameters<typeof createLuvusWireAdapter>) {
  const adapter = createLuvusWireAdapter(...args)
  adapters.add(adapter)
  return adapter
}

afterEach(
  /* 每个用例都销毁自建adapter的维护定时器和许可；unref不等于释放，失败路径同样必须清理。 */ () => {
    try {
      for (const adapter of adapters) {
        adapter.close()
      }
    } finally {
      adapters.clear()
    }
  }
)

// 全部是隔离 P0 fixture 与明确的测试权限；生产模块不导入本工厂或测试 gate。
function fixture(method = 'task.add', raw = false, limits?: Parameters<typeof createLuvusWireAdapter>[1]) {
  const params = method === 'task.add' ? { title: 'synthetic' } : {}
  const candidate = request(view(), { id: 'native_1', method, params })
  const origin: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: identity.binary_sha256,
    schema_sha256: identity.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: G,
    adapter_revision: 'integration_test',
    classification_revision: 'review1',
    support_basis: 'live_catalog'
  }
  const binding: AttemptBinding = {
    machine_id: 'm1',
    recovery_generation: 'recovery1',
    connection_epoch: 'e1',
    call_id: 'call1',
    attempt_id: 'attempt1',
    native_request_id: 'native_1',
    provider_kind: 'luvus',
    binding_revision: 1,
    contract_ref: contractRef(origin),
    target: { machine_id: 'm1', provider_id: 'p1', profile: 'session', session: 'synthetic' },
    registration: {
      deadline: 1000
    }
  }
  const row: TrustedAttempt = {
    binding,
    principal_id: 'synthetic',
    method,
    mode: raw ? 'raw-contract' : 'strict',
    native_request: { method, params }
  }
  const rows = new Map([[binding.call_id, row]])
  const state = {
    active: true,
    enabled: true,
    sourceVerified: true,
    reader: 'synthetic',
    content: 'available' as 'available' | 'expired' | 'discarded' | 'unavailable',
    revision: 1,
    localConfig: 'config1',
    now: 100
  }
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = G
  // 从指定测试记录构造独立原生绑定，保留 provider、revision 与连接身份差异。
  const nativeBinding = (record: TrustedAttempt): NativeBinding => ({
    ...candidate.binding,
    provider_id: record.binding.target.provider_id,
    binding_revision: record.binding.binding_revision,
    contract_source_ref: record.binding.contract_ref
  })
  const backend: NativeWireBackend = {
    // 返回测试连接及可变在线状态，用于验证 epoch 与认证失效。
    connection: () => ({
      machine_id: 'm1',
      recovery_generation: 'recovery1',
      connection_epoch: 'e1',
      authenticated: true,
      active: state.active as true,
      negotiated: {
        major: 2,
        minor: 0,
        capabilities: ['rpc', 'late_evidence']
      }
    }),
    // 只查找调用及尝试 ID 均匹配的测试账本记录，避免夹具掩盖跨绑定错误。
    attempt: (call, attempt) => {
      const found = rows.get(call)
      return found?.binding.attempt_id === attempt ? found : undefined
    },
    // 返回当前测试 revision 的网关 provider 配置，支持双端错配注入。
    provider: (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      binding_revision: state.revision,
      kind: 'luvus',
      enabled: state.enabled,
      config_ref: 'config1'
    }),
    // 返回本地 provider 配置，用于真实适配器的双端配置交叉核对。
    localProvider: (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      binding_revision: state.revision,
      kind: 'luvus',
      enabled: state.enabled,
      config_ref: state.localConfig
    }),
    // 返回固定来源的真实编译契约和可变能力广告，支持陈旧能力与预算检查。
    contract: (ref) =>
      ref === contractRef(origin)
        ? {
            wire: { source: origin, support_status: 'validated' },
            compiled,
            capabilities,
            capability_revision: 'caps1'
          }
        : undefined,
    // 按调用独立提供已认证的原生绑定，找不到记录时不补造来源。
    nativeSource: (call) => {
      const found = rows.get(call)
      return found
        ? {
            authenticated: true,
            source_verified: state.sourceVerified,
            binding: nativeBinding(found)
          }
        : undefined
    },
    // 从真实候选构造独立测试授权事实，并覆盖当前分类和秘密边界状态。
    validateAttempt: () => {},
    // 返回测试读取者身份，验证结果读取不能借用原调用者身份。
    currentPrincipal: () => state.reader,
    // 返回当前测试内容状态，用于验证过期和 discard 后的不可复活边界。
    contentStatus: () => state.content,
    // 返回可控测试时钟，让 deadline 与 TTL 边界可精确重现。
    now: () => state.now,
    // 按精确调用和尝试返回固定响应锚点，方法、模式及期限来自对应记录。
    responseAnchor: (input) => {
      const found = rows.get(input.call_id)
      if (!found || found.binding.attempt_id !== input.attempt_id) {
        return undefined
      }
      return {
        binding: found.binding,
        method: found.method,
        mode: found.mode,
        state: 'outcome_unknown',
        content_status: state.content,
        content_expires_at: 500,
        dedup_expires_at: 2000
      }
    }
  }
  const adapter = testAdapter(backend, limits)
  // 从完整测试绑定提取消息所携带的尝试身份，连接外壳保持独立。
  const attempt = ({
    machine_id: _machine,
    recovery_generation: _recovery,
    connection_epoch: _epoch,
    ...rest
  }: AttemptBinding) => rest
  // 把测试 payload 包装为当前连接的认证 Wire 消息，保持固定消息 ID 供去重测试。
  function frame<K extends keyof Payloads>(type: K, payload: Payloads[K]): Extract<AuthenticatedEnvelope, { type: K }> {
    return {
      protocol_major: 2,
      protocol_minor: 0,
      type,
      message_id: 'msg1',
      machine_id: 'm1',
      recovery_generation: 'recovery1',
      connection_epoch: 'e1',
      payload
    } as Extract<AuthenticatedEnvelope, { type: K }>
  }
  const opening = frame('request', {
    attempt: attempt(binding),
    expected_binding_revision: 1,
    native_request: row.native_request,
    validation: row.mode
  })
  const response = frame('response', {
    attempt: attempt(binding),
    native_response: {
      id: 'native_1',
      error: {
        code: 'synthetic',
        message: 'preserve',
        data: { deep: ['汉字', { native: true }] }
      }
    }
  })
  // 将测试对象序列化后交给真实适配器解码，默认模拟网关到连接器方向。
  const decode = (
    value: unknown,
    direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector'
  ) => adapter.decode(JSON.stringify(value), direction)
  return {
    adapter,
    backend,
    binding,
    row,
    rows,
    origin,
    state,
    opening,
    response,
    decode,
    frame,
    attempt,
    nativeBinding
  }
}
// 执行待拒绝操作并核对固定错误码，避免只检查抛错而掩盖错误分支。
const rejects = (run: () => unknown, code: string) =>
  assert.throws(run, /* 核对抛出的固定错误码与预期一致，避免无关异常被误判为通过。 */ (e: any) => e.code === code, code)

test(
  'backend 回调不能重入修改正在验证的 adapter，外层校验仍能完成',
  /* 在宿主授权回调内尝试重入释放，确认内层被拒且外层校验仍保留正确许可。 */ () => {
    const f = fixture()
    const authority = f.backend.validateAttempt
    f.backend.validateAttempt = /* 在宿主授权回调内故意重入释放，再返回原授权，验证外层校验不被破坏。 */ (...args) => {
      rejects(
        /* 重入释放正在验证的尝试上下文，要求以 native_adapter_unavailable 拒绝（适配器拒绝重入或底层异常）。 */ () =>
          f.adapter.release(f.binding),
        'native_adapter_unavailable'
      )
      return authority?.(...args)
    }
    assert.doesNotThrow(
      /* 完成包含受拒重入回调的外层请求校验，确认原子状态没有被内层释放。 */ () => f.decode(f.opening)
    )
    assert.doesNotThrow(
      /* 读取外层成功校验后保留的许可，证明重入失败未撤销外层状态。 */ () => f.adapter.checkResult(f.binding)
    )
  }
)

test(
  '证据原文只在读取者就是派发主体时保留，其余只留元数据',
  /* 验证保留门禁与读取授权同源：主体不符、策略撤销时证据计划只含元数据。 */ () => {
    const f = fixture()
    f.decode(f.opening)
    assert.doesNotThrow(
      /* 原主体、有效来源和双端读权限下允许保留。 */ () =>
        f.adapter.checkResultRetention(f.binding, f.response.payload.native_response)
    )
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'payload')
    f.state.reader = 'other'
    rejects(
      /* 保留 port 不能借用其它读取者身份。 */ () =>
        f.adapter.checkResultRetention(f.binding, f.response.payload.native_response),
      'forbidden'
    )
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'payload')
  }
)

test(
  '保留 port 要求活的原请求、精确响应和当前读取授权，不由账本或响应反建 permit',
  /* 独立核对无原上下文、错响应、撤权和显式释放；所有拒绝均发生在结果层创建句柄之前。 */ () => {
    const f = fixture()
    const cold = createLuvusWireAdapter(f.backend)
    const native = f.response.payload.native_response
    try {
      f.decode(f.opening)
      rejects(
        /* 相同受信后端与完整响应仍不能为冷 adapter 恢复原请求许可。 */ () =>
          cold.checkResultRetention(f.binding, native),
        'dispatch_permit_unavailable'
      )
      assert.doesNotThrow(
        /* 真实原请求、精确响应与双时点保留分类全部有效时允许创建结果句柄。 */ () =>
          f.adapter.checkResultRetention(f.binding, native)
      )
      for (const missing of [undefined, null, [], 'response']) {
        assert.throws(
          /* JS 调用或不可信宿主传入非对象时也拒绝，不能退化为省略响应的读取检查。 */ () =>
            f.adapter.checkResultRetention(f.binding, missing as unknown as typeof native)
        )
      }
      rejects(
        /* 不能用另一个原生 ID 的响应为当前请求保留内容。 */ () =>
          f.adapter.checkResultRetention(f.binding, { ...native, id: 'other_native' }),
        'native_id_mismatch'
      )
      f.adapter.release(f.binding)
      rejects(
        /* 原上下文显式释放后，既有响应 JSON 不能重新创建 permit。 */ () =>
          f.adapter.checkResultRetention(f.binding, native),
        'dispatch_permit_unavailable'
      )
    } finally {
      cold.close()
      f.adapter.close()
    }
  }
)

test(
  '真实 validator 接入 Wire：完整参数、独立 source 和原生 error.data 保真，结果读取另过当前门禁',
  /* 往返真实 Wire 请求与响应并保留原生 error.data，再逐项撤销当前读取权限验证结果门禁。 */ () => {
    const f = fixture()
    assert.deepEqual(f.decode(f.opening), f.opening)
    assert.deepEqual(
      f.adapter.decode(f.adapter.encode(f.opening, 'gateway_to_connector'), 'gateway_to_connector'),
      f.opening
    )
    assert.deepEqual(f.decode(f.response, 'connector_to_gateway'), f.response)
    assert.doesNotThrow(
      /* 在原调用者和双端读取权限有效时读取 RPC，作为随后撤权检查的对照。 */ () => f.adapter.checkResult(f.binding)
    )
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 native_id_mismatch 拒绝。
      () =>
        f.decode(
          {
            ...f.response,
            payload: { ...f.response.payload, native_response: { id: 'other', result: {} } }
          },
          'connector_to_gateway'
        ),
      'native_id_mismatch'
    )
    f.state.reader = 'other'
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 forbidden 拒绝（当前读取未授权）。 */ () =>
        f.adapter.checkResult(f.binding),
      'forbidden'
    )
    f.state.reader = 'synthetic'
    assert.doesNotThrow(() => f.adapter.checkResult(f.binding))
  }
)

test(
  '真实 generic 只能标 incomplete；raw 只放宽参数覆盖，方法表与来源仍逐次核验',
  /* 通用参数 schema 在 strict 下必须拒绝；raw 放行参数覆盖但仍受静态方法表和当前来源约束。 */ () => {
    const strict = fixture('workspace.list')
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 parameter_schema_incomplete 拒绝。 */ () =>
        strict.decode(strict.opening),
      'parameter_schema_incomplete'
    )
    const raw = fixture('workspace.list', true)
    assert.deepEqual(raw.decode(raw.opening), raw.opening)
    // 表外方法即使以 raw 模式提交也不可派发。
    const unlisted = fixture('ping', true)
    rejects(/* 方法表之外的方法一律拒绝。 */ () => unlisted.decode(unlisted.opening), 'method_not_listed')
  }
)

test(
  '消息不能覆盖已登记参数、principal、provider 或原生来源；双端配置必须完全一致',
  /* 逐项篡改登记参数、外壳字段、双端配置和独立来源，确认消息不能覆盖宿主事实且异常不泄漏私密文本。 */ () => {
    const f = fixture()
    const altered = clone(f.opening)
    altered.payload.native_request.params = { server_generation: G, terminal_id: T, pane_id: '4' }
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 attempt_request_mismatch 拒绝。 */ () => f.decode(altered),
      'attempt_request_mismatch'
    )
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 invalid_frame_fields 拒绝。 */ () =>
        f.decode({ ...f.opening, payload: { ...f.opening.payload, owner: true } }),
      'invalid_frame_fields'
    )
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 reserved_request_field 拒绝。
      () =>
        f.decode({
          ...f.opening,
          payload: {
            ...f.opening.payload,
            native_request: { ...f.row.native_request, id: 'caller' }
          }
        }),
      'reserved_request_field'
    )
    f.state.sourceVerified = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 native_source_untrusted 拒绝。 */ () => f.decode(f.opening),
      'native_source_untrusted'
    )
    f.state.sourceVerified = true
    f.state.localConfig = 'other_root'
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 provider_binding_mismatch 拒绝。 */ () => f.decode(f.opening),
      'provider_binding_mismatch'
    )
    f.state.localConfig = 'config1'
    f.state.enabled = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 provider_disabled 拒绝。 */ () => f.decode(f.opening),
      'provider_disabled'
    )
    f.state.enabled = true
    f.state.revision = 2
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 provider_binding_mismatch 拒绝。 */ () => f.decode(f.opening),
      'provider_binding_mismatch'
    )
    f.state.revision = 1
    f.state.active = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 authentication_required 拒绝。 */ () => f.decode(f.opening),
      'authentication_required'
    )
    f.state.active = true
    f.backend.nativeSource = /* 注入含合成私密文本的来源异常，验证公开错误不会带出底层异常内容。 */ () => {
      throw Error('synthetic-private-payload')
    }
    assert.throws(
      // 触发宿主来源异常，确认解码只报告固定适配器错误且不泄露底层私密文本。
      () => f.decode(f.opening),
      // 核对公开错误仅含固定码，并确认底层合成私密文本没有泄露。
      (e: any) => e.code === 'native_adapter_unavailable' && !e.message.includes('synthetic-private-payload')
    )
  }
)

test(
  '同设备同名方法/native ID 的多个 provider 独立，错 endpoint 来源和 Herdr 冒充均拒绝',
  /* 在同设备构造多个同名方法及 ID 的 provider，分别验证跨 endpoint 来源及 Herdr 冒充均被拒绝。 */ () => {
    const f = fixture()
    f.decode(f.opening)
    const second = clone(f.row)
    second.binding = {
      ...second.binding,
      call_id: 'call2',
      target: { ...second.binding.target, provider_id: 'p2' }
    }
    f.rows.set('call2', second)
    const request2 = {
      ...f.opening,
      payload: { ...f.opening.payload, attempt: f.attempt(second.binding) }
    }
    assert.deepEqual(f.decode(request2), request2)
    f.backend.nativeSource = /* 故意返回另一个测试 provider 的绑定，验证同名方法和 ID 不能掩盖来源错配。 */ () => ({
      authenticated: true,
      source_verified: true,
      binding: f.nativeBinding(second)
    })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 native_identity_mismatch 拒绝。 */ () =>
        f.decode(f.response, 'connector_to_gateway'),
      'native_identity_mismatch'
    )
    const herdr = clone(f.row)
    herdr.binding = {
      ...herdr.binding,
      call_id: 'call3',
      provider_kind: 'herdr',
      target: { ...herdr.binding.target, provider_id: 'p3' }
    }
    f.rows.set('call3', herdr)
    f.backend.provider = /* 把网关 provider 冒报为 Herdr，验证 Luvus 适配器拒绝跨 provider 种类复用。 */ (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      kind: 'herdr',
      binding_revision: 1,
      config_ref: 'config1',
      enabled: true
    })
    f.backend.localProvider = f.backend.provider
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 contract_binding_mismatch 拒绝。
      () =>
        f.decode({
          ...f.opening,
          payload: { ...f.opening.payload, attempt: f.attempt(herdr.binding) }
        }),
      'contract_binding_mismatch'
    )
  }
)

test(
  '结果内容过期/discard 仅补最小可靠证据；原锚点不变、不派发、不续期限',
  /* 固定原响应锚点后切换过期和 discard，确认只生成最小可靠证据且不能恢复读取或改写期限。 */ () => {
    const f = fixture()
    f.decode(f.opening)
    const original = clone(f.backend.responseAnchor!(f.binding))
    const available = f.adapter.planEvidence(f.response)
    assert.equal(available.content.delivery, 'payload')
    assert.equal(available.dispatch, false)
    for (const status of ['expired', 'discarded', 'unavailable'] as const) {
      f.state.content = status
      rejects(
        /* 检查所选响应或事件的当前读取权限，要求以 content_unavailable 拒绝（内容不可用）。 */ () =>
          f.adapter.checkResult(f.binding),
        'content_unavailable'
      )
      const plan = f.adapter.planEvidence(f.response)
      assert.equal(plan.content.delivery, 'metadata_only')
      assert.equal(plan.content.native_response, undefined)
      assert.equal(plan.content.expires_at, original!.content_expires_at)
      assert.equal(plan.dispatch, false)
    }
    f.adapter.release(f.binding)
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        f.adapter.checkResult(f.binding),
      'dispatch_permit_unavailable'
    )
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        f.decode(f.response, 'connector_to_gateway'),
      'dispatch_permit_unavailable'
    )
  }
)

test(
  '迟到证据先执行完整原生较低帧预算，过期内容也不能绕过边界',
  /* 降低原生响应帧预算后提交迟到证据，证明内容已过期也必须先通过完整原生字节边界检查。 */ () => {
    const f = fixture()
    const registry = f.backend.contract(f.binding.contract_ref)!
    const caps = registry.capabilities as ReturnType<typeof json>
    caps.result.limits.frame_bytes = Buffer.byteLength(JSON.stringify(f.response.payload.native_response))
    f.decode(f.opening)
    const anchor = clone(f.backend.responseAnchor!(f.binding))
    for (const status of ['available', 'expired', 'discarded', 'unavailable'] as const) {
      f.state.content = status
      rejects(
        /* 为该响应生成持久化证据计划，要求以 native_response_invalid 拒绝。 */ () =>
          f.adapter.planEvidence(f.response),
        'native_response_invalid'
      )
    }
    f.state.content = 'available'
    assert.deepEqual(f.backend.responseAnchor!(f.binding), anchor)
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 content_unavailable 拒绝（内容不可用）。 */ () =>
        f.adapter.checkResult(f.binding),
      'content_unavailable'
    )
  }
)

test(
  '超限帧被拒绝，adapter 不暴露私有句柄且拒绝消息注入 native_handle',
  /* 验证单帧上限仍生效，且消息不能注入私有句柄。 */ () => {
    const f = fixture()
    f.decode(f.opening)
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 frame_limit 拒绝。 */ () =>
        f.adapter.decode('x'.repeat(LIMITS.frame_bytes + 1), 'connector_to_gateway'),
      'frame_limit'
    )
    assert.equal('context' in f.adapter, false)
    assert.equal('validators' in f.adapter, false)
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 invalid_frame_fields 拒绝。
      () => f.decode({ ...f.response, payload: { ...f.response.payload, native_handle: {} } }, 'connector_to_gateway'),
      'invalid_frame_fields'
    )
  }
)

test(
  'Wire 外壳使用原生有界 JSON parser：重复键/精度损失在解码前拒绝',
  /* 在原始 Wire JSON 中注入重复键及不安全整数，确认有界 parser 在后续校验前拒绝精度或覆盖歧义。 */ () => {
    const f = fixture()
    const raw = JSON.stringify(f.opening).replace('"message_id":"msg1"', '"message_id":"old","message_id":"msg1"')
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 duplicate_json_key 拒绝（原始 JSON 存在重复键）。 */ () =>
        f.adapter.decode(raw, 'gateway_to_connector'),
      'duplicate_json_key'
    )
    const heartbeat = f.frame('heartbeat', { sequence: 0 })
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 invalid_integer 拒绝。
      () =>
        f.adapter.decode(
          JSON.stringify(heartbeat).replace('"sequence":0', '"sequence":9007199254740993'),
          'gateway_to_connector'
        ),
      'invalid_integer'
    )
  }
)

test(
  '私有 attempt/快照预算满额拒绝，显式释放后不继承旧 permit',
  /* 分别耗尽快照与 attempt 配额，显式释放后确认容量返还且旧调用不能继承已释放许可。 */ () => {
    const f = fixture()
    const tiny = testAdapter(f.backend, { attempts: 1, snapshot_bytes: 1 })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 adapter_limit 拒绝（保留上下文超出预算）。 */ () =>
        tiny.decode(JSON.stringify(f.opening), 'gateway_to_connector'),
      'adapter_limit'
    )
    const limited = testAdapter(f.backend, { attempts: 1 })
    limited.decode(JSON.stringify(f.opening), 'gateway_to_connector')
    const second = clone(f.row)
    second.binding.call_id = 'call2'
    f.rows.set('call2', second)
    const next = {
      ...f.opening,
      payload: { ...f.opening.payload, attempt: f.attempt(second.binding) }
    }
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 adapter_limit 拒绝（保留上下文超出预算）。 */ () =>
        limited.decode(JSON.stringify(next), 'gateway_to_connector'),
      'adapter_limit'
    )
    limited.release(f.binding)
    assert.deepEqual(limited.decode(JSON.stringify(next), 'gateway_to_connector'), next)
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        limited.checkResult(f.binding),
      'dispatch_permit_unavailable'
    )
  }
)
