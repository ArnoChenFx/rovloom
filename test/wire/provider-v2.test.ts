// 验证 v2 provider 绑定、完整目标权限、不可变契约来源和示例消息。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  encodeWireFrame,
  decodeWireFrame,
  contractRef,
  validateContractSource,
  providerFor,
  planResponseEvidence,
  registeredRequestDigest
} from '../../src/wire/index.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import type { AttemptBinding, ContractSource, AuthenticatedContext } from '../../src/wire/types.js'
import {
  source,
  provider,
  binding,
  attempt,
  request,
  response,
  context,
  frame,
  fixtureValidator,
  rejects
} from './helpers.js'

// 将测试对象序列化并使用指定认证上下文解码。
const decode = (value: unknown, ctx = context()) => decodeWireFrame(JSON.stringify(value), ctx)
// 替换测试上下文的 provider 解析器，以模拟绑定版本或启用状态变化。
function replaceProvider(ctx: AuthenticatedContext, revision = 1, enabled = true) {
  ctx.resolveProvider = /* 返回具有指定版本和启用状态的 provider 测试绑定。 */ () => ({
    ...provider,
    binding_revision: revision,
    enabled
  })
  return ctx
}
const responseAnchor = {
  binding,
  method: 'ping',
  mode: 'strict' as const,
  state: 'outcome_unknown' as const,
  content_status: 'available' as const,
  content_expires_at: 500,
  dedup_expires_at: 2000
}

test(
  'V2Target 必须显式 provider，expected revision 只在调用外层；旧字段与未知枚举拒绝',
  /* 验证V2Target 必须显式 provider，expected revision 只在调用外层；旧字段与未知枚举拒绝。 */ () => {
    const target = { ...attempt.target } as any
    delete target.provider_id
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
        decode({ ...request, payload: { ...request.payload, attempt: { ...attempt, target } } }),
      'invalid_frame_fields'
    )
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
        decode({
          ...request,
          payload: {
            ...request.payload,
            attempt: { ...attempt, target: { ...attempt.target, kind: 'luvus' } }
          }
        }),
      'invalid_frame_fields'
    )
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
        decode({
          ...request,
          payload: {
            ...request.payload,
            attempt: { ...attempt, target: { ...attempt.target, expected_binding_revision: 1 } }
          }
        }),
      'invalid_frame_fields'
    )
    rejects(
      /* 提交该用例输入，确认整数越界或不满足非负限制时被拒绝。 */ () =>
        decode({ ...request, payload: { ...request.payload, expected_binding_revision: 0 } }),
      'invalid_integer'
    )
    rejects(
      /* 提交该用例输入，确认provider 配置或绑定版本不匹配时被拒绝。 */ () =>
        decode({ ...request, payload: { ...request.payload, expected_binding_revision: 2 } }),
      'provider_binding_mismatch'
    )
    for (const field of ['uhp_request', 'deadline', 'history']) {
      rejects(
        /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
          decode({ ...request, payload: { ...request.payload, [field]: {} } }),
        'invalid_frame_fields'
      )
    }
    rejects(
      /* 提交该用例输入，确认字段使用未知枚举值时被拒绝。 */ () =>
        decode({
          ...request,
          payload: { ...request.payload, attempt: { ...attempt, provider_kind: 'other' } }
        }),
      'invalid_enum'
    )
    const hostAttempt = {
      ...attempt,
      target: {
        machine_id: provider.machine_id,
        provider_id: provider.provider_id,
        profile: 'host' as const
      }
    }
    const host = frame('request', { ...request.payload, attempt: hostAttempt })
    const hostContext = context('gateway_to_connector', fixtureValidator(), {
      ...binding,
      ...hostAttempt
    })
    assert.deepEqual(decode(host, hostContext), host)
  }
)

