// 真 HTTPS 代理转发到 HTTP 管理 listener；身份、Cookie、CSRF 和写入账本均走现有实现。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:https'
import { openProtectedManagementSource } from '../../src/cli/management-source.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { createManagementPageInitializer } from '../../src/cli/management-page.js'
import { scopeManagementService } from '../../src/cli/management-scope.js'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import {
  createManagementHandler,
  createManagementSessionAdapter,
  startManagementListener,
  StoreManagementWriteService
} from '../../src/admin/index.js'
import type { GatewayManagementService, ManagementArguments } from '../../src/mcp/management.js'
import type { ManagementReadOperation } from '../../src/webui/read.js'
import { fixtureReply } from '../webui/fixtures.js'
import { setup } from '../admin/write-helpers.js'
import { managementSourceFixture } from './management-source-fixture.js'

test('HTTPS 反代无需 public_url：保留/改写 Host 和不带转发头均可登录、加载模块、读取并完成 CSRF 写入', async () => {
  const f = await managementSourceFixture()
  const db = setup()
  const source = openProtectedManagementSource(f.config, 'management', { assets: f.assets })
  const callers = openCallerSource(f.callerPath, f.callers.resource, source.administrator)
  const authority = createManagementSessionAuthority(callers.identities)
  source.bindAuthority(authority)
  const authentication = createManagementSessionAdapter({
    identities: authority.identities,
    sessions: authority.sessions,
    cookie_name: 'rovloom_management',
    origin: f.origin
  })
  const writes = new StoreManagementWriteService({
    store: db.store,
    identities: authority.identities,
    // 只读状态 DTO 是固定 fixture；登录、授权、CSRF 与 history_open 的账本写入不是替身。
    reads: {
      execute: async (name, args) =>
        fixtureReply(name as ManagementReadOperation, args as ManagementArguments[ManagementReadOperation])
    } as GatewayManagementService
  })
  const scoped = scopeManagementService(writes, authority, 'rovloom_management')
  const handler = scoped.handler(
    createManagementHandler({
      origin: f.origin,
      service: scoped.service,
      ...authentication,
      assets: new Map([...f.assets, ['/browser.js', new TextEncoder().encode('export {}')]]),
      initializePage: createManagementPageInitializer(
        authority,
        source.management.resolveLease.bind(source.management),
        { challenge: 'basic' }
      )
    })
  )
  const listener = startManagementListener({
    port: f.config.management_port,
    maxRequestBodySize: 16384,
    handler: () => handler
  })
  const cert = join(f.root, 'proxy.crt')
  const key = join(f.root, 'proxy.key')
  let rewriteHost = false
  let forwardProtocol = true
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
      '/CN=management-proxy',
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
  const proxy = createServer({ cert: ca, key: readFileSync(key, 'utf8') }, async (incoming, outgoing) => {
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && !['connection', 'transfer-encoding'].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(',') : value)
        }
      }
      if (rewriteHost) {
        headers.set('host', new URL(f.origin).host)
      }
      if (forwardProtocol) {
        headers.set('x-forwarded-proto', 'https')
      }
      const chunks: Buffer[] = []
      for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk))
      }
      const response = await fetch(f.origin + incoming.url, {
        method: incoming.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
      })
      outgoing.statusCode = response.status
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') {
          outgoing.setHeader(name, value)
        }
      }
      if (response.headers.getSetCookie().length) {
        outgoing.setHeader('set-cookie', response.headers.getSetCookie())
      }
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.statusCode = 502
      outgoing.end()
    }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  assert(address && typeof address === 'object')
  const external = `https://127.0.0.1:${address.port}`
  const request = (path: string, init: RequestInit = {}) =>
    fetch(external + path, { ...init, tls: { ca } } as RequestInit)
  try {
    for (const mode of ['preserve', 'rewrite', 'no-forwarded-headers']) {
      rewriteHost = mode !== 'preserve'
      forwardProtocol = mode !== 'no-forwarded-headers'
      const publicHost = mode === 'preserve' ? new URL(external).host : 'arbitrary.example:12443'
      const browserOrigin = 'https://' + publicHost
      const base = { host: publicHost, 'sec-fetch-site': 'same-origin' }
      assert.equal((await request('/', { headers: { ...base } })).status, 401)
      const page = await request('/', {
        headers: { ...base, authorization: f.request().headers.get('authorization')! }
      })
      assert.equal(page.status, 200, mode)
      const cookie = page.headers.getSetCookie()[0]!.split(';')[0]!
      if (forwardProtocol) {
        assert.match(page.headers.getSetCookie()[0]!, /; Secure/)
      }
      const csrf = /<meta name="rovloom-management-bootstrap" content="([\w-]+)"/.exec(await page.text())![1]!
      assert.equal((await request('/browser.js', { headers: { ...base, origin: browserOrigin } })).status, 200)
      assert.equal(
        (await request('/admin/v1/status', { headers: { ...base, origin: browserOrigin, cookie } })).status,
        200
      )
      const post = {
        ...base,
        origin: browserOrigin,
        cookie,
        'x-rovloom-csrf': csrf,
        'content-type': 'application/json'
      }
      const result = await request('/admin/v1/actions/history_open', { method: 'POST', headers: post, body: '{}' })
      assert.equal(result.status, 200, mode)
      assert.equal(result.headers.get('access-control-allow-origin'), null)
      assert.equal(
        (
          await request('/admin/v1/actions/history_open', {
            method: 'POST',
            headers: { ...post, 'x-rovloom-csrf': 'wrong' },
            body: '{}'
          })
        ).status,
        403
      )
      assert.equal(
        (
          await request('/admin/v1/status', {
            headers: { ...base, origin: browserOrigin, 'x-forwarded-user': 'admin' }
          })
        ).status,
        401
      )
      assert.equal(
        (
          await request('/browser.js', {
            headers: { ...base, origin: 'https://cross-site.example', 'sec-fetch-site': 'cross-site' }
          })
        ).status,
        403
      )
    }
  } finally {
    const closed = once(proxy, 'close')
    proxy.closeAllConnections()
    proxy.close()
    await closed
    listener.stop()
    authority.close()
    source.close()
    db.close()
    f.close()
  }
})
