// 真实 HTTP SDK、Gateway/Connector、双库和 IPC；native 行为为合成回包，不冒充真实模型或终端验收。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { runtimeFixture } from '../runtime/helpers.js'
import { until } from '../transport/helpers.js'
import { httpFixture } from './http-fixture.js'

test(
  '输出哨兵经真实 MCP/Wire/IPC 保留命中与未命中结果，非法参数不派发且读权限仍可撤销',
  { timeout: 45_000 },
  async () => {
    const params = { pane: '3', match: 'fresh_汉字_.*', timeout_s: 0.25 }
    const f = await runtimeFixture({}, undefined, { method: 'wait.output', params, validation: 'raw-contract' })
    const service = new RuntimeGatewayService({ ...f.mcp, catalog: f.catalog })
    const http = httpFixture(service, { authentication: { authenticate: () => f.caller } })
    const received: unknown[] = []
    try {
      f.native.respond((socket, raw) => {
        const request = JSON.parse(raw.trim())
        received.push(request.params)
        socket.end(
          JSON.stringify({
            id: request.id,
            result:
              request.params.match === params.match
                ? { type: 'wait', matched: true, pane: '3' }
                : { type: 'wait', matched: false }
          }) + '\n'
        )
      })
      await f.ready()
      await http.client.connect(http.transport, { timeout: 5000 })
      const call = async (name: string, args: Record<string, unknown>) =>
        CallToolResultSchema.parse(
          await http.client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 10_000 })
        )
      const route = { target: f.target, expected_binding_revision: 1 }
      const discovered = await call('runtime_discover', route)
      const methods = (discovered.structuredContent!.data as { items: { method: string }[] }).items
      assert.deepEqual(
        methods.map((method) => method.method),
        ['wait.output']
      )
      const described = await call('runtime_describe', { ...route, method: 'wait.output' })
      const description = described.structuredContent!.data as {
        schema_status: string
        params_schema?: unknown
        params_schema_source: string
        parameter_help: { source: string; required: string[] }
      }
      assert.equal(description.schema_status, 'generic_params_only')
      assert(description.params_schema)
      assert.equal(description.params_schema_source, 'rovloom_reviewed_subset')
      assert.equal(description.parameter_help.source, 'rovloom_reviewed_subset')
      assert.deepEqual(description.parameter_help.required, ['pane', 'match'])
      const input = { ...route, contract_ref: f.reference, deadline: f.state.store.clock() + 30_000 }
      const invalid = await call('runtime_call', {
        ...input,
        native_request: { method: 'wait.output', params: { pane: '3', timeout_ms: 1 } }
      })
      assert.equal(invalid.isError, true)
      assert.equal((invalid.structuredContent!.gateway_error as { code: string }).code, 'native_request_invalid')
      assert.equal(f.native.state.responses, 0)
      const epoch = f.connector.transport.status().connection_epoch
      let resultId = ''
      for (const matched of [true, false]) {
        const requestParams = matched ? params : { ...params, match: 'absent_marker', timeout_s: 0 }
        const submitted = await call('runtime_call', {
          ...input,
          native_request: { method: 'wait.output', params: requestParams }
        })
        assert(!submitted.isError)
        const callId = (submitted.structuredContent!.data as { call_id: string }).call_id
        await f.responded(callId)
        const queried = await call('runtime_call_get', { call_id: callId })
        const view = queried.structuredContent!.data as { state: string; result: { result_id: string } }
        assert.equal(view.state, 'responded')
        resultId = view.result.result_id
        const read = await call('runtime_result_read', { result_id: resultId })
        assert(!read.isError)
        const body = JSON.parse(
          Buffer.from((read.structuredContent!.data as { chunk: string }).chunk, 'base64').toString()
        )
        assert.deepEqual(
          body.result,
          matched ? { type: 'wait', matched: true, pane: '3' } : { type: 'wait', matched: false }
        )
        assert.deepEqual(received.at(-1), requestParams)
      }
      assert.equal(f.claims(), 2)
      assert.equal(f.connector.transport.status().connection_epoch, epoch)
      f.deviceScope([])
      const revoked = await call('runtime_result_read', { result_id: resultId })
      assert.equal(revoked.isError, true)
      assert.equal((revoked.structuredContent!.gateway_error as { code: string }).code, 'forbidden')
      await until(() => f.connector.transport.status().phase === 'ready')
    } finally {
      await http.close()
      service.close()
      await f.close()
    }
  }
)
