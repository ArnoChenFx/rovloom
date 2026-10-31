/** 使用合成请求盘点直接终端入口，验证默认关闭、配置类型与目录/执行判定一致。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertTerminalExecutionAllowed,
  TERMINAL_EXECUTION_DEFAULT,
  currentTerminalExecution,
  pinTerminalExecution,
  resolveTerminalExecution,
  requiresTerminalExecution,
  terminalExecutionAllowed,
  terminalExecutionCatalog
} from '../../src/connector/terminal-execution.js'

const direct = {
  luvus: [
    'pane.run',
    'pane.send_input',
    'terminal.backend.create',
    'terminal.backend.control',
    'terminal.backend.type_literal',
    'terminal.backend.paste_text',
    'terminal.backend.submit_text',
    'terminal.backend.send_key',
    'module.action.invoke',
    'agent.report',
    'pane.report_session',
    'pane.report_event',
    'agent.keys',
    'task.done',
    'task.retry'
  ],
  herdr: ['pane.send_text', 'pane.send_keys', 'pane.send_input', 'pane.link.activate']
} as const

test(
  'current terminal execution reads the seam first and otherwise resolves the config default',
  /** 接缝每次现读且优先；无接缝时省略取默认开启，显式 false 仍关闭（目录上报与最终写入共用）。 */ () => {
    let seam = true
    const read = /** 模拟宿主接缝的当前值。 */ () => seam
    assert.equal(currentTerminalExecution(read, false), true)
    seam = false
    assert.equal(currentTerminalExecution(read, true), false)
    assert.equal(currentTerminalExecution(undefined, undefined), true)
    assert.equal(currentTerminalExecution(undefined, true), true)
    assert.equal(currentTerminalExecution(undefined, false), false)
  }
)

test(
  'terminal execution defaults on and accepts only a literal local boolean',
  /** 省略取默认开启；字符串或其它真值既不能开启也不能关闭。 */ () => {
    assert.equal(TERMINAL_EXECUTION_DEFAULT, true)
    assert.equal(pinTerminalExecution(undefined), true)
    assert.equal(resolveTerminalExecution(undefined), true)
    assert.equal(resolveTerminalExecution(false), false)
    assert.equal(resolveTerminalExecution(true), true)
    assert.equal(pinTerminalExecution(false), false)
    assert.equal(pinTerminalExecution(true), true)
    for (const value of ['true', 1, null, {}, [], Promise.resolve(true)]) {
      assert.throws(
        /** 无效本地配置保持拒绝。 */ () => pinTerminalExecution(value),
        /terminal_execution_config_invalid/
      )
    }
  }
)

for (const kind of ['luvus', 'herdr'] as const) {
  test(
    `${kind} alternate terminal inputs share directory and final execution denial`,
    /** 同一合成方法逐项经过目录判定和实际写入守卫。 */ () => {
      for (const method of direct[kind]) {
        const request = { method, params: {} }
        assert.equal(requiresTerminalExecution(kind, method), true)
        assert.equal(terminalExecutionAllowed(kind, method, {}), false)
        assert.equal(terminalExecutionAllowed(kind, method, {}, false), false)
        assert.throws(
          /** 隐藏目录之外，实际派发边界仍拒绝。 */ () => assertTerminalExecutionAllowed(kind, request),
          /terminal_execution_disabled/
        )
        assert.doesNotThrow(
          /** 显式开启仅通过本地开关，原 Wire 与原生权限仍由适配器检查。 */ () =>
            assertTerminalExecutionAllowed(kind, request, true)
        )
      }
    }
  )

  test(
    `${kind} ordinary Agent conversation and reads retain independent authorization`,
    /** 开关不声称限制 Agent 自身工具；不会把普通对话归类为裸 shell。 */ () => {
      for (const method of [
        'agent.prompt',
        'agent.read',
        'pane.read',
        'ping',
        ...(kind === 'luvus' ? ['agent.send', 'terminal.backend.capture'] : ['agent.send_keys'])
      ]) {
        assert.equal(
          terminalExecutionAllowed(kind, method, { target: 'owned-agent', text: 'synthetic', strict: true }),
          true
        )
      }
      assert.equal(terminalExecutionAllowed(kind, 'agent.start', { name: 'owned', kind: 'opencode', args: [] }), true)
      if (kind === 'herdr') {
        assert.equal(terminalExecutionAllowed(kind, 'agent.send_keys', { target: 'owned-agent', keys: ['a'] }), true)
      }
    }
  )
}

for (const method of ['agent.send', 'agent.prompt']) {
  test(
    `Luvus ${method} needs explicit strict true while direct execution is disabled`,
    /** 省略与 false 保留上游宽松语义并受开关约束；严格请求保持可用，不能由写入层补参。 */ () => {
      for (const strict of [undefined, false]) {
        const params = { target: 'owned-agent', text: 'synthetic', ...(strict === undefined ? {} : { strict }) }
        assert.equal(terminalExecutionAllowed('luvus', method, params), false)
        assert.equal(terminalExecutionAllowed('luvus', method, params, true), true)
        assert.equal(terminalExecutionAllowed('herdr', 'agent.prompt', params), true)
      }
      assert.equal(
        terminalExecutionAllowed('luvus', method, { target: 'owned-agent', text: 'synthetic', strict: true }),
        true
      )
    }
  )
}

