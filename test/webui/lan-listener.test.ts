// 监听网卡控制网络可达性，HTTP Host 不作代理域名白名单；认证仍由会话后端决定。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startManagementReadListener } from '../../src/admin/read-http.js'
import type { GatewayManagementService, ManagementArguments } from '../../src/mcp/management.js'
import type { ManagementHttpOptions } from '../../src/admin/read-http.js'
import type { ManagementReadOperation } from '../../src/webui/read.js'
import { fixtureReply } from './fixtures.js'
import { statusWithHost } from '../mcp/wildcard-listener.js'

function options(): ManagementHttpOptions {
  return {
    service: {
      execute: /* 合成 DTO 只验证传输边界。 */ async (name, args) =>
        fixtureReply(name as ManagementReadOperation, args as ManagementArguments[ManagementReadOperation])
    } as GatewayManagementService,
    authenticate: /* 此身份仅限本测试。 */ async () => ({
      caller: { principal_id: 'fixture-principal' },
      management_session_ref: 'fixture-session'
    })
  }
}

test(
  'management accepts proxy hosts on loopback and wildcard listeners without a domain opt-in',
  /** 不同绑定下均可携带代理域名 Host；仅使用明确注入的测试身份。 */ async () => {
    const plain = startManagementReadListener({ ...options(), port: 0, hostname: '0.0.0.0' })
    const lan = startManagementReadListener({ ...options(), port: 0, hostname: '0.0.0.0', lan: true })
    try {
      const plainPort = Number(new URL(plain.url).port)
      const lanPort = Number(new URL(lan.url).port)
      assert.match(lan.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
      // 不以 Host 区分代理域名；监听网卡与请求认证分别控制。
      const refused = await statusWithHost(plainPort, `192.0.2.10:${plainPort}`, '/admin/v1/status')
      assert.equal(refused, 200, `plain -> ${refused}`)
      // 旧 LAN 提示不影响代理域名与回环 Host 的认证。
      assert.equal(await statusWithHost(lanPort, `192.0.2.10:${lanPort}`, '/admin/v1/status'), 200)
      assert.equal(await statusWithHost(lanPort, `127.0.0.1:${lanPort}`, '/admin/v1/status'), 200)
      // 即使物理连接走回环，也可由代理交付任意域名 Host。
      const loopback = startManagementReadListener({ ...options(), port: 0, lan: true })
      try {
        const loopPort = Number(new URL(loopback.url).port)
        const denied = await statusWithHost(loopPort, `192.0.2.10:${loopPort}`, '/admin/v1/status')
        assert.equal(denied, 200, `loopback-only -> ${denied}`)
        assert.equal(await statusWithHost(loopPort, `127.0.0.1:${loopPort}`, '/admin/v1/status'), 200)
      } finally {
        loopback.stop()
      }
    } finally {
      plain.stop()
      lan.stop()
    }
  }
)
