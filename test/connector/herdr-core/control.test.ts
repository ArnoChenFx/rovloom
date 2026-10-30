/**
 * herdr-core 控制档的执行端：终端三元组栅栏、blocked 判定、本机开关与参数剥离。
 * 全部对真实 framed 连接上的假 core 运行；断言「拒绝发生在原生写入之前」时直接看 core 收到的请求。
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { createHerdrCoreConnectorResources } from '../../../src/connector/herdr-core/connector.js'
import {
  HERDR_CORE_KEYS_MAX,
  HERDR_CORE_LABEL_MAX_LENGTH,
  HERDR_CORE_PUT_MAX_BASE64,
  HERDR_CORE_REQUEST_MAX_MS,
  HERDR_CORE_SEND_MAX_BYTES,
  HERDR_CORE_SEND_MAX_MS,
  herdrCoreNativeParams,
  herdrCoreRequestTimeout,
  reviewHerdrCoreParams
} from '../../../src/connector/herdr-core/methods.js'
import { herdrCoreControlNativeParams } from '../../../src/connector/herdr-core/control.js'
import { startFakeCore } from './fake-core.js'
import { CREATED_MS, CORE_ID, OPENRPC, attachment, connection, fixture, request } from './connector-harness.js'
import type { ConnectorWireSession } from '../../../src/transport/connector.js'

const DISCOVER = JSON.parse(OPENRPC.toString('utf8'))

/** 一条带完整栅栏的控制档请求参数。 */
function fence(params: Record<string, unknown> = {}) {
  return { terminal: 't1', core_id: CORE_ID, created_ms: CREATED_MS, ...params }
}

async function withSession(
  options: Parameters<typeof startFakeCore>[0],
  run: (context: {
    core: Awaited<ReturnType<typeof startFakeCore>>
    session: ConnectorWireSession
    release: () => Promise<void>
  }) => Promise<void>,
  allow_terminal_execution = true
) {
  const core = await startFakeCore(options)
  const { root, config } = fixture(core)
  const attached = await attachment(core)
  const resources = await createHerdrCoreConnectorResources({
    config,
    now: Date.now,
    allow_terminal_execution,
    open: async () => attached
  })
  try {
    await run({ core, session: resources.session(connection()), release: resources.release })
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

test('控制档在写入前核对终端三元组，并把 rovloom 自有字段从原生请求里剥离', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    const sent = await execute(session, 'terminal.send', fence({ text: 'hello' }))
    assert.equal(typeof sent.turn, 'number')
    // 先读一次终端事实，再写入；顺序固定。
    assert.deepEqual(core.requests, ['terminal.get', 'terminal.send'])
    const native = core.calls.find((call) => call.method === 'terminal.send')!
    // core 不认识 core_id/created_ms；必须在发送前剥离，而不是依赖它静默忽略。
    assert.deepEqual(Object.keys(native.params).sort(), ['terminal', 'text'])
    assert.equal(native.params.terminal, 't1')
    await execute(session, 'terminal.keys', fence({ keys: ['enter'] }), '2')
    await execute(session, 'terminal.interrupt', fence({}), '3')
    await execute(session, 'terminal.keep', fence({ keep: true }), '4')
    await execute(session, 'terminal.label', fence({ labels: { role: 'e2e' } }), '5')
    await execute(session, 'terminal.put', fence({ data: 'YWJj', name: 'a.png' }), '6')
    await execute(session, 'terminal.kill', fence({}), '7')
    await execute(session, 'terminal.rm', fence({}), '8')
  })
})

test('created_ms 与 core.id 不一致时拒绝，输入不会送给同地址的另一个终端', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    await refuses(
      execute(session, 'terminal.send', fence({ text: 'x', created_ms: CREATED_MS + 1 })),
      'herdr_core_terminal_identity_mismatch'
    )
    await refuses(
      execute(session, 'terminal.keys', fence({ keys: ['enter'], core_id: 'ffffffffffffffff' }), '2'),
      'herdr_core_terminal_identity_mismatch'
    )
    // 第一次读到 created_ms 不符；第二次在 core.id 上就拒绝，连读取都不发生。
    assert.deepEqual(core.requests, ['terminal.get'])
  })
})

