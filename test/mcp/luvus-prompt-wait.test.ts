// 原生回包为合成数据；用真实 HTTP/Wire/IPC 验证观察超时不被改写为调用失败或完成证据。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { runtimeFixture } from '../runtime/helpers.js'
import { httpFixture } from './http-fixture.js'

test('prompt 等待超时保留原生证据，describe 提供两段式指导而非把 idle 兜底为完成', async () => {
  const params = { target: 'synthetic-agent', text: '13*7=?', strict: true, wait: true, until: ['idle'], timeout_s: 0 }
  const f = await runtimeFixture({}, undefined, { method: 'agent.prompt', params, validation: 'strict' })
  const service = new RuntimeGatewayService({ ...f.mcp, catalog: f.gateway.catalog })
  const http = httpFixture(service, { authentication: { authenticate: () => f.caller } })
  let observed: 'working' | null = null
  let status = 'idle'
  let original = ''
  const received: unknown[] = []
  try {
    f.native.respond((socket, raw) => {
      const request = JSON.parse(raw.trim())
      received.push(request.params)
      original = JSON.stringify({
        id: request.id,
        result: {
          type: 'agent_prompt',
          pane: '3',
          submitted: true,
          matched: false,
          status,
          baseline_revision: 10,
          content_revision: 12,
          evidence: 'timeout',
          observed_state: observed
        }
      })
      socket.end(original + '\n')
    })
    await f.ready()
    await http.client.connect(http.transport, { timeout: 5000 })
    const call = async (name: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(
        await http.client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 10_000 })
      )
    const route = { target: f.target, expected_binding_revision: 1 }
    const described = await call('runtime_describe', { ...route, method: 'agent.prompt' })
    const description = described.structuredContent!.data as {
      parameter_help: { source: string; rules: string[]; examples: Record<string, unknown>[] }
    }
    const help = description.parameter_help
    assert.equal(help.source, 'rovloom_reviewed_subset')
    assert(help.rules.some((rule) => rule.includes('observed_state:null') && rule.includes('Neither proves')))
    assert(help.rules.some((rule) => rule.includes('without wait') && rule.includes('Do not resend')))
    assert(
      help.rules.some(
        (rule) => rule.includes('fast-completing') && rule.includes('agent.wait') && rule.includes('agent.read')
      )
    )
    assert.equal(help.examples[0]!.wait, undefined)
    assert(help.rules.some((rule) => rule.includes('wait.output is not in the current authorized method catalog')))
    const listed = await call('runtime_discover', route)
    assert.deepEqual(
      (listed.structuredContent!.data as { items: { method: string }[] }).items.map((row) => row.method),
      ['agent.prompt']
    )
    for (const method of ['wait.output', 'nope.nope']) {
      const hidden = await call('runtime_describe', { ...route, method })
      assert.deepEqual(hidden.structuredContent, { gateway_error: { code: 'not_found' } })
    }
    const denied = await call('runtime_call', {
      ...route,
      contract_ref: f.reference,
      deadline: f.state.store.clock() + 30_000,
      native_request: { method: 'wait.output', params: { pane: '3', match: 'sentinel', timeout_s: 0 } }
    })
    assert.deepEqual(denied.structuredContent, { gateway_error: { code: 'forbidden' } })
    assert.equal(f.claims(), 0)
    assert.equal(f.native.state.responses, 0)
    const epoch = f.connector.transport.status().connection_epoch
    for (const scenario of [
      { observed: null, status: 'idle', until: ['idle'] },
      { observed: 'working', status: 'idle', until: ['idle'] },
      { observed: null, status: 'done', until: ['idle'] },
      { observed: null, status: 'done', until: ['working'] },
      { observed: null, status: 'done', until: ['done'] },
      { observed: null, status: 'done', until: ['done', 'idle'] }
    ] as const) {
      observed = scenario.observed
      status = scenario.status
      const requestParams = { ...params, until: scenario.until }
      const submitted = await call('runtime_call', {
        ...route,
        contract_ref: f.reference,
        deadline: f.state.store.clock() + 30_000,
        native_request: { method: 'agent.prompt', params: requestParams }
      })
      assert(!submitted.isError)
      const callId = (submitted.structuredContent!.data as { call_id: string }).call_id
      await f.responded(callId)
      const queried = await call('runtime_call_get', { call_id: callId })
      const view = queried.structuredContent!.data as { state: string; result: { result_id: string } }
      assert.equal(view.state, 'responded')
      const read = await call('runtime_result_read', { result_id: view.result.result_id })
      assert(!read.isError)
      const content = Buffer.from((read.structuredContent!.data as { chunk: string }).chunk, 'base64').toString()
      assert.deepEqual(JSON.parse(content), JSON.parse(original))
      assert.equal(JSON.parse(content).result.matched, false)
      assert.equal(JSON.parse(content).result.evidence, 'timeout')
      assert.equal(JSON.parse(content).result.status, scenario.status)
      assert.deepEqual(received.at(-1), requestParams)
    }
    assert.equal(f.native.state.responses, 6)
    assert.equal(f.connector.transport.status().connection_epoch, epoch)
  } finally {
    await http.close()
    service.close()
    await f.close()
  }
})
