// 独立管理来源使用真实私有文件/摘要/authority；principal和既有批准均为明确合成fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { chmodSync, statSync, unlinkSync } from 'node:fs'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { openProtectedManagementSource } from '../../src/cli/management-source.js'
import { managementSourceFixture, mcpProof } from './management-source-fixture.js'

test(
  '受保护管理来源只接受独立证明和固定租期，MCP凭据、URL及伪造来源均不升级为管理员',
  /** 页面资源为显式fixture；身份解析、文件保护、摘要与会话authority全部走正式实现。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    const source = openProtectedManagementSource(f.config, 'management', {
      now: /** 共用受控测试时钟。 */ () => f.clock.now,
      assets: f.assets
    })
    try {
      assert.equal(source.isFullAdministrator(f.lease.caller, f.lease.management_session_ref), false)
      const signal = new AbortController().signal
      assert.deepEqual(await source.management.resolveLease(f.request(), signal), f.lease)
      for (const request of [
        f.request('Bearer ' + mcpProof),
        f.request('Basic ' + Buffer.from(f.lease.caller.principal_id + ':' + mcpProof).toString('base64')),
        f.request('Basic malformed'),
        f.request(
          'Basic ' +
            Buffer.from(f.lease.caller.principal_id + ':SYNTHETIC_WRONG_PROOF_'.padEnd(64, 'w')).toString('base64')
        ),
        f.request(undefined, { headers: { origin: 'http://untrusted.invalid' } }),
        f.request(undefined, { headers: { host: 'untrusted.invalid' } }),
        f.request(undefined, { headers: { 'sec-fetch-site': 'cross-site' } }),
        new Request(f.origin + '/?proof=SYNTHETIC_PRIVATE', { headers: { host: new URL(f.origin).host } })
      ]) {
        assert.equal(await source.management.resolveLease(request, signal), null)
      }
      assert.equal(source.administrator({ principal_id: 'other' }, f.lease.management_session_ref), null)
      assert.deepEqual(source.administrator(f.lease.caller, f.lease.management_session_ref), f.admin)
      const cancelled = new AbortController()
      cancelled.abort()
      assert.equal(await source.management.resolveLease(f.request(), cancelled.signal), null)
      f.clock.now = f.lease.expires_at
      assert.equal(await source.management.resolveLease(f.request(), signal), null)
      assert.equal(source.administrator(f.lease.caller, f.lease.management_session_ref), null)
      f.clock.now--
      assert.equal(await source.management.resolveLease(f.request(), signal), null)
    } finally {
      source.close()
      f.close()
    }
  }
)

