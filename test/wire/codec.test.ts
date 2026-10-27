// 验证 Wire 编解码、协商、独立调用关联、原生门禁与 JSON 边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeWireFrame,
  encodeWireFrame,
  negotiate,
  validateNegotiated,
  LIMITS,
  boundedJson,
  WireError
} from '../../src/wire/index.js'
import type { PreAuthEnvelope, CodecContext } from '../../src/wire/types.js'
import {
  ajv,
  transcript,
  context,
  identity,
  attempt,
  binding,
  request,
  response,
  frame,
  offer,
  rejects,
  fixtureValidator,
  nativeRequest,
  withoutId
} from './helpers.js'

// 将测试对象序列化后交给带指定上下文的 Wire 解码器。
const decode = (v: unknown, ctx = context()) => decodeWireFrame(JSON.stringify(v), ctx)
// 构造已登记为原始契约模式的认证测试上下文。
const rawContext = (validator = fixtureValidator()) =>
  context('gateway_to_connector', validator, binding, 'ping', 'raw-contract')

test(
  '协商结果能力列表只接受字符串，不隐式转换数组/对象为 capability 名',
  /* 验证协商结果能力列表只接受字符串，不隐式转换数组/对象为 capability 名。 */ () => {
    for (const value of [['rpc'], { toString: null }, null, true, 0, { toString: 'rpc' }]) {
      rejects(
        /* 提交该用例输入，确认能力列表或能力依赖非法时被拒绝。 */ () =>
          validateNegotiated({ major: 2, minor: 0, capabilities: [value] }),
        'invalid_capabilities'
      )
    }
    assert.doesNotThrow(
      /* 验证仅含字符串能力的协商结果可以通过检查。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['rpc'] })
    )
  }
)

test(
  'malformed welcome 的 capability 元素统一返回结构化 WireError',
  /* 验证malformed welcome 的 capability 元素统一返回结构化 WireError。 */ () => {
    const ctx: CodecContext = {
      phase: 'preauth',
      direction: 'gateway_to_connector',
      offer,
      handshake_message_id: 'handshake_1'
    }
    for (const value of [{ toString: null }, ['rpc'], null]) {
      const welcome = {
        protocol_major: 2,
        protocol_minor: 0,
        type: 'welcome',
        message_id: 'welcome_1',
        payload: {
          ...identity,
          in_reply_to: 'handshake_1',
          selected: { major: 2, minor: 0, capabilities: [value] }
        }
      }
      assert.throws(
        /* 解码含非法能力元素的 welcome，触发结构化协商错误。 */ () => decodeWireFrame(JSON.stringify(welcome), ctx),
        /* 确认异常为 WireError 且错误码表示非法能力列表。 */ (error: unknown) =>
          error instanceof WireError && error.code === 'invalid_capabilities'
      )
    }
  }
)

test(
  'v2 major 拒绝、minor 取交集，未知可选能力忽略、未知必需能力拒绝',
  /* 验证v2 major 拒绝、minor 取交集，未知可选能力忽略、未知必需能力拒绝。 */ () => {
    const local = { ...offer, capabilities: ['rpc', 'late_evidence'] }
    assert.deepEqual(negotiate(local, { ...local, minor: 12, capabilities: ['rpc', 'future'] }), {
      major: 2,
      minor: 0,
      capabilities: ['rpc']
    })
    rejects(
      /* 提交该用例输入，确认不支持的协议主版本时被拒绝。 */ () => negotiate(local, { ...local, major: 1 }),
      'protocol_major_unsupported'
    )
    rejects(
      /* 提交该用例输入，确认无法满足必需能力时被拒绝。 */ () =>
        negotiate(local, { ...local, capabilities: ['rpc', 'future'], required: ['future'] }),
      'required_capability_unsupported'
    )
    rejects(
      /* 提交该用例输入，确认整数越界或不满足非负限制时被拒绝。 */ () => negotiate(local, { ...local, minor: -1 }),
      'invalid_integer'
    )
    rejects(
      /* 提交该用例输入，确认能力列表或能力依赖非法时被拒绝。 */ () =>
        negotiate(local, { ...local, capabilities: ['rpc', 'rpc'] }),
      'invalid_capabilities'
    )
    rejects(
      /* 提交该用例输入，确认能力列表或能力依赖非法时被拒绝。 */ () =>
        negotiate(local, { ...local, required: ['missing'] }),
      'invalid_capabilities'
    )
  }
)

test(
  'v2 握手必填字段、方向与 welcome 关联完整，不构造认证来源',
  /* 验证v2 握手必填字段、方向与 welcome 关联完整，不构造认证来源。 */ () => {
    const c2g: CodecContext = { phase: 'preauth', direction: 'connector_to_gateway' }
    const g2c: CodecContext = {
      phase: 'preauth',
      direction: 'gateway_to_connector',
      offer,
      handshake_message_id: 'handshake_1'
    }
    const authenticate: PreAuthEnvelope = {
      protocol_major: 2,
      protocol_minor: 0,
      type: 'authenticate',
      message_id: 'handshake_1',
      payload: {
        machine_id: identity.machine_id,
        recovery_generation: identity.recovery_generation,
        connector_instance_id: 'connector_1',
        device_credential: 'synthetic-test-value',
        offer
      }
    }
    const enroll: PreAuthEnvelope = {
      ...authenticate,
      type: 'enroll',
      payload: {
        registration_id: 'registration_1',
        connector_instance_id: 'connector_1',
        enrollment_credential: 'synthetic-test-value',
        offer
      }
    }
    const welcome: PreAuthEnvelope = {
      ...authenticate,
      type: 'welcome',
      payload: { ...identity, in_reply_to: 'handshake_1', selected: negotiate(offer, offer) }
    }
    for (const value of [authenticate, enroll]) {
      assert.deepEqual(decodeWireFrame(encodeWireFrame(value, c2g), c2g), value)
      rejects(
        /* 提交该用例输入，确认消息传输方向错误时被拒绝。 */ () => decodeWireFrame(JSON.stringify(value), g2c),
        'wrong_direction'
      )
      const missing = structuredClone(value) as any
      delete missing.payload.connector_instance_id
      rejects(
        /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
          decodeWireFrame(JSON.stringify(missing), c2g),
        'invalid_frame_fields'
      )
      rejects(
        /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
          decodeWireFrame(JSON.stringify({ ...value, connection_epoch: 'fake' }), c2g),
        'invalid_frame_fields'
      )
    }
    assert.deepEqual(decodeWireFrame(encodeWireFrame(welcome, g2c), g2c), welcome)
    rejects(
      /* 提交该用例输入，确认欢迎帧与原握手不关联时被拒绝。 */ () =>
        decodeWireFrame(JSON.stringify(welcome), { ...g2c, handshake_message_id: 'wrong' }),
      'handshake_mismatch'
    )
    rejects(
      /* 提交该用例输入，确认缺少独立握手上下文时被拒绝。 */ () =>
        decodeWireFrame(JSON.stringify(welcome), {
          phase: 'preauth',
          direction: 'gateway_to_connector'
        }),
      'handshake_context_required'
    )
    rejects(
      /* 提交该用例输入，确认使用尚未协商的能力时被拒绝。 */ () =>
        decodeWireFrame(
          JSON.stringify({
            ...welcome,
            payload: {
              ...welcome.payload,
              selected: { major: 2, minor: 0, capabilities: ['future'] }
            }
          }),
          g2c
        ),
      'unsupported_capability'
    )
    rejects(
      /* 提交该用例输入，确认消息版本与协商广告不一致时被拒绝。 */ () =>
        decodeWireFrame(JSON.stringify({ ...authenticate, protocol_minor: 1 }), c2g),
      'invalid_negotiation'
    )
    const {
      machine_id: _machineId,
      recovery_generation: _recoveryGeneration,
      connection_epoch: _connectionEpoch,
      ...forged
    } = request
    rejects(
      /* 提交该用例输入，确认连接尚未认证或已停用时被拒绝。 */ () =>
        decodeWireFrame(JSON.stringify(forged), {
          phase: 'preauth',
          direction: 'gateway_to_connector'
        }),
      'authentication_required'
    )
  }
)

test(
  'v2 基础帧往返，完整原生错误 data 保留，所有帧有缺字段与方向负例',
  /* 验证v2 基础帧往返，完整原生错误 data 保留，所有帧有缺字段与方向负例。 */ () => {
    const fixtures = [
      request,
      frame('accepted', { attempt }),
      response,
      frame('cancel', { attempt, reason: 'deadline_exceeded' }),
      frame('heartbeat', { sequence: 0 }),
      frame('error', { source: 'gateway', code: 'forbidden', retryable: false })
    ]
    for (const f of fixtures) {
      const c2g = ['accepted', 'response'].includes(f.type)
      const ctx = context(c2g ? 'connector_to_gateway' : 'gateway_to_connector')
      assert.deepEqual(decodeWireFrame(encodeWireFrame(f, ctx), ctx), f)
      const bad = structuredClone(f) as any
      delete bad.payload[Object.keys(bad.payload)[0]!]
      rejects(
        /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () => decodeWireFrame(JSON.stringify(bad), ctx),
        'invalid_frame_fields'
      )
      if (!['heartbeat', 'error'].includes(f.type)) {
        rejects(
          /* 提交该用例输入，确认消息传输方向错误时被拒绝。 */ () =>
            decodeWireFrame(JSON.stringify(f), context(c2g ? 'gateway_to_connector' : 'connector_to_gateway')),
          'wrong_direction'
        )
      }
    }
    const err = {
      ...response,
      payload: {
        ...response.payload,
        native_response: {
          id: attempt.native_request_id,
          error: {
            code: 'revision_conflict',
            message: 'synthetic',
            data: { revision: 42, nested: { retain: true } }
          }
        }
      }
    }
    assert.deepEqual(
      decodeWireFrame(encodeWireFrame(err, context('connector_to_gateway')), context('connector_to_gateway')),
      err
    )
    rejects(
      /* 提交该用例输入，确认字段使用未知枚举值时被拒绝。 */ () =>
        decode(frame('error', { source: 'native' as any, code: 'native_error', retryable: false })),
      'invalid_enum'
    )
    rejects(
      /* 提交该用例输入，确认整数越界或不满足非负限制时被拒绝。 */ () => decode(frame('heartbeat', { sequence: -1 })),
      'invalid_integer'
    )
    rejects(
      /* 提交该用例输入，确认整数越界或不满足非负限制时被拒绝。 */ () =>
        decode(frame('heartbeat', { sequence: Number.MAX_SAFE_INTEGER + 1 })),
      'invalid_integer'
    )
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
        decode({ ...request, payload: { ...request.payload, owner: true } }),
      'invalid_frame_fields'
    )
  }
)

test(
  '连接、provider、revision、契约、登记 deadline/policy 与原生 ID 核对独立锚点',
  /* 验证连接、provider、revision、契约、登记 deadline/policy 与原生 ID 核对独立锚点。 */ () => {
    for (const key of ['machine_id', 'recovery_generation', 'connection_epoch'] as const) {
      rejects(
        /* 提交该用例输入，确认消息与当前连接身份不匹配时被拒绝。 */ () =>
          decode({ ...response, [key]: 'wrong' }, context('connector_to_gateway')),
        'connection_binding_mismatch'
      )
    }
    for (const [key, value] of [
      ['call_id', 'wrong'],
      ['attempt_id', 'wrong'],
      ['native_request_id', 'wrong'],
      ['binding_revision', 2],
      ['provider_kind', 'herdr'],
      ['contract_ref', 'b'.repeat(64)]
    ] as const) {
      rejects(
        /* 提交该用例输入，确认消息与独立调用锚点不匹配时被拒绝。 */ () =>
          decode(
            { ...response, payload: { ...response.payload, attempt: { ...attempt, [key]: value } } },
            context('connector_to_gateway')
          ),
        'attempt_binding_mismatch'
      )
    }
    for (const [key, value] of [
      ['provider_id', 'other'],
      ['session', 'other']
    ] as const) {
      rejects(
        /* 提交该用例输入，确认消息与独立调用锚点不匹配时被拒绝。 */ () =>
          decode(
            {
              ...response,
              payload: {
                ...response.payload,
                attempt: { ...attempt, target: { ...attempt.target, [key]: value } }
              }
            },
            context('connector_to_gateway')
          ),
        'attempt_binding_mismatch'
      )
    }
    for (const [key, value] of [['deadline', 2000]] as const) {
      rejects(
        /* 提交该用例输入，确认消息与独立调用锚点不匹配时被拒绝。 */ () =>
          decode(
            {
              ...response,
              payload: {
                ...response.payload,
                attempt: { ...attempt, registration: { ...attempt.registration, [key]: value } }
              }
            },
            context('connector_to_gateway')
          ),
        'attempt_binding_mismatch'
      )
    }
    rejects(
      /* 提交该用例输入，确认查不到独立调用锚点时被拒绝。 */ () =>
        decode(response, { ...context('connector_to_gateway'), resolveAttempt: undefined }),
      'attempt_anchor_unavailable'
    )
    rejects(
      /* 提交该用例输入，确认响应原生 ID 与登记值不一致时被拒绝。 */ () =>
        decode(
          {
            ...response,
            payload: { ...response.payload, native_response: { id: 'wrong', result: {} } }
          },
          context('connector_to_gateway')
        ),
      'native_id_mismatch'
    )
    const inactive = context()
    ;(inactive.connection as any).active = false
    rejects(
      /* 提交该用例输入，确认连接尚未认证或已停用时被拒绝。 */ () => decode(request, inactive),
      'authentication_required'
    )
    rejects(
      /* 提交该用例输入，确认不支持的协议主版本时被拒绝。 */ () => decode({ ...request, protocol_major: 1 }),
      'protocol_major_unsupported'
    )
    rejects(
      /* 提交该用例输入，确认消息版本不在当前协商范围时被拒绝。 */ () => decode({ ...request, protocol_minor: 1 }),
      'protocol_version_unsupported'
    )
  }
)

test(
  '真实 P0 完整 UHP request 注入可信 ID；response 依赖原 handle/source 与完整离线 schema',
  /* 验证真实 P0 完整 UHP request 注入可信 ID；response 依赖原 handle/source 与完整离线 schema。 */ () => {
    let checked = 0
    for (const row of transcript.filter(
      /* 选出同时具有请求和响应的真实 P0 进程记录。 */ (r) => r.kind === 'process' && r.stdin && r.stdout
    )) {
      const req = JSON.parse(row.stdin.split('\n')[0])
      const res = JSON.parse(row.stdout.split('\n')[0])
      const a = {
        ...attempt,
        native_request_id: req.id,
        target: row.label.startsWith('host-')
          ? {
              machine_id: identity.machine_id,
              provider_id: attempt.target.provider_id,
              profile: 'host' as const
            }
          : attempt.target
      }
      const b = { ...binding, ...a }
      const f = frame('response', { attempt: a, native_response: res })
      const ctx = context('connector_to_gateway', fixtureValidator(), b, req.method)
      assert.deepEqual(decodeWireFrame(encodeWireFrame(f, ctx), ctx), f)
      if (nativeRequest(req)) {
        const rf = frame('request', {
          attempt: a,
          expected_binding_revision: 1,
          native_request: withoutId(req),
          validation: 'strict'
        })
        const rc = context('gateway_to_connector', fixtureValidator(), b, req.method)
        assert.deepEqual(decodeWireFrame(encodeWireFrame(rf, rc), rc), rf)
      }
      checked++
    }
    assert(checked >= 8)
    for (const req of [
      { ...request.payload.native_request, extra: true },
      { method: 'uhp.capabilities', params: { unannounced: true } },
      { method: 'agent.prompt', params: { target: '1', text: 'synthetic', until: 'done' } },
      { method: 'ping' }
    ]) {
      rejects(
        /* 提交该用例输入，确认原生请求未通过完整 schema时被拒绝。 */ () =>
          decode(
            { ...request, payload: { ...request.payload, native_request: req } },
            context('gateway_to_connector', fixtureValidator(), binding, req.method as string)
          ),
        'native_request_invalid'
      )
    }
    for (const bad of [
      { id: attempt.native_request_id },
      { id: attempt.native_request_id, result: {}, extra: true },
      { id: attempt.native_request_id, error: { code: 'internal' } }
    ]) {
      rejects(
        /* 提交该用例输入，确认原生响应未通过校验时被拒绝。 */ () =>
          decode(
            { ...response, payload: { ...response.payload, native_response: bad } },
            context('connector_to_gateway')
          ),
        'native_response_invalid'
      )
    }
    for (const field of ['id', 'auth']) {
      rejects(
        /* 提交该用例输入，确认请求正文试图注入保留字段时被拒绝。 */ () =>
          decode({
            ...request,
            payload: {
              ...request.payload,
              native_request: { ...request.payload.native_request, [field]: 'caller' }
            }
          }),
        'reserved_request_field'
      )
    }
    assert.throws(
      /* 尝试编译外部引用，验证离线 schema 校验不会解析网络资源。 */ () =>
        ajv.compile({ $ref: 'https://untrusted.invalid/no-network.json' }),
      /resolve reference/
    )
  }
)

test(
  '原生校验器拒绝或缺失时请求被拒绝，错误码原样透出且不继续派发',
  /* 验证 Wire 授权通过后仍由原生校验器决定；缺校验器、schema 不全、方法表外均被拒绝。 */ () => {
    const raw = { ...request, payload: { ...request.payload, validation: 'raw-contract' as const } }
    rejects(/* 提交该用例输入，确认消息与独立调用锚点不匹配时被拒绝。 */ () => decode(raw), 'attempt_binding_mismatch')
    rejects(
      /* 提交该用例输入，确认原生请求未通过完整 schema时被拒绝。 */ () =>
        decode(
          {
            ...raw,
            payload: {
              ...raw.payload,
              native_request: { ...raw.payload.native_request, extra: true }
            }
          },
          rawContext()
        ),
      'native_request_invalid'
    )
    rejects(
      /* 提交该用例输入，确认未安装对应原生校验器时被拒绝。 */ () =>
        decode(request, { ...context(), validators: undefined }),
      'native_validator_unavailable'
    )
    for (const code of [
      'parameter_schema_incomplete',
      'parameter_schema_unavailable',
      'method_not_listed',
      'raw_contract_not_authorized',
      'forbidden'
    ]) {
      const validator = fixtureValidator()
      validator.validateRequest = /* 模拟原生校验器按方法表、参数完整度或授权拒绝。 */ () => {
        throw new WireError(code)
      }
      rejects(
        /* 提交该用例输入，确认原生校验器的固定错误码被原样透出。 */ () =>
          decode(request, context('gateway_to_connector', validator)),
        code
      )
    }
    const garbled = fixtureValidator()
    garbled.validateRequest = /* 模拟违规的非 undefined 返回值。 */ (() => ({})) as any
    rejects(
      /* 提交该用例输入，确认违规返回值被固定错误码拒绝。 */ () =>
        decode(request, context('gateway_to_connector', garbled)),
      'invalid_native_validator_result'
    )
  }
)

test(
  'UTF-8/JSON/Unicode、精确大小/深度/节点与 ID 边界保持有界',
  /* 验证UTF-8/JSON/Unicode、精确大小/深度/节点与 ID 边界保持有界。 */ () => {
    rejects(
      /* 提交该用例输入，确认输入含非法 UTF-8 字节时被拒绝。 */ () =>
        decodeWireFrame(new Uint8Array([0xc3, 0x28]), context()),
      'invalid_utf8'
    )
    for (const raw of ['{', '{}\n{}', '\uFEFF{}', 'null', '[]']) {
      assert.throws(/* 解码畸形 JSON，验证其统一抛出 WireError。 */ () => decodeWireFrame(raw, context()), WireError)
    }
    rejects(
      /* 提交该用例输入，确认输入超过单帧大小上限时被拒绝。 */ () =>
        decodeWireFrame('x'.repeat(LIMITS.frame_bytes + 1), context()),
      'frame_limit'
    )
    for (const message_id of ['', 'a'.repeat(129)]) {
      rejects(
        /* 提交该用例输入，确认消息标识超出格式或长度边界时被拒绝。 */ () => decode({ ...request, message_id }),
        'invalid_frame_id'
      )
    }
    assert.doesNotThrow(
      /* 验证长度恰好达到标识上限的消息仍可解码。 */ () => decode({ ...request, message_id: 'a'.repeat(128) })
    )
    let boundary: unknown = 0
    for (let i = 0; i < LIMITS.depth; i++) {
      boundary = [boundary]
    }
    assert.doesNotThrow(/* 验证深度恰好达到允许边界的 JSON 可以序列化。 */ () => boundedJson(boundary))
    rejects(
      /* 提交该用例输入，确认JSON 超过深度或节点上限时被拒绝。 */ () => boundedJson([boundary]),
      'json_depth_limit'
    )
    assert.doesNotThrow(
      /* 验证包含根节点后恰好达到节点上限的数据可以序列化。 */ () =>
        boundedJson(Array.from({ length: LIMITS.nodes - 1 }, /* 生成用于节点数量边界测试的空值元素。 */ () => null))
    )
    rejects(
      /* 提交该用例输入，确认JSON 超过深度或节点上限时被拒绝。 */ () =>
        boundedJson(Array.from({ length: LIMITS.nodes }, /* 生成用于超出节点上限测试的空值元素。 */ () => null)),
      'json_depth_limit'
    )
    rejects(
      /* 提交该用例输入，确认输入含未配对 Unicode 代理码元时被拒绝。 */ () => boundedJson({ text: '\ud800' }),
      'invalid_unicode'
    )
    assert.equal(boundedJson('😀'), '"😀"')
    const cyclic: any = {}
    cyclic.self = cyclic
    rejects(
      /* 提交该用例输入，确认输入不是可安全规范化的 JSON 数据时被拒绝。 */ () => boundedJson(cyclic),
      'invalid_json'
    )
    rejects(
      /* 提交该用例输入，确认输入不是可安全规范化的 JSON 数据时被拒绝。 */ () =>
        boundedJson({
          // 在属性被读取时抛错，用于证明序列化不会执行 getter。
          get x() {
            throw Error('不得执行')
          }
        }),
      'invalid_json'
    )
    rejects(
      /* 提交该用例输入，确认输入不是可安全规范化的 JSON 数据时被拒绝。 */ () => boundedJson(new Date()),
      'invalid_json'
    )
    rejects(
      // Intentionally sparse: Array.from would fill the holes and change this negative input.
      // oxlint-disable-next-line unicorn/no-new-array
      /* 序列化稀疏数组，确认缺失元素会被拒绝而非静默补全。 */ () => boundedJson(new Array(3)),
      'invalid_json'
    )
    const heartbeat = frame('heartbeat', { sequence: 0 })
    const raw = JSON.stringify(heartbeat)
    assert.deepEqual(
      decodeWireFrame(raw + ' '.repeat(LIMITS.frame_bytes - Buffer.byteLength(raw)), context()),
      heartbeat
    )
  }
)
