// 既有PR69/authority/真实Store的隔离交付测试；管理员和受保护Request均为明确合成fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { createManagementPageInitializer } from '../../src/cli/management-page.js'
import type { ManagementPageLeaseSource } from '../../src/cli/management-page.js'
import { setup } from '../admin/write-helpers.js'
import { gate } from '../admin/session-flow-helpers.js'

const origin = 'http://127.0.0.1:43819'
const html = '<html><head></head><body>synthetic page</body></html>'

/** 仅WeakSet里这一个Request具有合成宿主授权，不把loopback、header或固定管理员当成请求证明。 */
function fixture() {
  const f = setup()
  const state = { now: Date.now(), calls: 0, resolve: undefined as ManagementPageLeaseSource | undefined }
  const lease = {
    caller: { principal_id: 'fixture_admin' },
    management_session_ref: 'fixture_session',
    issued_at: state.now,
    expires_at: state.now + 600_000
  }
  const trusted = new WeakSet<Request>()
  const authority = createManagementSessionAuthority(f.identities, {
    now: /** 合成宿主和adapter共用同一可控可信时钟。 */ () => state.now
  })
  const adapter = createManagementSessionAdapter({
    identities: authority.identities,
    sessions: authority.sessions,
    cookie_name: 'rovloom_management',
    origin,
    now: /** 与签发端完全相同的固定时钟。 */ () => state.now
  })
  const service = new StoreManagementWriteService({
    store: f.store,
    identities: authority.identities,
    transport: { /** 本例没有socket；不把空刷新算成真实设备验收。 */ refresh() {} }
  })
  const handler = createManagementHandler({
    origin,
    service,
    authenticate: adapter.authenticate,
    verifyCsrf: adapter.verifyCsrf,
    assets: new Map([
      ['/', new TextEncoder().encode(html)],
      ['/index.html', new TextEncoder().encode(html)],
      ['/browser.js', new TextEncoder().encode('/* fixture */')]
    ]),
    initializePage: createManagementPageInitializer(
      authority,
      /** 真正产品须调用原受保护会话后端；此处只认可fixture显式授予的Request对象。 */ async (request, signal) => {
        state.calls++
        return state.resolve ? state.resolve(request, signal) : trusted.has(request) ? lease : null
      }
    )
  })
  return {
    f,
    authority,
    handler,
    state,
    lease,
    /** 仅在测试中把该Request标记为原宿主已保护，不添加任何线上认证头或URL参数。 */
    request(path = '/', init?: RequestInit) {
      const request = new Request(origin + path, { ...init, headers: { host: new URL(origin).host, ...init?.headers } })
      trusted.add(request)
      return request
    },
    /** 关闭本例拥有的handler、短期宿主与内存Store。 */
    close() {
      handler.stop()
      authority.close()
      f.close()
    }
  }
}

test(
  '页面交付只含内存CSRF与HttpOnly cookie，正式adapter读取同一Store并逐请求撤权',
  /** 没有现成保护请求时只读；bootstrap不把principal/session_ref或cookie写进HTML及JSON。 */ async () => {
    const f = fixture()
    try {
      const plain = await f.handler.fetch(new Request(origin, { headers: { host: new URL(origin).host } }))
      assert.equal(await plain.text(), html)
      assert.equal(plain.headers.get('set-cookie'), null)
      const response = await f.handler.fetch(f.request())
      assert.equal(response.status, 200)
      const body = await response.text()
      const cookies = response.headers.getSetCookie()
      assert.equal(cookies.length, 2)
      const cookieHeader = cookies[0]!
      const cookie = /^rovloom_management=([\w-]{43});/.exec(cookieHeader)![1]!
      const csrf = /content="([\w-]{43})"/.exec(body)![1]!
      assert.match(cookieHeader, /; Path=\/; HttpOnly; SameSite=Strict; Expires=/)
      assert(!cookieHeader.includes('Domain='))
      // 升级前写入的是 Path=/admin/v1：必须同时过期，否则它会与新 cookie 同时出现在 API 请求上，
      // 而 adapter 对同名重复 cookie 一律拒绝，用户重新登录也清不掉。
      assert.match(cookies[1]!, /^rovloom_management=; Path=\/admin\/v1;/)
      assert.match(cookies[1]!, /; Max-Age=0;/)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert(body.includes(`data-expires-at="${f.lease.expires_at}"`))
      for (const secret of [cookie, f.lease.caller.principal_id, f.lease.management_session_ref]) {
        assert(!body.includes(secret))
      }
      const post = f.request('/admin/v1/actions/history_open', {
        method: 'POST',
        headers: {
          origin,
          cookie: 'rovloom_management=' + cookie,
          'x-rovloom-csrf': csrf,
          'content-type': 'application/json'
        },
        body: '{}'
      })
      const write = await f.handler.fetch(post.clone())
      assert.equal(write.status, 200)
      const json = await write.text()
      assert(!json.includes(cookie) && !json.includes(csrf))
      f.f.admin = null
      assert.equal((await f.handler.fetch(new Request(post))).status, 401)
    } finally {
      f.close()
    }
  }
)

