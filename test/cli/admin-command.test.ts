// rovloom admin：纯函数签发/撤销与 CLI 对真实文件的端到端行为；口令只在签发时出现一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import type { GatewayConfig } from '../../src/cli/config.js'
import { handleAdminCommand, managementSourceExists, writeAdminFiles } from '../../src/cli/admin-command.js'
import { isAdminPlaceholder } from '../../src/cli/admin-registry.js'
import { handleTokenCommand } from '../../src/cli/token-command.js'
import { emptyManagement, issueAdmin, revokeAdmin } from '../../src/cli/admin-registry.js'
import { digestToken, parseRegistry } from '../../src/cli/token-registry.js'
import type { CallerRegistry } from '../../src/cli/token-registry.js'
import { DEFAULT_PAIRING_POLICY_REF } from '../../src/pairing-policy.js'

const DAY = 86_400_000
const policy = { revision: 'p1', grants: [] }
function callers(now = 1_000): CallerRegistry {
  return {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource: 'http://127.0.0.1:9/mcp',
    local_policy: { revision: 'local1', grants: [] },
    callers: [
      {
        principal: { id: 'owner' },
        token_sha256: digestToken('o'.repeat(43)),
        issued_at: now,
        expires_at: now + DAY
      }
    ]
  }
}

test('issue creates a hash-only admin session plus a permissionless MCP placeholder, and reissue replaces it', () => {
  const first = issueAdmin(callers(), emptyManagement(9445), 'admin', 2_000, 7)
  assert.equal(first.expires_at, 2_000 + 7 * DAY)
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/)
  const session = first.management.sessions[0]!
  assert.equal(session.credential_sha256, digestToken(first.secret))
  assert.equal(session.scope, 'all_devices')
  assert.deepEqual(session.administrator.grants, [])
  assert.deepEqual(first.management.pairing_policy_refs, [DEFAULT_PAIRING_POLICY_REF])
  assert(!JSON.stringify({ callers: first.callers, management: first.management }).includes(first.secret))
  const placeholder = first.callers.callers.find((entry) => entry.principal.id === 'admin')!
  assert.equal(placeholder.management_only, true)
  assert(!Object.hasOwn(placeholder.principal, 'policy'))
  // 管理员口令摘要与任何 MCP 令牌摘要都不同，注册表仍然合法。
  assert.notEqual(placeholder.token_sha256, session.credential_sha256)
  parseRegistry(JSON.parse(JSON.stringify(first.callers)))
  const second = issueAdmin(first.callers, first.management, 'admin', 3_000)
  assert.notEqual(second.secret, first.secret)
  assert.equal(second.management.sessions.length, 1)
  assert.notEqual(second.management.sessions[0]!.credential_sha256, session.credential_sha256)
  assert.notEqual(
    second.management.sessions[0]!.lease.management_session_ref,
    session.lease.management_session_ref,
    '重新签发换新会话引用，旧 Cookie 随之失效'
  )
  assert.equal(second.callers.callers.filter((entry) => entry.principal.id === 'admin').length, 1)
})

test('admin creation retains custom pairing policies and seeds an empty legacy allowlist', () => {
  const management = emptyManagement(9445)
  assert.deepEqual(
    issueAdmin(callers(), { ...management, pairing_policy_refs: ['custom'] }, 'admin', 2_000).management
      .pairing_policy_refs,
    ['custom']
  )
  assert.deepEqual(
    issueAdmin(callers(), { ...management, pairing_policy_refs: [] }, 'admin', 2_000).management.pairing_policy_refs,
    [DEFAULT_PAIRING_POLICY_REF]
  )
})