test('blocked 由 rovloom 自己判断：send/keys/interrupt 拒绝，put 与记录类控制照常', async () => {
  await withSession(
    {
      discover: DISCOVER,
      terminal: { status: { state: 'blocked', kind: 'permission', app: 'blocker' } }
    },
    async ({ core, session }) => {
      let index = 0
      for (const [method, params] of [
        ['terminal.send', fence({ text: 'y' })],
        ['terminal.keys', fence({ keys: ['y', 'enter'] })],
        ['terminal.interrupt', fence({})]
      ] as const) {
        index += 1
        await refuses(execute(session, method, params, String(index)), 'herdr_core_terminal_blocked')
      }
      // 只读终端事实，没有写入任何输入。
      assert.deepEqual(core.requests, ['terminal.get', 'terminal.get', 'terminal.get'])
      // blocked 时仍然可以收拾现场：put 只写文件，kill/rm/keep/label 改的是终端记录。
      await execute(session, 'terminal.put', fence({ data: 'YWJj', name: 'a.png' }), '4')
      await execute(session, 'terminal.label', fence({ labels: { state: 'seen' } }), '5')
      await execute(session, 'terminal.kill', fence({}), '6')
    }
  )
})

test('状态字缺失不是未知：不上报状态的程序不可能被 core 判为 blocked', async () => {
  await withSession({ discover: DISCOVER }, async ({ session }) => {
    const sent = await execute(session, 'terminal.send', fence({ text: 'ls\n' }))
    assert.equal(typeof sent.turn, 'number')
  })
})

test('读不到终端事实或终端已结束时 fail-closed', async () => {
  await withSession(
    {
      discover: DISCOVER,
      terminal: { state: 'finished', status: null }
    },
    async ({ core, session }) => {
      await refuses(execute(session, 'terminal.send', fence({ text: 'x' })), 'herdr_core_terminal_unavailable')
      assert.deepEqual(core.requests, ['terminal.get'])
      // 已结束的终端仍能按记录收拾：rm 就是用来删除它的。
      const removed = await execute(session, 'terminal.rm', fence({}), '2')
      assert.equal(removed.removed, 't1')
    }
  )
  await withSession(
    {
      discover: DISCOVER,
      terminal: { status: { state: 7 } }
    },
    async ({ core, session }) => {
      await refuses(execute(session, 'terminal.keys', fence({ keys: ['enter'] })), 'herdr_core_terminal_unavailable')
      assert.deepEqual(core.requests, ['terminal.get'])
    }
  )
})

test('本机开关关闭时控制档在原生写入前拒绝，读取不受影响', async () => {
  await withSession(
    { discover: DISCOVER },
    async ({ core, session }) => {
      await refuses(execute(session, 'terminal.send', fence({ text: 'x' })), 'terminal_execution_disabled')
      await refuses(execute(session, 'terminal.kill', fence({}), '2'), 'terminal_execution_disabled')
      // 一次原生请求都没有发出。
      assert.deepEqual(core.requests, [])
      const listed = await execute(session, 'terminal.list', {}, '3')
      assert.ok(Array.isArray(listed.terminals))
    },
    false
  )
})

test('名字与 machine/tN 不作为输入目标，宿主级方法仍不可调用', async () => {
  await withSession({ discover: DISCOVER }, async ({ core, session }) => {
    for (const [method, params] of [
      ['terminal.send', { terminal: 'e2e', core_id: CORE_ID, created_ms: CREATED_MS, text: 'x' }],
      ['terminal.send', { terminal: 'm1/t1', core_id: CORE_ID, created_ms: CREATED_MS, text: 'x' }],
      ['terminal.run', fence({ argv: ['sh'] })]
    ] as const) {
      await assert.rejects(execute(session, method, params))
    }
    assert.deepEqual(core.requests, [])
  })
})