test(
  'trusted provider kind/revision/config 枚举严格检查，消息不能选择另一 validator',
  /* 验证trusted provider kind/revision/config 枚举严格检查，消息不能选择另一 validator。 */ () => {
    const missing = context()
    delete missing.resolveProvider
    rejects(
      /* 提交该用例输入，确认查不到可信 provider 登记时被拒绝。 */ () => decode(request, missing),
      'provider_binding_unavailable'
    )
    for (const delta of [
      { provider_id: 'other' },
      { machine_id: 'other' },
      { binding_revision: 2 },
      { kind: 'herdr' as const }
    ]) {
      const ctx = context()
      ctx.resolveProvider = /* 返回逐项篡改后的 provider，检验可信登记的严格字段验证。 */ () => ({
        ...provider,
        ...delta
      })
      rejects(
        /* 提交该用例输入，确认provider 配置或绑定版本不匹配时被拒绝。 */ () => decode(request, ctx),
        'provider_binding_mismatch'
      )
    }
    for (const revision of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      rejects(
        /* 提交该用例输入，确认整数越界或不满足非负限制时被拒绝。 */ () =>
          decode(request, replaceProvider(context(), revision)),
        'invalid_integer'
      )
    }
    const extra = context()
    extra.resolveProvider = /* 返回带未声明 endpoint 字段的 provider，模拟污染的可信登记。 */ () =>
      ({ ...provider, endpoint: 'untrusted' }) as any
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () => decode(request, extra),
      'invalid_frame_fields'
    )
    let called = false
    const selection = context()
    selection.validators!.herdr = {
      ...fixtureValidator(),
      // 记录意外的原生校验调用并立即抛错，确保前置检查未被绕过。
      validateRequest() {
        called = true
        throw Error('不得调用')
      }
    }
    assert.deepEqual(decode(request, selection), request)
    assert.equal(called, false)
  }
)

test(
  '禁用只封锁指定 provider 的派发/输入/读取/迟到，新 revision 不接纳旧 attempt',
  /* 验证禁用只封锁指定 provider 的派发/输入/读取/迟到，新 revision 不接纳旧 attempt。 */ () => {
    const disabled = replaceProvider(context(), 2, false)
    rejects(
      /* 提交该用例输入，确认当前 provider 已被禁用时被拒绝。 */ () => decode(request, disabled),
      'provider_disabled'
    )
    rejects(
      /* 提交该用例输入，确认当前 provider 已被禁用时被拒绝。 */ () => providerFor(binding, disabled),
      'provider_disabled'
    )
    rejects(
      /* 提交该用例输入，确认当前 provider 已被禁用时被拒绝。 */ () =>
        planResponseEvidence(response, replaceProvider(context('connector_to_gateway'), 2, false), responseAnchor, 400),
      'provider_disabled'
    )
    rejects(
      /* 提交该用例输入，确认provider 配置或绑定版本不匹配时被拒绝。 */ () =>
        decode(response, replaceProvider(context('connector_to_gateway'), 3, true)),
      'provider_binding_mismatch'
    )
    // 设备连接/心跳仍有效；另一个 provider 具有独立 ID、revision 与授权。
    assert.doesNotThrow(
      /* 验证 provider 禁用不会阻止连接级心跳编码。 */ () =>
        encodeWireFrame(frame('heartbeat', { sequence: 0 }), disabled)
    )
    const otherBinding: AttemptBinding = {
      ...binding,
      target: { ...binding.target, provider_id: 'provider_2' }
    }
    const otherAttempt = { ...attempt, target: otherBinding.target }
    const otherContext = context('gateway_to_connector', fixtureValidator(), otherBinding)
    otherContext.resolveProvider = /* 仅启用指定的第二个 provider，验证不同实例独立授权。 */ (target) => ({
      ...provider,
      provider_id: target.provider_id,
      enabled: target.provider_id === 'provider_2'
    })
    assert.doesNotThrow(
      /* 验证第二个启用 provider 的请求仍可被解码。 */ () =>
        decode(frame('request', { ...request.payload, attempt: otherAttempt }), otherContext)
    )
    assert.doesNotThrow(
      /* 验证禁用其他 provider 不影响当前 provider 的读取权限。 */ () => providerFor(otherBinding, otherContext)
    )
  }
)

