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
    for (const hostname of ['127.0.0.1', '0.0.0.0'] as const) {
      const listener = startManagementReadListener({ ...options(), port: 0, hostname })
      try {
        assert.match(listener.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
        const port = Number(new URL(listener.url).port)
        // Host 对齐请求 URL 即可，物理监听网卡不构成域名白名单。
        for (const host of [`192.0.2.10:${port}`, `127.0.0.1:${port}`, 'public.example']) {
          assert.equal(await statusWithHost(port, host, '/admin/v1/status'), 200, `${hostname}: ${host}`)
        }
      } finally {
        listener.stop()
      }
    }
  }
)