test('admin create and reissue accept valid caller registries larger than 16 KiB', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-admin-large-registry-'))
  try {
    mkdirSync(join(root, 'managed'), { mode: 0o700 })
    const config = { ...configTemplate('gateway'), state_dir: root } as GatewayConfig
    const registry = callers(Date.now())
    registry.callers = Array.from({ length: 55 }, (_, i) => ({
      ...registry.callers[0]!,
      principal: { id: 'caller_' + i + '_' + 'a'.repeat(100), policy },
      token_sha256: digestToken('fixture_' + i)
    }))
    const original = JSON.stringify(parseRegistry(registry))
    assert(Buffer.byteLength(original) > 16_384)
    const path = join(root, 'managed', 'mcp-callers.json')
    writeFileSync(path, original, { mode: 0o600 })
    const first = writeAdminFiles(config, 'admin', Date.now())
    const second = writeAdminFiles(config, 'admin', Date.now())
    assert.notEqual(second.secret, first.secret)
    const after = parseRegistry(JSON.parse(readFileSync(path, 'utf8')))
    assert.deepEqual(
      after.callers.filter((entry) => entry.principal.id !== 'admin'),
      parseRegistry(registry).callers
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('issue refuses to attach admin rights to a real MCP principal, revoke never deletes one', () => {
  assert.throws(() => issueAdmin(callers(), emptyManagement(9445), 'owner', 2_000), { code: 'invalid_arguments' })
  assert.throws(() => issueAdmin(callers(), emptyManagement(9445), 'bad id', 2_000), { code: 'invalid_arguments' })
  const made = issueAdmin(callers(), emptyManagement(9445), 'admin', 2_000)
  const revoked = revokeAdmin(made.callers, made.management, 'admin')
  assert.deepEqual(revoked.management.sessions, [])
  assert.deepEqual(
    revoked.callers.callers.map((entry) => entry.principal.id),
    ['owner']
  )
  assert.throws(() => revokeAdmin(made.callers, made.management, 'owner'), { code: 'invalid_arguments' })
})

function sink() {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

test('admin CLI creates, lists and revokes through the real files; the secret goes only to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-admin-cli-'))
  try {
    const state = join(root, 'gateway')
    mkdirSync(join(state, 'managed'), { recursive: true, mode: 0o700 })
    const config = { ...configTemplate('gateway'), state_dir: state } as GatewayConfig
    const configPath = join(root, 'gateway.json')
    writeFileSync(configPath, JSON.stringify(configDocument(config)), { mode: 0o600 })
    const callerPath = join(state, 'managed', 'mcp-callers.json')
    const managementPath = join(state, 'managed', 'management.json')
    writeFileSync(callerPath, JSON.stringify(callers(Date.now() - 1000)), { mode: 0o600 })
    const run = async (...args: string[]) => {
      const out = sink()
      const err = sink()
      const code = await handleAdminCommand(['admin', ...args, '--config', configPath], {
        stdout: out.stream,
        stderr: err.stream
      })
      return { code, out: out.text(), err: err.text() }
    }

    let result = await run('list')
    assert.equal(result.code, 0)
    assert.equal(result.out, '')

    result = await run('create', '--ttl-days', '7')
    assert.equal(result.code, 0)
    const secret = result.out.trim()
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/)
    assert(!result.err.includes(secret), '口令不得出现在 stderr')
    assert(!readFileSync(managementPath, 'utf8').includes(secret))
    assert(!readFileSync(callerPath, 'utf8').includes(secret))
    assert.equal(JSON.parse(readFileSync(managementPath, 'utf8')).port, config.management_port)

    result = await run('list')
    assert.match(result.out, /^admin\tactive\t/)
    // MCP 令牌列表不显示管理员占位主体。
    const tokenOut = sink()
    await handleTokenCommand(['token', 'list', '--config', configPath], {
      stdout: tokenOut.stream,
      stderr: sink().stream
    })
    assert.doesNotMatch(tokenOut.text(), /admin/)
    assert.match(tokenOut.text(), /^owner\t/)

    result = await run('create', '--principal', 'owner')
    assert.notEqual(result.code, 0)
    assert.match(result.err, /invalid_arguments/)

    // 中文模式的 create/revoke 结果行与登录提示全部来自词典，不再残留英文文案。
    const zhRun = async (...args: string[]) => {
      const err = sink()
      const code = await handleAdminCommand(['admin', ...args, '--config', configPath], {
        stdout: sink().stream,
        stderr: err.stream,
        language: 'zh-CN'
      })
      return { code, err: err.text() }
    }
    let zh = await zhRun('create', '--principal', 'ops', '--ttl-days', '7')
    assert.equal(zh.code, 0)
    assert.match(zh.err, /^已创建管理员 ops，到期时间 \S+\n在 http:\/\/127\.0\.0\.1:9445\/ 用用户名 "ops"/)
    assert.doesNotMatch(zh.err, /created administrator|login at/)
    zh = await zhRun('revoke', '--principal', 'ops')
    assert.equal(zh.code, 0)
    assert.equal(zh.err, '已撤销管理员 ops\n')
    const zhTokenErr = sink()
    assert.equal(
      await handleTokenCommand(['token', 'create', '--principal', 'demo', '--like', 'owner', '--config', configPath], {
        stdout: sink().stream,
        stderr: zhTokenErr.stream,
        language: 'zh-CN'
      }),
      0
    )
    assert.match(zhTokenErr.text(), /^已创建 demo，到期时间 \S+\n/)
    assert.doesNotMatch(zhTokenErr.text(), /created/)

    result = await run('revoke')
    assert.equal(result.code, 0)
    result = await run('list')
    assert.equal(result.out, '')
    result = await run('revoke')
    assert.notEqual(result.code, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('first-setup helper writes both files once; only an absent source file triggers automatic creation', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-admin-setup-'))
  try {
    const state = join(root, 'gateway')
    mkdirSync(join(state, 'managed'), { recursive: true, mode: 0o700 })
    const config = { ...configTemplate('gateway'), state_dir: state } as GatewayConfig
    writeFileSync(join(state, 'managed', 'mcp-callers.json'), JSON.stringify(callers(Date.now() - 1000)), {
      mode: 0o600
    })
    assert.equal(managementSourceExists(config), false)
    const first = writeAdminFiles(config, 'admin', Date.now())
    assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(managementSourceExists(config), true)
    const stored = readFileSync(join(state, 'managed', 'management.json'), 'utf8')
    assert(!stored.includes(first.secret))
    const second = writeAdminFiles(config, 'admin', Date.now())
    assert.notEqual(second.secret, first.secret)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'admin create works before first pairing: an empty caller registry is initialized for the management page',
  /** 全新 Gateway 先建管理员再在线配对；占位主体没有 MCP 权限，配对激活不会覆盖它。 */ async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-admin-bootstrap-'))
    try {
      const state = join(root, 'gateway')
      mkdirSync(join(state, 'managed'), { recursive: true, mode: 0o700 })
      const config = { ...configTemplate('gateway'), state_dir: state } as GatewayConfig
      const configPath = join(root, 'gateway.json')
      writeFileSync(configPath, JSON.stringify(configDocument(config)), { mode: 0o600 })
      const callerPath = join(state, 'managed', 'mcp-callers.json')
      const run = async (...args: string[]) => {
        const out = sink()
        const err = sink()
        const code = await handleAdminCommand(['admin', ...args, '--config', configPath], {
          stdout: out.stream,
          stderr: err.stream
        })
        return { code, out: out.text(), err: err.text() }
      }
      // 注册表不存在时 create 初始化空来源并签发管理员。
      const created = await run('create')
      assert.equal(created.code, 0)
      assert.match(created.out.trim(), /^[A-Za-z0-9_-]{43}$/)
      const registry = parseRegistry(JSON.parse(readFileSync(callerPath, 'utf8')))
      assert.equal(registry.resource, `http://127.0.0.1:${config.mcp_port}/mcp`)
      assert(!Object.hasOwn(registry, 'local_policy'))
      assert.equal(registry.callers.length, 1)
      assert.equal(registry.callers[0]!.principal.id, 'admin')
      assert.equal(isAdminPlaceholder(registry.callers[0]!), true)
      // list 在同一初始化后的注册表上正常工作；revoke 清掉占位主体但不删除注册表文件。
      const listed = await run('list')
      assert.equal(listed.code, 0)
      assert.match(listed.out, /^admin\tactive\t/)
      const revoked = await run('revoke')
      assert.equal(revoked.code, 0)
      const after = parseRegistry(JSON.parse(readFileSync(callerPath, 'utf8')))
      assert.equal(after.callers.length, 0)
      // 再次 create 在既有注册表上重新签发。
      const again = await run('create')
      assert.equal(again.code, 0)
      assert.match(again.out.trim(), /^[A-Za-z0-9_-]{43}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