test(
  '管理来源字段与凭据摘要独立，普通权限不撤销cookie，自己的记录变更或删除仍永久拒绝',
  /** 使用正式caller和authority读取同一文件后端；不注入管理员成功回调。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    for (const mutation of ['changed', 'missing'] as const) {
      const f = await managementSourceFixture()
      const source = openProtectedManagementSource(f.config, 'management', { assets: f.assets })
      const caller = openCallerSource(f.callerPath, f.callers.resource, source.administrator)
      const authority = createManagementSessionAuthority(caller.identities)
      source.bindAuthority(authority)
      try {
        const lease = await source.management.resolveLease(f.request(), new AbortController().signal)
        assert(lease)
        const cookie = authority.bootstrap(lease).cookie
        assert(await authority.sessions.resolveCookie(cookie, new AbortController().signal))
        chmodSync(f.sourcePath, 0o644)
        assert(await authority.sessions.resolveCookie(cookie, new AbortController().signal))
        assert.equal(statSync(f.sourcePath).mode & 0o777, 0o644)
        if (mutation === 'changed') {
          f.save(f.sourcePath, {
            ...f.source,
            sessions: [{ ...f.source.sessions[0]!, credential_sha256: '1'.repeat(64) }]
          })
        }
        if (mutation === 'missing') {
          unlinkSync(f.sourcePath)
        }
        assert.equal(await authority.sessions.resolveCookie(cookie, new AbortController().signal), null)
        f.save(f.sourcePath, f.source)
        chmodSync(f.sourcePath, 0o600)
        assert.equal(await authority.sessions.resolveCookie(cookie, new AbortController().signal), null)
        const relogin = await source.management.resolveLease(f.request(), new AbortController().signal)
        if (mutation === 'missing') {
          // 文件被删除是永久关闭：恢复文件也不能让本轮来源复活。
          assert.equal(relogin, null)
        } else {
          // 记录改动后旧 Cookie 已失效；还原为合法记录后，用原证明重新登录是一次新的认证。
          assert(relogin)
        }
      } finally {
        source.close()
        authority.close()
        caller.close()
        f.close()
      }
    }
    const f = await managementSourceFixture()
    try {
      f.source.sessions[0]!.credential_sha256 = f.callers.callers[0]!.token_sha256
      f.save(f.sourcePath, f.source)
      assert.throws(
        /** 同一MCP凭据摘要不得兼任独立管理员证明。 */ () =>
          openProtectedManagementSource(f.config, 'management', { assets: f.assets }),
        { code: 'invalid_config' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  'scope=all_devices 的管理员授权按 Store 当前设备与 provider 生成，新设备无需改文件即获授权',
  /** 静态授权为空；资源枚举绑定后每个设备与 provider 都得到完整的管理动作，未绑定时没有任何设备授权。 */ () => {
    return (async () => {
      if (process.platform !== 'linux') {
        return
      }
      const f = await managementSourceFixture()
      try {
        f.save(f.sourcePath, {
          ...f.source,
          sessions: [{ ...f.source.sessions[0]!, scope: 'all_devices', administrator: { ...f.admin, grants: [] } }]
        })
        const source = openProtectedManagementSource(f.config, 'management', { assets: f.assets })
        try {
          const caller = f.lease.caller
          const ref = f.lease.management_session_ref
          assert.equal(source.isFullAdministrator(caller, ref), true)
          assert.equal(source.isFullAdministrator({ principal_id: 'other' }, ref), false)
          const bare = source.administrator(caller, ref)!
          assert.deepEqual(bare.grants, [])
          let machines = [{ machine_id: 'm_one', provider_ids: ['p_a'] }]
          source.bindResources(() => machines)
          const first = source.administrator(caller, ref)!.grants
          assert(first.some((grant) => grant.action === 'gateway_read'))
          assert(first.some((grant) => grant.action === 'devices_register'))
          for (const action of [
            'devices_read',
            'devices_rename',
            'devices_disconnect',
            'devices_revoke',
            'calls_read'
          ]) {
            assert(
              first.some((grant) => grant.action === action && 'machine_id' in grant && grant.machine_id === 'm_one')
            )
          }
          assert(
            first.some(
              (grant) => grant.action === 'providers_manage' && 'provider_id' in grant && grant.provider_id === 'p_a'
            )
          )
          machines = [...machines, { machine_id: 'm_two', provider_ids: [] }]
          const second = source.administrator(caller, ref)!.grants
          assert(
            second.some(
              (grant) => grant.action === 'devices_read' && 'machine_id' in grant && grant.machine_id === 'm_two'
            )
          )
          assert.throws(/** 资源来源只绑定一次。 */ () => source.bindResources(() => []), { code: 'invalid_config' })
        } finally {
          source.close()
        }
      } finally {
        f.close()
      }
    })()
  }
)

test(
  '管理员记录热读：新增管理员立即可登录且不影响已登录者，移除记录立即撤销其 Cookie',
  /** rovloom admin 对文件的合法修改无需重启；撤销只作用于被移除/改动的那条记录。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    const source = openProtectedManagementSource(f.config, 'management', { assets: f.assets })
    const caller = openCallerSource(f.callerPath, f.callers.resource, source.administrator)
    const authority = createManagementSessionAuthority(caller.identities)
    source.bindAuthority(authority)
    try {
      const signal = new AbortController().signal
      const lease = await source.management.resolveLease(f.request(), signal)
      assert(lease)
      const cookie = authority.bootstrap(lease).cookie
      assert(await authority.sessions.resolveCookie(cookie, signal))
      const secret = 'SECOND_ADMIN_PROOF_'.padEnd(64, 's')
      const second = {
        ...f.source.sessions[0]!,
        credential_sha256: createHash('sha256').update(secret).digest('hex'),
        lease: { ...f.lease, caller: { principal_id: 'second_admin' }, management_session_ref: 'second_session' },
        administrator: { ...f.admin, principal_id: 'second_admin', session_ref: 'second_session' }
      }
      f.save(f.sourcePath, { ...f.source, sessions: [...f.source.sessions, second] })
      const login = f.request('Basic ' + Buffer.from('second_admin:' + secret).toString('base64'))
      assert(await source.management.resolveLease(login, signal))
      assert(await authority.sessions.resolveCookie(cookie, signal), '新增另一位管理员不影响已登录者')
      f.save(f.sourcePath, { ...f.source, sessions: [second] })
      assert.equal(await authority.sessions.resolveCookie(cookie, signal), null, '移除自己的记录立即撤销 Cookie')
      assert.equal(await source.management.resolveLease(f.request(), signal), null)
      assert(await source.management.resolveLease(login, signal), '其余管理员不受影响')
      f.save(f.sourcePath, { ...f.source, sessions: [] })
      assert.equal(await source.management.resolveLease(login, signal), null, '清空后没有任何管理员可登录')
    } finally {
      source.close()
      authority.close()
      caller.close()
      f.close()
    }
  }
)

test(
  'allowMissing：启动时没有来源文件按零管理员运行，创建后热读生效，出现过又被删除则永久关闭',
  /** 新用户先启动 Gateway 再 rovloom admin create：无需重启；删除文件仍是永久撤销。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    unlinkSync(f.sourcePath)
    const source = openProtectedManagementSource(f.config, 'management', { assets: f.assets, allowMissing: true })
    try {
      const signal = new AbortController().signal
      assert.equal(await source.management.resolveLease(f.request(), signal), null, '零管理员时任何口令都不能登录')
      assert.equal(source.administrator(f.lease.caller, f.lease.management_session_ref), null)
      f.save(f.sourcePath, f.source)
      assert(await source.management.resolveLease(f.request(), signal), '文件出现后无需重启即可登录')
      unlinkSync(f.sourcePath)
      assert.equal(await source.management.resolveLease(f.request(), signal), null)
      f.save(f.sourcePath, f.source)
      assert.equal(
        await source.management.resolveLease(f.request(), signal),
        null,
        '出现过又删除：永久关闭，恢复文件无效'
      )
    } finally {
      source.close()
      f.close()
    }
    // 默认（不允许缺失）时文件不存在仍是明确的配置错误。
    const g = await managementSourceFixture()
    try {
      unlinkSync(g.sourcePath)
      assert.throws(() => openProtectedManagementSource(g.config, 'management', { assets: g.assets }), {
        code: 'backend_unavailable'
      })
    } finally {
      g.close()
    }
  }
)

test(
  '配对前创建管理员后页面无需重启即发出Basic挑战；未配对时零管理员仍交付空壳',
  /** bootstrap_challenge 随来源文件热读，全新 Gateway 先 rovloom admin create 再打开页面即可登录。 */
  async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    unlinkSync(f.sourcePath)
    const source = openProtectedManagementSource(f.config, 'management', { assets: f.assets, allowMissing: true })
    try {
      const signal = new AbortController().signal
      assert.equal(source.management.bootstrap_challenge, undefined, '零管理员时不挑战，先交付空壳')
      f.save(f.sourcePath, f.source)
      assert.equal(source.management.bootstrap_challenge, 'basic', '文件出现后下一次页面交付即挑战')
      assert(await source.management.resolveLease(f.request(), signal), '无需重启即可登录')
      unlinkSync(f.sourcePath)
      assert.equal(source.management.bootstrap_challenge, 'basic', '来源关闭后 fail closed 仍挑战')
    } finally {
      source.close()
      f.close()
    }
  }
)

