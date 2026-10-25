// R2-4使用真实受保护文件来源、会话authority和HTTP handler复现；全部身份为短期合成fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { openProtectedManagementSource } from '../../src/cli/management-source.js'
import { createManagementPageInitializer } from '../../src/cli/management-page.js'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { managementSourceFixture } from './management-source-fixture.js'

/** 原服务重新认证每个页面；从不以cookie代替独立Basic证明。 */
async function fixture() {
  const f = await managementSourceFixture()
  const source = openProtectedManagementSource(f.config, 'management', {
    assets: f.assets,
    now: /** 共用合成服务时钟，不由浏览器决定期限。 */ () => f.clock.now
  })
  const caller = openCallerSource(f.callerPath, f.callers.resource, source.administrator)
  const authority = createManagementSessionAuthority(caller.identities, {
    now: /** 共用合成服务时钟，不由浏览器决定期限。 */ () => f.clock.now
  })
  source.bindAuthority(authority)
  const adapter = createManagementSessionAdapter({
    identities: authority.identities,
    sessions: authority.sessions,
    cookie_name: 'rovloom_management',
    origin: f.origin,
    now: /** 共用合成服务时钟，不由浏览器决定期限。 */ () => f.clock.now
  })
  const handler = createManagementHandler({
    origin: f.origin,
    assets: f.assets,
    ...adapter,
    service: {
      /** 本例只验证页面及原会话CSRF，不执行任何设备动作。 */ async execute() {
        throw new Error('unavailable')
      }
    },
    initializePage: createManagementPageInitializer(authority, source.management.resolveLease, { challenge: 'basic' })
  })
  return {
    f,
    source,
    authority,
    adapter,
    handler,
    /** 只关闭此例拥有的临时服务及目录。 */
    close() {
      handler.stop()
      authority.close()
      source.close()
      f.close()
    }
  }
}

/** 提取仅供内存断言的交付；断言失败不输出秘密原值。 */
async function delivery(response: Response) {
  assert.equal(response.status, 200)
  const cookie = /^rovloom_management=([\w-]{43});/.exec(response.headers.get('set-cookie')!)![1]!
  const html = await response.text()
  const csrf = /content="([\w-]{43})"/.exec(html)![1]!
  const expires = Number(/data-expires-at="([0-9]+)"/.exec(html)![1])
  assert.equal(html.includes(cookie), false)
  return { cookie, csrf, expires }
}

test(
  'R2-4刷新、新标签、首响应丢失和并发加载恢复同一有效交付，不滑动期限',
  /** 每个请求都重新核验真实私有来源和当前管理员。 */ async () => {
    const h = await fixture()
    try {
      const first = await delivery(await h.handler.fetch(h.f.request()))
      const responses = await Promise.all(
        Array.from(
          { length: 3 },
          /** 独立页面请求仍携带原来源证明。 */ () =>
            h.handler.fetch(h.f.request(undefined, { headers: { cookie: 'rovloom_management=' + first.cookie } }))
        )
      )
      for (const response of responses) {
        const restored = await delivery(response)
        assert.ok(restored.cookie === first.cookie && restored.csrf === first.csrf)
        assert.equal(restored.expires, first.expires)
      }
      // 未接收首响应的浏览器没有cookie；独立证明仍可恢复同一交付。
      const recovered = await delivery(await h.handler.fetch(h.f.request()))
      assert.ok(recovered.cookie === first.cookie && recovered.csrf === first.csrf)
      // 已登录浏览器的根页面请求只带 cookie 也恢复同一租期，刷新与重启后不必重输密码。
      const byCookie = await h.source.management.resolveLease(
        new Request(h.f.origin, {
          headers: { host: new URL(h.f.origin).host, cookie: 'rovloom_management=' + first.cookie }
        }),
        new AbortController().signal
      )
      assert.equal(byCookie?.caller.principal_id, h.f.lease.caller.principal_id)
      assert.equal(byCookie?.management_session_ref, h.f.lease.management_session_ref)
      assert.equal(byCookie?.expires_at, first.expires)
    } finally {
      h.close()
    }
  }
)

test(
  'R2-4会话截止跟随管理员租期，到期后旧cookie与CSRF均不复活',
  /** 会话没有独立短窗口；租期内重复请求恢复同一交付，到期后带证明也拒绝。 */ async () => {
    const h = await fixture()
    try {
      const first = await delivery(await h.handler.fetch(h.f.request()))
      assert.equal(first.expires, h.f.lease.expires_at)
      const again = await delivery(await h.handler.fetch(h.f.request()))
      assert.ok(again.cookie === first.cookie && again.csrf === first.csrf)
      h.f.clock.now = first.expires
      assert.equal(await h.authority.sessions.resolveCookie(first.cookie, new AbortController().signal), null)
      const noProof = await h.handler.fetch(
        new Request(h.f.origin, {
          headers: { host: new URL(h.f.origin).host, cookie: 'rovloom_management=' + first.cookie }
        })
      )
      assert.equal(noProof.status, 401)
      assert.equal(noProof.headers.get('set-cookie'), null)
      assert.equal((await h.handler.fetch(h.f.request())).status, 401)
      const expiredCsrf = new Request(h.f.origin + '/admin/v1/actions/history_open', {
        method: 'POST',
        headers: {
          host: new URL(h.f.origin).host,
          origin: h.f.origin,
          cookie: 'rovloom_management=' + first.cookie,
          'x-rovloom-csrf': first.csrf
        }
      })
      assert.equal(await h.adapter.authenticate(expiredCsrf, new AbortController().signal), null)
    } finally {
      h.close()
    }
  }
)

test(
  'R2-4显式撤销或当前管理来源政策变化后不恢复旧交付',
  /** 缓存不能绕过原authority墓碑与受保护文件代次。 */ async () => {
    for (const mutation of ['revoke', 'policy'] as const) {
      const h = await fixture()
      try {
        const first = await delivery(await h.handler.fetch(h.f.request()))
        if (mutation === 'revoke') {
          h.authority.revoke(h.f.lease.caller, h.f.lease.management_session_ref)
        } else {
          h.f.save(h.f.sourcePath, {
            ...h.f.source,
            sessions: [{ ...h.f.source.sessions[0], administrator: { ...h.f.admin, policy_revision: 'changed' } }]
          })
        }
        h.f.clock.now = first.expires
        const response = await h.handler.fetch(h.f.request())
        assert.equal(response.status, 401)
        assert.equal(response.headers.get('set-cookie'), null)
        assert.equal((await response.text()).includes(first.csrf), false)
        assert.equal(await h.authority.sessions.resolveCookie(first.cookie, new AbortController().signal), null)
      } finally {
        h.close()
      }
    }
  }
)