test(
  'ContractSource 摘要不可变，来源缺失/互相矛盾或分类 revision 缺失都不能执行',
  /* 验证ContractSource 摘要不可变，来源缺失/互相矛盾或分类 revision 缺失都不能执行。 */ () => {
    assert.equal(contractRef(source), attempt.contract_ref)
    for (const delta of [
      { schema_sha256: 'b'.repeat(64) },
      { adapter_revision: 'other' },
      { runtime_generation: 'actual_other_generation' }
    ]) {
      assert.notEqual(contractRef({ ...source, ...delta }), attempt.contract_ref)
    }
    for (const field of ['binary_sha256', 'schema_command', 'schema_origin', 'binary_version']) {
      const broken = { ...source } as any
      delete broken[field]
      rejects(
        /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () => validateContractSource(broken),
        'invalid_frame_fields'
      )
    }
    rejects(
      /* 提交该用例输入，确认契约协议族与 provider 类型矛盾时被拒绝。 */ () =>
        validateContractSource({ ...source, protocol_family: 'herdr-json' }),
      'contract_provider_mismatch'
    )
    rejects(
      /* 提交该用例输入，确认字段使用未知枚举值时被拒绝。 */ () =>
        validateContractSource({ ...source, schema_origin: 'website' }),
      'invalid_enum'
    )
    const changed = context()
    changed.resolveContract = /* 返回来源已改变但沿用旧引用的契约，模拟摘要关联冲突。 */ () => ({
      source: { ...source, adapter_revision: 'other' },
      support_status: 'validated'
    })
    rejects(
      /* 提交该用例输入，确认契约来源与固定摘要不匹配时被拒绝。 */ () => decode(request, changed),
      'contract_binding_mismatch'
    )
    for (const delta of [{ classification_revision: null }, { support_basis: 'schema_and_version' as const }]) {
      const recordSource = { ...source, ...delta }
      const ref = contractRef(recordSource)
      const a = { ...attempt, contract_ref: ref }
      const ctx = context('gateway_to_connector', fixtureValidator(), { ...binding, ...a })
      ctx.resolveContract = /* 提供修改后的契约记录，验证来源缺项仍不能执行。 */ () => ({
        source: recordSource,
        support_status: 'validated'
      })
      rejects(
        /* 提交该用例输入，确认契约缺少执行所需的可信分类来源时被拒绝。 */ () =>
          decode(frame('request', { ...request.payload, attempt: a }), ctx),
        'contract_unavailable'
      )
    }
    // 缺 generation 用 null 表达，不能合成一个看似原生的值。
    assert.equal(source.runtime_generation, null)
    assert.doesNotThrow(/* 验证运行代次为空的合法来源仍能通过结构检查。 */ () => validateContractSource(source))
  }
)

test(
  'Herdr 未评审来源保持 candidate；Host 先报 unsupported_profile',
  /* 用 candidate 夹具验证 Herdr 可由 v2 类型表示但不获得生产许可，Host 请求优先因 profile 被拒。 */ () => {
    const herdrSource: ContractSource = {
      ...source,
      provider_kind: 'herdr',
      protocol_family: 'herdr-json',
      binary_version: 'synthetic_unverified',
      binary_sha256: 'b'.repeat(64),
      schema_sha256: 'c'.repeat(64),
      adapter_revision: 'synthetic_herdr_candidate',
      classification_revision: null,
      schema_command: 'herdr api schema --json',
      support_basis: 'schema_and_version',
      runtime_generation: null,
      server_version: null,
      native_protocol_version: null
    }
    const ref = contractRef(herdrSource)
    for (const profile of ['session', 'host'] as const) {
      const target =
        profile === 'host'
          ? { machine_id: provider.machine_id, provider_id: provider.provider_id, profile }
          : { ...attempt.target, profile, session: 'synthetic' }
      const a = { ...attempt, target, provider_kind: 'herdr' as const, contract_ref: ref }
      const ctx = context('gateway_to_connector', fixtureValidator(), { ...binding, ...a })
      ctx.resolveProvider = /* 返回 Herdr 类型的 provider，测试候选支持边界。 */ () => ({ ...provider, kind: 'herdr' })
      ctx.resolveContract = /* 返回只有候选状态的 Herdr 契约，模拟尚未实际支持的 provider。 */ () => ({
        source: herdrSource,
        support_status: 'candidate'
      })
      const value = frame('request', { ...request.payload, attempt: a })
      rejects(
        /* 提交该用例输入，确认provider 仍未具备实际支持实证时被拒绝。 */ () => decode(value, ctx),
        profile === 'host' ? 'unsupported_profile' : 'provider_support_candidate'
      )
      ctx.resolveContract = /* 模拟错误提升为已验证的 Herdr 契约，确保仍不能绕过支持边界。 */ () => ({
        source: herdrSource,
        support_status: 'validated'
      })
      rejects(
        /* 提交该用例输入，确认provider 仍未具备实际支持实证时被拒绝。 */ () => decode(value, ctx),
        profile === 'host' ? 'unsupported_profile' : 'provider_support_candidate'
      )
    }
  }
)

