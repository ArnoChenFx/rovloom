// 验证登记后的真实 transport 失败仍可对账；不返回未经当前身份和读取策略复核的调用引用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runtimeFixture } from './helpers.js'
import { until } from '../transport/helpers.js'

/** 固定原 deadline，只有显式提供历史 key 时才启用已有的持久去重。 */
function input(f: Awaited<ReturnType<typeof runtimeFixture>>, client_request_key?: string) {
  return {
    target: f.target,
    native_request: { method: 'task.add', params: { title: 'synthetic' } },
    options: {
      binding_revision: 1,
      contract_ref: f.reference,
      deadline: f.state.store.clock() + 30_000,
      ...(client_request_key ? { client_request_key } : {})
    }
  }
}

for (const unavailable of ['connection', 'provider'] as const) {
  test(
    `registered call without history remains queryable when ${unavailable} is unavailable`,
    { timeout: 45_000 },
    /** 锚点前断连由 Store 标为 not_dispatched，readiness 拒绝仍为 created，均返回实际持久状态。 */ async () => {
      const f = await runtimeFixture()
      try {
        await f.ready()
        if (unavailable === 'connection') {
          const dispatch = f.gateway.transport.dispatch
          f.gateway.transport.dispatch = /** 先完成真实登记，再从真实服务器关闭连接，覆盖登记与派发之间的断连竞态。 */ (
            callId
          ) => {
            f.gateway.transport.disconnect(f.target.machine_id)
            return dispatch(callId)
          }
        } else {
          f.native.state.active = false
        }
        const request = input(f)
        const admitted = await f.gateway.runAuthenticated(
          f.caller,
          /** 已登记调用不因随后发送前失败而丢失唯一引用。 */ () => f.gateway.admit(request)
        )
        assert.equal(admitted.created, true)
        assert.equal(admitted.call.state, unavailable === 'connection' ? 'not_dispatched' : 'created')
        assert.equal(admitted.call.attempt_id, null)
        assert.equal(admitted.call.deadline, request.options.deadline)
        assert.equal(admitted.call.response, null)
        const current = await f.gateway.runAuthenticated(
          f.caller,
          /** 无历史 key 仍可凭首次返回的 ID 对账。 */ () => f.gateway.get(admitted.call.call_id)
        )
        assert.equal(current.call_id, admitted.call.call_id)
        assert.equal(current.state, admitted.call.state)
        assert.equal(f.claims(), 0)
        assert.equal(f.native.state.responses, 0)
        assert.equal(f.gateway.transport.status().stopped, false)
      } finally {
        await f.close()
      }
    }
  )
}