test('控制档参数在原生请求之前逐项收紧，超限拒绝而不是截断', () => {
  const review = (method: string, params: Record<string, unknown>) => {
    assert.throws(() => reviewHerdrCoreParams(method, params))
  }
  // 栅栏必须齐全且形状正确。
  review('terminal.send', { terminal: 't1', text: 'x' })
  review('terminal.keys', { terminal: 't1', core_id: CORE_ID, created_ms: -1, keys: ['enter'] })
  review('terminal.kill', { terminal: 't1', core_id: 'zz', created_ms: CREATED_MS })
  // 名字与远端路由都不是输入目标。
  review('terminal.send', { terminal: 'e2e', core_id: CORE_ID, created_ms: CREATED_MS, text: 'x' })
  review('terminal.send', { terminal: 'm1/t1', core_id: CORE_ID, created_ms: CREATED_MS, text: 'x' })
  // force 会绕过 core 自己的 blocked 闸门；rovloom 的判定不依赖它，默认从严拒绝。
  review('terminal.send', fence({ text: 'x', force: true }))
  review('terminal.send', fence({ text: 'x'.repeat(HERDR_CORE_SEND_MAX_BYTES + 1) }))
  // wait=true 的期限必须显式给出且不超过检查间隔上限。
  review('terminal.send', fence({ text: 'x', wait: true }))
  review('terminal.send', fence({ text: 'x', wait: true, timeout: 61 }))
  review('terminal.send', fence({ text: 'x', timeout: 5 }))
  review('terminal.send', fence({ text: 'x', if: 'blocked' }))
  review('terminal.keys', fence({ keys: [] }))
  review('terminal.keys', fence({ keys: Array.from({ length: HERDR_CORE_KEYS_MAX + 1 }, () => 'enter') }))
  review('terminal.keys', fence({ keys: [7] }))
  review('terminal.interrupt', fence({ timeout: -1 }))
  review('terminal.interrupt', fence({ timeout: 61 }))
  review('terminal.put', fence({ data: 'YWJj', name: '../x.png' }))
  review('terminal.put', fence({ data: 'A'.repeat(HERDR_CORE_PUT_MAX_BASE64 + 1), name: 'a.png' }))
  review('terminal.keep', fence({ keep: 'yes' }))
  review('terminal.label', fence({ labels: { ['a'.repeat(65)]: 'x' } }))
  review('terminal.label', fence({ labels: { role: 'x'.repeat(HERDR_CORE_LABEL_MAX_LENGTH + 1) } }))
  // 合法形态不拒绝。
  assert.doesNotThrow(() => reviewHerdrCoreParams('terminal.send', fence({ text: '' })))
  assert.doesNotThrow(() => reviewHerdrCoreParams('terminal.send', fence({ text: 'x', wait: true, timeout: 30 })))
  assert.doesNotThrow(() => reviewHerdrCoreParams('terminal.label', fence({ labels: { role: 'e2e', old: '' } })))
})

test('控制档的本地期限覆盖粘贴安静窗口与 interrupt 的默认观察时间', () => {
  // 粘贴安静窗口约 3 秒，逐段粘贴按 200 ms 间隔：send 用固定预算。
  assert.equal(herdrCoreRequestTimeout('terminal.send', {}), HERDR_CORE_SEND_MAX_MS)
  // wait=true 是这一轮的检查点，期限由调用方显式给出。
  assert.equal(herdrCoreRequestTimeout('terminal.send', { wait: true, timeout: 30 }), 35_000)
  // interrupt 不传 timeout 时 core 自己观察 10 秒，本地必须留出余量。
  assert.equal(herdrCoreRequestTimeout('terminal.interrupt', {}), 15_000)
  assert.equal(herdrCoreRequestTimeout('terminal.interrupt', { timeout: 2 }), 7_000)
  assert.equal(herdrCoreRequestTimeout('terminal.wait', { timeout: 0.2 }), 5_200)
  assert.equal(herdrCoreRequestTimeout('terminal.wait', { timeout: 60 }), HERDR_CORE_REQUEST_MAX_MS)
  assert.equal(herdrCoreRequestTimeout('terminal.kill', {}), 5_000)
  // 栅栏字段只属于 rovloom，发送前显式剥离。
  assert.deepEqual(herdrCoreControlNativeParams(fence({ text: 'x' })), { terminal: 't1', text: 'x' })
  assert.deepEqual(herdrCoreNativeParams(fence({ text: 'x' })), { terminal: 't1', text: 'x' })
})
