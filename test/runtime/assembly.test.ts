// 验证角色工厂经真实认证/Wire 的唯一派发、原结果门禁和独立生命周期；原生 listener 使用明确 fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runtimeFixture } from './helpers.js'
import { createTrustedRequestScope } from '../../src/runtime/request-scope.js'
import { until } from '../transport/helpers.js'

/** 重复 key 保持首次期限和单次原生发送，HTTP 请求结束后 Gateway 仍长期存活。 */
test(
  'runtime assembly keeps one dispatch and the original Wire result gate',
  { timeout: 45_000 },
  /** 只操作本 fixture 的短期凭据和自建 native listener。 */ async () => {
    const f = await runtimeFixture()
    try {
      await f.ready()
      await assert.rejects(
        f.gateway.runAuthenticated(
          f.caller,
          /** 配置只固定一个完整 session Target，不能用同 provider 改选另一会话。 */ () =>
            f.gateway.admit({
              target: { ...f.target, session: 'unconfigured_session' },
              native_request: { method: 'task.add', params: { title: 'synthetic' } },
              options: { binding_revision: 1, contract_ref: f.reference, deadline: f.state.store.clock() + 30_000 }
            })
        ),
        /provider_binding_mismatch/
      )
      assert.equal(f.native.state.responses, 0)
      assert.equal(f.claims(), 0)
      const input = {
        target: f.target,
        native_request: { method: 'task.add', params: { title: 'synthetic' } },
        options: {
          binding_revision: 1,
          contract_ref: f.reference,
          deadline: f.state.store.clock() + 30_000,
          client_request_key: 'one_intent'
        }
      }
      const first = await f.gateway.runAuthenticated(
        f.caller,
        /** 实际认证 adapter 的作用域内执行原子准入。 */ () => f.gateway.admit(input)
      )
      assert.equal(first.created, true)
      await f.responded(first.call.call_id)
      const duplicate = await f.gateway.runAuthenticated(
        f.caller,
        /** 重送原意图不刷新 deadline 或重新发送。 */ () => f.gateway.admit(input)
      )
      assert.equal(duplicate.created, false)
      assert.equal(duplicate.call.call_id, first.call.call_id)
      assert.equal(duplicate.call.deadline, input.options.deadline)
      assert.equal(duplicate.call.response, null)
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.claims(), 1)
      assert.throws(/** 作用域外不可借用最近 caller。 */ () => f.gateway.get(first.call.call_id), /unauthenticated/)
      const result = await f.gateway.runAuthenticated(
        f.caller,
        /** 只有原 Wire 当前读许可与保留许可均通过才创建句柄。 */ () => f.gateway.results.open(first.call.call_id)
      )
      const page = await f.gateway.runAuthenticated(
        f.caller,
        /** 每页重新校验实际句柄期限和原请求 Wire。 */ () => f.gateway.results.read(result.result_id)
      )
      const response = JSON.parse(Buffer.from(page.data, 'base64').toString())
      assert.deepEqual(response.error, f.native.response.error)
      f.authorize(false)
      await assert.rejects(
        f.gateway.runAuthenticated(
          f.caller,
          /** 已撤销 caller 不能继续读已拿到的句柄。 */ () => f.gateway.results.read(result.result_id)
        ),
        /unauthenticated/
      )
      f.authorize(true)
      await f.connector.close()
      await until(
        /** 等待服务器实际消费对端关闭事件，不把本机 stop 当远端已完成清理。 */ () =>
          f.gateway.transport.status().devices.length === 0
      )
      assert.equal(f.gateway.transport.status().stopped, false)
      assert.equal(f.state.store.health().mode, 'active')
      const offline = await f.gateway.runAuthenticated(f.caller, () => f.gateway.results.read(result.result_id))
      assert.deepEqual(offline, page)
    } finally {
      await f.close()
    }
  }
)

/** 并发请求和逃逸任务不能沿用另一 caller 或已经结束的请求身份。 */
test(
  'trusted request scope isolates callers and expires escaped async work',
  /** 并发执行两个已知合成 caller，并观察请求终结。 */ async () => {
    const source = {
      principal: /** 仅测试两个预先授权的合成主体。 */ (caller: { principal_id: string }) => ({
        id: caller.principal_id,
        policy: { revision: 'one', grants: [] }
      }),
      administrator: /** 此测试不提供管理员会话。 */ () => null
    }
    const scope = createTrustedRequestScope(source)
    let escaped!: () => string
    try {
      const seen = await Promise.all(
        ['alice', 'bob'].map(
          /** 各异步调用只可看到自己的受信 caller。 */ (id) =>
            scope.runAuthenticated(
              { principal_id: id },
              /** await 后仍绑定本请求，不能读取全局最近身份。 */ async () => {
                await Promise.resolve()
                if (id === 'alice') {
                  escaped = /** 延后执行时必须发现原请求已失效。 */ () => scope.principal().id
                }
                return scope.principal().id
              }
            )
        )
      )
      assert.deepEqual(seen, ['alice', 'bob'])
      assert.throws(/** 请求结束后即使闭包仍存在也不得使用旧身份。 */ () => escaped(), /unauthenticated/)
      scope.close()
      await assert.rejects(
        scope.runAuthenticated({ principal_id: 'alice' }, /** 关闭后不再开始新请求。 */ () => 1),
        /runtime_closed/
      )
    } finally {
      scope.close()
    }
  }
)
