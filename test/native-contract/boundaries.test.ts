// 验证静态方法表、raw 授权、结果读取/保留门禁，以及可信绑定与编译输入的拒绝边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { checkDispatch, checkResultBoundary, compileBundle } from '../../src/native-contract/index.js'
import { checkResultRetention } from '../../src/native-contract/safety.js'
import {
  auth,
  bytes,
  clone,
  G,
  identity,
  json,
  raw,
  rejects,
  request,
  source,
  sourceFor,
  unwrap,
  validator,
  view
} from './helpers.js'

test(
  '不在静态方法表中的方法一律拒绝，raw 模式也不能代替',
  /* 容器方法、token、终端和未来方法即使在线广告并以 raw 模式提交也不可派发。 */ () => {
    const caps = json('session-capabilities.json')
    caps.result.session = 'synthetic'
    caps.result.server_generation = G
    caps.result.methods.push('future.synthetic')
    caps.result.method_contracts.push({ method: 'future.synthetic', scope: 'read', access: 'read', idempotent: true })
    const discovered = unwrap(validator.bindCapabilities(caps, source()))
    assert.equal(unwrap(validator.describe(discovered, 'future.synthetic')).transport, 'unclassified')
    for (const [method, params] of [
      ['future.synthetic', { synthetic: true }],
      ['ping', {}],
      ['module.action.invoke', { action: 'reviewed' }],
      ['uhp.token.create', { scopes: ['read'] }]
    ] as const) {
      const candidate = request(discovered, { id: 'unlisted', method, params }, true)
      rejects(checkDispatch(candidate, auth(candidate)), 'method_not_listed')
      rejects(checkDispatch(candidate, raw(candidate)), 'method_not_listed')
    }
    const candidate = request(discovered, { id: 'future', method: 'future.synthetic', params: {} }, true)
    assert.equal(candidate.validation, 'unavailable')
  }
)

test(
  '实际安装契约广告的原生提示必须与静态表一致',
  /* 把写方法广告成读方法、改幂等性或篡改 scope 都会使该方法失效，其它方法保持健康。 */ () => {
    for (const change of [{ access: 'read' }, { idempotent: true }, { scope: 'admin' }] as const) {
      const caps = json('session-capabilities.json')
      caps.result.session = 'synthetic'
      caps.result.server_generation = G
      Object.assign(
        caps.result.method_contracts.find(/* 选出被篡改提示的方法。 */ (row: any) => row.method === 'agent.prompt'),
        change
      )
      const changed = unwrap(validator.bindCapabilities(caps, source()))
      const candidate = request(changed, {
        id: 'prompt',
        method: 'agent.prompt',
        params: { target: '3', text: 'synthetic' }
      })
      rejects(checkDispatch(candidate, auth(candidate)), 'method_contract_mismatch')
    }
    const candidate = request(view(), {
      id: 'prompt',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    })
    unwrap(checkDispatch(candidate, auth(candidate)))
  }
)

test(
  '结果读取按派发主体和内容状态检查',
  /* 验证结果读取只给原主体，内容不可用时拒绝。 */ () => {
    const candidate = request(view(), { id: 'result', method: 'task.add', params: { title: 'synthetic' } })
    const permit = unwrap(checkDispatch(candidate, auth(candidate)))
    const ok = {
      principal_id: 'synthetic',
      content_status: 'available' as const
    }
    unwrap(checkResultBoundary(permit, ok))
    rejects(checkResultBoundary(clone(permit), ok), 'invalid_permit_handle')
    rejects(checkResultBoundary(permit, { ...ok, principal_id: 'other' }), 'forbidden')
    rejects(checkResultBoundary(permit, { ...ok, content_status: 'expired' }), 'content_unavailable')
    rejects(checkResultBoundary(permit, { ...ok, content_status: 'discarded' }), 'content_unavailable')
  }
)

