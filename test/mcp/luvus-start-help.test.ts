// 真实 HTTP/Wire/IPC 验证登记前诊断与可选 pane 透传；原生响应为合成数据，不启动真实 Agent。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { runtimeFixture } from '../runtime/helpers.js'
import { httpFixture } from './http-fixture.js'

test('agent.start 名称诊断可定位、describe 说明可选 pane，纠正后同 key 只派发一次', async () => {
  const params = { name: 'worker', kind: 'pi' }
  const f = await runtimeFixture({}, undefined, { method: 'agent.start', params, validation: 'raw-contract' })
  const service = new RuntimeGatewayService({ ...f.mcp, catalog: f.catalog })
  const http = httpFixture(service, { authentication: { authenticate: () => f.caller } })
  const reader = new DatabaseSync(join(f.native.root, 'gateway/gateway.db'), { readOnly: true })
  const received: unknown[] = []
  let original = ''
  try {
    f.native.respond((socket, raw) => {
      const request = JSON.parse(raw.trim())
      received.push(request.params)
      original = JSON.stringify({
        id: request.id,
        result: { type: 'agent_start', name: 'worker', kind: 'pi', pane: '10', ready: true, status: 'working' }
      })
      socket.end(original + '\n')
    })
    await f.ready()
    await http.client.connect(http.transport, { timeout: 5000 })
    const call = async (name: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(
        await http.client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 10000 })
      )
    const route = { target: f.target, expected_binding_revision: 1 }
    const input = {
      ...route,
      contract_ref: f.reference,
      deadline: f.state.store.clock() + 30000,
      client_request_key: 'corrected_start',
      wait_ms: 2000
    }
    const epoch = f.connector.transport.status().connection_epoch
    const invalid = await call('runtime_call', {
      ...input,
      native_request: { method: 'agent.start', params: { ...params, name: 'wA' } }
    })
    assert.equal(invalid.isError, true)
    const error = invalid.structuredContent!.gateway_error as {
      code: string
      outcome: string
      details: { issues: unknown[]; parameter_help: unknown }
    }
    assert.equal(error.code, 'native_request_invalid')
    assert.equal(error.outcome, 'not_dispatched')
    assert(error.details, 'agent.start rejection must include field diagnostics')
    assert.deepEqual(error.details.issues, [{ path: '/params/name', rule: 'pattern' }])
    const described = await call('runtime_describe', { ...route, method: 'agent.start' })
    const description = described.structuredContent!.data as {
      schema_status: string
      params_schema?: unknown
      parameter_help: { required: string[]; optional: string[]; rules: string[] }
    }
    assert.equal(description.schema_status, 'generic_params_only')
    assert.equal(description.params_schema, undefined)
    assert.deepEqual(description.parameter_help.required, ['name', 'kind'])
    assert(description.parameter_help.optional.includes('pane'))
    assert(description.parameter_help.rules.some((rule) => rule.includes('Omitting pane creates a new pane')))
    assert.deepEqual(error.details.parameter_help, description.parameter_help)
    assert(!JSON.stringify(invalid.structuredContent).includes('wA'))
    assert.equal(reader.prepare('SELECT count(*) AS n FROM calls').get()!.n, 0)
    assert.equal(f.claims(), 0)
    assert.equal(f.native.state.responses, 0)
    const args = { ...input, native_request: { method: 'agent.start', params } }
    const accepted = await call('runtime_call', args)
    assert(!accepted.isError, JSON.stringify(accepted.structuredContent))
    const view = accepted.structuredContent!.data as { call_id: string; state: string; result: { result_id: string } }
    assert.equal(view.state, 'responded')
    const result = await call('runtime_result_read', { result_id: view.result.result_id })
    const content = Buffer.from((result.structuredContent!.data as { chunk: string }).chunk, 'base64').toString()
    assert.deepEqual(JSON.parse(content), JSON.parse(original))
    const duplicate = await call('runtime_call', args)
    assert.equal((duplicate.structuredContent!.data as { call_id: string }).call_id, view.call_id)
    assert.deepEqual(received, [params])
    assert.equal(f.claims(), 1)
    assert.equal(f.native.state.responses, 1)
    assert.equal(f.connector.transport.status().connection_epoch, epoch)
  } finally {
    reader.close()
    await http.close()
    service.close()
    await f.close()
  }
})
