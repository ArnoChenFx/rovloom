// 校验逐调用拒绝的协商、方向、固定错误码和独立完整 attempt 关联。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeWireFrame, negotiate, validateNegotiated } from '../../src/wire/index.js'
import { HerdrLocalError } from '../../src/connector/herdr/local.js'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import { ProviderAdapterError } from '../../src/connector/provider-error.js'
import { dispatchRefusal } from '../../src/transport/dispatch-refusal.js'
import { attempt, context, frame, rejects } from './helpers.js'

/** 保留既有独立测试锚点，只在已认证上下文显式启用可选拒绝能力。 */
function refusalContext() {
  const ctx = context('connector_to_gateway')
  ctx.connection.negotiated.capabilities.push('dispatch_refusal')
  return ctx
}

test(
  '逐调用拒绝只在双方协商 rpc 与 dispatch_refusal 后可用',
  /** 未广告、错误方向和多余字段均不能通过固定 envelope。 */ () => {
    const offer = { major: 2, minor: 0, capabilities: ['rpc', 'dispatch_refusal'], required: ['rpc'] }
    assert.deepEqual(negotiate(offer, offer).capabilities, ['dispatch_refusal', 'rpc'])
    assert.deepEqual(negotiate(offer, { ...offer, capabilities: ['rpc'] }).capabilities, ['rpc'])
    rejects(
      /** 单独广告拒绝能力不能绕过 RPC 依赖。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['dispatch_refusal'] }),
      'invalid_capabilities'
    )
    const message = frame('dispatch_refused', { attempt, code: 'terminal_execution_disabled' })
    const raw = JSON.stringify(message)
    assert.deepEqual(decodeWireFrame(raw, refusalContext()), message)
    rejects(
      /** 未协商能力不能发送新帧。 */ () => decodeWireFrame(raw, context('connector_to_gateway')),
      'unsupported_capability'
    )
    const wrong = refusalContext()
    wrong.direction = 'gateway_to_connector'
    rejects(/** 拒绝只能由 Connector 发往 Gateway。 */ () => decodeWireFrame(raw, wrong), 'wrong_direction')
    rejects(
      /** 额外原生响应或异常正文不属于此固定消息。 */ () =>
        decodeWireFrame(
          JSON.stringify({ ...message, payload: { ...message.payload, message: 'private' } }),
          refusalContext()
        ),
      'invalid_frame_fields'
    )
  }
)

test(
  '拒绝逐字段绑定原 attempt 与当前认证 epoch，不接受任意错误码',
  /** 独立锚点来自 fixture backend，不能由帧自身替换。 */ () => {
    const message = frame('dispatch_refused', { attempt, code: 'terminal_execution_disabled' })
    for (const change of [
      { call_id: 'wrong_call' },
      { attempt_id: 'wrong_attempt' },
      { native_request_id: 'wrong_native' },
      { binding_revision: 2 },
      { contract_ref: 'f'.repeat(64) },
      { registration: { ...attempt.registration, deadline: attempt.registration.deadline + 1 } }
    ]) {
      rejects(
        /** 每个修改都必须与原始完整 tuple 冲突。 */ () =>
          decodeWireFrame(
            JSON.stringify({ ...message, payload: { ...message.payload, attempt: { ...attempt, ...change } } }),
            refusalContext()
          ),
        'attempt_binding_mismatch'
      )
    }
    rejects(
      /** 已认证连接也不能接受旧 epoch。 */ () =>
        decodeWireFrame(JSON.stringify({ ...message, connection_epoch: 'old_epoch' }), refusalContext()),
      'connection_binding_mismatch'
    )
    rejects(
      /** 不把未知异常或原生错误解释成未写出证明。 */ () =>
        decodeWireFrame(
          JSON.stringify({ ...message, payload: { ...message.payload, code: 'native_timeout' } }),
          refusalContext()
        ),
      'invalid_enum'
    )
  }
)

test(
  '本机拒绝只接受对应 provider 的真实异常类型和确定未写出结果',
  /** 结构相似对象、普通异常、错 provider 和 outcome_unknown 均不能降级为确定拒绝。 */ () => {
    const code = 'terminal_execution_disabled'
    assert.equal(dispatchRefusal(new LuvusAdapterError(code), 'luvus'), code)
    assert.equal(dispatchRefusal(new HerdrLocalError(code), 'herdr'), code)
    for (const error of [
      new Error(code),
      { code, outcome: 'not_dispatched' },
      new LuvusAdapterError(code, 'outcome_unknown'),
      new LuvusAdapterError('native_timeout'),
      new HerdrLocalError(code)
    ]) {
      assert.equal(dispatchRefusal(error, 'luvus'), undefined)
    }
    // herdr-core 只接受自己执行前判定的固定码，且必须是确定未派发。
    for (const refusal of [
      'terminal_execution_disabled',
      'herdr_core_terminal_blocked',
      'herdr_core_terminal_identity_mismatch',
      'herdr_core_terminal_unavailable',
      'herdr_core_connection_closed'
    ] as const) {
      assert.equal(dispatchRefusal(new ProviderAdapterError(refusal), 'herdr-core'), refusal)
      assert.equal(dispatchRefusal(new ProviderAdapterError(refusal, 'outcome_unknown'), 'herdr-core'), undefined)
      assert.equal(dispatchRefusal(new ProviderAdapterError(refusal), 'herdr'), undefined)
    }
    // 已写出后才知道的失败不是未派发证明。
    for (const code of ['herdr_core_timeout', 'herdr_core_installation_changed', 'herdr_core_runtime_unavailable']) {
      assert.equal(dispatchRefusal(new ProviderAdapterError(code), 'herdr-core'), undefined)
    }
  }
)