test(
  '响应校验的原生异常只返回 code',
  /* 验证原生校验器异常不会泄露正文，只返回固定错误码。 */ () => {
    const leaking = fixtureValidator()
    leaking.validateResponse = /* 模拟携带私密文本的原生校验异常，检验错误收敛。 */ () => {
      throw Error('synthetic-private-payload')
    }
    assert.throws(
      /* 解码触发内部异常的响应，验证边界不会泄露异常正文。 */ () =>
        decode(response, context('connector_to_gateway', leaking)),
      /* 确认只返回固定原生响应错误码，且错误消息不含私密内容。 */ (e: any) =>
        e.code === 'native_response_invalid' && !e.message.includes('synthetic-private-payload')
    )
  }
)

test(
  '旧 Wire 帧与缺失 provider 的 v2 请求拒绝，不能触发原生校验或默认派发',
  /* 验证旧 Wire 帧与缺失 provider 的 v2 请求拒绝，不能触发原生校验或默认派发。 */ () => {
    let nativeCalls = 0
    const validator = fixtureValidator()
    validator.validateRequest = /* 记录请求参数校验是否被错误触发。 */ () => {
      nativeCalls++
    }
    validator.validateResponse = /* 记录响应校验是否被错误触发。 */ () => {
      nativeCalls++
    }
    const legacy = {
      ...response,
      protocol_major: 1,
      payload: {
        attempt: {
          call_id: 'old_call',
          attempt_id: 'old_attempt',
          native_request_id: 'old_native',
          target: { machine_id: provider.machine_id, profile: 'session', session: 'old_session' },
          contract_revision: 'old_revision',
          contract_digest: 'a'.repeat(64)
        },
        uhp_response: { id: 'old_native', result: {} }
      }
    }
    rejects(
      /* 提交该用例输入，确认不支持的协议主版本时被拒绝。 */ () =>
        decode(legacy, context('connector_to_gateway', validator)),
      'protocol_major_unsupported'
    )
    rejects(
      /* 提交该用例输入，确认不支持的协议主版本时被拒绝。 */ () =>
        decode({ ...request, protocol_major: 1 }, context('gateway_to_connector', validator)),
      'protocol_major_unsupported'
    )
    const foundation = {
      protocol_major: 1,
      protocol_minor: 0,
      type: 'request',
      message_id: 'old_message',
      connection_epoch: 'old_epoch',
      payload: {
        call_id: 'old_call',
        attempt_id: 'old_attempt',
        deadline: 1000,
        target: { machine_id: provider.machine_id, profile: 'session', session: 'old_session' },
        request: { method: 'ping', params: {} }
      }
    }
    rejects(
      /* 提交该用例输入，确认不支持的协议主版本时被拒绝。 */ () =>
        decode(foundation, context('gateway_to_connector', validator)),
      'protocol_major_unsupported'
    )
    const target = { ...attempt.target } as any
    delete target.provider_id
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
        decode(
          { ...request, payload: { ...request.payload, attempt: { ...attempt, target } } },
          context('gateway_to_connector', validator)
        ),
      'invalid_frame_fields'
    )
    for (const resolveProvider of [undefined, /* 模拟已存在解析器但查不到 provider 的情况。 */ () => undefined]) {
      const ctx = context('gateway_to_connector', validator)
      ctx.resolveProvider = resolveProvider
      rejects(
        /* 提交该用例输入，确认查不到可信 provider 登记时被拒绝。 */ () => decode(request, ctx),
        'provider_binding_unavailable'
      )
    }
    assert.equal(nativeCalls, 0)
  }
)

