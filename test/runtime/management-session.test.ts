// 用正式 PR69 adapter 与真实管理 Store 验证显式 cookie 宿主、固定租期、源撤权及请求作用域。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import type { ManagementSessionBootstrap, ManagementSessionLease } from '../../src/runtime/management-session.js'
import type {
  ManagementSessionPersistence,
  PersistedManagementSession
} from '../../src/runtime/management-session-store.js'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import type { GatewayIdentitySource } from '../../src/mcp/management.js'
import { setup } from '../admin/write-helpers.js'

const origin = 'http://127.0.0.1:42819'
const caller = Object.freeze({ principal_id: 'fixture_admin' })
const sessionRef = 'fixture_session'

/** 合成来源只认可 fixture 已存在的管理员；cookie 宿主没有创建账号、MCP 或设备身份的路径。 */
function fixture(capacity = 4) {
  const managed = setup()
  const state = {
    now: 1000,
    adminCalls: 0,
    principalCalls: 0,
    afterPrincipal: undefined as (() => void) | undefined,
    afterAdmin: undefined as (() => void) | undefined,
    refs: new Set([sessionRef, 'second_session'])
  }
  const source: GatewayIdentitySource = {
    /** 读取同一原服务的 principal，并允许精确测试身份回调同步撤销或关闭。 */
    principal(identity) {
      state.principalCalls++
      const principal = managed.identities.principal(identity)
      state.afterPrincipal?.()
      return principal
    },
    /** 两个既有 ref 都由隔离 fixture 的原身份服务认可，不是 cookie 宿主发行的新 ref。 */
    administrator(identity, ref) {
      state.adminCalls++
      const admin = state.refs.has(ref) ? managed.identities.administrator(identity, sessionRef) : null
      state.afterAdmin?.()
      return admin ? { ...admin, session_ref: ref } : null
    }
  }
  const authority = createManagementSessionAuthority(source, {
    now: /** 使用与正式 adapter 相同的可控可信时钟。 */ () => state.now,
    max_sessions: capacity
  })
  const adapter = createManagementSessionAdapter({
    identities: authority.identities,
    sessions: authority.sessions,
    origin,
    cookie_name: 'protected_management',
    now: /** adapter 与宿主检查同一个固定期限。 */ () => state.now
  })
  const service = new StoreManagementWriteService({
    store: managed.store,
    identities: authority.identities,
    transport: { /** 本测试不触及设备通道，仅验证真实管理事务入口。 */ refresh() {} },
    pairingPolicy: /** 配对策略仍来自独立已有服务。 */ (ref) => ref === 'fixture_policy'
  })
  const handler = createManagementHandler({ origin, service, ...adapter })
  return {
    managed,
    source,
    authority,
    adapter,
    handler,
    state,
    /** 仅模拟受保护本机产品的显式动作，实际 HTTP/MCP 参数没有调用此方法的入口。 */
    issue(overrides: Partial<ManagementSessionLease> = {}) {
      return authority.bootstrap({
        caller,
        management_session_ref: sessionRef,
        issued_at: 1000,
        expires_at: 601_000,
        ...overrides
      })
    },
    /** 只回收本 fixture 自己拥有的内存会话、handler 与 Store。 */
    close() {
      handler.stop()
      authority.close()
      managed.close()
    }
  }
}

/** cookie 与 CSRF 仅由本次显式交付结果供浏览器请求使用，不从 bearer 或正文取身份。 */
function request(delivery?: ManagementSessionBootstrap, headers: Record<string, string> = {}): Request {
  return new Request(origin + '/admin/v1/actions/history_open', {
    method: 'POST',
    body: '{}',
    headers: {
      host: '127.0.0.1:42819',
      origin,
      'content-type': 'application/json',
      ...(delivery
        ? { cookie: 'protected_management=' + delivery.cookie, 'x-rovloom-csrf': delivery.csrf }
        : { 'x-rovloom-csrf': 'missing_bootstrap_secret_00000000000' }),
      ...headers
    }
  })
}

/** 每个操作使用独立真实取消信号，已中止请求不能进入 ALS。 */
function signal(): AbortSignal {
  return new AbortController().signal
}

