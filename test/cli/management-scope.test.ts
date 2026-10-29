// 正式PR69 adapter及PR71 authority验证管理作用域；业务handler只是明确的计数stub，不执行真实管理动作。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { createManagementHandler, createManagementSessionAdapter } from '../../src/admin/index.js'
import type { GatewayManagementService, ManagementReply } from '../../src/mcp/management.js'
import { scopeManagementService } from '../../src/cli/management-scope.js'

test(
  '管理HTTP在真实cookie作用域内执行一次，验证CSRF且撤权后的不确定结果不重放',
  /* 只创建隔离测试会话，不使用用户账户、真实设备或native custody。 */ async () => {
    let allowed = true
    let calls = 0
    let failAfter = false
    const authority = createManagementSessionAuthority({
      principal: /* 合成普通caller的空政策没有native权限。 */ (caller) =>
        allowed && caller.principal_id === 'fixture'
          ? { id: 'fixture', policy: { revision: 'one', grants: [] } }
          : null,
      administrator: /* 原始管理员是本例显式fixture，不能从MCP bearer或cookie正文生成。 */ (caller, sessionRef) =>
        allowed && caller.principal_id === 'fixture' && sessionRef === 'fixture_admin'
          ? {
              principal_id: 'fixture',
              session_ref: sessionRef,
              assurance: 'administrator',
              policy_revision: 'one',
              grants: [{ action: 'gateway_read' }]
            }
          : null
    })
    const now = Date.now()
    const bootstrap = authority.bootstrap({
      caller: { principal_id: 'fixture' },
      management_session_ref: 'fixture_admin',
      issued_at: now,
      expires_at: now + 60_000
    })
    const origin = 'http://127.0.0.1:9445'
    const authentication = createManagementSessionAdapter({
      identities: authority.identities,
      sessions: authority.sessions,
      cookie_name: 'fixture_cookie',
      origin
    })
    const service: GatewayManagementService = {
      execute: /* 业务stub只观察原handler准入后的真实authority，不执行或模拟任何持久管理动作。 */ async (name) => {
        assert.equal(name, 'history_open')
        assert.equal(authority.current().administrator.principal_id, 'fixture')
        calls++
        if (failAfter) {
          allowed = false
        }
        return {
          history_epoch: 'fixture_history',
          recovery_generation: 'fixture_generation',
          accept_new_until: now + 1000
        } as ManagementReply[typeof name]
      }
    }
    const scoped = scopeManagementService(service, authority, 'fixture_cookie')
    const handler = scoped.handler(createManagementHandler({ origin, service: scoped.service, ...authentication }))
    const request = /* 只有专用测试bootstrap原值进入cookie与CSRF header，不进入URL或普通caller DTO。 */ (
      cookie = bootstrap.cookie
    ) =>
      new Request(origin + '/admin/v1/actions/history_open', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:9445',
          origin,
          cookie: `fixture_cookie=${cookie}`,
          'x-rovloom-csrf': bootstrap.csrf,
          'content-type': 'application/json'
        },
        body: '{}'
      })
    try {
      assert.equal((await handler.fetch(request())).status, 200)
      assert.equal(calls, 1)
      assert.throws(/* 请求结束后不存在最近管理员作用域。 */ () => authority.current())
      const csrf = request()
      csrf.headers.set('x-rovloom-csrf', 'wrong')
      assert.equal((await handler.fetch(csrf)).status, 403)
      assert.equal(calls, 1)
      const invalid = await handler.fetch(request('x'.repeat(43)))
      assert.equal(invalid.status, 401)
      assert.equal(calls, 1)
      failAfter = true
      const outcome = await handler.fetch(request())
      assert.equal(outcome.status, 503)
      assert(!JSON.stringify(await outcome.json()).includes(bootstrap.cookie))
      assert.equal(calls, 2)
      assert.equal((await handler.fetch(request())).status, 401)
      assert.equal(calls, 2)
      assert.throws(/* 后置撤权也不留下可复用的作用域。 */ () => authority.current())
    } finally {
      handler.stop()
      authority.close()
    }
  }
)

test(
  '管理作用域没有handler前置认证等待，原stop中止慢认证且不进入业务服务',
  /* 仅认证回调是明确阻塞fixture，用实际HTTP handler的controller验证关闭预算。 */ async () => {
    const authority = createManagementSessionAuthority({
      principal: /* 无身份来源，不能建立任何管理权限。 */ () => null,
      administrator: /* 无管理员来源，不能bootstrap成功。 */ () => null
    })
    let entered!: () => void
    const started = new Promise<void>(/* 真实认证开始后才关闭原handler。 */ (resolve) => (entered = resolve))
    let authenticatedSignal: AbortSignal | undefined
    let calls = 0
    const scoped = scopeManagementService(
      {
        execute: /* 未认证时任何业务调用都是错误，明确记录而不返回假成功。 */ async () => {
          calls++
          throw new Error('unexpected_fixture_management')
        }
      },
      authority,
      'fixture_cookie'
    )
    const origin = 'http://127.0.0.1:9445'
    const handler = scoped.handler(
      createManagementHandler({
        origin,
        service: scoped.service,
        authenticate: /* 慢认证由原handler实际signal结束，没有另一个CLI层deadline或pending集合。 */ async (
          _request,
          signal
        ) => {
          authenticatedSignal = signal
          entered()
          return new Promise(
            /* 原stop必须唤醒本次等待，不能由测试计时器假装认证完成。 */ (resolve) => {
              signal.addEventListener('abort', /* 关闭只撤销等待，不产生管理员。 */ () => resolve(null), { once: true })
            }
          )
        },
        verifyCsrf: /* 缺认证时本回调不应放行任何写入。 */ async () => false
      })
    )
    try {
      const pending = handler.fetch(
        new Request(origin + '/admin/v1/actions/history_open', {
          method: 'POST',
          headers: { host: '127.0.0.1:9445', origin, 'content-type': 'application/json', 'x-rovloom-csrf': 'fixture' },
          body: '{}'
        })
      )
      await started
      handler.stop()
      assert.equal((await pending).status, 503)
      assert.equal(authenticatedSignal?.aborted, true)
      assert.equal(calls, 0)
    } finally {
      handler.stop()
      authority.close()
    }
  }
)
