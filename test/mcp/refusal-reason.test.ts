/** D3：确定未派发的固定原因码。内部码只映射到闭合集合，未知码不给原因。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CALL_REFUSAL_REASONS, callRefusalReason, publicCallView } from '../../src/mcp/call-view.js'
import type { Call } from '../../src/store.js'

test('每个内部拒绝码都映射到闭合集合里的原因，未知码不外泄', () => {
  const cases: [string, string][] = [
    ['terminal_execution_disabled', 'terminal_execution_disabled'],
    ['herdr_core_terminal_blocked', 'blocked'],
    ['herdr_core_native_blocked', 'blocked'],
    ['herdr_core_native_status_mismatch', 'status_mismatch'],
    ['herdr_core_native_finished', 'terminal_finished'],
    ['herdr_core_native_not_found', 'not_found'],
    ['herdr_core_native_machine_unknown', 'machine_unknown'],
    ['herdr_core_native_invalid_params', 'invalid_params'],
    ['herdr_core_terminal_identity_mismatch', 'fence_mismatch'],
    ['herdr_core_terminal_unavailable', 'terminal_unavailable'],
    ['herdr_core_template_unavailable', 'template_unavailable'],
    ['herdr_core_template_ambiguous', 'template_ambiguous'],
    ['herdr_core_run_capacity', 'capacity'],
    ['herdr_core_native_name_taken', 'name_taken'],
    ['herdr_core_native_conflict', 'conflict'],
    ['herdr_core_native_invalid_template', 'invalid_template'],
    ['herdr_core_connection_closed', 'unavailable'],
    // 登记前预检与编码阶段的参数拒绝都要有原因，不能只剩 not_dispatched。
    ['herdr_core_param_blocked', 'invalid_params'],
    ['herdr_core_terminal_address_unsupported', 'invalid_params'],
    ['herdr_core_terminal_fence_required', 'fence_mismatch'],
    ['herdr_core_core_id_required', 'invalid_params'],
    ['herdr_core_text_too_large', 'invalid_params']
  ]
  for (const [code, reason] of cases) {
    assert.equal(callRefusalReason(code), reason, code)
    assert.ok((CALL_REFUSAL_REASONS as readonly string[]).includes(reason))
  }
  for (const code of ['native_timeout', 'herdr_core_native_unavailable', 'unknown']) {
    assert.equal(callRefusalReason(code), undefined)
  }
  assert.equal(callRefusalReason(undefined), undefined)
})

test('调用视图只在有原因时带上 reason 字段', () => {
  const call = {
    call_id: 'call_a',
    target_json: JSON.stringify({ machine_id: 'm1', provider_id: 'herdr-core', profile: 'session', session: 'e2e' }),
    provider_kind: 'herdr-core',
    binding_revision: 1,
    state: 'not_dispatched',
    content_status: 'unavailable',
    content_expires: 1000
  } as unknown as Call
  assert.equal('reason' in publicCallView(call), false)
  assert.equal(publicCallView(call, 'blocked').reason, 'blocked')
})
