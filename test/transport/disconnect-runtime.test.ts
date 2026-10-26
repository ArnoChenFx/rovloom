// 用真实 loopback 与原生 WebSocket 验证 Connector 断连观测：只交付白名单原因与有界关闭码，正文不进入输出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { CliSetup } from '../../src/cli/setup-runtime.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { createConnector } from '../../src/transport/index.js'
import { runtime } from '../../src/transport/common.js'
import type { Socket } from '../../src/transport/common.js'
import { fixture, until } from './helpers.js'

type ServerAction = { kind: 'close'; code: number; reason: string } | { kind: 'terminate' } | { kind: 'stay' }

/** 建立只接受握手、不认证的对端；按 action 在 socket 打开后关闭、掐断或保持打开。 */
function server(action: ServerAction) {
  const listener = runtime().serve<null>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, s) =>
      new URL(request.url).pathname === '/connector' && s.upgrade(request, { data: null })
        ? undefined
        : new Response(null, { status: 404 }),
    websocket: {
      maxPayloadLength: 1 << 20,
      backpressureLimit: 1 << 20,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      open(ws) {
        if (action.kind === 'close') {
          ws.close(action.code, action.reason)
        } else if (action.kind === 'terminate') {
          ws.terminate()
        }
      },
      message() {},
      close() {}
    }
  })
  return { url: `ws://127.0.0.1:${listener.port}/connector`, stop: () => listener.stop(true) }
}

/** 建立不会真正认证成功、也不会调用原生回调的 Connector；所有身份输入都是本测试的合成值。 */
function connectorTo(url: string) {
  return createConnector({
    url,
    developmentLoopback: true,
    credential: () => ({
      machine_id: 'mock_drop',
      recovery_generation: 'mock_generation',
      credential: 'SYNTHETIC_CREDENTIAL_NOT_REAL'
    }),
    session: () => {
      throw new Error('fixture_must_not_open_session')
    },
    nativeInput: () => {
      throw new Error('fixture_must_not_call_native')
    },
    execute: async () => {
      throw new Error('fixture_must_not_execute')
    },
    limits: {
      heartbeat_ms: 10_000,
      idle_ms: 10_000,
      handshake_ms: 500,
      reconnect_ms: 5_000,
      reconnect_max_ms: 5_000
    },
    random: () => 1,
    now: () => 1000
  })
}

/** 取队列里最新一条断开观测；队列为空时返回 undefined，不合成观测。 */
function latest(client: ReturnType<typeof createConnector>) {
  return client.status().disconnect_recent.at(-1)
}

/** 先准备 CLI，再创建真实 transport 并同步订阅，确保首个采样窗口从零计数开始。 */
async function observedTransport(create: () => ReturnType<typeof createConnector>) {
  const setup = new CliSetup()
  const stderr = new PassThrough()
  let output = ''
  stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    signal: new AbortController().signal
  })
  const client = create()
  setup.observe({ transport: client, closed: new Promise(() => {}), close: async () => client.stop() })
  return { client, setup, output: () => output }
}

test('真实关闭发生在 CLI 首个采样之前仍打印 1008 原因', async () => {
  const peer = server({ kind: 'close', code: 1008, reason: 'transport_closed' })
  const observed = await observedTransport(() => connectorTo(peer.url))
  try {
    assert.equal(observed.client.status().disconnects, 0)
    await untilDisconnect(observed.client)
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.match(observed.output(), /connector_disconnect code=1008 close_reason=transport_closed\n/)
  } finally {
    observed.setup.close()
    observed.client.stop()
    peer.stop()
  }
})

test('真实 transport 的晚到关闭订正在下一采样补报，计数不重复', async () => {
  let controlled: ReturnType<typeof stubConnector>
  const observed = await observedTransport(() => {
    controlled = stubConnector()
    return controlled.client
  })
  try {
    controlled!.handlers.error?.({ type: 'error' })
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.match(observed.output(), /connector_disconnect close_reason=transport_unavailable\n/)
    controlled!.handlers.close?.({ code: 1006, reason: '' })
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.match(observed.output(), /connector_disconnect_update code=1006 close_reason=transport_abnormal\n/)
    assert.equal(observed.client.status().disconnects, 1)
  } finally {
    observed.setup.close()
    observed.client.stop()
  }
})