test(
  'Luvus task gates and custom worker commands share the terminal switch',
  /** 保存 shell gate、触发旧 gate 与自定义 worker 命令各自形成执行入口，不能仅检查显式 pane 输入。 */ () => {
    for (const gate of [undefined, null, '', ' \n\t ']) {
      assert.equal(terminalExecutionAllowed('luvus', 'task.add', { title: 'synthetic', gate }), true)
    }
    for (const gate of ['printf synthetic', '\n printf synthetic \n']) {
      assert.equal(terminalExecutionAllowed('luvus', 'task.add', { title: 'synthetic', gate }), false)
      assert.equal(terminalExecutionAllowed('luvus', 'task.add', { title: 'synthetic', gate }, true), true)
    }
    assert.equal(terminalExecutionAllowed('luvus', 'task.start', { id: 'owned' }), true)
    assert.equal(terminalExecutionAllowed('luvus', 'task.start', { id: 'owned', agent: '/bin/sh -c true' }), false)
    assert.equal(terminalExecutionAllowed('luvus', 'task.done', { id: 'owned' }), false)
    assert.equal(terminalExecutionAllowed('luvus', 'task.retry', { id: 'owned' }), false)
    assert.equal(terminalExecutionAllowed('luvus', 'task.update', { id: 'owned', note: 'synthetic' }), true)
  }
)

for (const [kind, method] of [
  ['luvus', 'agent.start'],
  ['luvus', 'workspace.new'],
  ['luvus', 'node.new'],
  ['luvus', 'tab.new'],
  ['luvus', 'pane.split'],
  ['herdr', 'agent.start'],
  ['herdr', 'workspace.create'],
  ['herdr', 'tab.create'],
  ['herdr', 'pane.split'],
  ['herdr', 'pane.report_agent'],
  ['herdr', 'pane.report_agent_session']
] as const) {
  test(
    `${kind}/${method} cannot introduce commands through launch or restore parameters`,
    /** 任意 argv、环境及恢复命令都能等价启动程序，不能用方法名绕过关闭状态。 */ () => {
      for (const params of [
        { command: ['/bin/sh'] },
        { args: ['--eval', 'synthetic'] },
        { env: { BASH_ENV: '/synthetic/startup' } },
        { resume_argv: ['sh', '-c', 'printf synthetic'] },
        { resume_command: 'printf synthetic' }
      ]) {
        assert.equal(terminalExecutionAllowed(kind, method, params), false)
        assert.throws(
          /** 参数预检与实际派发拒绝相同候选。 */ () => assertTerminalExecutionAllowed(kind, { method, params }),
          /terminal_execution_disabled/
        )
      }
    }
  )
}

test('herdr-core 关闭开关时仍列出控制档但标成不可用，读历史按输入处理', () => {
  // 关闭：控制档列出但不可用，控制端能提前知道后端有哪些能力。
  assert.deepEqual(terminalExecutionCatalog('herdr-core', 'terminal.send', false), {
    available: false,
    listed: true,
    visible: false,
    details: { local_state: 'disabled' }
  })
  assert.deepEqual(terminalExecutionCatalog('herdr-core', 'terminal.run', false), {
    available: false,
    listed: true,
    visible: false,
    details: { local_state: 'disabled' }
  })
  // 打开：同一批方法可用。
  assert.equal(terminalExecutionCatalog('herdr-core', 'terminal.send', true).available, true)
  assert.equal(terminalExecutionCatalog('herdr-core', 'terminal.run', true).available, true)
  // 读取不受开关影响，但 lines>0 需要开关（缝合会向程序发滚轮输入）。
  assert.equal(terminalExecutionCatalog('herdr-core', 'terminal.read', false).available, true)
  assert.deepEqual(terminalExecutionCatalog('herdr-core', 'terminal.read', false).details, {
    local_state: 'disabled',
    request_parameters_checked: true
  })
  assert.equal(requiresTerminalExecution('herdr-core', 'terminal.read', { lines: 0 }), false)
  assert.equal(requiresTerminalExecution('herdr-core', 'terminal.read', { lines: 50 }), true)
  assert.equal(requiresTerminalExecution('herdr-core', 'terminal.read', {}), false)
  // 观察档与有条件档不受影响。
  assert.deepEqual(terminalExecutionCatalog('herdr-core', 'server.status', false), {
    available: true,
    listed: true,
    visible: true
  })
  // 其它 kind 的关闭语义不变：不列出、不可用。
  assert.equal(terminalExecutionCatalog('luvus', 'pane.run', false).listed, false)
  assert.equal(terminalExecutionCatalog('herdr', 'pane.send_text', false).listed, false)
})
