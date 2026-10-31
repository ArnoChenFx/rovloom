/**
 * herdr-core 的登记前参数预检：与 Wire 编码阶段**同序同规则**（参数形状 → 逐方法复核 → 审核 schema），
 * 拒绝一律抛 `NativeRequestPreflightError`，在登记之前发生，因此不会留下调用记录。
 * 诊断只含固定路径与固定规则，不含请求值、字段原文或原生错误文本。
 */
import type { ParameterDiagnostic, ParameterIssueRule } from '../../mcp/diagnostic.js'
import { object } from '../../wire/index.js'
import { GatewayError } from '../../contracts.js'
import type { JsonObject } from '../../wire/types.js'
import { NativeRequestPreflightError } from '../preflight.js'
import { HERDR_CORE_BLOCKED_PARAMS, HERDR_CORE_SYNTHETIC_METHODS, reviewHerdrCoreParams } from './methods.js'
import { herdrCoreParameterHelp } from './overlay.js'
import type { HerdrCoreContract } from './schema.js'

type Issue = ParameterDiagnostic['issues'][number]

const MAX_ISSUES = 8
const FENCE = ['core_id', 'created_ms'] as const
/** 可能被 `herdr_core_text_too_large` 指的文本字段；用于给出固定路径。 */
const TEXT_FIELDS = ['text', 'data', 'line', 'argv', 'value', 'edits'] as const
/** 文本字段缺省时的路径：core 侧对「缺字段」与「超限」用同一个码，诊断仍按方法说清是哪个参数。 */
const TEXT_FIELD_FOR_METHOD: Readonly<Record<string, string>> = Object.freeze({
  'terminal.send': '/text',
  'terminal.put': '/data',
  'file.write': '/data',
  'file.edit': '/edits',
  'machine.exec': '/line',
  'terminal.run': '/line',
  'doc.set': '/value'
})

/** 被拒绝的参数名：只在请求的键里找，回显键名本身就是规则的一部分。 */
function blockedKey(method: string, params: Record<string, unknown>): string | undefined {
  const keys = Object.keys(params)
  const blocked = keys.find((key) => HERDR_CORE_BLOCKED_PARAMS.includes(key))
  if (blocked !== undefined) {
    return blocked
  }
  if (method !== 'terminal.run') {
    return keys.find((key) => key === 'parent' || key === 'parent_created_ms')
  }
  return undefined
}

/** 终端类字段的路径：请求里实际出现的那一个，避免把 parent/address 报成 terminal。 */
function terminalField(params: Record<string, unknown>): string {
  for (const field of ['terminal', 'parent', 'address'] as const) {
    if (Object.hasOwn(params, field)) {
      return '/' + field
    }
  }
  return '/terminal'
}

function textField(method: string, params: Record<string, unknown>): string {
  for (const field of TEXT_FIELDS) {
    if (Object.hasOwn(params, field)) {
      return '/' + field
    }
  }
  return TEXT_FIELD_FOR_METHOD[method] ?? '/params'
}

