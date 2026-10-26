// 观察循环的对外输出：断开按独立事件序号补报为诊断行，与 250ms 采样相位解耦；未知/越界值整条丢弃。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { CliSetup } from '../../src/cli/setup-runtime.js'
import { DisconnectLog } from '../../src/transport/disconnect.js'
import type { RunningConnector } from '../../src/cli/run.js'

type Status = ReturnType<NonNullable<RunningConnector['transport']>['status']>

/**
 * 合成状态只覆盖被观察字段，其余字段取固定空值，不伪造连接或 provider 事实。
 * extra 按 unknown 透传：观察循环必须能处理宿主交付的越界/未知值，不能靠类型断言屏蔽。
 */
function status(phase: string, disconnects: unknown, extra: Record<string, unknown> = {}): Status {
  const recent = Array.isArray(extra.disconnect_recent) ? extra.disconnect_recent : []
  return {
    disconnect_change_sequence: disconnects,
    disconnect_changes: recent.map((observation, index) => ({
      sequence: typeof disconnects === 'number' ? disconnects - recent.length + index + 1 : disconnects,
      correction: false,
      observation
    })),
    phase,
    running: 0,
    reconnects: 0,
    machine_id: 'mock_observed',
    connection_epoch: 'mock_epoch',
    providers: [],
    disconnects,
    disconnect_recent: [],
    ...extra
  } as unknown as Status
}

/** 已就绪状态，供“采样期间仍 ready”的用例复用。 */
const ready = (disconnects: unknown, extra: Record<string, unknown> = {}) =>
  status('ready', disconnects, { providers: [{ provider_id: 'provider', ready: true }], ...extra })

/** 交付固定状态快照的合成 Connector 生命周期，不创建 socket、身份或原生会话。 */
function lifecycle(current: () => Status): RunningConnector {
  return {
    // 观察循环的清理回调只清 timer，不会提前结束本 Promise。
    closed: new Promise<void>(() => {}),
    transport: {
      /** 每次取样返回当前合成状态，模拟真实 transport 的只读 status。 */
      status: () => current()
    },
    /** 合成生命周期没有真实资源需要释放。 */
    close: async () => {}
  }
}

/** 排空已缓冲的全部块；读取端口按块返回，不能只看第一块。 */
function drain(stderr: PassThrough): string {
  let text = ''
  for (let chunk = stderr.read(); chunk !== null; chunk = stderr.read()) {
    text += String(chunk)
  }
  return text
}

/** 等待超过一个 250ms 取样周期，让本轮状态至少输出一次。 */
const sample = () =>
  new Promise<void>(/** 覆盖固定取样周期，不推断观察循环内部状态。 */ (resolve) => setTimeout(resolve, 320))

/**
 * 启动真实 CliSetup 观察循环。observe 同步建立断开计数基线，随后由 change 推进状态，
 * 再用一个 sample 周期观察补报结果。
 */
async function observe(connector: RunningConnector, change?: () => void): Promise<string> {
  const stderr = new PassThrough()
  const setup = new CliSetup()
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr, signal: new AbortController().signal }
  try {
    await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', io)
    setup.observe(connector)
    await sample()
    if (change) {
      change()
      await sample()
    }
    return drain(stderr)
  } finally {
    setup.close()
  }
}

test('断开诊断独立成行，相位行不再附带关闭码', async () => {
  let current = ready(0)
  const output = await observe(
    lifecycle(() => current),
    () => {
      current = status('disconnected', 1, { disconnect_recent: [{ code: 1008, reason: 'transport_closed' }] })
    }
  )
  assert.equal(
    output,
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect code=1008 close_reason=transport_closed\n' +
      'connector_transport disconnected provider_ready=false\n'
  )
})

test('本机收敛的断开只输出原因，不伪造未观察到的关闭码', async () => {
  let current = ready(0)
  const output = await observe(
    lifecycle(() => current),
    () => {
      current = status('disconnected', 1, { disconnect_recent: [{ reason: 'handshake_timeout' }] })
    }
  )
  assert.equal(
    output,
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect close_reason=handshake_timeout\n' +
      'connector_transport disconnected provider_ready=false\n'
  )
})