test(
  'full transport returns the original registered call and duplicate admission never dispatches it',
  { timeout: 45_000 },
  /** 以真实未完成调用占满唯一 inflight，第二次登记不能偷取发送机会或刷新期限。 */ async () => {
    const f = await runtimeFixture({ inflight: 1 })
    try {
      await f.ready()
      f.native.respond(/** 保留真实 fixture socket，故意不回应以占用当前发送槽。 */ () => {})
      await f.gateway.runAuthenticated(
        f.caller,
        /** 第一个调用实际经 Wire/native 消耗一个 claim。 */ () => f.gateway.admit(input(f))
      )
      await until(/** 等待原生 fixture 真正接收首个请求。 */ () => f.native.state.responses === 1)
      const request = input(f, 'blocked_by_capacity')
      const admitted = await f.gateway.runAuthenticated(
        f.caller,
        /** 并发拒绝发生在本调用派发锚点前，仍返回已提交的登记元数据。 */ () => f.gateway.admit(request)
      )
      assert.equal(admitted.created, true)
      assert.equal(admitted.call.state, 'created')
      assert.equal(admitted.call.attempt_id, null)
      const duplicate = await f.gateway.runAuthenticated(
        f.caller,
        /** 重复 key 仅查原记录，不能因为原发送失败而再发一次。 */ () => f.gateway.admit(request)
      )
      assert.equal(duplicate.created, false)
      assert.equal(duplicate.call.call_id, admitted.call.call_id)
      assert.equal(duplicate.call.state, 'created')
      assert.equal(duplicate.call.deadline, request.options.deadline)
      assert.equal(duplicate.call.dedup_expires, admitted.call.dedup_expires)
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.claims(), 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'encoding budget failure before socket write returns not_dispatched with its original call id',
  { timeout: 45_000 },
  /** 正常认证之后用明确大于发送预算的有效请求触发写前失败，不伪造 transport 结果。 */ async () => {
    const f = await runtimeFixture({ frame_bytes: 4096 })
    try {
      await f.ready()
      const request = input(f, 'refused_after_anchor')
      request.native_request.params.title = 'x'.repeat(8192)
      const admitted = await f.gateway.runAuthenticated(
        f.caller,
        /** 锚点已提交但整帧在发送前超预算；本机证据须持久提交为未派发。 */ () => f.gateway.admit(request)
      )
      assert.equal(admitted.created, true)
      assert.equal(admitted.call.state, 'not_dispatched')
      assert.equal(typeof admitted.call.attempt_id, 'string')
      assert.equal(admitted.call.response, null)
      const current = await f.gateway.runAuthenticated(
        f.caller,
        /** 以首次 ID 取回同一拒绝记录，不能生成第二个 attempt。 */ () => f.gateway.get(admitted.call.call_id)
      )
      assert.equal(current.state, 'not_dispatched')
      assert.equal(current.attempt_id, admitted.call.attempt_id)
      const duplicate = await f.gateway.runAuthenticated(
        f.caller,
        /** 原历史登记只返回旧拒绝，不发送或延长任何截止。 */ () => f.gateway.admit(request)
      )
      assert.equal(duplicate.created, false)
      assert.equal(duplicate.call.call_id, admitted.call.call_id)
      assert.equal(duplicate.call.deadline, request.options.deadline)
      assert.equal(duplicate.call.dedup_expires, admitted.call.dedup_expires)
      assert.equal(f.native.state.responses, 0)
      assert.equal(f.claims(), 0)
      assert.equal(f.gateway.transport.status().connections, 1)
    } finally {
      await f.close()
    }
  }
)

for (const revoked of ['identity', 'read'] as const) {
  test(
    `dispatch failure followed by ${revoked} revocation cannot return the registered or historical call id`,
    { timeout: 45_000 },
    /** 只在真实失败返回的受信边界撤销测试身份，随后返回必须再次授权而非用登记快照兜底。 */ async () => {
      const f = await runtimeFixture()
      try {
        await f.ready()
        f.native.state.active = false
        const request = input(f, 'revoked_after_registration')
        const dispatch = f.gateway.transport.dispatch
        let registered = ''
        f.gateway.transport.dispatch = /** 包住真实派发入口，在其失败后模拟可信身份来源即时撤销。 */ (callId) => {
          registered = callId
          try {
            return dispatch(callId)
          } finally {
            if (revoked === 'identity') {
              f.authorize(false)
            } else {
              f.deviceScope([])
            }
          }
        }
        await assert.rejects(
          f.gateway.runAuthenticated(f.caller, /** 登记后撤权只能返回固定认证错误。 */ () => f.gateway.admit(request)),
          /** 错误内不附带已经提交的 ID、请求或登记快照。 */ (error: unknown) => {
            assert(error instanceof Error)
            assert.equal(error.message, revoked === 'identity' ? 'unauthenticated' : 'forbidden')
            assert.equal('call' in error, false)
            assert.equal('call_id' in error, false)
            return true
          }
        )
        assert.notEqual(registered, '')
        assert.equal(f.state.store.call('synthetic', registered).state, 'created')
        await assert.rejects(
          f.gateway.runAuthenticated(
            f.caller,
            /** 重复历史 key 也不能越过当前身份验证取得旧 ID。 */ () => f.gateway.admit(request)
          ),
          revoked === 'identity' ? /unauthenticated/ : /forbidden/
        )
        f.authorize(true)
        f.deviceScope(undefined)
        const duplicate = await f.gateway.runAuthenticated(
          f.caller,
          /** 身份恢复后原历史记录仍保留，只能查回原 ID，不重新派发。 */ () => f.gateway.admit(request)
        )
        assert.equal(duplicate.created, false)
        assert.equal(duplicate.call.call_id, registered)
        assert.equal(f.native.state.responses, 0)
        assert.equal(f.claims(), 0)
      } finally {
        await f.close()
      }
    }
  )
}
