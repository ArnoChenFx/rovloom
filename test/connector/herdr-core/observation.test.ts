/** 用假 core 核对观察档调用：参数规则先于原生请求，结果按审核 schema 校验并附终端三元组。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { NativeRequestPreflightError } from '../../../src/connector/preflight.js'
import { ProviderAdapterError } from '../../../src/connector/provider-error.js'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { createHerdrCoreObservation } from '../../../src/connector/herdr-core/observation.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { startFakeCore } from './fake-core.js'

const CONTRACT = compileHerdrCoreContract(
  readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
)

test('observation calls validate params and results and keep the terminal triple', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    const observation = createHerdrCoreObservation({ client, contract: CONTRACT })
    const status = await observation.call('server.status')
    assert.equal(status.result.version, '0.1.14')
    // server.status 没有终端事实，不能补造三元组。
    assert.equal(status.terminal, undefined)
    const listed = await observation.call('terminal.list')
    assert.deepEqual(listed.terminals, [{ core_id: '0f0e0d0c0b0a0908', created_ms: 1793335137041, address: 't1' }])
    const single = await observation.call('terminal.get', { terminal: 't1' })
    assert.deepEqual(single.terminal, { core_id: '0f0e0d0c0b0a0908', created_ms: 1793335137041, address: 't1' })
    const read = await observation.call('terminal.read', { terminal: 't1', lines: 0 })
    assert.equal(read.result.text, 'hello\n')
    assert.deepEqual(core.requests, ['server.status', 'terminal.list', 'terminal.get', 'terminal.read'])
    client.close()
  } finally {
    await core.close()
  }
})

test('blocked parameters never reach the core', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    const observation = createHerdrCoreObservation({ client, contract: CONTRACT })
    await assert.rejects(
      observation.call('terminal.get', { caller: 't2', terminal: 't1' }),
      /herdr_core_param_blocked/u
    )
    await assert.rejects(
      observation.call('terminal.read', { terminal: 't1', lines: 40 }),
      /herdr_core_read_history_unsupported/u
    )
    await assert.rejects(
      observation.call('terminal.send', { terminal: 't1', text: 'x' }),
      /herdr_core_method_unavailable/u
    )
    // 一次原生请求都没有发生：参数规则在发送之前。
    assert.deepEqual(core.requests, [])
    client.close()
  } finally {
    await core.close()
  }
})

test('a native result that does not match the reviewed schema is not treated as success', async () => {
  const core = await startFakeCore({
    handler: () => ({ terminals: [{ address: 't1' }], hidden_finished: 0 })
  })
  try {
    const client = await openHerdrCoreClient(core.socket)
    const observation = createHerdrCoreObservation({ client, contract: CONTRACT })
    await assert.rejects(
      observation.call('terminal.list'),
      (error: unknown) => error instanceof ProviderAdapterError && error.code === 'herdr_core_result_invalid'
    )
    client.close()
  } finally {
    await core.close()
  }
})

test('invalid params produce the public diagnostic shape, not a native error', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    const observation = createHerdrCoreObservation({ client, contract: CONTRACT })
    await assert.rejects(observation.call('terminal.get', { terminal: 5 }), (error: unknown) => {
      assert.ok(error instanceof NativeRequestPreflightError)
      assert.deepEqual(error.parameterDiagnostic, { issues: [{ path: '/terminal', rule: 'invalid_value' }] })
      return true
    })
    assert.deepEqual(core.requests, [])
    client.close()
  } finally {
    await core.close()
  }
})

test('wait timeout is bounded by the review rule, not by the request deadline', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    const observation = createHerdrCoreObservation({ client, contract: CONTRACT })
    await assert.rejects(
      observation.call('terminal.wait', { terminal: 't1', timeout: 120 }),
      /herdr_core_timeout_exceeds_limit/u
    )
    const waited = await observation.call('terminal.wait', { terminal: 't1', timeout: 0.2 })
    // timeout 只是 check-in：不能当作本轮完成。
    assert.equal(waited.result.ended, false)
    assert.equal(waited.result.reason, 'timeout')
    client.close()
  } finally {
    await core.close()
  }
})

test('wait accepts the whole reviewed range, including fractional seconds and the 60 s cap', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    const observation = createHerdrCoreObservation({ client, contract: CONTRACT })
    // 上限 60 秒是审核规则；请求期限要给检查间隔留余量，不能把合法值挡在客户端。
    for (const timeout of [1.2345, 56, 59.9, 60]) {
      const waited = await observation.call('terminal.wait', { terminal: 't1', timeout })
      assert.equal(waited.result.ended, false, String(timeout))
    }
    client.close()
  } finally {
    await core.close()
  }
})
