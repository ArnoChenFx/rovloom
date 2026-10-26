// 观察循环的对外输出：断开只打印有界关闭码与白名单原因，未知/越界值整条丢弃且不输出正文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { CliSetup } from '../../src/cli/setup-runtime.js'
import type { RunningConnector } from '../../src/cli/run.js'
import type { RunningConnector as _RunningConnector } from '../../src/cli/run.js'

type Status = ReturnType<NonNullable<_RunningConnector['transport']>['status']>

/**
 * 合成状态只覆盖被观察字段，其余字段取固定空值，不伪造连接或 provider 事实。
 * extra 按 unknown 透传：观察循环必须能处理宿主交付的越界/未知值，不能靠类型断言屏蔽。
 */
function status(phase: string, extra: Record<string, unknown> = {}): Status {
  return {
    phase,
    running: 0,
    reconnects: 0,
    machine_id: 'mock_observed',
    connection_epoch: 'mock_epoch',
    providers: [],
    ...extra
  } as Status
}

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

/** 启动真实 CliSetup 观察循环，执行本轮到状态变化后再排空 stderr。 */
async function observe(connector: RunningConnector, during: () => Promise<void>): Promise<string> {
  const stderr = new PassThrough()
  const setup = new CliSetup()
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr, signal: new AbortController().signal }
  try {
    await setup.prepare({ ...configTemplate('connector'), state_dir: '/nonexistent' } as ConnectorConfig, '', io)
    setup.observe(connector)
    await during()
    return drain(stderr)
  } finally {
    setup.close()
  }
}

test('断开输出有界关闭码与固定原因，与现有 reason/capacity 顺序稳定', async () => {
  const output = await observe(
    lifecycle(() => status('disconnected', { disconnect: { code: 1008, reason: 'transport_closed' } })),
    sample
  )
  assert.equal(
    output,
    'connector_transport disconnected provider_ready=false code=1008 close_reason=transport_closed\n'
  )
})

test('本机收敛的断开只输出原因，不伪造未观察到的关闭码', async () => {
  const output = await observe(
    lifecycle(() => status('disconnected', { disconnect: { reason: 'handshake_timeout' } })),
    sample
  )
  assert.equal(output, 'connector_transport disconnected provider_ready=false close_reason=handshake_timeout\n')
})

test('容量、失败码与断开观测同帧输出时保持固定顺序', async () => {
  const output = await observe(
    lifecycle(() =>
      status('disconnected', {
        providers: [{ provider_id: 'provider', ready: false }],
        failure: 'claim_capacity',
        capacity: { resource: 'claim_entries', reclaim_at: 1234 },
        disconnect: { code: 1006, reason: 'transport_abnormal' }
      })
    ),
    sample
  )
  assert.equal(
    output,
    'connector_transport disconnected provider_ready=false capacity=claim_entries reclaim_at=1234' +
      ' reason=claim_capacity code=1006 close_reason=transport_abnormal\n'
  )
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
    const output = await observe(
      lifecycle(() => status('disconnected', { disconnect })),
      sample
    )
    assert.equal(output, 'connector_transport disconnected provider_ready=false\n')
    assert.equal(output.includes(secret), false)
  }
})

test('相同状态只输出一次，阶段变化后才输出新行', async () => {
  let current = status('disconnected', { disconnect: { code: 1008, reason: 'transport_closed' } })
  const output = await observe(
    lifecycle(() => current),
    async () => {
      await new Promise<void>(/** 覆盖两个取样周期，确认同状态不重复输出。 */ (resolve) => setTimeout(resolve, 560))
      current = status('connecting')
      await sample()
    }
  )
  assert.equal(
    output,
    'connector_transport disconnected provider_ready=false code=1008 close_reason=transport_closed\n' +
      'connector_transport connecting provider_ready=false\n'
  )
})
