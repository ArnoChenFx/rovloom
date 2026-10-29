/** 固定 Luvus 0.14.3 的窗口、pane 与 Agent 普通操作及参数子集；不发行凭据或把 generic schema 冒称完整。 */
import type { NativeMethodContract } from './contract/index.js'
import { LUVUS_OPERATION_READ, LUVUS_OPERATION_WRITE, luvusMethod } from './methods.js'
import { LuvusAdapterError } from './types.js'
import { boundedJson, fields, object } from '../../wire/index.js'

export type LuvusOperationDescriptor = Readonly<{
  native: Readonly<NativeMethodContract>
  effect: 'read' | 'execute'
  native_parameter_schema: 'conditional_branch' | 'generic_params_only'
}>
const conditional = new Set(['pane.list', 'agent.prompt', 'agent.send', 'agent.wait', 'agent.keys'])
const operations = new Map<string, LuvusOperationDescriptor>()
for (const groups of [LUVUS_OPERATION_READ, LUVUS_OPERATION_WRITE]) {
  for (const methods of Object.values(groups)) {
    for (const method of methods) {
      const native = luvusMethod(method)!
      operations.set(
        method,
        Object.freeze({
          native,
          effect: native.access === 'read' ? 'read' : 'execute',
          native_parameter_schema: conditional.has(method) ? 'conditional_branch' : 'generic_params_only'
        })
      )
    }
  }
}
export const LUVUS_OPERATION_METHODS = Object.freeze([...operations.keys()])

/** 返回固定普通接口事实；未知方法、token/admin 和集成伪状态上报不在此清单；终端输入仍须本机显式开关。 */
export function luvusOperationDescriptor(method: string): LuvusOperationDescriptor | undefined {
  return operations.get(method)
}

/** UI 自动选原协议已存在的验证模式；generic 保持事实，通过显式实际本机 Owner 的现有 raw 路径执行。 */
export function luvusOperationValidation(method: string): 'strict' | 'raw-contract' {
  const descriptor = operations.get(method)
  if (!descriptor) {
    throw new LuvusAdapterError('luvus_operation_unreviewed')
  }
  return descriptor.native_parameter_schema === 'conditional_branch' ? 'strict' : 'raw-contract'
}

/** 只返回固定安全错误码，参数值、路径、prompt 和原生输出不进入错误。 */
function invalid(): never {
  throw new LuvusAdapterError('luvus_operation_params_invalid')
}

/** 文本只限定本操作所需的有界子集，不执行字符串、展开路径或补读用户配置。 */
function text(value: unknown, maximum: number, empty = false): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.length) ||
    Buffer.byteLength(value) > maximum ||
    value.includes('\0')
  ) {
    invalid()
  }
}

/** 窗口/标签索引保留官方的零基/一基约定，不把显示位置混作稳定 workspace_id/tab_id。 */
function index(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 4_294_967_295) {
    invalid()
  }
}

/** 稳定 ID 与位置选择器互斥；读取可显式省略，写入不得隐式选择当前对象。 */
function selector(params: Record<string, unknown>, position: 'workspace' | 'tab', required: boolean): void {
  const stable = position + '_id'
  if (params[position] !== undefined && params[stable] !== undefined) {
    invalid()
  }
  if (params[position] !== undefined) {
    const value = params[position]
    if (typeof value === 'string' && !/^[0-9]+$/.test(value)) {
      invalid()
    }
    index(typeof value === 'string' ? Number(value) : value, position === 'workspace' ? 0 : 1)
  } else if (params[stable] !== undefined) {
    text(params[stable], 256)
  } else if (required) {
    invalid()
  }
}

/** 原生 mutation guard 使用事件 sequence；仅安全整数可精确穿过 JSON，不把旧 revision 自动改成当前值。 */
function mutationRevision(params: Record<string, unknown>): void {
  if (
    params.if_revision !== undefined &&
    (!Number.isSafeInteger(params.if_revision) || (params.if_revision as number) < 0)
  ) {
    invalid()
  }
}

/** pane 显式选择原生正 u32 ID；terminal_id 另作真实 PTY 生命周期 fence。 */
function pane(value: unknown): void {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 4_294_967_295) {
    invalid()
  }
}