test(
  'management host supplies the canonical PR69 adapter without automatic identities or HTTP hooks',
  /** 构造只交付来源，显式 bootstrap 后正式 HTTP adapter 和 Store 使用完全相同的对象。 */ async () => {
    const f = fixture()
    try {
      assert.equal(f.state.adminCalls, 0)
      assert.equal(f.state.principalCalls, 0)
      assert.equal('authenticate' in f.authority, false)
      assert.equal('verifyCsrf' in f.authority, false)
      assert.equal(f.authority.sessions.identities, f.authority.identities)
      assert.equal(f.adapter.identities, f.authority.identities)
      assert.equal(f.authority.identities.administrator(caller, sessionRef), null)
      assert.equal((await f.handler.fetch(request(undefined, { authorization: 'Bearer fixture_mcp' }))).status, 401)
      const delivery = f.issue()
      assert.equal(delivery.management_session_ref, sessionRef)
      assert.equal(delivery.expires_at, 601_000)
      assert.match(delivery.cookie, /^[a-zA-Z0-9_-]{43}$/)
      assert.match(delivery.csrf, /^[a-zA-Z0-9_-]{43}$/)
      assert.notEqual(delivery.cookie, delivery.csrf)
      const binding = await f.authority.sessions.resolveCookie(delivery.cookie, signal())
      assert.deepEqual(binding, {
        caller,
        session_ref: sessionRef,
        expires_at: delivery.expires_at,
        csrf_sha256: createHash('sha256').update(delivery.csrf).digest('hex')
      })
      assert.equal(JSON.stringify(binding).includes(delivery.cookie), false)
      assert.equal(JSON.stringify(binding).includes(delivery.csrf), false)
      assert.equal((await f.handler.fetch(request(delivery))).status, 200)
      assert.equal((await f.handler.fetch(request(delivery, { 'x-rovloom-csrf': delivery.cookie }))).status, 403)
      assert.equal(f.authority.identities.administrator(caller, sessionRef)?.principal_id, caller.principal_id)
    } finally {
      f.close()
    }
  }
)

test(
  'bootstrap requires the same existing ordinary administrator and never mints a session reference',
  /** 未知 ref、普通 caller、恢复身份与源异常都不能靠短 cookie 创建管理能力。 */ () => {
    const f = fixture()
    try {
      assert.throws(
        /** 猜测原服务不认识的引用。 */ () => f.issue({ management_session_ref: 'unknown_session' }),
        /unauthenticated/
      )
      assert.throws(
        /** 普通 MCP caller 不具备独立管理员来源。 */ () => f.issue({ caller: { principal_id: 'mcp_caller' } }),
        /unauthenticated/
      )
      const saved = f.managed.admin
      f.managed.admin = null
      assert.throws(/** 没有真实管理员来源时不能创建短期 cookie。 */ () => f.issue(), /unauthenticated/)
      f.managed.admin = saved
      f.state.afterAdmin = /** 底层失败必须转为固定错误，不能输出私有正文。 */ () => {
        throw new Error('private_native_secret')
      }
      assert.throws(/** 不允许底层异常原样越过 bootstrap。 */ () => f.issue(), { message: 'unauthenticated' })
      f.state.afterAdmin = undefined
      assert.equal(f.issue().management_session_ref, sessionRef)
    } finally {
      f.close()
    }
  }
)

