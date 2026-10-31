/**
 * `terminal.run`：参数收紧、模板核对、本地容量上限与开关。
 * 全部对真实 framed 连接上的假 core 运行；模板核对与容量都发生在发送墓碑之前。
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import type { ConnectorWireSession } from '../../../src/transport/connector.js'
import { startFakeCore } from './fake-core.js'
import { OPENRPC, attachment, connection, fixture, request } from './connector-harness.js'

const DISCOVER = JSON.parse(OPENRPC.toString('utf8'))

async function withSession(
  options: Parameters<typeof startFakeCore>[0],
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

async function refuses(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    assert.equal((error as { outcome?: string }).outcome, 'not_dispatched')
    return true
  })
}

test('terminal.run 只把原生参数交给 core，模板字段与自有字段都在发送前剥离', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    const run = await execute(session, 'terminal.run', { argv: ['cat'], name: 'agent-1', labels: { role: 'e2e' } })
    assert.equal(run.address, 't1')
    assert.equal(typeof run.created_ms, 'number')
    const native = core.calls.find((call) => call.method === 'terminal.run')!
    assert.deepEqual(Object.keys(native.params).sort(), ['argv', 'labels', 'name'])
    // 模板形态：先列模板，再启动；template 字段本身不发给 core。
    await withSession(
      {
        discover: DISCOVER,
        templates: [{ name: 'agent', description: 'fake agent', command: 'cat', error: null }]
      },
      async ({ core: templated, session: templatedSession }) => {
        const result = await execute(templatedSession, 'terminal.run', {
          argv: ['agent', 'do the task'],
          template: true,
          no_parent: true,
          no_notify: true
        })
        assert.equal(result.address, 't1')
        assert.deepEqual(templated.requests, ['templates.list', 'terminal.run'])
        const sent = templated.calls.find((call) => call.method === 'terminal.run')!
        assert.deepEqual(sent.params, { argv: ['agent', 'do the task'], no_parent: true, no_notify: true })
      }
    )
  })
})

test('模板声明与真实模板不符时在写入前拒绝', async () => {
  const templates = [{ name: 'agent', description: 'fake agent', command: 'cat', error: null }]
  await withSession({ discover: DISCOVER, templates }, async ({ core, session }) => {
    // 声明模板但不存在：拒绝，不启动。
    await refuses(
      execute(session, 'terminal.run', { argv: ['missing', 'task'], template: true }),
      'herdr_core_template_unavailable'
    )
    // 没声明但恰好与模板同名：拒绝，避免悄悄跑模板而不是那个程序。
    await refuses(execute(session, 'terminal.run', { argv: ['agent', 'task'] }, '2'), 'herdr_core_template_ambiguous')
    // 路径形态不是模板名。
    await refuses(
      execute(session, 'terminal.run', { argv: ['/usr/bin/agent'], template: true }, '3'),
      'herdr_core_template_unavailable'
    )
    assert.deepEqual(core.requests, ['templates.list', 'templates.list'])
  })
})

test('parent/caller/on 一律拒绝，no_parent/no_notify 只接受 true', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    for (const params of [
      { argv: ['cat'], parent: 't1' },
      { argv: ['cat'], caller: 't1' },
      { argv: ['cat'], on: 'box' }
    ]) {
      // 固定在审核表里拒绝，不靠 schema 的「未知字段」兜底。
      await assert.rejects(execute(session, 'terminal.run', params), /herdr_core_param_blocked/u)
    }
    for (const params of [
      { argv: ['cat'], no_parent: false },
      { argv: ['cat'], no_notify: false }
    ]) {
      await assert.rejects(execute(session, 'terminal.run', params), /herdr_core_parent_unsupported/u)
    }
    assert.deepEqual(core.requests, [])
  })
})

test('本机容量上限：达到上限后拒绝，kill 后回收名额', async () => {
  await withSession(
    { discover: DISCOVER },
    async ({ core, session }) => {
      // 假 core 的 terminal.list 只报 t1，所以到上限时会被回收；用 custom handler 报全部已启动终端。
      for (let index = 0; index < 2; index++) {
        await execute(session, 'terminal.run', { argv: ['cat'], name: `a${index}` }, String(index + 1))
      }
      await refuses(execute(session, 'terminal.run', { argv: ['cat'] }, '3'), 'herdr_core_run_capacity')
      // 杀掉其中一个后名额释放。
      await execute(
        session,
        'terminal.kill',
        { terminal: 't1', core_id: '0f0e0d0c0b0a0908', created_ms: 1793335137041 },
        '4'
      )
      const again = await execute(session, 'terminal.run', { argv: ['cat'] }, '5')
      assert.equal(typeof again.address, 'string')
      assert.equal(core.requests.filter((method) => method === 'terminal.run').length, 3)
    },
    { allow_terminal_execution: true, max_run_terminals: 2 }
  )
})

test('开关关闭时 terminal.run 在原生请求前拒绝，templates.list 不受影响', async () => {
  await withSession(
    { discover: DISCOVER, templates: [] },
    async ({ core, session }) => {
      await refuses(execute(session, 'terminal.run', { argv: ['cat'] }), 'terminal_execution_disabled')
      const listed = await execute(session, 'templates.list', {}, '2')
      assert.deepEqual(listed.templates, [])
      assert.deepEqual(core.requests, ['templates.list'])
    },
    { allow_terminal_execution: false }
  )
})
