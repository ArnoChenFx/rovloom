/** 以合成安装接缝、自建 Unix listener 和真实 Herdr runtime/持久 claim 验证最终终端执行门禁。 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { HerdrInstallation } from '../../../src/connector/herdr/installation.js'
import { inspectHerdrPath, pinHerdrConfig } from '../../../src/connector/herdr/local.js'
import { createHerdrRuntime } from '../../../src/connector/herdr/runtime.js'
import { LuvusDispatchClaims } from '../../../src/connector/luvus/claims.js'
import { backendFixture } from './helpers.js'
import { privateHerdrTestRoot } from './private-root.js'

/** 安装来源是明确的合成 fixture；真实 Wire、内核 peer、Unix IO 和 SQLite claim 保持原实现。 */
async function fixture(method: string, enabled?: boolean, installedEnabled = enabled) {
  const state = backendFixture()
  const root = privateHerdrTestRoot('.herdr-terminal-switch-')
  const endpoint = join(root, 'native.sock')
  mkdirSync(join(root, 'claims'), { mode: 0o700 })
  state.record.method = method
  state.record.native_request = { method, params: { pane_id: 'owned', text: 'printf synthetic' } }
  const nativeSource = state.backend.nativeSource
  state.backend.nativeSource = /** 将 fixture 来源明确标为合成本机安装，不冒充认证远端报告。 */ (binding) => ({
    ...nativeSource(binding)!,
    role: 'local_installation'
  })
  const sockets = new Set<Socket>()
  let received = ''
  let onInput = /** 合成输入 ack 不是 shell 完成；测试不增加 exit_code。 */ (socket: Socket, id: string) =>
    socket.end(JSON.stringify({ id, result: { type: 'ok' } }) + '\n')
  const server = createServer(
    /** 自建 listener 只记录本轮合成请求，不启动进程或模型。 */ (socket) => {
      sockets.add(socket)
      socket.on('error', /** 消费故意断连的测试 IO 错误。 */ () => {})
      socket.on('close', /** 释放自有连接引用。 */ () => sockets.delete(socket))
      socket.on(
        'data',
        /** 接收实际产品 IO 写出的完整单帧。 */ (chunk) => {
          received += chunk.toString()
          if (received.endsWith('\n')) {
            onInput(socket, JSON.parse(received).id)
          }
        }
      )
    }
  )
  await new Promise<void>(
    /** 等待唯一私有 listener 就绪，失败保持拒绝。 */ (resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    }
  )
  chmodSync(endpoint, 0o600)
  const local = { allow_terminal_execution: enabled }
  // 测试仅替换安装测量这一明确接缝；不声称 fake token 是原生安装证据。
  const installation = Object.assign(Object.create(HerdrInstallation.prototype), {
    config: { allow_terminal_execution: installedEnabled },
    assert: /** 真实 IO 仍核对本测试 socket 的路径与归属。 */ () => ({
      address: endpoint,
      stamp: inspectHerdrPath(endpoint, 'socket'),
      uid: process.geteuid!()
    }),
    source: /** 复用当前 fixture 的完整 binding 与合成本机来源。 */ (binding: typeof state.binding) =>
      state.backend.nativeSource(binding)
  }) as HerdrInstallation
  const claims = new LuvusDispatchClaims({
    path: join(root, 'claims', 'claims.sqlite'),
    mode: 'create',
    ledger_id: 'synthetic',
    limits: { entries: 16, bytes: 262_144 },
    now: /** 与原 fixture deadline 使用同一可信时钟。 */ () => state.backend.now()
  })
  const runtime = createHerdrRuntime(
    installation,
    state.backend,
    claims,
    /** 每次边界读取当前布尔值。 */ () => local.allow_terminal_execution === true
  )
  const raw = JSON.stringify({
    protocol_major: 2,
    protocol_minor: 0,
    message_id: 'owned',
    machine_id: state.binding.machine_id,
    recovery_generation: state.binding.recovery_generation,
    connection_epoch: state.binding.connection_epoch,
    type: 'request',
    payload: {
      attempt: state.identity,
      expected_binding_revision: 1,
      validation: 'strict',
      native_request: state.record.native_request
    }
  })
  return {
    state,
    runtime,
    claims,
    local,
    raw,
    received: /** 读取自建 listener 收到的实际字节。 */ () => received,
    respond: /** 设置合成原生响应，仅用于未知结果边界测试。 */ (callback: typeof onInput) => {
      onInput = callback
    },
    close: /** 停止本轮 runtime、数据库、socket 和 listener，不操作任何用户会话。 */ async () => {
      runtime.close()
      claims.close()
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>(
        /** 完成监听关闭后删除全部自有文件。 */ (resolve) => server.close(/** 结束本轮清理等待。 */ () => resolve())
      )
      rmSync(root, { recursive: true, force: true })
    }
  }
}

