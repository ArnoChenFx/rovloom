/** 使用自建 listener 和真实 LuvusRpcAdapter 验证本地开关；所有原生回包均为明确合成数据。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './helpers.js'
import { G, validator, view, rejects } from './contract/helpers.js'
import { LuvusRpcAdapter } from '../../../src/connector/luvus/adapter.js'

const method = 'terminal.backend.submit_text'
const params = { server_generation: G, terminal_id: '1'.repeat(32), pane_id: '3', text: 'printf synthetic' }

for (const agentMethod of ['agent.send', 'agent.prompt']) {
  for (const strict of [undefined, false]) {
    test(
      `Luvus ${agentMethod} refuses strict ${strict} before native dispatch when switch is off`,
      /** 完整原生 schema 接受该宽松参数；Connector 本地开关仍须在发现与 claim 前明确拒绝。 */ async () => {
        const requestParams = { target: 'owned-agent', text: 'synthetic', ...(strict === undefined ? {} : { strict }) }
        const f = await fixture('ipc', agentMethod, requestParams)
        try {
          await assert.rejects(f.adapter.dispatch(f.input()), {
            code: 'terminal_execution_disabled',
            outcome: 'not_dispatched'
          })
          assert.equal(f.state.claims, 0)
          assert.equal(f.received(), '')
          assert.deepEqual(f.row.native_request.params, requestParams)
        } finally {
          await f.close()
        }
      }
    )
  }
}