test(
  '并发根页面与刷新恢复同一固定交付，不旋转既有cookie',
  /** 后到响应和首响应丢失不会破坏其它页面；每个请求仍由原来源认证。 */ async () => {
    const f = fixture()
    try {
      const responses = await Promise.all([f.handler.fetch(f.request()), f.handler.fetch(f.request('/index.html'))])
      assert(responses.every(/** 两个页面均恢复同一交付。 */ (response) => response.status === 200))
      const first = responses[0]!
      const rawCookie = /^rovloom_management=([\w-]{43});/.exec(first.headers.get('set-cookie')!)![1]!
      const nextCookie = /^rovloom_management=([\w-]{43});/.exec(responses[1]!.headers.get('set-cookie')!)![1]!
      assert.ok(rawCookie === nextCookie)
      assert.equal((await f.handler.fetch(f.request())).status, 200)
      assert(await f.authority.sessions.resolveCookie(rawCookie, new AbortController().signal))
      assert.equal((await f.handler.fetch(f.request('/browser.js'))).status, 200)
      assert.equal(f.state.calls, 3)
    } finally {
      f.close()
    }
  }
)

test(
  '错误Origin/查询/方法不解析会话，异步取消及源异常不签发也不输出底层秘密',
  /** 取消只结束本次等待；无真实会话、未知身份及已过期lease均不能自动恢复或续期。 */ async () => {
    const f = fixture()
    const release = gate()
    try {
      assert.equal(
        (
          await f.handler.fetch(
            f.request('/', { headers: { origin: 'http://untrusted.invalid', 'sec-fetch-site': 'cross-site' } })
          )
        ).status,
        403
      )
      assert.equal((await f.handler.fetch(f.request('/?secret=synthetic'))).status, 404)
      assert.equal((await f.handler.fetch(f.request('/', { method: 'HEAD' }))).status, 405)
      assert.equal(f.state.calls, 0)
      f.state.resolve = /** 忽略abort的合成来源，确保迟到lease仍不会进入authority。 */ async () => {
        await release.promise
        return f.lease
      }
      const cancellation = new AbortController()
      const waiting = f.handler.fetch(f.request('/', { signal: cancellation.signal }))
      await Promise.resolve()
      await Promise.resolve()
      cancellation.abort()
      assert.equal((await waiting).status, 408)
      release.resolve()
      await new Promise(/** 让真实迟到来源结束，而不改变产品等待预算。 */ (resolve) => setTimeout(resolve, 0))
      assert.equal(f.authority.identities.administrator(f.lease.caller, f.lease.management_session_ref), null)
      f.state.resolve = /** 原后端异常仅保留固定问题。 */ async () => {
        throw new Error('SYNTHETIC_PRIVATE_SOURCE_ERROR')
      }
      const failed = await f.handler.fetch(f.request())
      assert.equal(await failed.text(), '{"error":"unauthenticated"}')
      assert.equal(failed.headers.get('set-cookie'), null)
      f.state.resolve = /** 固定旧租期不会被签发成新租期。 */ async () => ({ ...f.lease, expires_at: f.state.now })
      assert.equal((await f.handler.fetch(f.request())).status, 401)
      f.state.resolve = /** 不存在的caller不得借用fixture管理员。 */ async () => ({
        ...f.lease,
        caller: { principal_id: 'unknown' }
      })
      assert.equal((await f.handler.fetch(f.request())).status, 401)
    } finally {
      release.resolve()
      f.close()
    }
  }
)

