// 用真实 loopback 与原生 WebSocket 验证 Connector 断连观测：只交付白名单原因与有界关闭码，正文不进入输出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnector } from '../../src/transport/index.js'
import { runtime } from '../../src/transport/common.js'
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
