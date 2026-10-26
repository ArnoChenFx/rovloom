// 用真实 loopback 与原生 WebSocket 验证 Connector 断连观测：只交付白名单原因与有界关闭码，正文不进入输出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

/** 等待 Connector 的当前 socket 收敛到断开并带出断开观测；失败只报告固定诊断。 */
async function untilDisconnect(client: ReturnType<typeof createConnector>) {
  const start = performance.now()
  while (!['disconnected', 'stopped'].includes(client.status().phase) || !client.status().disconnect) {
    if (performance.now() - start > 3000) {
      throw new Error('fixture_disconnect_timeout')
    }
    await new Promise(/** 让出事件循环供真实 socket 关闭事件推进。 */ (resolve) => setTimeout(resolve, 5))
  }
  return client.status().disconnect
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
    assert.deepEqual(client.status().disconnect, { reason: 'connector_stopped' })
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
    assert.deepEqual(client.status().disconnect, { code: 1008, reason: 'transport_closed' })
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
function capture(socket: Socket, slot: Handlers): Socket {
  const real = { onclose: socket.onclose, onerror: socket.onerror }
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
    assert.deepEqual(client.status().disconnect, { reason: 'transport_unavailable' })
    // 随后 onclose(1006) 到达：纠正为远端实际观察值，不再 +1。
    handlers.close?.({ code: 1006, reason: '' })
    await new Promise(/** 让纠正写入完成。 */ (resolve) => setTimeout(resolve, 20))
    assert.deepEqual(client.status().disconnect, { code: 1006, reason: 'transport_abnormal' })
    assert.equal(client.status().disconnects, 1)
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
    assert.deepEqual(client.status().disconnect, { code: 1006, reason: 'transport_abnormal' })
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
    assert.deepEqual(client.status().disconnect, { reason: 'transport_unavailable' })
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
    assert.deepEqual(client.status().disconnect, { reason: 'transport_unavailable' })
    assert.equal(client.status().disconnects, 1)
  } finally {
    client.stop()
  }
})