/** 把逐方法复核的固定码投影成固定的路径/规则；表外码只给根路径。 */
function issuesFor(method: string, params: Record<string, unknown>, code: string): Issue[] {
  switch (code) {
    case 'herdr_core_param_blocked': {
      const key = blockedKey(method, params)
      return [{ path: key === undefined ? '/params' : '/' + key, rule: 'invalid_value' }]
    }
    case 'herdr_core_terminal_address_unsupported': {
      // 字段缺失与格式不符是两回事：缺失报 required，别让调用方去猜是不是格式问题。
      const path = terminalField(params)
      return [{ path, rule: Object.hasOwn(params, path.slice(1)) ? 'pattern' : 'required' }]
    }
    case 'herdr_core_terminal_fence_required': {
      const missing = FENCE.filter((field) => params[field] === undefined)
      return missing.length
        ? missing.map((field) => ({ path: '/' + field, rule: 'required' as const }))
        : [{ path: '/params', rule: 'invalid_value' }]
    }
    case 'herdr_core_terminal_fence_invalid': {
      const coreId = params.core_id
      if (typeof coreId !== 'string' || !/^[a-f0-9]{8,64}$/u.test(coreId)) {
        return [{ path: '/core_id', rule: 'pattern' }]
      }
      const created = params.created_ms
      return [
        {
          path: '/created_ms',
          rule: typeof created === 'number' && Number.isSafeInteger(created) ? 'range' : 'invalid_value'
        }
      ]
    }
    case 'herdr_core_core_id_required':
      return [{ path: '/core_id', rule: 'required' }]
    case 'herdr_core_core_id_invalid':
      return [{ path: '/core_id', rule: 'pattern' }]
    case 'herdr_core_timeout_invalid':
      return [{ path: '/timeout', rule: 'invalid_value' }]
    case 'herdr_core_timeout_exceeds_limit':
      return [{ path: '/timeout', rule: 'range' }]
    case 'herdr_core_text_too_large': {
      const path = textField(method, params)
      // 缺字段时 core 侧同样是这个码；诊断按实际原因报 required 而不是 range。
      const key = path.slice(1)
      return [{ path, rule: path !== '/params' && !Object.hasOwn(params, key) ? 'required' : 'range' }]
    }
    case 'herdr_core_read_history_exceeds_limit':
      return [{ path: '/lines', rule: 'range' }]
    case 'herdr_core_read_history_unsupported':
      return [{ path: '/lines', rule: 'invalid_value' }]
    case 'herdr_core_force_unsupported':
      return [{ path: '/force', rule: 'invalid_value' }]
    case 'herdr_core_template_required':
      return [{ path: '/argv', rule: 'required' }]
    case 'herdr_core_template_ambiguous':
      return [{ path: '/argv', rule: 'invalid_value' }]
    case 'herdr_core_template_unavailable':
      return [{ path: '/argv', rule: 'invalid_value' }]
    case 'herdr_core_parent_unsupported':
      return [{ path: '/no_parent', rule: 'invalid_value' }]
    case 'herdr_core_event_invalid':
      return [{ path: '/params', rule: 'range' }]
    case 'herdr_core_param_invalid':
      return [{ path: '/params', rule: 'invalid_value' }]
    default:
      return [{ path: '/params', rule: 'invalid_value' }]
  }
}

/**
 * 登记前预检：形状、逐方法规则与审核 schema 三段的顺序必须与编码阶段一致。
 * 形状不是对象时也只给 `/params` 的固定规则，不回显请求正文。
 */
export function preflightHerdrCoreRequest(input: {
  contract: HerdrCoreContract
  method: string
  params: unknown
}): void {
  let params: JsonObject
  try {
    // 端口自己的规范化已把省略补成 `{}`；直接使用端口（如嵌入式装配）时同样按空对象预检。
    params = input.params === undefined ? {} : object(input.params)
  } catch {
    throw new NativeRequestPreflightError({ issues: [{ path: '/params', rule: 'object' }] })
  }
  try {
    reviewHerdrCoreParams(input.method, params)
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : 'herdr_core_native_request_invalid'
    throw new NativeRequestPreflightError({
      issues: issuesFor(input.method, params, code).slice(0, MAX_ISSUES),
      ...help(input.contract, input.method)
    })
  }
  // rovloom 自有方法不在 core 契约里：参数已由逐方法复核收紧。
  if (HERDR_CORE_SYNTHETIC_METHODS.includes(input.method)) {
    return
  }
  try {
    input.contract.validateParams(input.method, params)
  } catch (error) {
    if (error instanceof NativeRequestPreflightError) {
      const issues = (error.parameterDiagnostic?.issues ?? []).slice(0, MAX_ISSUES)
      throw new NativeRequestPreflightError({
        issues: issues.length ? issues : [{ path: '/params', rule: 'invalid_value' }],
        ...help(input.contract, input.method)
      })
    }
    throw error
  }
}

/** parameter_help 与 describe 同源；任何生成失败都只省略它，不把内部错误带进诊断。 */
function help(contract: HerdrCoreContract, method: string): Pick<ParameterDiagnostic, 'parameter_help'> {
  try {
    const parameter_help = herdrCoreParameterHelp(contract, method)
    return parameter_help === undefined ? {} : { parameter_help }
  } catch {
    return {}
  }
}

/** 公开规则类型只用于类型收窄，避免拼错的规则名悄悄通过编译。 */
export type HerdrCoreIssueRule = ParameterIssueRule
