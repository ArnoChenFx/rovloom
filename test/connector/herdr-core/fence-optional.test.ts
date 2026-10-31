/**
 * 控制档栅栏字段可选、终端可以用名字（用户 2026-10-31 拍板）：
 * - `core_id`/`created_ms` 各自可选，给了就严格核对，省略就不比；
 * - `terminal`/`parent` 可以是裸地址或名字，`machine/t7` 仍拒绝；
 * - 写入用执行端解析出的地址，不用调用方给的名字；
 * - `started` 记账按解析出的地址回收。
 * 全部对真实 framed 连接上的假 core 运行，断言「拒绝发生在原生写入之前」时直接看 core 收到的请求。
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import { fakeTerminal, startFakeCore } from './fake-core.js'
import { CREATED_MS, CORE_ID, OPENRPC, attachment, connection, fixture, request } from './connector-harness.js'
import type { ConnectorWireSession } from '../../../src/transport/connector.js'
import type { FakeCoreOptions } from './fake-core.js'

const DISCOVER = JSON.parse(OPENRPC.toString('utf8'))

async function withSession(
  options: FakeCoreOptions,
  run: (context: { core: Awaited<ReturnType<typeof startFakeCore>>; session: ConnectorWireSession }) => Promise<void>,
  extra: { allow_terminal_execution?: boolean; max_run_terminals?: number } = { allow_terminal_execution: true }
) {
  const core = await startFakeCore(options)
  const { root, config } = fixture(core)
  const attached = await attachment(core)
  const resources = await createHerdrCoreConnectorResources({
    config,
    now: Date.now,
    ...extra,
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

/** 与 transport 相同顺序：先由 session adapter 准入，再交给执行端。 */
async function execute(
  session: ConnectorWireSession,
  method: string,
  params: Record<string, unknown>,
  id = '1'
): Promise<Record<string, unknown>> {
  const raw = request(method, params, id)
  session.adapter.decode(raw, 'gateway_to_connector')
  return (await session.executeWire(raw, new AbortController().signal)).native_response
}

/** 断言被拒绝且原因是固定码；同时核对本地结局是确定未派发。 */
async function refuses(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    assert.equal((error as { outcome?: string }).outcome, 'not_dispatched')
    return true
  })
}

test('core_id / created_ms 各自可选：省略就不核对，给了仍严格拒绝', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    // 三个组合都成功；每次只读一次终端事实，写入用地址。
    await execute(session, 'terminal.send', { terminal: 't1', text: 'a' }, '1')
    await execute(session, 'terminal.send', { terminal: 't1', core_id: CORE_ID, text: 'b' }, '2')
    await execute(session, 'terminal.send', { terminal: 't1', created_ms: CREATED_MS, text: 'c' }, '3')
    await execute(session, 'terminal.send', { terminal: 't1', text: 'd' }, '4')
    assert.deepEqual(core.requests, [
      'terminal.get',
      'terminal.send',
      'terminal.get',
      'terminal.send',
      'terminal.get',
      'terminal.send',
      'terminal.get',
      'terminal.send'
    ])
    // 给了错的值仍然拒绝，码不变。
    await refuses(
      execute(session, 'terminal.send', { terminal: 't1', core_id: 'ffffffffffffffff', text: 'x' }, '5'),
      'herdr_core_terminal_identity_mismatch'
    )
    await refuses(
      execute(session, 'terminal.send', { terminal: 't1', created_ms: CREATED_MS + 1, text: 'x' }, '6'),
      'herdr_core_terminal_identity_mismatch'
    )
    // 两次拒绝都发生在读取之后、写入之前：没有多出来的 send。
    assert.equal(core.requests.filter((method) => method === 'terminal.send').length, 4)
  })
})

test('名字解析成地址：send/keys/kill/rm/put 都发地址，不发名字', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    await execute(session, 'terminal.send', { terminal: 'alt', text: 'x' }, '1')
    await execute(session, 'terminal.keys', { terminal: 'alt', keys: ['enter'] }, '2')
    await execute(session, 'terminal.put', { terminal: 'alt', data: 'YWJj', name: 'a.png' }, '3')
    await execute(session, 'terminal.kill', { terminal: 'alt' }, '4')
    await execute(session, 'terminal.rm', { terminal: 'alt' }, '5')
    const writes = core.calls.filter((call) => call.method !== 'terminal.get')
    assert.deepEqual(
      writes.map((call) => call.method),
      ['terminal.send', 'terminal.keys', 'terminal.put', 'terminal.kill', 'terminal.rm']
    )
    for (const call of writes) {
      assert.equal(call.params.terminal, 't1', call.method)
    }
    // 每次写入前都读一次名字对应的终端。
    assert.equal(core.requests.filter((method) => method === 'terminal.get').length, 5)
  })
})

test('读与写之间名字被改指：写入仍用读到的那一个地址', async () => {
  // 假 core：terminal.get 把名字解析成 t1；如果有人把名字直接发给写入方法，它会落到 t2。
  const handler = (call: { method: string; params: Record<string, unknown> }) => {
    if (call.method === 'terminal.get') {
      return fakeTerminal({ terminal: { address: 't1', created_ms: 111, state: 'live', name: 'moved' } })
    }
    if (call.method === 'terminal.send') {
      // 名字在读写之间被改指：如果写入用名字，core 会落到另一个终端（这里直接报错）。
      if (call.params.terminal === 'moved') {
        return { error: { code: -32000, message: 'name repointed', data: { kind: 'not_found' } } }
      }
      return { turn: 0, started: null, status: null, wait: null }
    }
    return {}
  }
  await withSession({ discover: DISCOVER, handler }, async ({ core, session }) => {
    const sent = await execute(session, 'terminal.send', { terminal: 'moved', text: 'x' })
    assert.equal(typeof sent.turn, 'number')
    const write = core.calls.find((call) => call.method === 'terminal.send')!
    assert.equal(write.params.terminal, 't1')
  })
})

