/**
 * 宿主级能力：参数规则、core_id / parent 栅栏、开关（Gateway 登记前与 Connector 写入前）、
 * `truncated` 原样透传。全部对真实 framed 连接上的假 core 运行。
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import { reviewHerdrCoreParams } from '../../../src/connector/herdr-core/methods.js'
import type { ConnectorWireSession } from '../../../src/transport/connector.js'
import { fakeTerminal, startFakeCore } from './fake-core.js'
import { CREATED_MS, CORE_ID, OPENRPC, attachment, connection, fixture, request } from './connector-harness.js'

const DISCOVER = JSON.parse(OPENRPC.toString('utf8'))

async function withSession(
  options: Parameters<typeof startFakeCore>[0],
  run: (context: { core: Awaited<ReturnType<typeof startFakeCore>>; session: ConnectorWireSession }) => Promise<void>,
  allow = true
) {
  const core = await startFakeCore(options)
  const { root, config } = fixture(core)
  const attached = await attachment(core)
  const resources = await createHerdrCoreConnectorResources({
    config,
    now: Date.now,
    allow_terminal_execution: allow,
    open: async () => attached
  })
  try {
    await run({ core, session: resources.session(connection()) })
  } finally {
    await resources.release()
    await core.close()
    rmSync(root, { recursive: true, force: true })
  }
}

let nextId = 0
async function execute(session: ConnectorWireSession, method: string, params: Record<string, unknown>) {
  nextId += 1
  const raw = request(method, params, String(nextId))
  session.adapter.decode(raw, 'gateway_to_connector')
  return (await session.executeWire(raw, new AbortController().signal)).native_response as Record<string, unknown>
}

async function refuses(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    assert.equal((error as { outcome?: string }).outcome, 'not_dispatched')
    return true
  })
}

test('宿主级方法的参数逐项收紧', () => {
  const bad = (method: string, params: Record<string, unknown>, code?: RegExp) => {
    assert.throws(() => reviewHerdrCoreParams(method, params), code ?? /herdr_core_/u)
  }
  // machine.exec：argv 与 line 恰好一个、timeout 必填且 ≤60 秒、on/cwd 拒绝。
  bad('machine.exec', { argv: ['true'] })
  bad('machine.exec', { argv: ['true'], line: 'true', timeout: 5 })
  bad('machine.exec', { argv: ['true'], timeout: 61 }, /herdr_core_timeout_exceeds_limit/u)
  bad('machine.exec', { argv: ['true'], timeout: 5, on: 'box' }, /herdr_core_param_blocked/u)
  bad('machine.exec', { argv: ['true'], timeout: 5, cwd: 'relative' }, /herdr_core_param_invalid/u)
  assert.doesNotThrow(() => reviewHerdrCoreParams('machine.exec', { argv: ['true'], timeout: 5, cwd: '/tmp' }))
  bad('machine.exec', { argv: [], timeout: 5 })
  bad('machine.exec', { argv: ['true'], timeout: 5, input: 'A'.repeat(300 * 1024) }, /herdr_core_text_too_large/u)
  // file.*：绝对路径、不接受 cwd、载荷有界。
  bad('file.read', { path: 'relative.txt' })
  bad('file.read', { path: '/tmp/x', cwd: '/tmp' }, /herdr_core_param_blocked/u)
  bad('file.write', { path: '/tmp/x', data: 'A'.repeat(300 * 1024) }, /herdr_core_text_too_large/u)
  bad('file.edit', { path: '/tmp/x', edits: [] })
  bad('file.edit', { path: '/tmp/x', edits: [{ old: 'a', new: 'b' }], cwd: '/tmp' }, /herdr_core_param_blocked/u)
  // doc.*：名字规则、version 必填。
  bad('doc.get', { name: 'Bad Name' })
  bad('doc.set', { name: 'ok', value: 1 })
  bad('doc.set', { name: 'ok', value: 1, version: -1 })
  // server.*：只有 core_id。
  bad('server.stop', {})
  bad('server.stop', { core_id: 'not-hex' })
  bad('server.restart', { core_id: 'a'.repeat(16), extra: 1 })
  // 合法形态不拒绝。
  assert.doesNotThrow(() => reviewHerdrCoreParams('machine.exec', { line: 'id', timeout: 5 }))
  assert.doesNotThrow(() => reviewHerdrCoreParams('file.read', { path: '/tmp/x', offset: 1, limit: 10 }))
  assert.doesNotThrow(() => reviewHerdrCoreParams('doc.set', { name: 'ok', value: null, version: 0 }))
  assert.doesNotThrow(() => reviewHerdrCoreParams('server.stop', { core_id: 'a'.repeat(16) }))
})

test('machine.exec 的 truncated 原样透传，不被当成完整输出', async () => {
  await withSession(
    {
      discover: DISCOVER,
      handler: (call) =>
        call.method === 'machine.exec'
          ? { code: 0, signal: null, stdout: 'QUJD', stderr: '', timed_out: false, truncated: true, ms: 3 }
          : {}
    },
    async ({ session }) => {
      const result = await execute(session, 'machine.exec', { argv: ['true'], timeout: 5 })
      assert.equal(result.truncated, true)
      assert.equal(result.stdout, 'QUJD')
    }
  )
})

test('server.* 的 core_id 栅栏：不符即确定未派发', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    await refuses(
      Promise.resolve().then(() => execute(session, 'server.stop', { core_id: 'f'.repeat(16) })),
      'herdr_core_core_identity_mismatch'
    )
    // core 收到的请求里不能有这个自有字段。
    assert.equal(
      core.calls.some((call) => call.method === 'server.stop'),
      false
    )
    // 对上了就转发，并且不带 core_id。
    const stopped = await execute(session, 'server.stop', { core_id: CORE_ID })
    assert.equal(stopped.stopped, true)
    const sent = core.calls.find((call) => call.method === 'server.stop')!
    assert.deepEqual(sent.params, {})
  })
})

test('terminal.run 的 parent 栅栏：给了 created_ms 就严格比对，省略就用名字解析出的终端', async () => {
  // 假 core：名字 parent-a 解析成 t1；不存在的名字按 not_found 报错。
  const handler = (call: { method: string; params: Record<string, unknown> }) => {
    if (call.method === 'terminal.get') {
      if (call.params.terminal !== 't1' && call.params.terminal !== 'parent-a') {
        return { error: { code: -32602, message: 'no terminal', data: { kind: 'not_found' } } }
      }
      return fakeTerminal({ terminal: { address: 't1', created_ms: CREATED_MS, state: 'live', name: 'parent-a' } })
    }
    if (call.method === 'terminal.run') {
      return {
        ...fakeTerminal({ terminal: { address: 't7', created_ms: 777, state: 'live', name: 'child' } }),
        first_message: null,
        output: null,
        wait: null,
        template: null
      }
    }
    if (call.method === 'templates.list') {
      return { templates: [] }
    }
    return {}
  }
  await withSession({ discover: DISCOVER, handler }, async ({ core, session }) => {
    // 给了错的 created_ms：读完之后、写入之前拒绝。
    await refuses(
      execute(session, 'terminal.run', { argv: ['cat'], parent: 't1', parent_created_ms: CREATED_MS + 1 }),
      'herdr_core_terminal_identity_mismatch'
    )
    // 父终端不存在：确定未派发。
    await refuses(
      execute(session, 'terminal.run', { argv: ['cat'], parent: 'ghost' }),
      'herdr_core_terminal_unavailable'
    )
    // 名字 + 省略 parent_created_ms 可以；发给 core 的 parent 是解析出的地址。
    const run = await execute(session, 'terminal.run', { argv: ['cat'], parent: 'parent-a' })
    assert.equal(typeof run.address, 'string')
    const sent = core.calls.filter((call) => call.method === 'terminal.run')
    assert.equal(sent.length, 1)
    assert.deepEqual(Object.keys(sent[0]!.params).sort(), ['argv', 'parent'])
    assert.equal(sent[0]!.params.parent, 't1')
  })
})

test('开关关闭时宿主级方法在原生写入前被拒绝，读取不受影响', async () => {
  await withSession(
    { discover: DISCOVER },
    async ({ core, session }) => {
      for (const [method, params] of [
        ['machine.exec', { argv: ['true'], timeout: 5 }],
        ['file.read', { path: '/tmp/x' }],
        ['file.write', { path: '/tmp/x', data: 'YQ==' }],
        ['file.edit', { path: '/tmp/x', edits: [{ old: 'a', new: 'b' }] }],
        ['doc.get', { name: 'ok' }],
        ['doc.set', { name: 'ok', value: 1, version: 0 }],
        ['server.restart', { core_id: CORE_ID }],
        ['server.stop', { core_id: CORE_ID }]
      ] as const) {
        await refuses(execute(session, method, params), 'terminal_execution_disabled')
      }
      assert.deepEqual(core.requests, [])
    },
    false
  )
})