test('极快重连：断开与重连同处一次采样周期内仍补报一条断连诊断行', async () => {
  // 采样只看到 ready，但 disconnects 已 +1：相位行不得吞掉这条事件，也不得挂关闭码。
  let current = ready(0)
  const output = await observe(
    lifecycle(() => current),
    () => {
      // 采样窗口内完成：断开后立刻回到 ready，中间态从未被采样看到。
      current = ready(1, { disconnect_recent: [{ code: 1008, reason: 'transport_closed' }] })
    }
  )
  assert.equal(
    output,
    'connector_transport ready provider_ready=true\n' + 'connector_disconnect code=1008 close_reason=transport_closed\n'
  )
  assert.equal(output.includes('provider_ready=true code='), false)
})

test('同一采样窗口内两次断开必须补打两行，顺序从旧到新', async () => {
  // 实跑复现：一个窗口内先 1008/transport_closed，再 1006/transport_unclassified（重连被拒）。
  // 只交付“最近一条”会让更早的 1008 被覆盖，这里要求两行都在且顺序为旧→新。
  let current = ready(0)
  const output = await observe(
    lifecycle(() => current),
    () => {
      current = ready(2, {
        disconnect_recent: [
          { code: 1008, reason: 'transport_closed' },
          { code: 1006, reason: 'transport_unclassified' }
        ]
      })
    }
  )
  assert.equal(
    output,
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect code=1008 close_reason=transport_closed\n' +
      'connector_disconnect code=1006 close_reason=transport_unclassified\n'
  )
})

test('计数差大于队列长度时只补报队列里的条数，不虚构事件', async () => {
  // 宿主在两次采样之间发生了 20 次断开，但队列只保留最新 16 条：只能补报实际交付的条目。
  let current = ready(0)
  const recent = Array.from({ length: 16 }, (_, index) => ({
    code: 1000 + index,
    reason: 'transport_unclassified'
  }))
  const output = await observe(
    lifecycle(() => current),
    () => {
      current = ready(20, { disconnect_recent: recent })
    }
  )
  const lines = output.split('\n').filter(Boolean)
  // 一行相位行 + 16 行断连诊断，且顺序从旧到新。
  assert.equal(lines.length, 17)
  assert.deepEqual(
    lines.slice(1),
    recent.map((entry) => 'connector_disconnect code=' + entry.code + ' close_reason=' + entry.reason)
  )
})

test('连续两次断开各补报一条，计数不合并', async () => {
  let current = ready(0)
  const stderr = new PassThrough()
  const setup = new CliSetup()
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr, signal: new AbortController().signal }
  let text = ''
  try {
    await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', io)
    setup.observe(lifecycle(() => current))
    await sample()
    // 同一观察会话内两次独立断开，各自补报一条。
    current = ready(1, { disconnect_recent: [{ code: 1008, reason: 'transport_closed' }] })
    await sample()
    current = ready(2, { disconnect_recent: [{ code: 1006, reason: 'transport_abnormal' }] })
    await sample()
    text = drain(stderr)
  } finally {
    setup.close()
  }
  assert.equal(
    text,
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect code=1008 close_reason=transport_closed\n' +
      'connector_disconnect code=1006 close_reason=transport_abnormal\n'
  )
})

test('订阅时同步记基线：已有的历史断连不打印', async () => {
  // 连接启动时 transport 已带历史计数与观测；首轮采样不得把它当作本进程新事件。
  const output = await observe(
    lifecycle(() =>
      ready(7, {
        disconnect_recent: [{ code: 1008, reason: 'transport_closed' }]
      })
    )
  )
  assert.equal(output, 'connector_transport ready provider_ready=true\n')
  assert.equal(output.includes('connector_disconnect'), false)
})

test('基线之后的第一条新断开仍会打印', async () => {
  let current = ready(7, { disconnect_recent: [{ code: 1008, reason: 'transport_closed' }] })
  const output = await observe(
    lifecycle(() => current),
    () => {
      current = ready(8, { disconnect_recent: [{ code: 1006, reason: 'transport_abnormal' }] })
    }
  )
  assert.equal(
    output,
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect code=1006 close_reason=transport_abnormal\n'
  )
})

test('observe 返回后、首个采样前发生的断开必须补报', async () => {
  const log = new DisconnectLog()
  const stderr = new PassThrough()
  const setup = new CliSetup()
  try {
    await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
      signal: new AbortController().signal
    })
    setup.observe(lifecycle(() => ready(log.snapshot().disconnects, { ...log.snapshot(), ...log.changes() })))
    log.record({ code: 1008, reason: 'transport_closed' })
    await sample()
    assert.match(drain(stderr), /connector_disconnect code=1008 close_reason=transport_closed\n/)
  } finally {
    setup.close()
  }
})

