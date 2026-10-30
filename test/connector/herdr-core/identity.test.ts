/** 核对端点公式、session 上限与终端标识三元组；不访问真实 core 或真实 HOME。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  herdrCoreEndpoint,
  herdrCoreSessionLimit,
  herdrCoreSessionName,
  herdrCoreTerminalIdentity,
  herdrCoreProcessFacts
} from '../../../src/connector/herdr-core/identity.js'

test('runtime dir endpoint uses the documented core layout', () => {
  const env = { XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/dev' }
  const endpoint = herdrCoreEndpoint('default', env)
  assert.equal(endpoint.socket, '/run/user/1000/herdr-core/default.sock')
  assert.equal(endpoint.origin, 'runtime')
  // 107 - 9 - len('/run/user/1000/herdr-core') - 1 - len('.holder.sock')
  assert.equal(herdrCoreSessionLimit(env).limit, 60)
})

test('state fallback repeats the session name and allows only 25 characters', () => {
  const env = { HOME: '/home/dev' }
  const endpoint = herdrCoreEndpoint('default', env)
  assert.equal(endpoint.socket, '/home/dev/.local/state/herdr-core/default/default.sock')
  assert.equal(endpoint.origin, 'state')
  assert.equal(herdrCoreSessionLimit(env).limit, 25)
})

test('session names over the computed limit are refused before core starts', () => {
  const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
  // 60 个字符刚好放得下；61 个字符会让 holder 套接字超限。
  assert.equal(herdrCoreEndpoint('a'.repeat(60), env).session.length, 60)
  assert.throws(() => herdrCoreEndpoint('a'.repeat(61), env), /herdr_core_session_too_long/u)
  assert.throws(() => herdrCoreSessionName('has/slash'), /herdr_core_session_invalid/u)
  assert.throws(() => herdrCoreSessionName(''), /herdr_core_session_invalid/u)
})

test('no runtime and no state home means no endpoint, not a guessed one', () => {
  assert.throws(() => herdrCoreEndpoint('default', {}), /herdr_core_endpoint_unavailable/u)
})

test('terminal identity needs core, created_ms and address together', () => {
  const identity = herdrCoreTerminalIdentity('0f0e0d0c0b0a0908', { address: 't1', created_ms: 1793335137041 })
  assert.deepEqual(identity, { core_id: '0f0e0d0c0b0a0908', created_ms: 1793335137041, address: 't1' })
  // 只删 terminals.json 时地址会复用，所以缺 created_ms 不能建立标识。
  assert.throws(
    () => herdrCoreTerminalIdentity('0f0e0d0c0b0a0908', { address: 't1' }),
    /herdr_core_terminal_identity_invalid/u
  )
  assert.throws(
    () => herdrCoreTerminalIdentity('not-hex', { address: 't1', created_ms: 1 }),
    /herdr_core_core_id_invalid/u
  )
})

test('process facts refuse a pid that is not a bare `<bin> serve`', () => {
  // 当前测试进程的 argv 不是 `<bin> serve`，必须拒绝而不是接受自报 pid。
  assert.throws(() => herdrCoreProcessFacts(process.pid, 'test'), /herdr_core_peer_argv_untrusted/u)
  assert.throws(() => herdrCoreProcessFacts(0, 'test'), /herdr_core_peer_pid_invalid/u)
  assert.throws(() => herdrCoreProcessFacts(4194305, 'test'), /herdr_core_peer_pid_invalid/u)
})
