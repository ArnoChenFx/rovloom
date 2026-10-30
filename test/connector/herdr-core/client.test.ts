/** 用假 core 核对 framed 握手、请求配对、错误映射、超时与 EOF 语义；不启动真实 core。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { herdrCorePeerFacts } from '../../../src/connector/herdr-core/identity.js'
import { startFakeCore } from './fake-core.js'

test('framed handshake pins generation and exposes the core identity', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    assert.equal(client.hello.generation, 1)
    assert.equal(client.hello.version, '0.1.14')
    assert.equal(client.hello.core.id, '0f0e0d0c0b0a0908')
    assert.ok(client.hello.features.includes('framed'))
    client.close()
  } finally {
    await core.close()
  }
})

test('handshake refuses a core that does not switch to framed mode', async () => {
  const core = await startFakeCore({ hello: { framed: false } })
  try {
    await assert.rejects(openHerdrCoreClient(core.socket), /herdr_core_handshake_refused/u)
  } finally {
    await core.close()
  }
})

test('requests pair by id and native errors keep code and data.kind only', async () => {
  const core = await startFakeCore({
    handler: (request) => {
      if (request.method === 'terminal.get') {
        return { error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } } }
      }
      return { ok: true }
    }
  })
  try {
    const client = await openHerdrCoreClient(core.socket)
    const first = await client.request('server.status', {})
    assert.deepEqual(first, { ok: true })
    await assert.rejects(
      client.request('terminal.get', { terminal: 't9' }),
      (error: Error & { code?: number; kind?: string }) => {
        assert.equal(error.code, -32000)
        assert.equal(error.kind, 'not_found')
        // 自由文本消息不进入错误对象。
        assert.equal(error.message, 'herdr_core_rpc_error:not_found')
        return true
      }
    )
    // 第二个请求仍可用：一条错误回复不能破坏连接。
    assert.deepEqual(await client.request('server.status', {}), { ok: true })
    client.close()
  } finally {
    await core.close()
  }
})

test('a request that exceeds its own deadline rejects locally and keeps the connection', async () => {
  const core = await startFakeCore({ delay_ms: 60 })
  try {
    const client = await openHerdrCoreClient(core.socket)
    await assert.rejects(client.request('server.status', {}, 10), /herdr_core_timeout/u)
    // 迟到的回复按未知 id 丢弃；连接仍可继续用。
    const later = await client.request('server.status', {})
    assert.equal(later.version, '0.1.14')
    client.close()
  } finally {
    await core.close()
  }
})

test('EOF is observable as close, and later requests fail with a fixed code', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    let closed = 0
    client.onClose(() => {
      closed += 1
    })
    core.disconnect()
    for (let attempt = 0; attempt < 100 && closed === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(closed, 1)
    await assert.rejects(client.request('server.status', {}), /herdr_core_connection_closed/u)
    client.close()
  } finally {
    await core.close()
  }
})

test('connecting to a missing socket fails without exposing the path', async () => {
  await assert.rejects(openHerdrCoreClient('/nonexistent/herdr-core/none.sock'), (error: Error) => {
    assert.match(error.message, /herdr_core_connection_failed/u)
    assert.doesNotMatch(error.message, /nonexistent/u)
    return true
  })
})

test('the kernel peer of the connection is the listening process, not what the server advertises', async () => {
  const core = await startFakeCore()
  try {
    const client = await openHerdrCoreClient(core.socket)
    // 假 core 在本进程内监听，所以内核给出的 peer 就是本进程。
    const peer = client.peer()
    assert.equal(peer.pid, process.pid)
    assert.equal(peer.uid, process.getuid?.())
    client.close()
  } finally {
    await core.close()
  }
})

test('a server that advertises another pid than the kernel peer is refused before any /proc read', async () => {
  const core = await startFakeCore({ handler: () => ({ pid: process.pid + 1 }) })
  try {
    const client = await openHerdrCoreClient(core.socket)
    const status = await client.request('server.status', {})
    assert.throws(() => herdrCorePeerFacts(client.peer(), status.pid, 'test'), /herdr_core_peer_pid_mismatch/u)
    client.close()
  } finally {
    await core.close()
  }
})
