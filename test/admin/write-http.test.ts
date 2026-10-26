// HTTP handler使用真实管理业务服务与合成短期session；本文件不创建listener或生产身份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { context, setup } from './write-helpers.js'

const origin = 'http://127.0.0.1:42201'
/** 固定同源合成会话请求，CSRF值只在本测试内有效。 */
function request(
  operation: string,
  body: string | object = {},
  options: { method?: string; headers?: Record<string, string> } = {}
) {
  const method = options.method ?? 'POST'
  return new Request(origin + '/admin/v1/actions/' + operation, {
    method,
    headers: {
      host: '127.0.0.1:42201',
      origin,
      'content-type': 'application/json',
      'x-rovloom-csrf': 'fixture_csrf',
      ...options.headers
    },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  })
}
/** 只向handler注入fixture已有会话，不从浏览器参数建立管理员。 */
function handler(f: ReturnType<typeof setup>) {
  return createManagementHandler({
    origin,
    service: f.service,
    /** 测试身份后端仍逐次验证合成会话和当前principal。 */
    async authenticate() {
      return context()
    },
    /** CSRF测试值和独立会话绑定；此fixture不能作为生产实现。 */
    async verifyCsrf(req, identity) {
      return (
        req.headers.get('x-rovloom-csrf') === 'fixture_csrf' && identity.management_session_ref === 'fixture_session'
      )
    }
  })
}

test(
  'HTTP强制同源/Host/CSRF/POST及有界严格JSON，响应no-store不回显异常',
  /** 模拟直接恶意API请求，隐藏按钮不能影响拒绝结果。 */ async () => {
    const f = setup()
    const h = handler(f)
    try {
      const rejectedHeaders: Record<string, string>[] = [
        { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        { origin: '' },
        { host: 'evil.example' },
        { 'sec-fetch-site': 'cross-site' },
        { 'x-rovloom-csrf': 'forged' }
      ]
      for (const headers of rejectedHeaders) {
        assert.equal((await h.fetch(request('history_open', {}, { headers }))).status, 403)
      }
      assert.equal((await h.fetch(request('devices_revoke', {}, { method: 'GET' }))).status, 405)
      assert.equal(
        (await h.fetch(request('history_open', {}, { headers: { 'content-type': 'text/plain' } }))).status,
        400
      )
      assert.equal((await h.fetch(request('history_open', '{"a":1,"a":2}'))).status, 400)
      assert.equal((await h.fetch(request('history_open', { secret: 'SYNTHETIC_SECRET_DO_NOT_ECHO' }))).status, 400)
      assert.equal((await h.fetch(request('history_open', { approved: true }))).status, 400)
      assert.equal((await h.fetch(request('history_open', 'x'.repeat(16_385)))).status, 413)
      const response = await h.fetch(request('history_open'))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('access-control-allow-origin'), null)
      assert(!JSON.stringify(await response.json()).includes('fixture_session'))
      f.admin = null
      const expired = await h.fetch(request('history_open'))
      assert.equal(expired.status, 401)
      assert.deepEqual(await expired.json(), { error: 'unauthenticated' })
    } finally {
      h.stop()
      f.close()
    }
  }
)

test(
  'HTTP无默认session/CSRF、错误脱敏、关闭幂等，读桥仍只读',
  /** 缺少生产源时不能借loopback地址自动成为管理员。 */ async () => {
    const f = setup()
    try {
      assert.throws(
        /** 构造阶段缺CSRF就拒绝，不打开任何端口。 */ () =>
          createManagementHandler({
            origin,
            service: f.service,
            authenticate: /* 合成缺会话后端。 */ async () => null
          } as never),
        /management_csrf_required/
      )
      const h = createManagementHandler({
        origin,
        service: f.service,
        /** 未装配session来源。 */ authenticate: /* 合成缺会话后端。 */ async () => null,
        /** 没有session不会进入此验证。 */ verifyCsrf: async () => true
      })
      try {
        assert.equal((await h.fetch(request('history_open'))).status, 401)
      } finally {
        h.stop()
      }
      const failing = createManagementHandler({
        origin,
        service: f.service,
        /** 底层异常含假secret但不能进入HTTP响应。 */ authenticate: async () => {
          throw new Error('SYNTHETIC_SECRET /private/path')
        },
        /** 此路径不会获得有效session。 */ verifyCsrf: async () => true
      })
      try {
        const response = await failing.fetch(request('history_open'))
        assert.equal(response.status, 503)
        assert.deepEqual(await response.json(), { error: 'backend_unavailable' })
        failing.stop()
        failing.stop()
        assert.equal((await failing.fetch(request('history_open'))).status, 503)
      } finally {
        failing.stop()
      }
    } finally {
      f.close()
    }
  }
)
