/** 统一目录预检与本机最终写入的直接终端执行开关；不替代原生授权或操作系统隔离。 */
import { fail } from '../wire/index.js'
import { HERDR_CORE_METHODS } from './herdr-core/methods.js'

export type TerminalExecutionKind = 'luvus' | 'herdr' | 'herdr-core'

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
  herdr: new Set(['pane.send_text', 'pane.send_keys', 'pane.send_input', 'pane.link.activate']),
  // herdr-core 的输入与控制档从同一份已审核档位表派生，不按方法名前缀猜；
  // terminal.run 是宿主级的任意程序能力，本阶段随开关开放，启动即执行，必须受同一开关约束。
  'herdr-core': new Set([
    ...Object.entries(HERDR_CORE_METHODS)
      .filter(/** 只有审核为 control 的方法才进入直接输入集合。 */ ([, tier]) => tier === 'control')
      .map(/** 方法名本身即审核表键。 */ ([method]) => method),
    'terminal.run'
  ])
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
  ]),
  // 宿主级的 terminal.run 等本来就不进目录；这里保持空集，避免把任意命令当成可启动程序。
  'herdr-core': new Set<string>()
})

/** 仅接受显式布尔值；省略保持关闭，字符串、数字和对象均不能隐式开启。 */
export function pinTerminalExecution(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') {
    fail('terminal_execution_config_invalid')
  }
  return value === true
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
  // herdr-core 读历史会让 core 用鼠标滚轮「缝合」全屏程序（向程序发输入），所以按输入处理；
  // lines=0 只读屏幕，不需要开关。
  if (kind === 'herdr-core' && method === 'terminal.read') {
    return typeof params.lines === 'number' && params.lines > 0
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

/**
 * 关闭开关时仍要列出并标成不可用的 kind：控制端需要知道后端有哪些能力，
 * 而不是只看到一份「能用的」清单。调用仍会在 Gateway 登记前与 Connector 写入前被拒。
 */
const LISTS_WHEN_DISABLED: ReadonlySet<TerminalExecutionKind> = new Set(['herdr-core'])

/** 目录保留参数敏感方法的合法变体；它只描述本地限制，不生成执行许可或改写请求。 */
export function terminalExecutionCatalog(kind: TerminalExecutionKind, method: string, enabled: boolean | undefined) {
  const strictText = kind === 'luvus' && (method === 'agent.send' || method === 'agent.prompt')
  const parameterSensitive =
    launches[kind].has(method) ||
    strictText ||
    (kind === 'luvus' && (method === 'task.add' || method === 'task.start')) ||
    // herdr-core 的 terminal.read 只有 lines>0 需要开关，目录无法按调用参数判断。
    (kind === 'herdr-core' && method === 'terminal.read')
  const related = direct[kind].has(method) || parameterSensitive
  const available = terminalExecutionAllowed(kind, method, { strict: true }, enabled === true)
  return {
    available,
    // listed：目录里是否出现；available：现在能不能调用。
    listed: available || (related && LISTS_WHEN_DISABLED.has(kind)),
    visible: available,
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
