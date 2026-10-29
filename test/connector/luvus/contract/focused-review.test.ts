// 通过针对性反例复核句柄关联、来源锚点、raw 独立门禁、资源预算和原生字段保真。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  checkDispatch,
  checkResultBoundary,
  compileBundle,
  parseNativeJson
} from '../../../../src/connector/luvus/contract/index.js'
import { DEFAULT_LIMITS, snapshot } from '../../../../src/connector/luvus/contract/json.js'
import {
  auth,
  bytes,
  clone,
  G,
  identity,
  json,
  rejects,
  request,
  sourceFor,
  T,
  unwrap,
  validator,
  view
} from './helpers.js'

test(
  '聚焦复核：Check 成功但派发门禁拒绝不能转成候选/permit',
  /* 验证参数检查成功不产生派发许可，同形对象也不能冒充候选或许可。 */ () => {
    const candidate = request(view(), { id: 'review-gate', method: 'workspace.list', params: {} })
    rejects(checkDispatch(candidate, auth(candidate)), 'parameter_schema_incomplete')
    rejects(checkDispatch({ ...candidate } as any, auth(candidate)), 'invalid_request_handle')
    rejects(checkResultBoundary({ ...candidate } as any, {} as any), 'invalid_permit_handle')
  }
)

test(
  '聚焦复核：同名 native ID 的 provider/revision/source/旧 epoch 全链拒绝',
  /* 逐项修改来源锚点，确认响应与派发均拒绝身份混用。 */ () => {
    const candidate = request(view(), {
      id: 'review-source',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    })
    const permit = unwrap(checkDispatch(candidate, auth(candidate)))
    const response = { id: 'review-source', result: {} }
    for (const [field, value] of [
      ['provider_id', 'p2'],
      ['binding_revision', 2],
      ['contract_source_ref', 'other-source'],
      ['connection_epoch', 'old-epoch'],
      ['recovery_generation', 'old-recovery']
    ] as const) {
      const source: any = clone(sourceFor(candidate.binding))
      source.binding[field] = value
      rejects(validator.checkResponse(permit, response, source), 'native_identity_mismatch')
      rejects(checkDispatch(candidate, { ...auth(candidate), source }), 'capability_stale')
    }
    const untrusted = { ...sourceFor(candidate.binding), source_verified: false }
    rejects(validator.checkResponse(permit, response, untrusted), 'native_source_untrusted')
  }
)

test(
  '聚焦复核：累计字节预算在遍历中拒绝，Unicode/转义/标点计量准确',
  /* 核对累计字节预算可提前拒绝，且 Unicode、转义和标点均精确计费。 */ () => {
    const oversized = {
      id: 'review-bytes',
      method: 'ping',
      params: {
        batch: Array(100).fill('x'.repeat(16384)),
        tail: undefined
      }
    }
    rejects(validator.checkRequest(view(), oversized), 'object_limit')
    for (const value of [
      null,
      false,
      true,
      123.5,
      '测😀\n"\\\u0000\b\t\f\r\u2028',
      { '测\n': [null, true, 1.5, '😀'], nested: { empty: {} } }
    ]) {
      const exact = Buffer.byteLength(JSON.stringify(value))
      assert.deepEqual(snapshot(value, { ...DEFAULT_LIMITS, object_bytes: exact }), value)
      assert.throws(
        // 以比实际 JSON 少一字节的预算生成快照，触发边界拒绝。
        () => snapshot(value, { ...DEFAULT_LIMITS, object_bytes: exact - 1 }),
        // 确认抛出的失败来自对象字节预算。
        (error: any) => error.failure?.code === 'object_limit'
      )
    }
  }
)

test(
  '聚焦复核：schema 引用和结构资源预算实际拒绝，无 CPU 隔离虚假声明',
  /* 通过真实编译与解析反例覆盖文档、节点、引用及深度资源限制。 */ async () => {
    for (const limits of [
      { bundle_nodes: 32 },
      { documents: 28 },
      { document_bytes: 32 },
      { references: 1 },
      { reference_depth: 1 }
    ]) {
      rejects(await compileBundle(bytes, { identity, limits }), 'schema_unavailable')
    }
    const b = json('schema-bundle.json')
    b.extra_nodes = Array(150001).fill(null)
    const encoded = JSON.stringify(b)
    const checked = await compileBundle(encoded, {
      identity: { ...identity, schema_sha256: createHash('sha256').update(encoded).digest('hex') }
    })
    rejects(checked, 'schema_unavailable')
    if (!checked.ok) {
      assert.equal(checked.error.reason, 'bundle_limit')
    }
    rejects(parseNativeJson(JSON.stringify({ nodes: Array(32).fill(null) }), { object_nodes: 16 }), 'object_limit')
    rejects(parseNativeJson('['.repeat(65) + '0' + ']'.repeat(65)), 'object_limit')
    // 恶意引用/循环/超深链由原矩阵实际编译反例覆盖；不执行可能卡死的正则来冒充 worker 隔离验收。
  }
)

test(
  '聚焦复核：native 字段按完整结构保真，非法字段拒绝而不剥除',
  /* 验证合法原生扩展字段完整保留，非法字段拒绝且输入不被剥除或补默认值。 */ () => {
    const payload = JSON.parse(
      '{"__proto__":{"preserve":true},"nested":[null,false,1.25,"测😀"],"unknown_extension":{"keep":true}}'
    )
    const input = { id: 'review-native:1', method: 'ping', params: payload, auth: 'synthetic-only' }
    const candidate = request(view(), input)
    assert.deepEqual(candidate.request, input)
    const response = {
      id: input.id,
      error: {
        code: 'synthetic_extension',
        message: 'synthetic',
        data: payload,
        extra: { keep: true }
      }
    }
    assert.deepEqual(
      unwrap(validator.checkResponse(candidate, response, sourceFor(candidate.binding))).response,
      response
    )
    const invalid = { ...response, forbidden_root_extension: true }
    rejects(validator.checkResponseShape(invalid), 'native_response_invalid')
    assert.equal(invalid.forbidden_root_extension, true)
    const typed = {
      id: 'typed',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic', unknown_field: true }
    }
    rejects(validator.checkRequest(view(), typed), 'native_request_invalid')
    assert.equal(typed.params.unknown_field, true)
    const noDefaults = request(view(), {
      id: 'defaults',
      method: 'terminal.backend.control',
      params: { server_generation: G, terminal_id: T, pane_id: '3' }
    })
    const params = noDefaults.request.params
    assert(params !== null && typeof params === 'object')
    assert.equal(Object.hasOwn(params, 'ansi'), false)
  }
)
