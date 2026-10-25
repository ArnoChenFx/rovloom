// 真实会话适配逻辑只使用隔离短期cookie/CSRF材料，绝不创建生产身份或凭据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { setup } from './write-helpers.js'

const origin = 'http://127.0.0.1:43301'
const cookie = 'SYNTHETIC_COOKIE_' + 'a'.repeat(32)
const csrf = 'SYNTHETIC_CSRF_' + 'b'.repeat(32)
/** 生成本fixture同源请求，原始cookie永不作为caller或管理session引用。 */
function request(headers: Record<string, string> = {}) {
  return new Request(origin + '/admin/v1/actions/history_open', {
    method: 'POST',
    headers: { host: '127.0.0.1:43301', origin, cookie: 'fixture_admin=' + cookie, 'x-rovloom-csrf': csrf, ...headers }
  })
}

/** 当前后端在每次查询时返回短期绑定，不由浏览器自报管理员。 */
function fixture() {
  const f = setup()
  let now = 1000
  let expires = 2000
  let reads = 0
  let failure = false
  const source = {
    identities: f.identities,
    /** 仅精确fixture cookie有记录，任意bearer或伪造cookie没有身份效力。 */
    async resolveCookie(value: string) {
      reads++
      if (failure) {
        throw new Error('SYNTHETIC_PRIVATE_BACKEND_FAILURE')
      }
      return value === cookie
        ? {
            caller: { principal_id: 'fixture_admin' },
            session_ref: f.admin?.session_ref ?? 'fixture_session',
            expires_at: expires,
            csrf_sha256: [createHash('sha256').update(csrf).digest('hex')]
          }
        : null
    }
  }
  const options = {
    identities: f.identities,
    sessions: source,
    cookie_name: 'fixture_admin',
    origin,
    /** 与fixture可信时钟同源，不使用浏览器时间授权。 */ now: () => now
  }
  return {
    f,
    options,
    adapter: createManagementSessionAdapter(options),
    /** 控制当前可信时间。 */ set now(value: number) {
      now = value
    },
    /** 明确修改fixture当前session截止，绝不在读取时续期。 */ set expires(value: number) {
      expires = value
    },
    /** 观察实际后端查询次数。 */ get reads() {
      return reads
    },
    /** 制造受信后端故障以验证脱敏拒绝。 */ set failure(value: boolean) {
      failure = value
    }
  }
}

test(
  '构造必须绑定同一真实administrator来源；不接受bearer、自报principal或重复cookie',
  /** 来源缺失/混用在启动前拒绝，loopback不是认证。 */ async () => {
    const o = fixture()
    try {
      assert.throws(
        /** 缺会话解析器不能构造默认管理员。 */ () =>
          createManagementSessionAdapter({ ...o.options, sessions: undefined } as never),
        /management_session_source_required/
      )
      assert.throws(
        /** 相同形状的另一身份对象也不能替代运行宿主的同一来源。 */ () =>
          createManagementSessionAdapter({ ...o.options, identities: { ...o.f.identities } }),
        /management_identity_source_mismatch/
      )
      const signal = new AbortController().signal
      const rejectedHeaders: Record<string, string>[] = [
        { cookie: '', authorization: 'Bearer ' + cookie, 'x-principal': 'fixture_admin' },
        { cookie: 'fixture_admin=' + cookie + '; fixture_admin=' + cookie },
        { cookie: 'fixture_admin=' + 'forged'.repeat(8) },
        { host: 'evil.example' },
        { origin: 'https://evil.example' }
      ]
      for (const headers of rejectedHeaders) {
        assert.equal(await o.adapter.authenticate(request(headers), signal), null)
      }
      const identity = await o.adapter.authenticate(request(), signal)
      assert.deepEqual(identity, {
        caller: { principal_id: 'fixture_admin' },
        management_session_ref: 'fixture_session'
      })
      assert.equal(o.adapter.identities, o.f.identities)
      assert(!JSON.stringify(identity).includes(cookie))
      assert(!JSON.stringify(identity).includes(csrf))
      const resolve = o.options.sessions.resolveCookie
      o.options.sessions.resolveCookie = /** 查询等待期间更换来源也不能沿用旧cookie绑定。 */ async (value) => {
        const binding = await resolve(value)
        o.options.sessions.identities = { ...o.f.identities }
        return binding
      }
      assert.equal(await o.adapter.authenticate(request(), signal), null)
    } finally {
      o.f.close()
    }
  }
)

test(
  '会话截止、撤权、时钟回退与后端故障逐请求拒绝；既有认证不缓存通过',
  /** 使用真实适配器重查同一合成来源，不以固定true模拟会话成立。 */ async () => {
    const o = fixture()
    try {
      const signal = new AbortController().signal
      const identity = (await o.adapter.authenticate(request(), signal))!
      assert.equal(await o.adapter.verifyCsrf(request(), identity, signal), true)
      const initial = o.reads
      o.f.admin = null
      assert.equal(await o.adapter.verifyCsrf(request(), identity, signal), false)
      assert.equal(await o.adapter.authenticate(request(), signal), null)
      assert(o.reads > initial)
      o.f.admin = {
        principal_id: 'fixture_admin',
        session_ref: 'fixture_session',
        assurance: 'administrator',
        policy_revision: 'fixture_policy',
        grants: []
      }
      o.now = 2000
      assert.equal(await o.adapter.authenticate(request(), signal), null)
      o.expires = 4000
      o.now = 2500
      assert(await o.adapter.authenticate(request(), signal))
      o.now = 2499
      assert.equal(await o.adapter.authenticate(request(), signal), null)
      o.now = 2600
      o.failure = true
      assert.equal(await o.adapter.authenticate(request(), signal), null)
    } finally {
      o.f.close()
    }
  }
)

test(
  'CSRF绑定当前cookie/session，缺原值、跨站、换session或取消均拒绝',
  /** 所有失败不输出cookie、摘要或后端异常原文。 */ async () => {
    const o = fixture()
    try {
      const controller = new AbortController()
      const identity = (await o.adapter.authenticate(request(), controller.signal))!
      const rejectedHeaders: Record<string, string>[] = [
        { 'x-rovloom-csrf': '' },
        { 'x-rovloom-csrf': 'x'.repeat(48) },
        { origin: '' },
        { 'sec-fetch-site': 'cross-site' }
      ]
      for (const headers of rejectedHeaders) {
        assert.equal(await o.adapter.verifyCsrf(request(headers), identity, controller.signal), false)
      }
      o.f.admin = { ...o.f.admin!, session_ref: 'new_fixture_session' }
      assert.equal(await o.adapter.verifyCsrf(request(), identity, controller.signal), false)
      controller.abort()
      const before = o.reads
      assert.equal(await o.adapter.authenticate(request(), controller.signal), null)
      assert.equal(o.reads, before)
    } finally {
      o.f.close()
    }
  }
)
