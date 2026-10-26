import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managementRequestOrigin, managementSecureRequest } from '../../src/admin/http-origin.js'

test('任意 HTTP/HTTPS 域名和改写后的代理 Host 不需要公网地址配置', () => {
  for (const external of ['https://manage.example', 'https://other.example:12443', 'http://lan.example:8080']) {
    for (const upstream of [external.replace('https:', 'http:'), 'http://127.0.0.1:9445']) {
      const request = new Request(upstream + '/browser.js', {
        headers: { host: new URL(upstream).host, origin: external, 'sec-fetch-site': 'same-origin' }
      })
      assert.equal(managementRequestOrigin(request), external)
    }
  }
})

test('浏览器跨站元数据、无效 Origin 和不一致的 URL/Host 仍被拒绝，转发头不是登录证明', () => {
  for (const headers of [
    { origin: 'null' },
    { origin: 'file:///' },
    { origin: 'https://example/path' },
    { origin: 'https://user:secret@example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { host: 'other.example' }
  ] as Record<string, string>[]) {
    assert.equal(
      managementRequestOrigin(
        new Request('http://127.0.0.1:9445/', {
          headers: { host: '127.0.0.1:9445', 'x-forwarded-host': 'trusted.example', ...headers }
        })
      ),
      null
    )
  }
})

test('Cookie Secure 识别 HTTPS、浏览器 Origin 和两种标准代理协议头', () => {
  for (const headers of [
    { origin: 'https://manage.example' },
    { 'x-forwarded-proto': 'https' },
    { 'x-forwarded-proto': 'https, http' },
    { forwarded: 'for=127.0.0.1;proto=https;host=manage.example' },
    { forwarded: 'proto="https"' }
  ] as Record<string, string>[]) {
    assert.equal(managementSecureRequest(new Request('http://127.0.0.1:9445/', { headers })), true)
  }
  assert.equal(managementSecureRequest(new Request('https://manage.example/')), true)
  assert.equal(managementSecureRequest(new Request('http://127.0.0.1:9445/')), false)
})
