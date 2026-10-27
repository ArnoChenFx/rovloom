// 真实 Store/Router/HTTP SDK 验证离线拒绝；身份与后续派发端口明确为合成 fixture，不执行原生。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { projectionFixture } from './runtime-service-fixture.js'
import { httpFixture } from './http-fixture.js'
import { target } from './store-fixture.js'

test(
  'offline native admission reaches the SDK as unavailable without a call or dispatch',
  // 准入真实进入原唯一 writer；只读旁路核对行数，不写库、不重发已有意图。
  async () => {
    const f = projectionFixture()
    const reader = new DatabaseSync(f.path, { readOnly: true })
    let admissions = 0
    let preflights = 0
    let dispatchContinuations = 0
    const service = new RuntimeGatewayService({
      runtime: {
        ...f.runtime,
        // 使用原 Router 和 Store 的离线检查；不靠人为抛同名错误模拟映射。
        admit(input) {
          admissions++
          f.runtime.router.admit(
            f.runtime.principal(),
            input.target,
            input.native_request,
            input.options,
            // 离线拒绝必须先于原生请求预检，不形成任何 native 许可。
            () => {
              preflights++
            }
          )
          dispatchContinuations++
          throw new Error('synthetic_dispatch_must_not_run')
        }
      },
      identities: f.identities
    })
    const session = httpFixture(service, {
      authentication: {
        authenticate: /** 仅本例 HTTP 身份，不访问用户会话。 */ () => ({ principal_id: 'alice' })
      }
    })
    try {
      assert.equal(f.store.machine(target.machine_id).status, 'offline')
      const before = reader.prepare('SELECT count(*) AS n FROM calls').get()!.n
      const old = f.store.call('alice', 'call_fixture')
      await session.client.connect(session.transport, { timeout: 5000 })
      const result = await session.client.callTool({ name: 'runtime_call', arguments: f.args }, CallToolResultSchema, {
        timeout: 5000
      })
      assert.equal(result.isError, true)
      assert.deepEqual(result.structuredContent, { gateway_error: { code: 'unavailable' } })
      assert.equal(reader.prepare('SELECT count(*) AS n FROM calls').get()!.n, before)
      assert.deepEqual(f.store.call('alice', 'call_fixture'), old)
      assert.equal(admissions, 1)
      assert.equal(preflights, 0)
      assert.equal(dispatchContinuations, 0)
    } finally {
      await session.close()
      service.close()
      reader.close()
      f.close()
    }
  }
)
