// 通配绑定只改变监听范围；代理域名与回环 Host 都必须通过同一 Bearer 认证。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startHttpFacade } from '../../src/mcp/http.js'
import type { GatewayService } from '../../src/mcp/types.js'
import { canonicalLoopbackHost, isWildcardHostname } from '../../src/mcp/listen.js'
import { statusWithHost } from './wildcard-listener.js'

test('canonicalLoopbackHost 把监听地址换算为规范回环主机', () => {
  assert.equal(canonicalLoopbackHost('127.0.0.1'), '127.0.0.1')
  assert.equal(canonicalLoopbackHost('0.0.0.0'), '127.0.0.1')
  assert.equal(canonicalLoopbackHost(undefined), '127.0.0.1')
  assert.equal(canonicalLoopbackHost('::1'), '[::1]')
  assert.equal(canonicalLoopbackHost('::'), '[::1]')
  assert.equal(isWildcardHostname('0.0.0.0'), true)
  assert.equal(isWildcardHostname('::'), true)
  assert.equal(isWildcardHostname('127.0.0.1'), false)
  assert.equal(isWildcardHostname(undefined), false)
})

test(
  '通配监听的 MCP 端点接受代理 Host，所有 Host 仍需认证',
  /** 监听地址不是域名白名单，任意 Host 都到达认证门禁并返回 401。 */ async () => {
    const running = startHttpFacade({
      service: { execute: async () => Promise.reject(new Error('unused')) } as unknown as GatewayService,
      authentication: { authenticate: () => null },
      hostname: '0.0.0.0',
      port: 0
    })
    try {
      const port = Number(new URL(running.url).port)
      assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
      for (const host of ['example.com', `example.com:${port}`, `192.0.2.10:${port}`]) {
        const status = await statusWithHost(port, host, '/mcp')
        assert.equal(status, 401, `${host} -> ${status}`)
      }
      assert.equal(await statusWithHost(port, `127.0.0.1:${port}`, '/mcp'), 401)
    } finally {
      await running.close()
    }
  }
)
