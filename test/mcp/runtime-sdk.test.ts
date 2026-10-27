// 经真实HTTP SDK和角色工厂验证MCP接线；身份、策略及自建native listener均是隔离fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { httpFixture } from './http-fixture.js'
import { sdkTestLifecycle } from './sdk-lifecycle.js'

// 对照结构化和文本副本后读取数据，避免网关改写原生结果时仍让测试通过。
function data(value: unknown): Record<string, unknown> {
  const reply = CallToolResultSchema.parse(value)
  assert(!reply.isError, JSON.stringify(reply.structuredContent))
  assert(reply.structuredContent)
  assert(reply.content[0]?.type === 'text')
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent)
  return reply.structuredContent.data as Record<string, unknown>
}

test(
  '真实HTTP SDK接实际runtime准入、去重、原Wire结果分页、显式取消及撤权',
  { timeout: 30_000 },
  /* 动态加载真实native fixture；其编译失败照常报告，不用stub或缓存替代。 */ async (testContext) => {
    const lifecycle = sdkTestLifecycle(testContext, 'runtime-sdk', 30_000)
    return lifecycle.run(
      /** 模块、fixture和请求主体都归本测试，after等待其实际收尾。 */ async () => {
        const { runtimeFixture } = await lifecycle.load(
          /** 中止后的import不再交付工厂。 */ () => import('../runtime/helpers.js')
        )
        lifecycle.signal.throwIfAborted()
        lifecycle.phase('fixture_open')
        const f = await lifecycle.acquire(
          'runtime',
          runtimeFixture,
          /** 迟到fixture交回同一清理栈。 */ (value) => value.close()
        )
        const service = new RuntimeGatewayService({
          runtime: f.gateway,
          identities: {
            principal: /* 复用已进入fixture runtime的当前身份，不给SDK创建第二份权限。 */ (caller) => {
              const principal = f.gateway.principal()
              return principal.id === caller.principal_id ? principal : null
            },
            administrator: /* 普通测试caller没有管理会话，不能通过此组合获得管理权限。 */ () => null
          }
        })
        await lifecycle.own('service', /** facade service只关闭自己的等待/游标。 */ () => service.close())
        const http = httpFixture(lifecycle.service(service), {
          authentication: {
            authenticate: /* 仅本用例自建listener认识的合成HTTP身份。 */ () => f.caller
          }
        })
        await lifecycle.own('http', /** 先关闭真实SDK和HTTP，再关闭服务及双库角色。 */ () => http.close())
        const invoke = /** 所有SDK请求服从同一原测试期限，输入与原断言保持不变。 */ (
          request: Parameters<typeof http.client.callTool>[0]
        ) =>
          lifecycle.call(
            request.name,
            /** 请求只发送一次，不由诊断重试。 */ () =>
              http.client.callTool(request, CallToolResultSchema, lifecycle.options())
          )
        try {
          lifecycle.phase('ready')
          await lifecycle.wait(f.ready(lifecycle.signal))
          lifecycle.phase('http_connect')
          await lifecycle.call(
            'initialize',
            /** 初始化同样不遗留超过测试期限的默认SDK等待。 */ () =>
              http.client.connect(http.transport, lifecycle.options())
          )
          const args = {
            target: f.target,
            expected_binding_revision: 1,
            contract_ref: f.reference,
            native_request: { method: 'task.add', params: { title: 'synthetic_mcp' } },
            deadline: f.state.store.clock() + 25_000,
            wait_ms: 5000,
            client_request_key: 'mcp_one_intent'
          }
          lifecycle.phase('stale_contract')
          const refused = await invoke({
            name: 'runtime_call',
            arguments: { ...args, contract_ref: '0'.repeat(64) }
          })
          assert.equal(refused.isError, true)
          assert.deepEqual(refused.structuredContent, { gateway_error: { code: 'contract_unavailable' } })
          const reader = new DatabaseSync(join(f.native.root, 'gateway/gateway.db'), { readOnly: true })
          try {
            assert.equal(reader.prepare('SELECT count(*) AS n FROM calls').get()!.n, 0)
          } finally {
            reader.close()
          }
          assert.equal(f.claims(), 0)
          assert.equal(f.native.state.responses, 0)
          assert.equal(f.connector.transport.status().phase, 'ready')
          lifecycle.phase('call')
          const call = data(await invoke({ name: 'runtime_call', arguments: args }))
          lifecycle.phase('duplicate')
          const duplicate = data(await invoke({ name: 'runtime_call', arguments: args }))
          assert.equal(duplicate.call_id, call.call_id)
          assert.equal(call.state, 'responded')
          assert.equal(call.contract_ref, f.reference)
          assert.equal(f.native.state.responses, 1)
          assert.equal(f.claims(), 1)
          const result = call.result as { result_id: string; bytes: number; expires_at: number }
          assert(result.result_id)
          const chunks: Buffer[] = []
          let cursor: string | undefined
          let firstNext: string | undefined
          let bytesRead = 0
          do {
            lifecycle.phase('result_page')
            const page = data(
              await invoke({
                name: 'runtime_result_read',
                arguments: { result_id: result.result_id, max_bytes: 32, ...(cursor ? { cursor } : {}) }
              })
            )
            assert.equal(page.expires_at, result.expires_at)
            assert.equal(page.encoding, 'base64')
            const chunk = Buffer.from(page.chunk as string, 'base64')
            assert(chunk.byteLength > 0 && chunk.byteLength <= 32)
            bytesRead += chunk.byteLength
            assert(bytesRead <= result.bytes)
            assert.equal(page.eof, bytesRead === result.bytes)
            chunks.push(chunk)
            if (!cursor) {
              firstNext = page.next_cursor as string | undefined
            }
            cursor = page.next_cursor as string | undefined
          } while (cursor)
          assert(chunks.length > 1)
          assert.equal(Buffer.concat(chunks).byteLength, result.bytes)
          assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()).error, f.native.response.error)
          assert(firstNext)
          // 同一已连接 SDK 会话中实时收窄到零设备，既有结果和新调用都必须拒绝。
          f.deviceScope([])
          const hidden = data(await invoke({ name: 'machines_list', arguments: {} }))
          assert.deepEqual(hidden.items, [])
          for (const request of [
            { name: 'runtime_call', arguments: { ...args, client_request_key: 'denied_scope' } },
            { name: 'runtime_call_get', arguments: { call_id: call.call_id } },
            { name: 'runtime_result_read', arguments: { result_id: result.result_id } },
            { name: 'runtime_call_cancel', arguments: { call_id: call.call_id } }
          ]) {
            const denied = await invoke(request)
            assert.deepEqual(denied.structuredContent, { gateway_error: { code: 'forbidden' } })
          }
          assert.equal(f.native.state.responses, 1)
          f.deviceScope(undefined)
          assert.equal(
            data(await invoke({ name: 'runtime_call_get', arguments: { call_id: call.call_id } })).call_id,
            call.call_id
          )
          lifecycle.phase('changed_cursor')
          const changedPage = await invoke({
            name: 'runtime_result_read',
            arguments: { result_id: result.result_id, max_bytes: 64, cursor: firstNext }
          })
          assert.deepEqual(changedPage.structuredContent, { gateway_error: { code: 'invalid_cursor' } })
          lifecycle.phase('cancel')
          const cancelled = data(
            await invoke({
              name: 'runtime_call_cancel',
              arguments: { call_id: call.call_id }
            })
          )
          assert.equal(cancelled.cancellation, 'unsupported')
          assert.equal(f.native.state.responses, 1)
          f.deviceScope([])
          assert.equal(
            await f.gateway.runAuthenticated(
              f.caller,
              /** 只撤销read，当前主体仍真实有效。 */ () => f.gateway.principal().id
            ),
            f.caller.principal_id
          )
          const unreadable = await invoke({ name: 'runtime_result_read', arguments: { result_id: result.result_id } })
          assert.deepEqual(unreadable.structuredContent, { gateway_error: { code: 'forbidden' } })
          f.deviceScope(undefined)
          f.authorize(false)
          lifecycle.phase('revoked_read')
          const denied = await invoke({
            name: 'runtime_result_read',
            arguments: { result_id: result.result_id }
          })
          assert.deepEqual(denied.structuredContent, { gateway_error: { code: 'unauthenticated' } })
          lifecycle.phase('client_close')
          await http.client.close()
          assert.equal(f.gateway.transport.status().stopped, false)
          assert.equal(f.state.store.health().mode, 'active')
          lifecycle.phase('complete')
          lifecycle.complete()
        } finally {
          await lifecycle.close()
        }
      }
    )
  }
)
