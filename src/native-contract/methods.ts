// Luvus 已接入方法的静态表：不在表中的方法一律拒绝，schema 通过只代表参数合法，不代表允许调用。
import type { NativeMethodContract } from './types.js'

const read = (method: string, scope: string): NativeMethodContract =>
  Object.freeze({ method, access: 'read', scope, idempotent: true })
const write = (method: string, scope: string): NativeMethodContract =>
  Object.freeze({ method, access: 'write', scope, idempotent: false })

/** UI 操作清单中的普通读方法，按 scope 分组（窗口、pane 与 Agent）。 */
export const LUVUS_OPERATION_READ = Object.freeze({
  read: ['session.snapshot', 'wait.output'],
  workspace: [
    'workspace.list',
    'workspace.get',
    'tab.list',
    'tab.get',
    'pane.list',
    'pane.get',
    'pane.current',
    'pane.status',
    'pane.read'
  ],
  agent: ['agent.list', 'agent.get', 'agent.explain', 'agent.read', 'agent.sessions', 'agent.wait']
} as const)

/** UI 操作清单中的普通写方法。 */
export const LUVUS_OPERATION_WRITE = Object.freeze({
  workspace: [
    'workspace.new',
    'workspace.open',
    'workspace.focus',
    'workspace.rename',
    'workspace.close',
    'tab.new',
    'tab.focus',
    'tab.rename',
    'tab.close',
    'pane.split',
    'pane.focus',
    'pane.rename',
    'pane.close',
    'pane.run'
  ],
  agent: ['agent.start', 'agent.prompt', 'agent.send', 'agent.keys', 'agent.resume']
} as const)

/** 已审三项普通编排 RPC（独立 provider）及终端开关/编排相关的其余单请求 RPC；流与控制方法不在表中。 */
const OTHER_READ = Object.freeze({
  orchestration: ['automation.list', 'task.list', 'task.get'],
  terminal: [
    'terminal.backend.inventory',
    'terminal.backend.snapshot',
    'terminal.backend.validate',
    'terminal.backend.processes',
    'terminal.backend.capture'
  ]
} as const)
const OTHER_WRITE = Object.freeze({
  workspace: ['pane.send_input'],
  orchestration: ['task.add', 'task.update', 'task.start', 'task.done', 'task.retry', 'task.delete'],
  terminal: [
    'terminal.backend.create',
    'terminal.backend.close',
    'terminal.backend.type_literal',
    'terminal.backend.paste_text',
    'terminal.backend.submit_text',
    'terminal.backend.send_key',
    'terminal.backend.set_title',
    'terminal.backend.notify'
  ]
} as const)

const table = new Map<string, NativeMethodContract>()
for (const [groups, build] of [
  [LUVUS_OPERATION_READ, read],
  [OTHER_READ, read],
  [LUVUS_OPERATION_WRITE, write],
  [OTHER_WRITE, write]
] as const) {
  for (const [scope, methods] of Object.entries(groups)) {
    for (const method of methods) {
      table.set(method, build(method, scope))
    }
  }
}

/** 返回表中的原生契约；它必须与实际安装契约广告的方法提示逐字段一致。 */
export function luvusMethod(method: string): NativeMethodContract | undefined {
  return table.get(method)
}

/** 表中全部方法名，仅供测试和目录使用。 */
export const LUVUS_TABLE_METHODS: readonly string[] = Object.freeze([...table.keys()])
