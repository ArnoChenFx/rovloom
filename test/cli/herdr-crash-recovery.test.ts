/** 崩溃遗留清理只在“旧 owner 已死且端点无人监听”时动手；任何不确定都保持 fail-closed。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { once } from 'node:events'
import {
  HERDR_OWNER_FORMAT,
  currentProcessIdentity,
  recoverHerdrCrashResidue
} from '../../src/cli/herdr-crash-recovery.js'
import { createNativeRecord } from '../../src/connector/luvus/host/native-record-files.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

/** 退出后的真实子进程提供“PID 曾存在且已死”的身份。 */
async function deadProcess() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const identity = currentProcessIdentity(child.pid!)
  await once(child, 'close')
  return identity ?? { pid: child.pid!, start: '1' }
}

function fixture() {
  const root = privateHerdrTestRoot('.crash-recovery-')
  const endpoint = join(root, 'endpoint')
  mkdirSync(endpoint, { mode: 0o700 })
  const residue = {
    ownerPath: join(root, 'owner.json'),
    endpointDirectory: endpoint,
    claimsLockPath: join(root, 'claims.sqlite.lock')
  }
  const owner = (value: unknown) => createNativeRecord(residue.ownerPath, value)
  const lock = () => writeFileSync(residue.claimsLockPath, '', { mode: 0o600 })
  /** 子进程监听后被 SIGKILL：socket 文件原样遗留且无监听者，与真实崩溃一致。 */
  async function stale(name: string) {
    const path = join(endpoint, name)
    const child = spawn(
      process.execPath,
      ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)},()=>console.log('up'))`],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    await once(child.stdout!, 'data')
    child.kill('SIGKILL')
    await once(child, 'close')
    assert.equal(existsSync(path), true)
  }
  async function live(name: string): Promise<Server> {
    const server = createServer()
    server.listen(join(endpoint, name))
    await once(server, 'listening')
    return server
  }
  return { root, residue, owner, lock, stale, live, close: () => rmSync(root, { recursive: true, force: true }) }
}

const linux = process.platform === 'linux'

test('owner 已死且端点无监听：清理遗留 socket、claim 锁与 owner 记录', { skip: !linux }, async () => {
  const f = fixture()
  try {
    f.owner({ format: HERDR_OWNER_FORMAT, process: await deadProcess() })
    f.lock()
    await f.stale('herdr.sock')
    await f.stale('herdr-client.sock')
    assert.equal(await recoverHerdrCrashResidue(f.residue), true)
    for (const path of [
      f.residue.ownerPath,
      f.residue.claimsLockPath,
      join(f.residue.endpointDirectory, 'herdr.sock'),
      join(f.residue.endpointDirectory, 'herdr-client.sock')
    ]) {
      assert.equal(existsSync(path), false)
    }
  } finally {
    f.close()
  }
})

test('owner 进程仍存活（含当前进程之外的真实进程）：不清理任何东西', { skip: !linux }, async () => {
  const f = fixture()
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' })
  try {
    f.owner({ format: HERDR_OWNER_FORMAT, process: currentProcessIdentity(child.pid!) })
    f.lock()
    assert.equal(await recoverHerdrCrashResidue(f.residue), false)
    assert.equal(existsSync(f.residue.ownerPath), true)
    assert.equal(existsSync(f.residue.claimsLockPath), true)
  } finally {
    child.kill('SIGKILL')
    f.close()
  }
})

test('PID 被无关进程复用（启动 tick 不同）视为旧 owner 已死', { skip: !linux }, async () => {
  const f = fixture()
  try {
    const me = currentProcessIdentity()!
    // 当前进程占着该 PID，但记录里的 tick 不是它：等同崩溃后 PID 被复用。
    f.owner({ format: HERDR_OWNER_FORMAT, process: { pid: process.ppid, start: '1' } })
    f.lock()
    assert.notEqual(process.ppid, me.pid)
    assert.equal(await recoverHerdrCrashResidue(f.residue), true)
    assert.equal(existsSync(f.residue.ownerPath), false)
  } finally {
    f.close()
  }
})

test('端点仍有监听者（孤儿 native）：保持 fail-closed，不删任何文件', { skip: !linux }, async () => {
  const f = fixture()
  const server = await f.live('herdr.sock')
  try {
    f.owner({ format: HERDR_OWNER_FORMAT, process: await deadProcess() })
    f.lock()
    assert.equal(await recoverHerdrCrashResidue(f.residue), false)
    assert.equal(existsSync(f.residue.ownerPath), true)
    assert.equal(existsSync(f.residue.claimsLockPath), true)
    assert.equal(existsSync(join(f.residue.endpointDirectory, 'herdr.sock')), true)
  } finally {
    server.close()
    f.close()
  }
})

test('没有 owner 记录、旧格式记录或身份缺失：一律不动手', async () => {
  const f = fixture()
  try {
    f.lock()
    assert.equal(await recoverHerdrCrashResidue(f.residue), false)
    f.owner({ format: HERDR_OWNER_FORMAT })
    assert.equal(await recoverHerdrCrashResidue(f.residue), false)
    assert.equal(existsSync(f.residue.ownerPath), true)
    assert.equal(existsSync(f.residue.claimsLockPath), true)
  } finally {
    f.close()
  }
})