/** 等待 Connector 的当前 socket 收敛到断开并带出断开观测；失败只报告固定诊断。 */
async function untilDisconnect(client: ReturnType<typeof createConnector>) {
  const start = performance.now()
  while (!['disconnected', 'stopped'].includes(client.status().phase) || !latest(client)) {
    if (performance.now() - start > 3000) {
      throw new Error('fixture_disconnect_timeout')
    }
    await new Promise(/** 让出事件循环供真实 socket 关闭事件推进。 */ (resolve) => setTimeout(resolve, 5))
  }
  return latest(client)
}

test('对端 close(1008, transport_closed) 交付数值关闭码与固定原因', async () => {
  // 与 Gateway 实际关闭原因一致，证明抖动可被直接定性为网关主动关闭。
  const s = server({ kind: 'close', code: 1008, reason: 'transport_closed' })
  const client = connectorTo(s.url)
  try {
    assert.deepEqual(await untilDisconnect(client), { code: 1008, reason: 'transport_closed' })
    assert.equal(client.status().phase, 'disconnected')
  } finally {
    client.stop()
    s.stop()
  }
})

test('对端任意关闭正文不进入观测，只保留有界关闭码与固定分类', async () => {
  const secret = 'SYNTHETIC_SECRET token=/etc/passwd 你好'
  const s = server({ kind: 'close', code: 1008, reason: secret })
  const client = connectorTo(s.url)
  try {
    const observed = await untilDisconnect(client)
    assert.deepEqual(observed, { code: 1008, reason: 'transport_unclassified' })
    assert.equal(JSON.stringify(client.status()).includes(secret), false)
  } finally {
    client.stop()
    s.stop()
  }
})

test('TCP 被掐交付 1006/transport_abnormal，对端不回应交付无码握手超时', async () => {
  {
    const s = server({ kind: 'terminate' })
    const client = connectorTo(s.url)
    try {
      assert.deepEqual(await untilDisconnect(client), { code: 1006, reason: 'transport_abnormal' })
    } finally {
      client.stop()
      s.stop()
    }
  }
  {
    // 对端保持打开但从不回 welcome：握手计时到点收敛为超时，不伪造未观察到的关闭码。
    const s = server({ kind: 'stay' })
    const client = connectorTo(s.url)
    try {
      assert.deepEqual(await untilDisconnect(client), { reason: 'handshake_timeout' })
    } finally {
      client.stop()
      s.stop()
    }
  }
})

