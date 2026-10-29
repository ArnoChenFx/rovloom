// 用真实编译句柄及合成可信来源验证 RPC 仅响应上下文的最小保留、身份绑定和权限边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDispatch,
  checkResultBoundary,
  compileBundle,
  createNativeValidator
} from '../../../../src/connector/luvus/contract/index.js'
import type { DispatchCandidate, DispatchPermit } from '../../../../src/connector/luvus/contract/index.js'
import { responseContexts } from '../../../../src/connector/luvus/contract/internal.js'
import {
  auth,
  bytes,
  clone,
  G,
  identity,
  json,
  rejects,
  request,
  source,
  sourceFor,
  unwrap,
  validator,
  view
} from './helpers.js'

// 使用真实能力、请求和授权句柄配合合成来源生成 RPC 许可，供封存与释放测试使用。
function dispatched(
  method = 'task.add',
  params: Record<string, unknown> = { title: 'synthetic', prompt: 'synthetic-request-secret' }
) {
  const candidate = request(view(), { id: 'response-context', method, params })
  const authorization = auth(candidate)
  const permit = unwrap(checkDispatch(candidate, authorization))
  return { candidate, permit, authorization, source: sourceFor(candidate.binding) }
}

test(
  '已校验 RPC 响应封存后，仅响应密封句柄仍可校验',
  /* 封存最小响应约束后，用密封句柄校验同一响应。 */ () => {
    const original = dispatched()
    const checked = unwrap(
      validator.checkResponse(original.permit, { id: 'response-context', result: { id: 'synthetic' } }, original.source)
    )
    const sealed = unwrap(validator.sealResponseContext(original.permit))
    assert.equal(checked.response.id, 'response-context')
    assert.equal(unwrap(validator.checkResponseOnly(sealed, checked.response, original.source)), undefined)
    unwrap(validator.releaseResponseContext(sealed))
  }
)

test(
  '真实 permit seal 后只保留最小响应约束并验证 metadata-only，不授予执行或读取',
  /* 密封后核对私有保留字段，分别尝试读取和派发以证明权限没有随元数据保留。 */ () => {
    const original = dispatched()
    const sealed = unwrap(validator.sealResponseContext(original.permit))
    const retained = responseContexts.get(sealed)!
    assert(sealed.retained_bytes > 0)
    assert(!JSON.stringify(retained).includes('synthetic-request-secret'))
    for (const forbidden of ['request', 'params', 'permit', 'candidate', 'capabilities', 'view']) {
      assert(!Object.hasOwn(retained, forbidden))
    }
    const response = { id: 'response-context', result: { text: 'synthetic-output-secret' } }
    assert.equal(unwrap(validator.checkResponseOnly(sealed, response, original.source)), undefined)
    assert(!JSON.stringify(sealed).includes('synthetic-output-secret'))
    rejects(checkDispatch(sealed as unknown as DispatchCandidate, original.authorization), 'invalid_request_handle')
    rejects(checkResultBoundary(sealed as unknown as DispatchPermit, {} as never), 'invalid_permit_handle')
    rejects(validator.checkResponseOnly(clone(sealed), response, original.source), 'invalid_response_context')
    unwrap(validator.releaseResponseContext(sealed))
    rejects(validator.checkResponseOnly(sealed, response, original.source), 'invalid_response_context')
  }
)

test(
  '仅响应上下文逐项复核完整原生来源、原 ID 和原契约，不从同摘要重建',
  /* 篡改合成来源绑定、请求 ID 与契约对象，确认封存上下文只认可原句柄和完整匹配的可信来源输入。 */ async () => {
    const original = dispatched()
    const sealed = unwrap(validator.sealResponseContext(original.permit))
    const response = { id: 'response-context', result: { id: 'task-created' } }
    for (const field of [
      'provider_id',
      'connection_epoch',
      'recovery_generation',
      'contract_source_ref',
      'capability_revision',
      'classification_revision'
    ] as const) {
      const changed = clone(original.source)
      Object.assign(changed.binding, { [field]: 'different' })
      rejects(validator.checkResponseOnly(sealed, response, changed), 'native_identity_mismatch')
    }
    const changedRevision = { ...original.source, binding: { ...original.source.binding, binding_revision: '1' } }
    rejects(validator.checkResponseOnly(sealed, response, changedRevision), 'native_identity_mismatch')
    rejects(
      validator.checkResponseOnly(sealed, { ...response, id: 'different' }, original.source),
      'native_id_mismatch'
    )
    rejects(
      validator.checkResponseOnly(sealed, response, { ...original.source, source_verified: false }),
      'native_source_untrusted'
    )
    const other = createNativeValidator(unwrap(await compileBundle(bytes, { identity })))
    rejects(other.sealResponseContext(original.permit), 'invalid_capability_handle')
    rejects(other.checkResponseOnly(sealed, response, original.source), 'invalid_response_context')
    unwrap(validator.releaseResponseContext(sealed))
  }
)

test(
  'seal 固定在线帧预算含 LF，原 capabilities 变更后仍检查精确字节边界',
  /* 封存含多字节响应的精确帧预算，篡改原始广告仍不影响含 LF 的字节检查。 */ () => {
    const response = { id: 'frame-context', result: { text: '汉😀'.repeat(80) } }
    const frameBytes = Buffer.byteLength(JSON.stringify(response)) + 1
    for (const maxBytes of [frameBytes, frameBytes - 1]) {
      const caps = json('session-capabilities.json')
      caps.result.session = 'synthetic'
      caps.result.server_generation = G
      caps.result.limits.frame_bytes = maxBytes
      const from = unwrap(validator.bindCapabilities(caps, source()))
      const candidate = request(from, { id: 'frame-context', method: 'task.add', params: { title: 's' } })
      const permit = unwrap(checkDispatch(candidate, auth(candidate)))
      const sealed = unwrap(validator.sealResponseContext(permit))
      caps.result.limits.frame_bytes = 1_048_576
      const checked = validator.checkResponseOnly(sealed, response, sourceFor(candidate.binding))
      if (maxBytes === frameBytes) {
        unwrap(checked)
      } else {
        rejects(checked, 'native_response_invalid')
      }
      unwrap(validator.releaseResponseContext(sealed))
    }
  }
)

test(
  '终端 RPC 最小 matcher 保留原生 ID 约束与 method-result',
  /* 用终端快照核对结果类型和代次，。 */ () => {
    const original = dispatched('terminal.backend.snapshot', {})
    const sealed = unwrap(validator.sealResponseContext(original.permit))
    const response = {
      id: 'response-context',
      result: {
        type: 'terminal_backend_snapshot',
        server_generation: G,
        event_sequence: 0,
        terminals: [],
        truncated: false
      }
    }
    unwrap(validator.checkResponseOnly(sealed, response, original.source))
    rejects(
      validator.checkResponseOnly(
        sealed,
        { ...response, result: { ...response.result, server_generation: '2'.repeat(32) } },
        original.source
      ),
      'native_identity_mismatch'
    )
    rejects(
      validator.checkResponseOnly(
        sealed,
        { ...response, result: { type: 'terminal_backend_validation', state: 'alive' } },
        original.source
      ),
      'native_result_mismatch'
    )
    unwrap(validator.releaseResponseContext(sealed))
  }
)