for (const method of ['pane.send_text', 'pane.send_input']) {
  for (const enabled of [undefined, false] as const) {
    test(
      `Herdr ${method} rejects local ${enabled} before native write`,
      /** 实际 runtime 即使已有合法 Wire 授权也不能绕过本机关闭状态。 */ async () => {
        const f = await fixture(method, enabled)
        try {
          await assert.rejects(f.runtime.executeWire(f.raw, new AbortController().signal), {
            code: 'terminal_execution_disabled',
            outcome: 'not_dispatched'
          })
          assert.equal(f.received(), '')
        } finally {
          await f.close()
        }
      }
    )
  }
}

test(
  'Herdr enabled input keeps the native ack distinct from command completion',
  /** 合成原生 ok 只确认输入请求，完整回包没有伪造的 shell exit_code。 */ async () => {
    const f = await fixture('pane.send_input', true)
    try {
      const result = await f.runtime.executeWire(f.raw, new AbortController().signal)
      assert.equal(JSON.parse(f.received()).params.text, 'printf synthetic')
      assert.deepEqual(result.native_response, { id: f.state.binding.native_request_id, result: { type: 'ok' } })
      assert.equal(Object.hasOwn(result, 'exit_code'), false)
    } finally {
      await f.close()
    }
  }
)

for (const enabled of [false, true]) {
  test(`Herdr role switch ${enabled} overrides the opposite installation snapshot at the native boundary`, async () => {
    const f = await fixture('pane.send_input', enabled, !enabled)
    try {
      if (enabled) {
        await f.runtime.executeWire(f.raw, new AbortController().signal)
        assert.equal(JSON.parse(f.received()).params.text, 'printf synthetic')
      } else {
        await assert.rejects(f.runtime.executeWire(f.raw, new AbortController().signal), {
          code: 'terminal_execution_disabled',
          outcome: 'not_dispatched'
        })
        assert.equal(f.received(), '')
      }
    } finally {
      await f.close()
    }
  })
}

test(
  'Herdr revokes after durable claim and retains the tombstone without writing',
  /** 原 SQLite claim 提交后复查配置；禁止删除墓碑或重新派发旧 attempt。 */ async () => {
    const f = await fixture('pane.send_input', true)
    const claim = f.claims.claim.bind(f.claims)
    f.claims.claim = /** 保留真实持久 claim，再模拟本机所有者撤销。 */ (...args) => {
      claim(...args)
      f.local.allow_terminal_execution = false
    }
    try {
      await assert.rejects(f.runtime.executeWire(f.raw, new AbortController().signal), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.received(), '')
      assert.throws(
        /** 原持久发送墓碑仍存在，不能因关闭状态而清除。 */ () => claim(f.state.binding, 2000),
        /dispatch_already_claimed/
      )
      f.local.allow_terminal_execution = true
      await assert.rejects(f.runtime.executeWire(f.raw, new AbortController().signal), {
        code: 'attempt_already_observed'
      })
    } finally {
      await f.close()
    }
  }
)

test(
  'Herdr disconnect after input stays outcome_unknown and is never replayed',
  /** 真实发送后的 EOF 不是命令失败或回滚证明，重新开启也不能重发。 */ async () => {
    const f = await fixture('pane.send_input', true)
    f.respond(/** 故意丢弃 native ack，保留是否执行未知。 */ (socket) => socket.destroy())
    try {
      await assert.rejects(f.runtime.executeWire(f.raw, new AbortController().signal), { outcome: 'outcome_unknown' })
      assert.notEqual(f.received(), '')
      await assert.rejects(f.runtime.executeWire(f.raw, new AbortController().signal), {
        code: 'attempt_already_observed'
      })
    } finally {
      await f.close()
    }
  }
)

test(
  'Herdr local configuration accepts only the explicit optional boolean',
  /** 本地配置接受单一开关，未知字段、字符串及缺必填字段仍失败。 */ () => {
    const config = {
      target: { machine_id: 'owned', provider_id: 'herdr', profile: 'session' as const, session: 'owned' },
      binding_revision: 1,
      config_ref: 'owned',
      binary: '/synthetic/herdr',
      home: '/synthetic/home',
      config_home: '/synthetic/config',
      state_home: '/synthetic/state',
      cache_home: '/synthetic/cache',
      temporary_home: '/synthetic/tmp',
      cwd: '/synthetic/cwd'
    }
    assert.equal(pinHerdrConfig(config).allow_terminal_execution, undefined)
    assert.equal(pinHerdrConfig({ ...config, allow_terminal_execution: true }).allow_terminal_execution, true)
    assert.throws(
      /** JSON 真值不能扩大本机许可。 */ () =>
        pinHerdrConfig({ ...config, allow_terminal_execution: 'true' } as unknown as typeof config),
      /terminal_execution_config_invalid/
    )
  }
)
