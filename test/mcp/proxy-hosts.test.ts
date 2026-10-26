// MCP 与管理 API 共享代理请求边界：域名和上游协议无需配置，身份仍由 Bearer 决定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpFacade } from '../../src/mcp/http.js'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import { rpcResponse } from './http-fixture.js'

const init = {
  jsonrpc: '2.0',
  id: 'init',
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'proxy', version: '1' } }
}

test('MCP 接受任意代理域名与端口、外部 HTTPS 和改写后的 HTTP Host，仍逐请求认证', async () => {
  const facade = createHttpFacade({
    origin: 'http://127.0.0.1:9444',
    service: {
      execute: async () => {
        throw new Error('unused_test_stub')
      }
    },
    authentication: {
      authenticate: (request) =>
        request.headers.get('authorization') === 'Bearer TEST_ONLY' ? { principal_id: 'isolated' } : null
    }
  })
  const post = (url: string, headers: Record<string, string> = {}) =>
    facade.handleRequest(
      new Request(url, {
        method: 'POST',
        headers: {
          host: new URL(url).host,
          authorization: 'Bearer TEST_ONLY',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...headers
        },
        body: JSON.stringify(init)
      })
    )
  try {
    for (const [url, origin] of [
      ['http://public.example/mcp', 'https://public.example'],
      ['http://other.example:12443/mcp', 'https://other.example:12443'],
      ['http://127.0.0.1:9444/mcp', 'https://public.example:8443'],
      ['https://public.example/mcp', 'https://public.example'],
      ['http://192.0.2.10:9444/mcp', 'http://192.0.2.10:9444']
    ]) {
      for (const source of [{}, { origin: origin!, 'sec-fetch-site': 'same-origin' }] as Record<string, string>[]) {
        const response = await post(url!, source)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('access-control-allow-origin'), null)
        await rpcResponse(response)
      }
    }
    const url = 'http://127.0.0.1:9444/mcp'
    for (const headers of [
      { authorization: '' },
      { authorization: 'Bearer WRONG', 'x-forwarded-user': 'isolated' }
    ] as Record<string, string>[]) {
      assert.equal((await post(url, headers)).status, 401)
    }
    for (const headers of [
      { host: 'mismatched.example' },
      { origin: 'null' },
      { origin: 'https://public.example/path' },
      { origin: 'https://cross.example', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://sibling.example', 'sec-fetch-site': 'same-site' }
    ] as Record<string, string>[]) {
      assert.equal((await post(url, headers)).status, 403)
    }
    for (const path of ['/other', '/mcp?token=TEST_ONLY', '/mcp/']) {
      assert.equal((await post('http://127.0.0.1:9444' + path)).status, 403)
    }
  } finally {
    await facade.close()
  }
})

test('Gateway 配置不再包含公网 URL 选项，未知字段仍拒绝', () => {
  const document = configDocument(configTemplate('gateway')) as { mcp: Record<string, unknown> }
  assert.deepEqual(Object.keys(document.mcp).sort(), ['hostname', 'port'])
  assert.deepEqual(configDocument(parseConfig(document)), document)
  for (const field of ['public_url', 'allowed_origins', 'trusted_proxies', 'unknown']) {
    assert.throws(() => parseConfig({ ...document, mcp: { ...document.mcp, [field]: 'https://public.example/mcp' } }))
  }
})
