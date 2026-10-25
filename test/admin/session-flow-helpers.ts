// 组合真实管理handler/Store与浏览器逻辑，cookie/CSRF/设备身份均为本测试短期合成材料。
import { createHash } from 'node:crypto'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { createManagementWriteClient } from '../../src/webui/write-client.js'
import { connected, management } from '../storage/helpers.js'
import { setup } from './write-helpers.js'
import type { ManagementFetch } from '../../src/webui/http-client.js'

/** 各测试拥有自己的Store与handler，真实业务提交不使用服务stub。 */
export function sessionFlowFixture() {
  const f = setup(undefined, { management })
  const device = connected(f.store, 'owned_browser_flow')
  f.grant(
    { action: 'devices_read', machine_id: device.machine_id },
    { action: 'devices_rename', machine_id: device.machine_id },
    { action: 'devices_disconnect', machine_id: device.machine_id },
    { action: 'devices_revoke', machine_id: device.machine_id }
  )
  const cookie = 'SYNTHETIC_BROWSER_COOKIE_' + 'c'.repeat(32)
  const csrf = 'SYNTHETIC_BROWSER_CSRF_' + 'd'.repeat(32)
  const origin = 'http://127.0.0.1:43302'
  const adapter = createManagementSessionAdapter({
    identities: f.identities,
    origin,
    cookie_name: 'fixture_admin',
    /** 本测试可信时间不会创建/续期任何生产会话。 */ now: () => 1000,
    sessions: {
      identities: f.identities,
      /** 来源只认识本fixture内存中的短期cookie，不从HTTP参数构造管理员。 */
      async resolveCookie(value) {
        return value === cookie
          ? {
              caller: { principal_id: 'fixture_admin' },
              session_ref: 'fixture_session',
              expires_at: 301_000,
              csrf_sha256: [createHash('sha256').update(csrf).digest('hex')]
            }
          : null
      }
    }
  })
  const service = new StoreManagementWriteService({
    store: f.store,
    identities: adapter.identities,
    transport: { /** 此处只测试Store断开语义，实际socket另由原双Connector回归覆盖。 */ refresh() {} }
  })
  const handler = createManagementHandler({
    origin,
    service,
    authenticate: adapter.authenticate,
    verifyCsrf: adapter.verifyCsrf
  })
  const calls: string[] = []
  let hook: ((path: string, response: Response) => Promise<Response>) | undefined
  const fetcher: ManagementFetch = /** 模拟浏览器实际附带同源cookie和Origin，只使用标准Request/Response。 */ async (
    path,
    init
  ) => {
    calls.push(path.split('/').at(-1)!)
    const headers = new Headers(init.headers)
    headers.set('host', '127.0.0.1:43302')
    headers.set('origin', origin)
    headers.set('cookie', 'fixture_admin=' + cookie)
    const reply = await handler.fetch(new Request(origin + path, { ...init, headers }))
    return hook ? hook(path, reply) : reply
  }
  const client = createManagementWriteClient({
    fetcher,
    /** 既有受保护bootstrap的内存结果，仅为fixture，不实现生产登录。 */ csrf: async () => csrf
  })
  return {
    f,
    device,
    client,
    calls,
    cookie,
    csrf,
    /** 为丢响应/迟到与损坏回复注入受控网络行为，不替换实际业务服务。 */ set hook(value: typeof hook) {
      hook = value
    },
    /** 释放本fixture拥有的等待和Store，绝不关闭用户Gateway。 */ close() {
      client.close()
      handler.stop()
      f.close()
    }
  }
}

/** 受控网络gate用于验证取消和迟到响应，不通过真实sleep等待。 */
export function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(
    /** 暴露只供本测试释放的网络gate。 */ (done) => {
      resolve = done
    }
  )
  return { promise, resolve }
}