test('名字不存在是确定未派发；已结束终端 send 拒绝、rm 可以', async () => {
  const names: Record<string, Record<string, unknown>> = {
    live: { address: 't1', created_ms: 111, state: 'live' }
  }
  const handler = (call: { method: string; params: Record<string, unknown> }) => {
    if (call.method === 'terminal.get') {
      const found = names[String(call.params.terminal)]
      if (!found) {
        return { error: { code: -32602, message: 'no terminal', data: { kind: 'not_found' } } }
      }
      return fakeTerminal({ terminal: found })
    }
    if (call.method === 'terminal.rm') {
      return { removed: String(call.params.terminal) }
    }
    return {}
  }
  await withSession({ discover: DISCOVER, handler }, async ({ core, session }) => {
    await refuses(
      execute(session, 'terminal.send', { terminal: 'ghost', text: 'x' }, '1'),
      'herdr_core_terminal_unavailable'
    )
    // 已结束的终端：send 不能写，rm 可以删。
    names.finished = {
      address: 't2',
      created_ms: 222,
      state: 'finished',
      finished_ms: 333,
      exit_code: 1,
      reason: 'exited'
    }
    await refuses(
      execute(session, 'terminal.send', { terminal: 'finished', text: 'x' }, '2'),
      'herdr_core_terminal_unavailable'
    )
    const removed = await execute(session, 'terminal.rm', { terminal: 'finished' }, '3')
    assert.deepEqual(removed, { removed: 't2' })
    assert.equal(core.requests.filter((method) => method === 'terminal.send').length, 0)
  })
})

test('省略栅栏与名字形态下 blocked 判定仍然生效', async () => {
  await withSession(
    { discover: DISCOVER, terminal: { status: { state: 'blocked', kind: 'permission', app: 'blocker' } } },
    async ({ core, session }) => {
      await refuses(
        execute(session, 'terminal.send', { terminal: 'alt', text: 'x' }, '1'),
        'herdr_core_terminal_blocked'
      )
      await refuses(
        execute(session, 'terminal.keys', { terminal: 'alt', keys: ['enter'] }, '2'),
        'herdr_core_terminal_blocked'
      )
      assert.deepEqual(core.requests, ['terminal.get', 'terminal.get'])
    }
  )
})

test('kill/rm 用名字后按解析出的地址回收本机名额', async () => {
  await withSession(
    { discover: DISCOVER },
    async ({ core, session }) => {
      // 假 core 的 terminal.list 会报出已启动的终端，所以只能靠 started 记账回收名额。
      await execute(session, 'terminal.run', { argv: ['cat'], name: 'a0' }, '1')
      await refuses(execute(session, 'terminal.run', { argv: ['cat'] }, '2'), 'herdr_core_run_capacity')
      // 用名字 kill：terminal.get 解析出 t1，必须按 t1 回收，而不是按名字。
      await execute(session, 'terminal.kill', { terminal: 'alt' }, '3')
      const again = await execute(session, 'terminal.run', { argv: ['cat'] }, '4')
      assert.equal(typeof again.address, 'string')
      assert.equal(core.requests.filter((method) => method === 'terminal.run').length, 2)
    },
    { allow_terminal_execution: true, max_run_terminals: 1 }
  )
})

test('terminal.run 的 parent 可以用名字，parent_created_ms 可省略；给了仍严格核对', async () => {
  const handler = (call: { method: string; params: Record<string, unknown> }) => {
    if (call.method === 'terminal.get') {
      return fakeTerminal({ terminal: { address: 't1', created_ms: 111, state: 'live', name: 'parent-a' } })
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
    // 名字 + 省略 parent_created_ms：读一次父终端，按名字解析出地址。
    await execute(session, 'terminal.run', { argv: ['cat'], parent: 'parent-a' }, '1')
    // 名字 + 正确的 created_ms。
    await execute(session, 'terminal.run', { argv: ['cat'], parent: 'parent-a', parent_created_ms: 111 }, '2')
    // 给了错的 created_ms 仍拒绝（读完之后、写入之前）。
    await refuses(
      execute(session, 'terminal.run', { argv: ['cat'], parent: 'parent-a', parent_created_ms: 112 }, '3'),
      'herdr_core_terminal_identity_mismatch'
    )
    // 发给 core 的 parent 是地址，不是名字。
    const runs = core.calls.filter((call) => call.method === 'terminal.run')
    assert.deepEqual(
      runs.map((call) => call.params.parent),
      ['t1', 't1']
    )
    assert.equal(core.requests.filter((method) => method === 'terminal.run').length, 2)
  })
})

test('machine/t7、含斜杠的名字、server.* 缺 core_id 仍被拒', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    for (const [params, id] of [
      [{ terminal: 'machine/t1', text: 'x' }, '1'],
      [{ terminal: 'a/b', text: 'x' }, '2'],
      [{ terminal: 'E2E', text: 'x' }, '3']
    ] as const) {
      await assert.rejects(execute(session, 'terminal.send', { ...params }, id))
    }
    // core 生命周期不可撤销，core_id 仍然必填、仍然严格比对（这两条在参数复核阶段就拒绝）。
    await assert.rejects(execute(session, 'server.stop', {}, '4'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'herdr_core_core_id_required')
      return true
    })
    await assert.rejects(execute(session, 'server.restart', { core_id: 'ffffffffffffffff' }, '5'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'herdr_core_core_identity_mismatch')
      return true
    })
    assert.deepEqual(core.requests, [])
  })
})