test('主动 disconnect 与 stop 交付固定本机原因，不伪造对端关闭码', async () => {
  const s = server({ kind: 'stay' })
  const client = connectorTo(s.url)
  try {
    await new Promise(/** 等待真实链路打开，再走本机收敛路径。 */ (resolve) => setTimeout(resolve, 100))
    client.disconnect()
    assert.deepEqual(await untilDisconnect(client), { reason: 'connector_disconnected' })
    client.stop()
    assert.deepEqual(latest(client), { reason: 'connector_stopped' })
    assert.equal(client.status().phase, 'stopped')
  } finally {
    client.stop()
    s.stop()
  }
})
test('Gateway 侧主动断开在真实通道上交付 1008/transport_closed', async () => {
  const f = fixture()
  try {
    const device = f.pair('mock_gateway_disconnect')
    const client = f.connector(/** 只使用本用例无生产效力的设备身份。 */ () => device.credential)
    await until(
      /** 等待真实认证及 provider 就绪，确保关闭发生在已认证 epoch。 */ () => client.status().phase === 'ready'
    )
    f.gateway.disconnect(device.machine_id)
    const start = performance.now()
    while (client.status().phase !== 'disconnected') {
      if (performance.now() - start > 4000) {
        throw new Error('fixture_gateway_disconnect_timeout')
      }
      await new Promise(/** 让出事件循环供真实关闭帧到达。 */ (resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(latest(client), { code: 1008, reason: 'transport_closed' })
  } finally {
    f.stop()
  }
})

/**
 * 受控 socket 桩：捕获 connector 安装的处理器，由测试精确决定 error/close 的到达顺序，
 * 不建立真实链路，也不读写任何凭据或原生资源。
 */
type Handlers = {
  close?: (event: { code: number; reason: string }) => void
  error?: (event: unknown) => void
}

/**
 * 用属性描述符接管 onclose/onerror：Object.assign 只复制取值，会把访问器拍平成数据属性，
 * 必须用 defineProperties 才能截获 connector 的赋值。真实 socket 行为与字段全部保留。
 */
function capture(socket: Socket, slot: Handlers, { keepOpen = false } = {}): Socket {
  const real = { onclose: socket.onclose, onerror: socket.onerror }
  /** 只取原值的副本，避免重定义后自我递归。 */
  const terminate = socket.terminate.bind(socket)
  return Object.defineProperties(socket, {
    /** 记录 connector 安装的关闭处理器，供测试稍后触发。 */
    onclose: {
      get: () => real.onclose,
      set: (value: Handlers['close'] | null) => {
        real.onclose = value as never
        slot.close = value ?? undefined
      }
    },
    /** 记录 connector 安装的错误处理器，供测试稍后触发。 */
    onerror: {
      get: () => real.onerror,
      set: (value: Handlers['error'] | null) => {
        real.onerror = value as never
        slot.error = value ?? undefined
      }
    },
    /** keepOpen 固定「本机关闭帧回声先于 terminate 到达」的时序；否则保留原终止行为。 */
    terminate: {
      value: keepOpen ? /** 故意不真正拿断，让关闭帧的回声有机会到达。 */ () => {} : terminate,
      configurable: true,
      writable: true
    }
  })
}

function stubConnector() {
  const handlers: Handlers = {}
  const client = createConnector({
    url: 'ws://127.0.0.1:9/connector',
    developmentLoopback: true,
    credential: () => ({
      machine_id: 'mock_ordered',
      recovery_generation: 'mock_generation',
      credential: 'SYNTHETIC_CREDENTIAL_NOT_REAL'
    }),
    session: () => {
      throw new Error('fixture_must_not_open_session')
    },
    nativeInput: () => {
      throw new Error('fixture_must_not_call_native')
    },
    execute: async () => {
      throw new Error('fixture_must_not_execute')
    },
    // 长退避与长握手：观测窗口内不会建立新 epoch，也不会被本机超时提前收敛。
    limits: {
      heartbeat_ms: 10_000,
      idle_ms: 10_000,
      handshake_ms: 10_000,
      reconnect_ms: 60_000,
      reconnect_max_ms: 60_000
    },
    random: () => 1,
    now: () => 1000,
    /** 包装真实 socket，只接管事件处理器以构造指定顺序；其余行为仍是原 socket。 */
    socketFactory: (socket) => capture(socket, handlers)
  })
  return { client, handlers }
}

/** 等待断开计数达到期望值；失败只报告固定诊断。 */
async function untilCount(client: ReturnType<typeof createConnector>, count: number) {
  const start = performance.now()
  while (client.status().disconnects < count) {
    if (performance.now() - start > 3000) {
      throw new Error('fixture_disconnect_timeout')
    }
    await new Promise(/** 让出事件循环供受控事件处理器推进。 */ (resolve) => setTimeout(resolve, 5))
  }
}

test('onerror 后到达的 onclose 把本机观测纠正为 1006/transport_abnormal 且只记一次', async () => {
  const { client, handlers } = stubConnector()
  try {
    // 先等 connector 装好处理器（connect 在构造时同步执行）。
    await untilCount(client, 0)
    assert.equal(client.status().disconnects, 0)
    // 1.4.3 顺序：terminate 先触发 error（本机 transport_unavailable）。
    handlers.error?.({ type: 'error' })
    await untilCount(client, 1)
    assert.deepEqual(latest(client), { reason: 'transport_unavailable' })
    // 随后 onclose(1006) 到达：纠正为远端实际观察值，不再 +1。
    handlers.close?.({ code: 1006, reason: '' })
    await new Promise(/** 让纠正写入完成。 */ (resolve) => setTimeout(resolve, 20))
    assert.deepEqual(latest(client), { code: 1006, reason: 'transport_abnormal' })
    assert.equal(client.status().disconnects, 1)
  } finally {
    client.stop()
  }
})

test('同一窗口内两次真实断开都进队列：先 1008/transport_closed，后 1006/transport_abnormal', async () => {
  // 复现实跑顺序：网关主动关（1008）后立刻重连被拒（1006）。两者都必须在队列里，
  // 只留“最近一条”会让更早的 1008 消失。
  const first: Handlers = {}
  const second: Handlers = {}
  let built = 0
  const client = createConnector({
    url: 'ws://127.0.0.1:9/connector',
    developmentLoopback: true,
    credential: () => ({
      machine_id: 'mock_window',
      recovery_generation: 'mock_generation',
      credential: 'SYNTHETIC_CREDENTIAL_NOT_REAL'
    }),
    session: () => {
      throw new Error('fixture_must_not_open_session')
    },
    nativeInput: () => {
      throw new Error('fixture_must_not_call_native')
    },
    execute: async () => {
      throw new Error('fixture_must_not_execute')
    },
    // 退避极短，让第二条 socket 立即建立；两次断开都落在同一次采样窗口内。
    limits: { heartbeat_ms: 10_000, idle_ms: 10_000, handshake_ms: 10_000, reconnect_ms: 1, reconnect_max_ms: 1 },
    random: () => 1,
    now: () => 1000,
    /** 每建立一条 socket 就把处理器登记到对应的槽位。 */
    socketFactory: (socket) => capture(socket, built++ === 0 ? first : second)
  })
  try {
    await untilCount(client, 0)
    // 第一条：网关主动关闭 1008。
    first.close?.({ code: 1008, reason: 'transport_closed' })
    await untilCount(client, 1)
    const start = performance.now()
    while (built < 2) {
      if (performance.now() - start > 3000) {
        throw new Error('fixture_reconnect_timeout')
      }
      await new Promise(/** 让出事件循环供退避重连推进。 */ (resolve) => setTimeout(resolve, 5))
    }
    // 第二条：重连被拒，只有关闭码没有白名单原因；1006 表示未收到关闭帧 → transport_abnormal。
    second.close?.({ code: 1006, reason: '' })
    await untilCount(client, 2)
    // 两条都保留，顺序从旧到新，计数为 2（更早的 1008 不被最新一条覆盖）。
    assert.deepEqual(client.status().disconnect_recent, [
      { code: 1008, reason: 'transport_closed' },
      { code: 1006, reason: 'transport_abnormal' }
    ])
    assert.equal(client.status().disconnects, 2)
  } finally {
    client.stop()
  }
})

test('晚到 onclose 只纠正一次，重复事件不重复计数', async () => {
  const { client, handlers } = stubConnector()
  try {
    await untilCount(client, 0)
    handlers.error?.({ type: 'error' })
    await untilCount(client, 1)
    handlers.close?.({ code: 1006, reason: '' })
    handlers.close?.({ code: 1006, reason: '' })
    await new Promise(/** 让纠正写入完成。 */ (resolve) => setTimeout(resolve, 20))
    assert.deepEqual(latest(client), { code: 1006, reason: 'transport_abnormal' })
    assert.equal(client.status().disconnects, 1)
  } finally {
    client.stop()
  }
})

test('晚到 onclose 不把已重连后的新 epoch 观测覆盖成旧值', async () => {
  // 快速重连：本机收敛后立即建新 socket，旧 socket 的关闭事件必须被忽略。
  const first: Handlers = {}
  const second: Handlers = {}
  let built = 0
  const client = createConnector({
    url: 'ws://127.0.0.1:9/connector',
    developmentLoopback: true,
    credential: () => ({
      machine_id: 'mock_reconnect',
      recovery_generation: 'mock_generation',
      credential: 'SYNTHETIC_CREDENTIAL_NOT_REAL'
    }),
    session: () => {
      throw new Error('fixture_must_not_open_session')
    },
    nativeInput: () => {
      throw new Error('fixture_must_not_call_native')
    },
    execute: async () => {
      throw new Error('fixture_must_not_execute')
    },
    // 退避极短，让旧 socket 的 close 一定在新 epoch 建立之后才到达。
    limits: { heartbeat_ms: 10_000, idle_ms: 10_000, handshake_ms: 10_000, reconnect_ms: 1, reconnect_max_ms: 1 },
    random: () => 1,
    now: () => 1000,
    /** 每建立一条 socket 就把处理器登记到对应的槽位。 */
    socketFactory: (socket) => capture(socket, built++ === 0 ? first : second)
  })
  try {
    await untilCount(client, 0)
    assert.equal(built, 1)
    // 第一条 socket 本机收敛：本机原因，计数 1。
    first.error?.({ type: 'error' })
    await untilCount(client, 1)
    assert.deepEqual(latest(client), { reason: 'transport_unavailable' })
    // 等第二条 socket 真正建立（新 epoch）。
    const start = performance.now()
    while (built < 2) {
      if (performance.now() - start > 3000) {
        throw new Error('fixture_reconnect_timeout')
      }
      await new Promise(/** 让出事件循环供退避重连推进。 */ (resolve) => setTimeout(resolve, 5))
    }
    // 旧 socket 的晚到关闭事件：必须被忽略，不能覆盖当前观测。
    first.close?.({ code: 1006, reason: '' })
    await new Promise(/** 给被忽略的事件充分执行时间。 */ (resolve) => setTimeout(resolve, 30))
    assert.deepEqual(latest(client), { reason: 'transport_unavailable' })
    assert.equal(client.status().disconnects, 1)
  } finally {
    client.stop()
  }
})

test('已断开时重复 disconnect/stop 不新增断开记录，也不推迟重连', async () => {
  // 生产里 session_replaced 直接接 transport.disconnect()，来源反复重建会重复调用它；
  // 已没有活跃 socket 时那是重复请求，不能凭空记一次断开或再抬一档退避。
  const s = server({ kind: 'stay' })
  const client = connectorTo(s.url)
  try {
    await untilDisconnect(client)
    const settled = client.status()
    assert.equal(settled.disconnects, 1)
    client.disconnect()
    client.disconnect()
    client.disconnect()
    const current = client.status()
    assert.equal(current.disconnects, settled.disconnects)
    assert.equal(current.reconnects, settled.reconnects)
    assert.equal(current.disconnect_recent.length, settled.disconnect_recent.length)
    // 唯一例外是停止：这是全局生命周期的真实状态变化，仍如实交付一条。
    client.stop()
    assert.equal(client.status().disconnects, settled.disconnects + 1)
    assert.deepEqual(latest(client), { reason: 'connector_stopped' })
    assert.equal(client.status().phase, 'stopped')
  } finally {
    client.stop()
    s.stop()
  }
})

test('本机主动关闭帧的回声不被当成对端关闭，本机原因保持原样', async () => {
  // close() 先 close(1000, '') 再 terminate；某些运行时上关闭帧的回声可能先到。
  // terminate 换成 no-op 固定这一时序：本机原因不得被改写，也不得伪造成 Gateway 主动关闭。
  const s = server({ kind: 'stay' })
  const slot: Handlers = {}
  const client = createConnector({
    url: s.url,
    developmentLoopback: true,
    credential: () => ({
      machine_id: 'mock_local_echo',
      recovery_generation: 'mock_generation',
      credential: 'SYNTHETIC_CREDENTIAL_NOT_REAL'
    }),
    session: () => {
      throw new Error('fixture_must_not_open_session')
    },
    nativeInput: () => {
      throw new Error('fixture_must_not_call_native')
    },
    execute: async () => {
      throw new Error('fixture_must_not_execute')
    },
    limits: {
      heartbeat_ms: 10_000,
      idle_ms: 10_000,
      handshake_ms: 10_000,
      reconnect_ms: 60_000,
      reconnect_max_ms: 60_000
    },
    random: () => 1,
    now: () => 1000,
    /** 固定「关闭帧回声先于 terminate 到达」的时序，其余行为仍是原 socket。 */
    socketFactory: (socket) => capture(socket, slot, { keepOpen: true })
  })
  try {
    // 底层网络错误先收敛为本机原因。
    slot.error?.({ type: 'error' })
    await untilCount(client, 1)
    assert.deepEqual(latest(client), { reason: 'transport_unavailable' })
    // 本机 close() 已发出 1000 关闭帧；其回声不得把原因改写成对端关闭。
    slot.close?.({ code: 1000, reason: '' })
    await new Promise(/** 让被忽略的回声充分执行。 */ (resolve) => setTimeout(resolve, 30))
    assert.deepEqual(latest(client), { reason: 'transport_unavailable' })
    assert.equal(client.status().disconnects, 1)
  } finally {
    client.stop()
    s.stop()
  }
})
