// HTTPS 代理到真实 HTTP listener：官方 MCP SDK、热读 Bearer 注册表与 SSE 响应共同验证。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpFacade } from '../../src/mcp/http.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { managementSourceFixture, mcpProof } from '../cli/management-source-fixture.js'
import { stubFixture } from './stub-fixture.js'

test('MCP HTTPS 反代无需公网地址配置，保留/改写 Host 和无转发头均支持 SDK 会话、工具和 SSE', async () => {
  const f = await managementSourceFixture()
  const source = openCallerSource(f.callerPath, f.callers.resource)
  const running = startHttpFacade({
    authentication: source.authentication,
    service: stubFixture('proxy', f.root).service,
    port: f.config.mcp_port
  })
  const cert = join(f.root, 'proxy.crt')
  const key = join(f.root, 'proxy.key')
  const certificate = spawnSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=mcp-proxy',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-out',
      cert,
      '-keyout',
      key
    ],
    { stdio: 'ignore' }
  )
  assert.equal(certificate.status, 0)
  const ca = readFileSync(cert, 'utf8')
  let rewriteHost = false
  let forwardProtocol = true
  const methods = new Set<string>()
  const responseTypes = new Set<string>()
  const proxy = createServer({ cert: ca, key: readFileSync(key, 'utf8') }, async (incoming, outgoing) => {
    const stop = new AbortController()
    outgoing.once('close', () => stop.abort())
    try {
      methods.add(incoming.method!)
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && !['connection', 'transfer-encoding'].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(',') : value)
        }
      }
      if (rewriteHost) {
        headers.set('host', new URL(running.url).host)
      }
      if (forwardProtocol) {
        headers.set('x-forwarded-proto', 'https')
      }
      const chunks: Buffer[] = []
      for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk))
      }
      const response = await fetch(new URL(incoming.url!, running.url), {
        method: incoming.method,
        headers,
        signal: stop.signal,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
      })
      responseTypes.add(response.headers.get('content-type') ?? '')
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.flushHeaders()
      // SSE 必须逐块转发；等待完整 arrayBuffer 会阻塞 MCP 初始化和 GET 流。
      const reader = response.body?.getReader()
      if (reader) {
        try {
          for (let part = await reader.read(); !part.done; part = await reader.read()) {
            outgoing.write(part.value)
          }
        } finally {
          reader.releaseLock()
        }
      }
      outgoing.end()
    } catch {
      if (!outgoing.destroyed) {
        outgoing.statusCode = 502
        outgoing.end()
      }
    }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  assert(address && typeof address === 'object')
  const external = `https://127.0.0.1:${address.port}/mcp`
  const request = (url: string | URL | Request, init: RequestInit = {}) =>
    fetch(url, { ...init, tls: { ca } } as RequestInit)
  try {
    for (const mode of ['preserve', 'rewrite', 'no-forwarded-headers']) {
      rewriteHost = mode !== 'preserve'
      forwardProtocol = mode !== 'no-forwarded-headers'
      const headers = {
        authorization: `Bearer ${mcpProof}`,
        origin: 'https://arbitrary.example:12443',
        host: 'arbitrary.example:12443',
        'sec-fetch-site': 'same-origin'
      }
      const transport = new StreamableHTTPClientTransport(new URL(external), {
        fetch: request,
        requestInit: { headers }
      })
      const client = new Client({ name: 'proxy-sdk', version: '1' })
      try {
        await client.connect(transport)
        assert((await client.listTools()).tools.some((tool) => tool.name === 'machines_list'))
        assert.notEqual((await client.callTool({ name: 'machines_list', arguments: {} })).isError, true)
        const session = transport.sessionId!
        assert(session)
        const response = await request(external, {
          headers: {
            ...headers,
            authorization: '',
            'mcp-session-id': session,
            'x-forwarded-user': f.lease.caller.principal_id
          }
        })
        assert.equal(response.status, 401)
        const cross = await request(external, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })
        assert.equal(cross.status, 403)
        assert.equal(cross.headers.get('access-control-allow-origin'), null)
        await transport.terminateSession()
      } finally {
        await client.close()
      }
    }
    assert(methods.has('POST') && methods.has('GET') && methods.has('DELETE'))
    assert([...responseTypes].some((type) => type.startsWith('text/event-stream')))
    f.save(f.callerPath, { ...f.callers, callers: [] })
    assert.equal((await request(external, { headers: { authorization: `Bearer ${mcpProof}` } })).status, 401)
  } finally {
    const closed = once(proxy, 'close')
    proxy.closeAllConnections()
    proxy.close()
    await closed
    await running.close()
    source.close()
    f.close()
  }
})
