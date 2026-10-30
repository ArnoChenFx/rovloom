/** 统一目录预检与本机最终写入的直接终端执行开关；不替代原生授权或操作系统隔离。 */
import { fail } from '../wire/index.js'

export type TerminalExecutionKind = 'luvus' | 'herdr'

const direct = Object.freeze({
  luvus: new Set([
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
  ]),
  herdr: new Set(['pane.send_text', 'pane.send_keys', 'pane.send_input', 'pane.link.activate'])
})

const launches = Object.freeze({
  luvus: new Set([
    'agent.start',
    'agent.resume',
    'agent.fork',
    'workspace.new',
    'workspace.open',
    'node.new',
    'node.open',
    'tab.new',
    'pane.split',
    'pane.report_session',
    'agent.report'
  ]),
  herdr: new Set([
    'agent.start',
    'workspace.create',
    'tab.create',
    'pane.split',
    'pane.report_agent',
    'pane.report_agent_session'
  ])
})

/** 本机配置省略该项时的默认值：开启。只有字面量 false 关闭；Gateway 尚未收到报告的“未知”不受此默认影响，仍按关闭处理。 */
export const TERMINAL_EXECUTION_DEFAULT = true

/** 把本机配置值落成最终布尔；所有读取点共用，避免各处各自解释“省略”。 */
export function resolveTerminalExecution(value: boolean | undefined): boolean {
  return value ?? TERMINAL_EXECUTION_DEFAULT
}

/** 读取当前有效开关：宿主接缝（每次现读）优先，否则取本地配置并解析默认值。 */
export function currentTerminalExecution(seam: (() => boolean) | undefined, config: boolean | undefined): boolean {
  return seam ? seam() : resolveTerminalExecution(config)
}

/** 仅接受显式布尔值；省略取默认值，字符串、数字和对象既不能隐式开启也不能隐式关闭。 */
export function pinTerminalExecution(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') {
    fail('terminal_execution_config_invalid')
  }
  return resolveTerminalExecution(value)
}

/** 判断直接或宽松终端输入及可启动程序的请求；严格 Agent 文本对话保留原生门禁。 */
export function requiresTerminalExecution(
  kind: TerminalExecutionKind,
  method: string,
  params: Readonly<Record<string, unknown>> = {}
): boolean {
  if (direct[kind].has(method)) {
    return true
  }
  // 上游省略 strict 等同 false；关闭时仅接受调用者原请求中显式的严格文本对话。
  if (kind === 'luvus' && (method === 'agent.send' || method === 'agent.prompt')) {
    return params.strict !== true
  }
  // task.add 保存的 gate 会被后续 task.done 通过 shell 执行；空白 gate 不会运行。
  if (kind === 'luvus' && method === 'task.add') {
    return typeof params.gate === 'string' && params.gate.trim().length > 0
  }
  // task.start 的 agent 是可自定义的 executable/argv，不能当作受信 Agent kind。
  if (kind === 'luvus' && method === 'task.start') {
    return typeof params.agent === 'string' && params.agent.trim().length > 0
  }
  if (!launches[kind].has(method)) {
    return false
  }
  for (const key of ['command', 'args', 'env', 'resume_command', 'resume_argv']) {
    const value = params[key]
    if (value === undefined || value === null || value === '') {
      continue
    }
    if (typeof value === 'object' && Object.keys(value).length === 0) {
      continue
    }
    return true
  }
  return false
}

/** 目录可对完整请求使用同一判定；参数敏感方法仍可描述，其具体请求必须再经预检。 */
export function terminalExecutionAllowed(
  kind: TerminalExecutionKind,
  method: string,
  params: Readonly<Record<string, unknown>>,
  enabled: boolean = false
): boolean {
  return enabled === true || !requiresTerminalExecution(kind, method, params)
}

/** 目录保留参数敏感方法的合法变体；它只描述本地限制，不生成执行许可或改写请求。 */
export function terminalExecutionCatalog(kind: TerminalExecutionKind, method: string, enabled: boolean | undefined) {
  const strictText = kind === 'luvus' && (method === 'agent.send' || method === 'agent.prompt')
  const parameterSensitive =
    launches[kind].has(method) || strictText || (kind === 'luvus' && (method === 'task.add' || method === 'task.start'))
  const related = direct[kind].has(method) || parameterSensitive
  return {
    visible: terminalExecutionAllowed(kind, method, { strict: true }, enabled === true),
    ...(related
      ? {
          details: {
            local_state: enabled === undefined ? 'unknown' : enabled ? 'enabled' : 'disabled',
            ...(parameterSensitive ? { request_parameters_checked: true } : {}),
            ...(strictText && enabled !== true ? { requires_explicit_strict: true } : {})
          }
        }
      : {})
  }
}

/** 本机只在同步边界接受当前显式许可；不签发 dispatch permit、不清除持久 claim、不改变结果。 */
export function assertTerminalExecutionAllowed(
  kind: TerminalExecutionKind,
  request: Readonly<{ method?: unknown; params?: unknown }>,
  enabled: boolean = false
): void {
  if (
    typeof request.method !== 'string' ||
    !request.params ||
    typeof request.params !== 'object' ||
    Array.isArray(request.params)
  ) {
    fail('terminal_execution_request_invalid')
  }
  if (!terminalExecutionAllowed(kind, request.method, request.params as Record<string, unknown>, enabled)) {
    fail('terminal_execution_disabled')
  }
}