test(
  'bootstrap rotation preserves the first cutoff and invalidates the previous one-time delivery',
  /** 重复显式动作只旋转摘要，任何更长租期都不能滑动首次截止。 */ async () => {
    const f = fixture()
    try {
      const first = f.issue({ expires_at: 11_000 })
      f.state.now = 2000
      const second = f.issue({ expires_at: 901_000 })
      assert.equal(second.expires_at, 11_000)
      assert.notEqual(second.cookie, first.cookie)
      assert.notEqual(second.csrf, first.csrf)
      assert.equal(await f.authority.sessions.resolveCookie(first.cookie, signal()), null)
      assert.equal((await f.handler.fetch(request(second, { 'x-rovloom-csrf': first.csrf }))).status, 403)
      assert.equal((await f.handler.fetch(request(second))).status, 200)
      f.state.now = 11_000
      assert.equal(await f.authority.sessions.resolveCookie(second.cookie, signal()), null)
      assert.throws(
        /** 已到期原 ref 不能重新绑定成更晚租期。 */ () => f.issue({ expires_at: 901_000 }),
        /unauthenticated/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '页面首次交付和取消fence不会旋转、撤销或晚注册旧租期',
  /** 管理员回调同步取消时，提交前必须再次检查同一signal，旧cookie仍有效。 */ async () => {
    const f = fixture()
    const lease: ManagementSessionLease = {
      caller,
      management_session_ref: sessionRef,
      issued_at: 1000,
      expires_at: 601_000
    }
    try {
      const cancelled = new AbortController()
      cancelled.abort()
      const calls = f.state.adminCalls
      assert.throws(
        /** 已取消初始化不得进入身份回调或登记租期。 */ () =>
          f.authority.bootstrap(lease, { signal: cancelled.signal, rotate: false }),
        /unauthenticated/
      )
      assert.equal(f.state.adminCalls, calls)
      const pending = new AbortController()
      f.state.afterAdmin = /** 原身份后端同步取消当前请求，模拟stop/断开重入。 */ () => pending.abort()
      assert.throws(
        /** 回调返回有效管理员也不能越过已取消提交。 */ () =>
          f.authority.bootstrap(lease, { signal: pending.signal, rotate: false }),
        /unauthenticated/
      )
      f.state.afterAdmin = undefined
      const first = f.authority.bootstrap(lease, { rotate: false })
      const previousCalls = f.state.adminCalls
      assert.throws(
        /** 同一会话的重复页面在resolve前拒绝，不触发源回调或旧租期撤销。 */ () =>
          f.authority.bootstrap(lease, { rotate: false }),
        /unauthenticated/
      )
      assert.equal(f.state.adminCalls, previousCalls)
      const rotation = new AbortController()
      f.state.afterAdmin = /** 显式旋转也服从同一个提交前取消fence。 */ () => rotation.abort()
      assert.throws(
        /** 取消的旋转既不能替换cookie也不能撤销旧值。 */ () =>
          f.authority.bootstrap(lease, { signal: rotation.signal }),
        /unauthenticated/
      )
      f.state.afterAdmin = undefined
      assert(await f.authority.sessions.resolveCookie(first.cookie, signal()))
      f.authority.revoke(caller, sessionRef)
      assert.throws(
        /** 已撤销记录保留墓碑，页面不能恢复旧引用。 */ () => f.authority.bootstrap(lease, { rotate: false }),
        /unauthenticated/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'bounded session anchors reject new refs without evicting live sessions or forgetting tombstones',
  /** 满额保持已有活会话；撤销和到期墓碑也不腾出可复用的首次期限。 */ async () => {
    const f = fixture(1)
    try {
      const first = f.issue()
      assert.throws(
        /** 第二个源认可 ref 也不能驱逐第一个。 */ () => f.issue({ management_session_ref: 'second_session' }),
        /unauthenticated/
      )
      assert.equal((await f.handler.fetch(request(first))).status, 200)
      f.authority.revoke(caller, sessionRef)
      assert.equal(await f.authority.sessions.resolveCookie(first.cookie, signal()), null)
      assert.throws(/** 显式撤销永久封闭本宿主对原 ref 的重建。 */ () => f.issue(), /unauthenticated/)
      assert.throws(
        /** 墓碑仍计入有界容量。 */ () => f.issue({ management_session_ref: 'second_session' }),
        /unauthenticated/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'current administrator source revocation and policy changes invalidate established cookies',
  /** 每次解析都重新查源，观察到撤权后不能靠恢复旧对象重新启用 cookie。 */ async () => {
    for (const change of ['principal', 'administrator', 'policy'] as const) {
      const f = fixture()
      try {
        const delivery = f.issue()
        const saved = f.managed.admin
        if (change === 'principal') {
          f.managed.authenticated = false
        } else if (change === 'administrator') {
          f.managed.admin = null
        } else {
          f.managed.admin = { ...saved!, policy_revision: 'new_policy' }
        }
        assert.equal(f.authority.identities.administrator(caller, sessionRef), null)
        assert.equal((await f.handler.fetch(request(delivery))).status, 401)
        f.managed.admin = saved
        f.managed.authenticated = true
        assert.equal(await f.authority.sessions.resolveCookie(delivery.cookie, signal()), null)
      } finally {
        f.close()
      }
    }
  }
)

test(
  'management writer rechecks the fixed lease after a slow HTTP request body',
  /** 正式 adapter 已完成认证及 CSRF 后才放行正文，Store 的最终管理员复核仍须拒绝到期。 */ async () => {
    const f = fixture()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    let reading!: () => void
    const started = new Promise<void>(
      /** 精确观察 handler 开始读取正文，避免猜测异步阶段。 */ (resolve) => {
        reading = resolve
      }
    )
    const body = new ReadableStream<Uint8Array>(
      {
        /** 初次拉取代表 HTTP 路径确实开始消费正文。 */ pull() {
          reading()
        },
        /** 保存隔离流控制器，在源会话到期后再提供完整正文。 */ start(controller) {
          stream = controller
        }
      },
      { highWaterMark: 0 }
    )
    try {
      const delivery = f.issue({ expires_at: 11_000 })
      const original = request(delivery)
      const req = new Request(original.url, {
        method: 'POST',
        headers: original.headers,
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' })
      const response = f.handler.fetch(req)
      await started
      f.state.now = delivery.expires_at
      stream.enqueue(new TextEncoder().encode('{}'))
      stream.close()
      assert.equal((await response).status, 401)
    } finally {
      f.close()
    }
  }
)

test(
  '持久化绑定让重启后的既有 cookie 继续生效，撤销与到期仍立即拒绝',
  /** 新进程只恢复摘要绑定，每个请求仍复验原管理员记录，所以恢复不等于放行未验证会话。 */ async () => {
    const f = fixture()
    try {
      // 模拟落盘内容：只保留摘要，原 cookie/CSRF 从不写入。
      const saved: PersistedManagementSession[] = []
      const persist: ManagementSessionPersistence = {
        load: () => saved,
        save: (rows: readonly PersistedManagementSession[]) => {
          saved.length = 0
          saved.push(...rows)
        }
      }
      const first = createManagementSessionAuthority(f.source, {
        now: () => f.state.now,
        persist
      })
      let delivery: ManagementSessionBootstrap
      try {
        delivery = first.bootstrap({
          caller,
          management_session_ref: sessionRef,
          issued_at: 1000,
          expires_at: 601_000
        })
        assert.equal(saved.length, 1)
        const record = saved[0] as Record<string, unknown>
        // 落盘内容不含任何原值，只有摘要。
        assert.equal((record.cookie_sha256 as string).length, 64)
        assert.equal(JSON.stringify(record).includes(delivery.cookie), false)
        assert.equal(JSON.stringify(record).includes(delivery.csrf), false)
      } finally {
        first.close()
      }
      // 新 authority 只靠持久化恢复，旧 cookie 仍能解析出同一会话。
      const restarted = createManagementSessionAuthority(f.source, {
        now: () => f.state.now,
        persist
      })
      try {
        const restored = await restarted.sessions.resolveCookie(delivery.cookie, signal())
        assert.equal(restored?.session_ref, sessionRef)
        // 到期后同一绑定不再生效。
        f.state.now = 601_000
        assert.equal(await restarted.sessions.resolveCookie(delivery.cookie, signal()), null)
      } finally {
        restarted.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  'clock rollback and close permanently reject cookies without another bootstrap window',
  /** 宿主观察到回退或关闭后，恢复时钟和重复本机动作都不能重新启用旧引用。 */ async () => {
    for (const action of ['rollback', 'close'] as const) {
      const f = fixture()
      try {
        const delivery = f.issue()
        if (action === 'rollback') {
          f.state.now--
        } else {
          f.authority.close()
        }
        assert.equal(await f.authority.sessions.resolveCookie(delivery.cookie, signal()), null)
        f.state.now = 1000
        assert.throws(/** 停止状态不随时间恢复而重启。 */ () => f.issue(), /unauthenticated/)
        assert.equal(f.authority.identities.administrator(caller, sessionRef), null)
      } finally {
        f.close()
      }
    }
  }
)

test(
  'source callbacks cannot close or revoke a host and then return an accepted administrator',
  /** 原身份读取同步重入后，bootstrap 和既有 cookie 都必须在最终 fence 拒绝。 */ async () => {
    for (const stage of ['bootstrap', 'resolve', 'principal'] as const) {
      const f = fixture()
      try {
        if (stage === 'bootstrap') {
          f.state.afterAdmin = /** 身份来源关闭宿主后仍返回旧对象。 */ () => f.authority.close()
          assert.throws(/** 不能晚注册刚返回的原管理员。 */ () => f.issue(), /unauthenticated/)
        } else {
          const delivery = f.issue()
          if (stage === 'resolve') {
            f.state.afterAdmin = /** 回调内撤销同一个原 ref。 */ () => f.authority.revoke(caller, sessionRef)
          } else {
            f.state.afterPrincipal = /** principal 回调也不能越过关闭。 */ () => f.authority.close()
          }
          assert.equal(await f.authority.sessions.resolveCookie(delivery.cookie, signal()), null)
        }
      } finally {
        f.close()
      }
    }
  }
)

test(
  'management ALS requires the current cookie and rejects genuine escaped asynchronous descendants',
  /** 真实继承 ALS 的任务在原操作结束后再恢复，不能借另一请求仍活动拿到管理员。 */ async () => {
    const f = fixture()
    try {
      const delivery = f.issue()
      let release!: () => void
      let escaped!: Promise<void>
      await f.authority.runAuthenticated(
        delivery.cookie,
        signal(),
        /** 只以当前秘密进入作用域。 */ () => {
          assert.equal(f.authority.current().session.management_session_ref, sessionRef)
          escaped = new Promise<void>(
            /** latch 任务真实继承当前异步祖先。 */ (resolve) => {
              release = resolve
            }
          ).then(
            /** 请求结束后的后代必须失效。 */ () => {
              assert.throws(
                /** 此时另一个请求存在也不能复活旧上下文。 */ () => f.authority.current(),
                /unauthenticated/
              )
            }
          )
        }
      )
      await f.authority.runAuthenticated(
        delivery.cookie,
        signal(),
        /** 第二请求活动期间恢复旧后代。 */ async () => {
          release()
          await escaped
          assert.equal(f.authority.current().administrator.principal_id, caller.principal_id)
        }
      )
      await assert.rejects(
        f.authority.runAuthenticated(
          { caller, management_session_ref: sessionRef } as unknown as string,
          signal(),
          /** 任意 AdminContext JSON 不可获得本机审批能力。 */ () => undefined
        ),
        /unauthenticated/
      )
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        f.authority.runAuthenticated(delivery.cookie, controller.signal, /** 已取消操作不可进入。 */ () => undefined),
        /unauthenticated/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'management scope rechecks expiry, cancellation, policy and cookie rotation after awaits',
  /** 操作等待期间发生任何当前权限变化，current 与最终结果交付都保持拒绝。 */ async () => {
    for (const change of ['expiry', 'abort', 'policy', 'rotation'] as const) {
      const f = fixture()
      try {
        const delivery = f.issue({ expires_at: 11_000 })
        const controller = new AbortController()
        let rotated: ManagementSessionBootstrap | undefined
        await assert.rejects(
          f.authority.runAuthenticated(
            delivery.cookie,
            controller.signal,
            /** 在真实 await 后修改管理员有效性，验证最终结果也重新检查。 */ async () => {
              await Promise.resolve()
              if (change === 'expiry') {
                f.state.now = delivery.expires_at
              } else if (change === 'abort') {
                controller.abort()
              } else if (change === 'policy') {
                f.managed.admin = { ...f.managed.admin!, policy_revision: 'changed_policy' }
              } else {
                rotated = f.issue({ expires_at: 11_000 })
              }
              assert.throws(/** 当前审批已经失效。 */ () => f.authority.current(), /unauthenticated/)
              return 'late_secret_result'
            }
          ),
          /unauthenticated/
        )
        assert.throws(/** 失败退出同样撤销作用域。 */ () => f.authority.current(), /unauthenticated/)
        if (rotated) {
          assert(await f.authority.sessions.resolveCookie(rotated.cookie, signal()))
        }
      } finally {
        f.close()
      }
    }
  }
)