test(
  'Luvus strict agent.send succeeds without rewriting the authorized request',
  /** 保留调用者显式严格参数及合成原生成功回包，不发放真实前台身份保证。 */ async () => {
    const requestParams = { target: 'owned-agent', text: 'synthetic', strict: true }
    const f = await fixture('ipc', 'agent.send', requestParams)
    const response = {
      id: f.binding.native_request_id,
      result: { type: 'agent_send', pane: '3', agent: 'synthetic', status: 'idle', name: 'owned-agent' }
    }
    f.respond(
      /** 只模拟原生严格文本输入的成功回包，不调用 Agent 或 shell。 */ (socket) =>
        socket.end(JSON.stringify(response) + '\n')
    )
    try {
      assert.deepEqual((await f.adapter.dispatch(f.input())).native_response, response)
      assert.deepEqual(JSON.parse(f.received()).params, requestParams)
      assert.deepEqual(f.row.native_request.params, requestParams)
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus loose Agent input becomes forbidden if the switch closes after claim',
  /** 不能缓存首次 true 或临时补 strict 来改变已验权请求；最终写入必须拒绝原宽松输入。 */ async () => {
    const requestParams = { target: 'owned-agent', text: 'synthetic' }
    const f = await fixture('ipc', 'agent.prompt', requestParams)
    let enabled = true
    f.host.terminalExecution = /** 同步读取当前本机开关。 */ () => enabled
    const claim = f.host.claimDispatch
    f.host.claimDispatch = /** 保留唯一派发墓碑后撤销直接执行。 */ async (...args) => {
      await claim(...args)
      enabled = false
    }
    try {
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.received(), '')
      assert.equal(f.state.claims, 1)
      assert.deepEqual(f.row.native_request.params, requestParams)
    } finally {
      await f.close()
    }
  }
)

for (const [name, taskParams] of [
  ['gate', { title: 'synthetic', gate: 'printf synthetic' }],
  ['multiline gate', { title: 'synthetic', gate: '\n printf synthetic \n' }]
] as const) {
  test(
    `Luvus task.add ${name} is rejected with terminal execution disabled`,
    /** 真实 reviewed 方法的完整 Wire 请求仍不能借任务记录保存可执行 shell gate。 */ async () => {
      const f = await fixture('ipc', 'task.add', taskParams)
      try {
        await assert.rejects(f.adapter.dispatch(f.input()), {
          code: 'terminal_execution_disabled',
          outcome: 'not_dispatched'
        })
        assert.equal(f.state.claims, 0)
        assert.equal(f.received(), '')
      } finally {
        await f.close()
      }
    }
  )
}

for (const gate of [undefined, '', ' \n\t ']) {
  test(
    `Luvus ordinary task.add ${JSON.stringify(gate)} retains its original native dispatch`,
    /** 没有可执行 gate 的正常任务创建不被终端开关误禁。 */ async () => {
      const taskParams = { title: 'synthetic', ...(gate === undefined ? {} : { gate }) }
      const f = await fixture('ipc', 'task.add', taskParams)
      try {
        assert.deepEqual((await f.adapter.dispatch(f.input())).native_response, f.response)
        assert.deepEqual(JSON.parse(f.received()).params, taskParams)
        assert.equal(f.state.claims, 1)
      } finally {
        await f.close()
      }
    }
  )
}

test(
  'Luvus explicit enable permits task.add gate without changing its native reply',
  /** 显式开启只放行任务 gate 的本地边界，不把任务记录或原生 error 报成 shell 完成。 */ async () => {
    const f = await fixture('ipc', 'task.add', { title: 'synthetic', gate: 'printf synthetic' })
    f.host.terminalExecution = /** 只为本测试自建 listener 开启。 */ () => true
    try {
      assert.deepEqual((await f.adapter.dispatch(f.input())).native_response, f.response)
      assert.equal(JSON.parse(f.received()).params.gate, 'printf synthetic')
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus task.start custom executable cannot bypass the switch through its agent field',
  /** 完整官方 task.start schema 可接受该自定义 argv，但当前本地开关仍须拒绝。 */ async () => {
    const f = await fixture('ipc', 'task.start', { id: 'owned-task', agent: '/bin/sh -c true' })
    try {
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.state.claims, 0)
      assert.equal(f.received(), '')
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus task.add checks the current switch again after claim, while task.update rejects gate in its native schema',
  /** gate 的存储入口复用最终写入检查；task.update 根本不接受 gate，不增加伪参数策略。 */ async () => {
    const f = await fixture('ipc', 'task.add', { title: 'synthetic', gate: 'printf synthetic' })
    let enabled = true
    f.host.terminalExecution = /** 只为合成来源提供可关闭的当前本机状态。 */ () => enabled
    const claim = f.host.claimDispatch
    f.host.claimDispatch = /** 先保存本次唯一发送锚点，再模拟本机关闭开关。 */ async (...args) => {
      await claim(...args)
      enabled = false
    }
    try {
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.received(), '')
      assert.equal(f.state.claims, 1)
      rejects(
        validator.checkRequest(view(), {
          id: 'owned',
          method: 'task.update',
          params: { id: 't1', gate: 'printf synthetic' }
        }),
        'native_request_invalid'
      )
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus old Agent reports cannot permit agent.keys after true becomes false',
  /** 原生合成端保留旧报告并会接受输入；实际 Connector 必须在新请求触达它之前按当前关闭值拒绝。 */ async () => {
    const f = await fixture('ipc', 'agent.keys', { target: '3', keys: ['a'] })
    let enabled = true
    const oldReport = { agent: 'synthetic', status: 'idle' }
    f.host.terminalExecution = /** 不从原生报告或首次 true 推导后续执行许可。 */ () => enabled
    f.respond(
      /** 模拟原生 is_agent_pane 接受既有 report 的行为；不证明真实 Agent 前台身份。 */ (socket) => {
        assert.equal(oldReport.agent, 'synthetic')
        socket.end(JSON.stringify({ id: f.binding.native_request_id, result: { type: 'ok', pane: '3' } }) + '\n')
      }
    )
    try {
      await f.adapter.dispatch(f.input())
      assert.equal(f.state.responses, 1)
      const sent = f.received()
      enabled = false
      f.binding.call_id = 'call2'
      f.binding.attempt_id = 'attempt2'
      f.binding.native_request_id = 'native_2'
      Object.assign(f.envelope.payload.attempt, {
        call_id: 'call2',
        attempt_id: 'attempt2',
        native_request_id: 'native_2'
      })
      f.envelope.message_id = 'request2'
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(oldReport.agent, 'synthetic')
      assert.equal(f.received(), sent)
      assert.equal(f.state.responses, 1)
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus preexisting Agent session evidence never relaxes the default agent.keys boundary',
  /** Connector 不将别名、terminal fence 或旧 session 当作当前前台程序证明，未开启时一律保守拒绝按键。 */ async () => {
    const f = await fixture('ipc', 'agent.keys', {
      target: 'old-session',
      keys: ['Enter'],
      terminal_id: '1'.repeat(32),
      if_content_revision: 7
    })
    f.respond(
      /** 旧原生 session 即使会返回成功，本次请求也不能发往该合成端。 */ (socket) =>
        socket.end(JSON.stringify({ id: f.binding.native_request_id, result: { type: 'ok', pane: '3' } }) + '\n')
    )
    try {
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.received(), '')
      assert.equal(f.state.claims, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus ordinary Agent prompt succeeds through its independent native path with terminal execution disabled',
  /** 正常文本对话保留真实适配器正向路径；合成原生 queued 表示输入接纳，不表示模型完成或前台身份实证。 */ async () => {
    const requestParams = { target: 'owned-agent', text: 'synthetic', wait: false, strict: true }
    const f = await fixture('ipc', 'agent.prompt', requestParams)
    const response = {
      id: f.binding.native_request_id,
      result: {
        type: 'agent_prompt',
        pane: '3',
        submitted: true,
        matched: false,
        status: 'idle',
        baseline_revision: 7,
        content_revision: 7,
        evidence: 'queued'
      }
    }
    f.respond(
      /** 只交付明确标记的合成原生 prompt 成功回包，不调用模型或写入真实 Agent。 */ (socket) =>
        socket.end(JSON.stringify(response) + '\n')
    )
    try {
      const result = await f.adapter.dispatch(f.input())
      assert.deepEqual(result.native_response, response)
      assert.equal(JSON.parse(f.received()).method, 'agent.prompt')
      assert.deepEqual(JSON.parse(f.received()).params, requestParams)
      assert.deepEqual(f.row.native_request.params, requestParams)
      assert.equal(f.state.claims, 1)
      assert.equal(result.exit_code, null)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus pinned local config accepts a boolean enable and rejects truthy JSON',
  /** 不需要额外配置框架；原本机配置的单一布尔字段即可开启合成终端。 */ async () => {
    const f = await fixture('ipc', method, params)
    const adapter = new LuvusRpcAdapter({ ...f.config, allow_terminal_execution: true }, f.host)
    f.respond(
      /** 合成原生 queued 仅表示输入入队，不能表示 shell 命令完成。 */ (socket) =>
        socket.end(
          JSON.stringify({
            id: f.binding.native_request_id,
            result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' }
          }) + '\n'
        )
    )
    try {
      assert.throws(
        /** JSON 字符串不能通过静态本机配置的验证。 */ () =>
          new LuvusRpcAdapter({ ...f.config, allow_terminal_execution: 'true' as unknown as boolean }, f.host),
        /terminal_execution_config_invalid/
      )
      const result = await adapter.dispatch(f.input())
      assert.equal(
        result.native_response.result && (result.native_response.result as Record<string, unknown>).dispatch,
        'queued'
      )
      assert.equal(result.exit_code, null)
    } finally {
      adapter.close()
      await f.close()
    }
  }
)

for (const seam of ['config', 'host'] as const) {
  test(
    `Luvus rejects terminal input before discovery and claim when local switch is explicitly false (${seam})`,
    /** 显式关闭（静态配置或宿主接缝）不能触达自建原生 listener。 */ async () => {
      const f = await fixture('ipc', method, params)
      if (seam === 'host') {
        f.host.terminalExecution = /** 从受保护宿主接缝返回当前关闭状态。 */ () => false
      }
      try {
        await assert.rejects(f.adapter.dispatch(f.input()), {
          code: 'terminal_execution_disabled',
          outcome: 'not_dispatched'
        })
        assert.equal(f.state.claims, 0)
        assert.equal(f.received(), '')
      } finally {
        await f.close()
      }
    }
  )
}

test(
  'Luvus omitted local switch defaults on while explicit false still refuses',
  /** 配置省略取默认开启；同一请求在显式 false 下被拒，证明放行来自默认值而非夹具放宽。 */ async () => {
    const f = await fixture('ipc', method, params)
    const { allow_terminal_execution: _explicitOff, ...omitted } = f.config
    const adapter = new LuvusRpcAdapter(omitted, f.host)
    f.respond(
      /** 合成原生 queued 仅表示输入入队，不能表示 shell 命令完成。 */ (socket) =>
        socket.end(
          JSON.stringify({
            id: f.binding.native_request_id,
            result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' }
          }) + '\n'
        )
    )
    try {
      const result = await adapter.dispatch(f.input())
      assert.equal(
        result.native_response.result && (result.native_response.result as Record<string, unknown>).dispatch,
        'queued'
      )
      assert.notEqual(f.received(), '')
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
    } finally {
      adapter.close()
      await f.close()
    }
  }
)

test(
  'Luvus explicit enable preserves the native reply and never invents command completion',
  /** 发送成功只获得合成 native error，不能被包装成 shell 成功或退出码零。 */ async () => {
    const f = await fixture('ipc', method, params)
    f.host.terminalExecution = /** 只为本测试自建 listener 显式开启。 */ () => true
    const response = {
      id: f.binding.native_request_id,
      error: { code: 'send_failed', message: 'synthetic', dispatch: 'started', metadata: { retained: true } }
    }
    f.respond(
      /** 使用官方终端错误根允许的合成错误，保留其派发状态和元数据。 */ (socket) =>
        socket.end(JSON.stringify(response) + '\n')
    )
    try {
      const result = await f.adapter.dispatch(f.input())
      assert.equal(JSON.parse(f.received()).params.text, params.text)
      assert.deepEqual(result.native_response, response)
      assert.equal(result.exit_code, null)
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus revocation during durable claim blocks the final write and retains no-replay state',
  /** claim 异步边界后重新读取当前配置，发送墓碑不能因拒绝而丢失。 */ async () => {
    const f = await fixture('ipc', method, params)
    let enabled = true
    f.host.terminalExecution = /** 每次真实适配器检查都读取当前状态，不缓存首次 true。 */ () => enabled
    const claim = f.host.claimDispatch
    f.host.claimDispatch = /** 保留原唯一 claim，然后在写入前撤销。 */ async (...args) => {
      await claim(...args)
      enabled = false
    }
    try {
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.received(), '')
      assert.equal(f.state.claims, 1)
      enabled = true
      await assert.rejects(f.adapter.dispatch(f.input()), { code: 'attempt_already_observed' })
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus native Agent-not-ready remains an error with direct execution disabled',
  /** 对话沿用原生 Agent 门禁，测试 listener 的拒绝不能退化为 pane.run 或其它 shell 重试。 */ async () => {
    const f = await fixture('ipc', 'agent.send', { target: '3', text: 'synthetic', strict: true })
    const response = {
      id: f.binding.native_request_id,
      error: { code: 'agent_not_ready', message: 'synthetic shell pane' }
    }
    f.respond(
      /** 合成原生端明确拒绝普通 shell pane，没有发送文本到任何真实终端。 */ (socket) =>
        socket.end(JSON.stringify(response) + '\n')
    )
    try {
      const result = await f.adapter.dispatch(f.input())
      assert.deepEqual(result.native_response, response)
      assert.equal(f.state.responses, 1)
      assert.equal(JSON.parse(f.received()).method, 'agent.send')
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)
