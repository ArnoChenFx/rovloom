/** Luvus 崩溃锁只在持有者已死（且无孤儿 server 监听）时接管；任何不确定都保持 fail-closed。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { DISPATCH_CLAIMS_LOCK_FORMAT, DispatchClaims } from '../../src/connector/claims.js'
import {
  LUVUS_OWNER_FORMAT,
  recoverDispatchClaimsLock,
  recoverLuvusOwnerLock
} from '../../src/connector/luvus/host/native-crash-recovery.js'
import { createNativeRecord } from '../../src/connector/luvus/host/native-record-files.js'
import { currentProcessIdentity } from '../../src/storage/process-identity.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

// 崩溃恢复依赖进程身份证据：Linux（/proc）与 macOS（libproc）有，Windows 另有 e2e。
const unixHost = process.platform === 'linux' || process.platform === 'darwin'

/** 退出后的真实子进程提供“PID 曾存在且已死”的身份。 */
async function deadProcess() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const identity = currentProcessIdentity(child.pid!)
  await once(child, 'close')
  return identity ?? { pid: child.pid!, start: '1' }
}

function fixture() {
  const root = privateHerdrTestRoot('.luvus-crash-')
  const state = join(root, 'n')
  const sessions = join(state, 'sessions', 's1')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  const config = { state_root: state, target: { session: 's1' } } as never
  const claimsLock = join(root, 'luvus-claims.db.lock')
  const ownerLock = join(root, 'luvus-root.json.owner.lock')
  async function stale(name: string) {
    const path = join(sessions, name)
    const child = spawn(
      process.execPath,
      ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)},()=>console.log('up'))`],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    await once(child.stdout!, 'data')
    child.kill('SIGKILL')
    await once(child, 'close')
  }
  async function live(name: string): Promise<Server> {
    const server = createServer()
    server.listen(join(sessions, name))
    await once(server, 'listening')
    return server
  }
  return {
    root,
    config,
    claimsLock,
    ownerLock,
    stale,
    live,
    close: () => rmSync(root, { recursive: true, force: true })
  }
}

test('claim 账本锁：持有者已死则接管，空锁、旧格式、活进程与坏内容保持原样', { skip: !unixHost }, async () => {
  const f = fixture()
  try {
    const dead = await deadProcess()
    writeFileSync(f.claimsLock, JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: dead }), { mode: 0o600 })
    assert.equal(recoverDispatchClaimsLock(f.claimsLock), true)
    assert.equal(existsSync(f.claimsLock), false)

    const keep = async (content: string) => {
      writeFileSync(f.claimsLock, content, { mode: 0o600 })
      assert.equal(recoverDispatchClaimsLock(f.claimsLock), false)
      assert.equal(existsSync(f.claimsLock), true)
      rmSync(f.claimsLock)
    }
    await keep('')
    await keep('not json')
    await keep(JSON.stringify({ format: 'other', process: dead }))
    await keep(JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: { pid: 0, start: '1' } }))
    await keep(JSON.stringify({ format: DISPATCH_CLAIMS_LOCK_FORMAT, process: currentProcessIdentity() }))
    assert.equal(recoverDispatchClaimsLock(f.claimsLock), false)
  } finally {
    f.close()
  }
})

test('claim 账本实际写入持有者身份，进程内第二个实例仍被锁拒绝', { skip: !unixHost }, () => {
  const f = fixture()
  try {
    const path = join(f.root, 'luvus-claims.db')
    const options = {
      path,
      mode: 'create' as const,
      ledger_id: 'ledger_1',
      limits: { entries: 16, bytes: 262_144 },
      now: Date.now
    }
    const ledger = new DispatchClaims(options)
    assert.throws(() => new DispatchClaims({ ...options, mode: 'open' }))
    // 本进程仍活着：恢复必须拒绝。
    assert.equal(recoverDispatchClaimsLock(path + '.lock'), false)
    ledger.close()
    assert.equal(existsSync(path + '.lock'), false)
  } finally {
    f.close()
  }
})

test('owner 锁：持有者已死且端点无监听才接管', { skip: !unixHost }, async () => {
  const f = fixture()
  try {
    createNativeRecord(f.ownerLock, { root_id: 'r', format: LUVUS_OWNER_FORMAT, process: await deadProcess() })
    await f.stale('luvus.sock')
    await f.stale('luvus-client.sock')
    assert.equal(await recoverLuvusOwnerLock(f.ownerLock, f.config), true)
    assert.equal(existsSync(f.ownerLock), false)
  } finally {
    f.close()
  }
})

test('owner 锁：孤儿 server 仍在监听、无身份的旧锁、持有者仍活着都保持 fail-closed', { skip: !unixHost }, async () => {
  const f = fixture()
  try {
    createNativeRecord(f.ownerLock, { root_id: 'r', format: LUVUS_OWNER_FORMAT, process: await deadProcess() })
    const server = await f.live('luvus.sock')
    assert.equal(await recoverLuvusOwnerLock(f.ownerLock, f.config), false)
    assert.equal(existsSync(f.ownerLock), true)
    server.close()
    rmSync(f.ownerLock)

    createNativeRecord(f.ownerLock, { root_id: 'r', root_revision: 1, config_digest: 'x' })
    assert.equal(await recoverLuvusOwnerLock(f.ownerLock, f.config), false)
    rmSync(f.ownerLock)

    createNativeRecord(f.ownerLock, { root_id: 'r', format: LUVUS_OWNER_FORMAT, process: currentProcessIdentity() })
    assert.equal(await recoverLuvusOwnerLock(f.ownerLock, f.config), false)
    assert.equal(existsSync(f.ownerLock), true)
  } finally {
    f.close()
  }
})