test(
  '登记摘要绑定 caller/完整 provider target/revision/契约及登记条件，不混入新分配的执行 ID',
  /* 验证登记摘要绑定 caller/完整 provider target/revision/契约及登记条件，不混入新分配的执行 ID。 */ () => {
    const initial = registeredRequestDigest(request.payload, 'caller_1')
    assert.equal(
      initial,
      registeredRequestDigest(
        {
          ...request.payload,
          attempt: {
            ...attempt,
            call_id: 'other_call',
            attempt_id: 'other_attempt',
            native_request_id: 'other_native'
          }
        },
        'caller_1'
      )
    )
    assert.notEqual(initial, registeredRequestDigest(request.payload, 'caller_2'))
    for (const payload of [
      {
        ...request.payload,
        attempt: { ...attempt, target: { ...attempt.target, provider_id: 'provider_2' } }
      },
      {
        ...request.payload,
        attempt: { ...attempt, binding_revision: 2 },
        expected_binding_revision: 2
      },
      { ...request.payload, attempt: { ...attempt, contract_ref: 'b'.repeat(64) } },
      {
        ...request.payload,
        attempt: { ...attempt, registration: { ...attempt.registration, deadline: 2000 } }
      },
      { ...request.payload, native_request: { method: 'ping', params: { changed: true } } }
    ]) {
      assert.notEqual(initial, registeredRequestDigest(payload, 'caller_1'))
    }
    rejects(
      /* 提交该用例输入，确认请求正文试图注入保留字段时被拒绝。 */ () =>
        registeredRequestDigest(
          {
            ...request.payload,
            native_request: { ...request.payload.native_request, id: 'caller_supplied' }
          },
          'caller_1'
        ),
      'reserved_request_field'
    )
  }
)

test(
  '完整 v2 JSON 示例逐帧验证，包含 request/accepted/response/cancel',
  /* 验证完整 v2 JSON 示例逐帧验证，包含 request/accepted/response/cancel。 */ () => {
    const examples = JSON.parse(readFileSync(new URL('./v2-examples.json', import.meta.url), 'utf8'))
    for (const type of ['request', 'accepted', 'response', 'cancel']) {
      const direction = ['accepted', 'response'].includes(type) ? 'connector_to_gateway' : 'gateway_to_connector'
      const ctx = context(direction)
      assert.deepEqual(decodeWireFrame(JSON.stringify(examples[type]), ctx), examples[type])
      for (const [field, value, code] of [
        ['protocol_major', 1, 'protocol_major_unsupported'],
        ['protocol_major', 3, 'protocol_major_unsupported'],
        ['protocol_minor', 1, 'protocol_version_unsupported'],
        ['connection_epoch', 'wrong_epoch', 'connection_binding_mismatch']
      ] as const) {
        rejects(
          /* 逐项篡改 JSON 示例的关联字段，验证返回该字段对应的拒绝码。 */ () =>
            decodeWireFrame(JSON.stringify({ ...examples[type], [field]: value }), ctx),
          code
        )
      }
      rejects(
        /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
          decodeWireFrame(JSON.stringify(examples[type]), {
            phase: 'preauth',
            direction
          }),
        'invalid_frame_fields'
      )
    }
    assert.equal(contractRef(examples.contract_source), attempt.contract_ref)
    assert.equal('id' in examples.request.payload.native_request, false)
    assert.equal('expected_binding_revision' in examples.request.payload.attempt.target, false)
  }
)

test(
  'Herdr provider gate requires validated actual provenance without version or release-hash admission',
  /** 共享层核对完整实际来源；版本/发行版摘要不是门禁，schema_and_version 仍不授予实例身份。 */ () => {
    const reviewed = fixedHerdrSource()
    for (const delta of [
      undefined,
      { binary_sha256: 'f'.repeat(64) },
      { binary_version: 'future-diagnostic-version' },
      { native_protocol_version: '27' },
      { adapter_revision: 'future' },
      { support_basis: 'live_catalog' as const },
      { runtime_generation: 'invented' }
    ]) {
      const current = { ...reviewed, ...delta }
      const herdrBinding: AttemptBinding = {
        ...binding,
        provider_kind: 'herdr',
        contract_ref: contractRef(current)
      }
      const ctx = context('gateway_to_connector', fixtureValidator(), herdrBinding)
      ctx.resolveProvider = /** 返回独立注册的 Herdr provider 配置。 */ () => ({ ...provider, kind: 'herdr' })
      ctx.resolveContract = /** 完整来源必须与 binding 摘要同值，然后再比对固定评审。 */ () => ({
        source: current,
        support_status: 'validated'
      })
      if (
        delta === undefined ||
        'binary_sha256' in delta ||
        'binary_version' in delta ||
        'native_protocol_version' in delta
      ) {
        assert.equal(providerFor(herdrBinding, ctx).kind, 'herdr')
        ctx.resolveContract = /** 固定来源没有 validated 状态仍然不能派发。 */ () => ({
          source: current,
          support_status: 'candidate'
        })
      }
      rejects(
        /** 未评审字段或 candidate 状态不得变为生产许可。 */ () => providerFor(herdrBinding, ctx),
        'provider_support_candidate'
      )
    }
  }
)