test('已打印的断开可在下一采样补报订正，断连次数仍为一次，重复采样不重打', async () => {
  const log = new DisconnectLog()
  const stderr = new PassThrough()
  const setup = new CliSetup()
  try {
    await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
      signal: new AbortController().signal
    })
    setup.observe(lifecycle(() => ready(log.snapshot().disconnects, { ...log.snapshot(), ...log.changes() })))
    log.record({ reason: 'transport_unavailable' })
    await sample()
    assert.match(drain(stderr), /connector_disconnect close_reason=transport_unavailable\n/)
    log.refine({ code: 1006, reason: 'transport_abnormal' })
    await sample()
    assert.equal(drain(stderr), 'connector_disconnect_update code=1006 close_reason=transport_abnormal\n')
    await sample()
    assert.equal(drain(stderr), '')
    assert.equal(log.snapshot().disconnects, 1)
  } finally {
    setup.close()
  }
})

test('订正与下一次断开同处一个采样窗口时都按顺序补报', async () => {
  const log = new DisconnectLog()
  const output = await observe(
    lifecycle(() => ready(log.snapshot().disconnects, { ...log.snapshot(), ...log.changes() })),
    () => {
      log.record({ reason: 'transport_unavailable' })
      log.refine({ code: 1006, reason: 'transport_abnormal' })
      log.record({ code: 1008, reason: 'transport_closed' })
    }
  )
  assert.equal(
    output,
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect close_reason=transport_unavailable\n' +
      'connector_disconnect_update code=1006 close_reason=transport_abnormal\n' +
      'connector_disconnect code=1008 close_reason=transport_closed\n'
  )
  assert.equal(log.snapshot().disconnects, 2)
})

test('未知或越界的断开观测整条丢弃，绝不把宿主文本写进普通输出', async () => {
  const secret = 'SYNTHETIC_SECRET token=/etc/passwd'
  const values: unknown[] = [
    { code: 1008, reason: secret },
    { code: '1008', reason: 'transport_closed' },
    { code: 1e9, reason: 'transport_closed' },
    { code: 1008 },
    { reason: 'HANDSHAKE_TIMEOUT' },
    secret
  ]
  for (const disconnect of values) {
    let current = ready(0)
    // 计数已推进但观测不可交付：只能省掉诊断行，不能退化成原文输出。
    const output = await observe(
      lifecycle(() => current),
      () => {
        current = status('disconnected', 1, { disconnect_recent: [disconnect] })
      }
    )
    assert.equal(
      output,
      'connector_transport ready provider_ready=true\nconnector_transport disconnected provider_ready=false\n'
    )
    assert.equal(output.includes(secret), false)
  }
})

test('非整数或缺失事件序号不被采信，也不推进基线', async () => {
  let current = ready(0)
  const stderr = new PassThrough()
  const setup = new CliSetup()
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr, signal: new AbortController().signal }
  let text = ''
  try {
    await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', io)
    setup.observe(lifecycle(() => current))
    await sample()
    // 宿主交付越界事件序号：整轮按未知处理，既不打印也不污染基线。
    current = ready(1.5, { disconnect_recent: [{ code: 1006, reason: 'transport_abnormal' }] })
    await sample()
    current = ready(2, { disconnect_recent: [{ code: 1006, reason: 'transport_abnormal' }] })
    await sample()
    text = drain(stderr)
  } finally {
    setup.close()
  }
  assert.equal(
    text,
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect code=1006 close_reason=transport_abnormal\n'
  )
})

test('订阅时首次取样失败不弃掉整个观察：后续窗口仍打印相位与断开', async () => {
  // 降级宿主（例如 provider 健康度超额）确实会让 status() 抛固定错误码；
  // 首次取样失败只意味着暂无基线，不能整个进程再无任何诊断输出。
  let calls = 0
  let current = ready(0)
  const connector = lifecycle(() => {
    if (calls++ === 0) {
      throw new Error('provider_limit')
    }
    return current
  })
  const stderr = new PassThrough()
  const setup = new CliSetup()
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr, signal: new AbortController().signal }
  let text = ''
  try {
    await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', io)
    setup.observe(connector)
    await sample()
    current = ready(1, { disconnect_recent: [{ code: 1008, reason: 'transport_closed' }] })
    await sample()
    text = drain(stderr)
  } finally {
    setup.close()
  }
  // 首次失败不建立基线，因此下一次成功取样的第 1 条事件仍算新事件。
  assert.equal(
    text,
    'connector_transport ready provider_ready=true\n' + 'connector_disconnect code=1008 close_reason=transport_closed\n'
  )
})