test(
  '取消后未结算的页面解析仍占原16项额度，stop不允许迟到签发',
  /** 不合作的resolver不因HTTP取消释放真实工作额度。 */ async () => {
    const f = fixture()
    const entered = gate()
    const release = gate()
    f.state.resolve = /** 所有工作占用原handler pending直到真正结束。 */ async () => {
      if (f.state.calls === 16) {
        entered.resolve()
      }
      await release.promise
      return f.lease
    }
    try {
      const controllers = Array.from({ length: 16 }, /** 每个HTTP请求有自己的取消来源。 */ () => new AbortController())
      const tasks = controllers.map(
        /** 同时启动原handler上限数量的受保护页面解析。 */ (controller) =>
          f.handler.fetch(f.request('/', { signal: controller.signal }))
      )
      await entered.promise
      for (const controller of controllers) {
        controller.abort()
      }
      const cancelled = await Promise.all(tasks)
      assert(cancelled.every(/** 取消立即结束浏览器观察。 */ (response) => response.status === 408))
      assert.equal((await f.handler.fetch(f.request())).status, 503)
      assert.equal(f.state.calls, 16)
      f.handler.stop()
      release.resolve()
      await new Promise(/** 等待实际底层来源释放自己的pending。 */ (resolve) => setTimeout(resolve, 0))
      assert.equal(f.authority.identities.administrator(f.lease.caller, f.lease.management_session_ref), null)
    } finally {
      release.resolve()
      f.close()
    }
  }
)

test(
  '页面初始化同步异常沿原路径脱敏并释放额度',
  /** 直接抛错的宿主也不能遗留pending；既有读取时序由原HTTP取消回归独立约束。 */ async () => {
    const f = setup()
    let calls = 0
    const handler = createManagementHandler({
      origin,
      service: f.service,
      authenticate: /** 本例只访问公开HTML，不提供任何管理员身份。 */ async () => null,
      verifyCsrf: /** 同步异常测试不允许执行写操作。 */ async () => false,
      assets: new Map([['/', new TextEncoder().encode(html)]]),
      /** 模拟受信宿主实现自身同步失败，错误原文不得离开handler。 */
      initializePage() {
        calls++
        throw new Error('SYNTHETIC_PRIVATE_INITIALIZER_ERROR')
      }
    })
    try {
      for (let index = 0; index < 17; index++) {
        const response = await handler.fetch(new Request(origin, { headers: { host: new URL(origin).host } }))
        assert.equal(response.status, 503)
        assert.equal(await response.text(), '{"error":"unavailable"}')
        assert.equal(response.headers.get('set-cookie'), null)
      }
      assert.equal(calls, 17)
    } finally {
      handler.stop()
      f.close()
    }
  }
)

test(
  '函数式 challenge 随每次请求重算：没有管理员时交付原页面壳，有管理员后才返回 401 与 Basic 挑战',
  /** 新用户先看到页面壳而不是登录框；创建管理员后无需重启，下一次请求即开始要求登录。 */ async () => {
    const f = setup()
    const authority = createManagementSessionAuthority(f.identities)
    try {
      let admins = 0
      const initialize = createManagementPageInitializer(authority, async () => null, {
        challenge: /** 模拟来源里的管理员数量。 */ () => (admins > 0 ? 'basic' : undefined)
      })
      const page = () => new Response(html, { headers: { 'content-type': 'text/html' } })
      const signal = new AbortController().signal
      const open = await initialize(new Request(origin + '/'), page(), signal)
      assert.equal(open.status, 200)
      assert.equal(await open.text(), html)
      admins = 1
      const locked = await initialize(new Request(origin + '/'), page(), signal)
      assert.equal(locked.status, 401)
      assert.match(locked.headers.get('www-authenticate') ?? '', /^Basic /)
    } finally {
      authority.close()
    }
  }
)
