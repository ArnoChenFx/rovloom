/**
 * D1：core 返回 JSON-RPC 错误响应 = 已明确答复。核对过的类别确定没有写入，
 * 未核对的类别仍按 outcome_unknown 保守处理。
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import { HERDR_CORE_NATIVE_REJECTION_KINDS } from '../../../src/connector/herdr-core/methods.js'
import { callRefusalReason } from '../../../src/mcp/call-view.js'
import { fakeTerminal, startFakeCore } from './fake-core.js'
import { CREATED_MS, CORE_ID, OPENRPC, attachment, connection, fixture, request } from './connector-harness.js'

const DISCOVER = JSON.parse(OPENRPC.toString('utf8'))

async function executeWithError(kind: string) {
  const core = await startFakeCore({
    discover: DISCOVER,
    handler: (call) =>
      call.method === 'terminal.send'
        ? { error: { code: -32000, message: 'rejected', data: { kind } } }
        : call.method === 'terminal.get' || call.method === 'terminal.list'
          ? call.method === 'terminal.get'
            ? fakeTerminal()
            : { terminals: [fakeTerminal()], hidden_finished: 0 }
          : {}
  })
  const { root, config } = fixture(core)
  const resources = await createHerdrCoreConnectorResources({
    config,
    now: Date.now,
    allow_terminal_execution: true,
    open: async () => attachment(core)
  })
  try {
    const session = resources.session(connection())
    const raw = request('terminal.send', {
      terminal: 't1',
      core_id: CORE_ID,
      created_ms: CREATED_MS,
      text: 'x'
    })
    session.adapter.decode(raw, 'gateway_to_connector')
    try {
      await session.executeWire(raw, new AbortController().signal)
      assert.fail('expected rejection')
    } catch (error) {
      return error as { code?: string; outcome?: string }
    }
  } finally {
    await resources.release()
    await core.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('core 明确拒绝的类别是确定未派发，并带上 core 自己的类别', async () => {
  for (const kind of HERDR_CORE_NATIVE_REJECTION_KINDS) {
    const error = await executeWithError(kind)
    assert.equal(error.code, `herdr_core_native_${kind}`)
    assert.equal(error.outcome, 'not_dispatched', `${kind} must be deterministic`)
    // 公开原因来自闭合集合，控制端能据此决定下一步。
    assert.equal(callRefusalReason(error.code), kind === 'finished' ? 'terminal_finished' : kind)
  }
})

test('未核对的错误类别仍是 outcome_unknown，不假装确定', async () => {
  for (const kind of ['unavailable', 'config', 'internal', 'cancelled']) {
    const error = await executeWithError(kind)
    assert.equal(error.outcome, 'outcome_unknown', `${kind} must stay unknown`)
    // 未知类别不映射到公开原因，也不把内部码带出去。
    assert.equal(callRefusalReason(error.code), undefined)
  }
})