test(
  '通配管理页绑定接受局域网 Host 的同源登录，跨站 Origin 与回环绑定时不变',
  /** resolveLease 的 Origin/Host 核对按管理页绑定逐请求放宽，其余边界保持。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    const lanConfig = { ...f.config, management_hostname: '0.0.0.0' as const } as typeof f.config
    for (const [config, lan] of [
      [f.config, false],
      [lanConfig, true]
    ] as const) {
      const source = openProtectedManagementSource(config, 'management', {
        assets: f.assets
      })
      try {
        const signal = new AbortController().signal
        const lanHost = `192.0.2.10:${f.config.management_port}`
        const lanRequest = new Request(`http://${lanHost}/`, {
          headers: { host: lanHost, authorization: f.request().headers.get('authorization')! }
        })
        assert.deepEqual(
          await source.management.resolveLease(lanRequest, signal),
          lan ? f.lease : null,
          lan ? 'LAN 选择下局域网 Host 登录成功' : '未选择时局域网 Host 仍拒绝'
        )
        assert.deepEqual(await source.management.resolveLease(f.request(), signal), f.lease, '回环登录不变')
        const cross = new Request(`http://${lanHost}/`, {
          headers: {
            host: lanHost,
            origin: 'http://evil.example',
            authorization: f.request().headers.get('authorization')!
          }
        })
        assert.equal(await source.management.resolveLease(cross, signal), null, '跨站 Origin 始终拒绝')
      } finally {
        source.close()
      }
    }
    f.close()
  }
)