/** 只接受官方四个 Agent 状态，等待仍由原生决定是否真正经过新状态或已经超时。 */
function states(value: unknown): void {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 4 ||
    new Set(value).size !== value.length ||
    value.some(
      /** 状态不能由调用端自造为完成或伪造响应。 */ (state) => !['idle', 'working', 'blocked', 'done'].includes(state)
    )
  ) {
    invalid()
  }
}

/** 逐键复用官方 agent.keys 的普通快捷键语法，不接受脚本文本、控制字节或任意终端命令。 */
function agentKey(value: unknown): void {
  if (typeof value !== 'string') {
    invalid()
  }
  if (
    /^(enter|return|cr|esc|escape|tab|space|backspace|bs|delete|del|up|down|right|left|home|end|pageup|pgup|pagedown|pgdn)$/i.test(
      value
    ) ||
    /^(ctrl\+|c-)[a-z]$/i.test(value)
  ) {
    return
  }
  const point = value.codePointAt(0)
  if (
    Array.from(value).length !== 1 ||
    point === undefined ||
    point < 32 ||
    (point >= 127 && point <= 159) ||
    (point >= 0xd800 && point <= 0xdfff)
  ) {
    invalid()
  }
}

/** 对普通操作执行明确参数检查；这只是已审 adapter 子集，官方 generic 参数覆盖状态继续保留。 */
export function validateLuvusOperationParams(method: string, input: unknown): void {
  if (!operations.has(method)) {
    throw new LuvusAdapterError('luvus_operation_unreviewed')
  }
  try {
    const params = object(JSON.parse(boundedJson(input)))
    if (
      ['session.snapshot', 'workspace.list', 'tab.list', 'pane.current', 'agent.list', 'agent.sessions'].includes(
        method
      )
    ) {
      fields(params, [])
    } else if (method === 'workspace.new' || method === 'tab.new') {
      fields(params, [], ['if_revision'])
      mutationRevision(params)
    } else if (method === 'workspace.open') {
      fields(params, ['path'], ['focus', 'if_revision'])
      text(params.path, 4096)
      if (params.focus !== undefined && typeof params.focus !== 'boolean') {
        invalid()
      }
      mutationRevision(params)
    } else if (['workspace.get', 'workspace.focus', 'workspace.close', 'workspace.rename'].includes(method)) {
      fields(params, method === 'workspace.rename' ? ['name'] : [], [
        'workspace',
        'workspace_id',
        ...(method === 'workspace.get' ? [] : ['if_revision'])
      ])
      selector(params, 'workspace', method !== 'workspace.get')
      mutationRevision(params)
      if (method === 'workspace.rename') {
        text(params.name, 256, true)
      }
    } else if (method === 'tab.get') {
      fields(params, [], ['workspace', 'workspace_id', 'tab', 'tab_id'])
      selector(params, 'workspace', false)
      selector(params, 'tab', false)
    } else if (['tab.focus', 'tab.close', 'tab.rename'].includes(method)) {
      fields(params, method === 'tab.rename' ? ['name'] : [], ['tab', 'tab_id', 'if_revision'])
      selector(params, 'tab', true)
      mutationRevision(params)
      if (method === 'tab.rename') {
        text(params.name, 256, true)
      }
    } else if (method === 'pane.list') {
      fields(params, [], ['all_tabs'])
      if (params.all_tabs !== undefined && typeof params.all_tabs !== 'boolean') {
        invalid()
      }
    } else if (['pane.get', 'pane.status', 'pane.focus', 'pane.close', 'pane.rename'].includes(method)) {
      fields(params, method === 'pane.rename' ? ['pane', 'name'] : ['pane'])
      pane(params.pane)
      if (method === 'pane.rename') {
        text(params.name, 256, true)
      }
    } else if (method === 'pane.run') {
      fields(params, ['pane', 'command'])
      pane(params.pane)
      text(params.command, 65_536)
    } else if (method === 'wait.output') {
      fields(params, ['pane', 'match'], ['timeout_s'])
      pane(params.pane)
      text(params.match, 4096)
      if (
        params.timeout_s !== undefined &&
        (typeof params.timeout_s !== 'number' ||
          !Number.isFinite(params.timeout_s) ||
          params.timeout_s < 0 ||
          params.timeout_s > 3600)
      ) {
        invalid()
      }
    } else if (method === 'pane.split') {
      fields(params, ['pane'], ['direction'])
      pane(params.pane)
      if (params.direction !== undefined && !['auto', 'right', 'down'].includes(params.direction as string)) {
        invalid()
      }
    } else if (['agent.get', 'agent.explain'].includes(method)) {
      fields(params, ['target'])
      text(params.target, 128)
    } else if (method === 'agent.read' || method === 'pane.read') {
      const selector = method === 'pane.read' ? 'pane' : 'target'
      fields(params, [selector], method === 'pane.read' ? ['lines'] : ['lines', 'source'])
      if (selector === 'pane') {
        pane(params.pane)
      } else {
        text(params.target, 128)
      }
      if (params.lines !== undefined) {
        index(params.lines, 1)
        if ((params.lines as number) > 1000) {
          invalid()
        }
      }
      if (params.source !== undefined && !['visible', 'recent'].includes(params.source as string)) {
        invalid()
      }
    } else if (method === 'agent.resume') {
      fields(params, ['session_id'])
      text(params.session_id, 256)
    } else if (method === 'agent.start') {
      fields(params, ['name', 'kind'], ['pane', 'anchor', 'direction', 'timeout_s', 'args'])
      for (const value of [params.name, params.kind]) {
        if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
          invalid()
        }
      }
      if (params.pane !== undefined && params.anchor !== undefined) {
        invalid()
      }
      if (params.pane !== undefined) {
        pane(params.pane)
      }
      if (params.anchor !== undefined) {
        pane(params.anchor)
      }
      if (params.direction !== undefined && !['auto', 'right', 'down'].includes(params.direction as string)) {
        invalid()
      }
      if (
        params.timeout_s !== undefined &&
        (typeof params.timeout_s !== 'number' ||
          !Number.isFinite(params.timeout_s) ||
          params.timeout_s < 0 ||
          params.timeout_s > 3600)
      ) {
        invalid()
      }
      if (params.args !== undefined) {
        if (!Array.isArray(params.args) || params.args.length > 128) {
          invalid()
        }
        for (const arg of params.args) {
          text(arg, 16_384, true)
        }
      }
    } else if (method === 'agent.prompt' || method === 'agent.send') {
      fields(
        params,
        ['target', 'text'],
        method === 'agent.prompt' ? ['terminal_id', 'strict', 'wait', 'until', 'timeout_s'] : ['terminal_id', 'strict']
      )
      text(params.target, 128)
      text(params.text, 262_144)
      if (
        params.terminal_id !== undefined &&
        (typeof params.terminal_id !== 'string' || !/^[0-9a-f]{32}$/.test(params.terminal_id))
      ) {
        invalid()
      }
      for (const key of ['strict', 'wait']) {
        if (params[key] !== undefined && typeof params[key] !== 'boolean') {
          invalid()
        }
      }
      if (params.until !== undefined) {
        states(params.until)
      }
      if (
        params.timeout_s !== undefined &&
        (typeof params.timeout_s !== 'number' ||
          !Number.isFinite(params.timeout_s) ||
          params.timeout_s < 0 ||
          params.timeout_s > 3600)
      ) {
        invalid()
      }
      if ((params.until !== undefined || params.timeout_s !== undefined) && params.wait !== true) {
        invalid()
      }
    } else if (method === 'agent.keys') {
      fields(params, ['target', 'keys'], ['terminal_id', 'if_content_revision'])
      text(params.target, 128)
      if (!Array.isArray(params.keys) || !params.keys.length) {
        invalid()
      }
      for (const key of params.keys) {
        agentKey(key)
      }
      if ((params.terminal_id === undefined) !== (params.if_content_revision === undefined)) {
        invalid()
      }
      if (
        params.terminal_id !== undefined &&
        (typeof params.terminal_id !== 'string' || !/^[0-9a-f]{32}$/.test(params.terminal_id))
      ) {
        invalid()
      }
      if (params.if_content_revision !== undefined) {
        index(params.if_content_revision, 0)
      }
    } else if (method === 'agent.wait') {
      fields(params, ['pane'], ['status', 'statuses', 'timeout_s'])
      pane(params.pane)
      if ((params.status === undefined) === (params.statuses === undefined)) {
        invalid()
      }
      states(params.statuses ?? [params.status])
      if (
        params.timeout_s !== undefined &&
        (typeof params.timeout_s !== 'number' ||
          !Number.isFinite(params.timeout_s) ||
          params.timeout_s < 0 ||
          params.timeout_s > 3600)
      ) {
        invalid()
      }
    }
  } catch {
    invalid()
  }
}