test(
  '保留门禁不接受复制 permit、其它 principal 或过时来源',
  /* 验证保留门禁拒绝伪造许可、错误主体以及与派发时不同的当前来源。 */ () => {
    const candidate = request(view(), { id: 'retention', method: 'task.add', params: { title: 'synthetic' } })
    const context = auth(candidate)
    const permit = unwrap(checkDispatch(candidate, context))
    unwrap(checkResultRetention(permit, context))
    rejects(checkResultRetention(clone(permit), context), 'invalid_permit_handle')
    rejects(checkResultRetention(permit, { ...context, principal_id: 'other' }), 'forbidden')
    const stale = clone(context)
    rejects(
      checkResultRetention(permit, {
        ...stale,
        source: {
          ...stale.source,
          binding: { ...stale.source.binding, capability_revision: 'stale' }
        }
      }),
      'capability_stale'
    )
  }
)

test(
  '输入不可变快照与所有响应来源锚点，不能用接收时自报字段串调用',
  /* 验证请求快照不受后续变更影响，并逐项拒绝响应来源锚点变化。 */ () => {
    const input: any = {
      id: 'snapshot',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    }
    const checked = request(view(), input)
    input.params.text = 'changed'
    assert.equal((checked.request.params as any).text, 'synthetic')
    assert(Object.isFrozen(checked.request.params))
    const response = { id: 'snapshot', result: {} }
    for (const field of ['recovery_generation', 'connection_epoch', 'server_generation'] as const) {
      const trusted: any = clone(sourceFor(checked.binding))
      trusted.binding[field] += '-different'
      rejects(validator.checkResponse(checked, response, trusted), 'native_identity_mismatch')
    }
    const otherRuntime: any = clone(sourceFor(checked.binding))
    otherRuntime.binding.contract.schema_sha256 = '3'.repeat(64)
    rejects(validator.checkResponse(checked, response, otherRuntime), 'native_identity_mismatch')
    for (const [field, value] of [
      ['provider_id', 'p2'],
      ['binding_revision', 2],
      ['contract_source_ref', 'different-reviewed-source']
    ] as const) {
      const other: any = clone(sourceFor(checked.binding))
      other.binding[field] = value
      rejects(validator.checkResponse(checked, response, other), 'native_identity_mismatch')
    }
    const wrongKind: any = clone(sourceFor(checked.binding))
    wrongKind.binding.kind = 'herdr'
    rejects(validator.checkResponse(checked, response, wrongKind), 'native_source_untrusted')
  }
)

test(
  'schema 关键字/别名/字节预算 fail closed，不把未引用原生属性字典当约束',
  /* 构造未知关键字、非法属性字典引用及字节预算反例，确认编译保守拒绝。 */ async () => {
    const b = json('schema-bundle.json')
    const uri = 'https://luvus.dev/protocol/uhp/v1/request.schema.json'
    b.documents[uri].synthetic_future_keyword = true
    let encoded = JSON.stringify(b)
    // 按当前序列化内容重算 schema 摘要，避免摘要检查遮蔽待测编译失败。
    const changedIdentity = () => ({
      ...identity,
      schema_sha256: createHash('sha256').update(encoded).digest('hex')
    })
    rejects(await compileBundle(encoded, { identity: changedIdentity() }), 'schema_unavailable')
    const original = json('schema-bundle.json')
    original.documents[uri].allOf[0].then.properties.params.$ref =
      'https://luvus.dev/protocol/uhp/v1/schema/terminal/common.schema.json#/$defs/locatorProperties'
    encoded = JSON.stringify(original)
    const bad = await compileBundle(encoded, { identity: changedIdentity() })
    rejects(bad, 'schema_unavailable')
    if (!bad.ok) {
      assert.equal(bad.error.reason, 'unsupported_reference')
    }
    rejects(await compileBundle(bytes, { identity, limits: { bundle_bytes: 16 } }), 'schema_unavailable')
    rejects(await compileBundle(bytes, { identity, limits: { bundle_bytes: 2_097_153 } }), 'invalid_limits')
  }
)
