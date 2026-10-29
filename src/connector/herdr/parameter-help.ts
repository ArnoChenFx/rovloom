/** Herdr 参数拒绝的字段诊断由安装 schema 派生，与 runtime_describe 共用 describeHerdrParams；只给固定路径与规则，不回显请求值或字段名。 */
import type { ParameterDiagnostic, ParameterIssueRule } from '../../mcp/diagnostic.js'
import type { JsonObject } from '../../wire/types.js'
import { describeHerdrParams, herdrLineWindow } from './discovery.js'

type Issue = ParameterDiagnostic['issues'][number]

const MAX_ISSUES = 8
// 与 compiler-protocol.ts 的 HERDR_FORMAT_CODE 保持同一上下界，用于把越界整数归为 range。
const INTEGER_FORMATS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  uint: [0, Number.MAX_SAFE_INTEGER],
  uint64: [0, Number.MAX_SAFE_INTEGER],
  uint32: [0, 4294967295],
  uint16: [0, 65535],
  int32: [-2147483648, 2147483647]
})

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 只解析参数 schema 内的 #/$defs 引用；无法解析的分支不生成字段规则，由上层固定根路径兜底。 */
function branchOf(params: JsonObject, value: unknown): JsonObject | undefined {
  const defs = isObject(params.$defs) ? params.$defs : {}
  let branch = isObject(value) ? value : undefined
  for (let depth = 0; branch && branch.$ref !== undefined; depth++) {
    const ref = branch.$ref
    const name = typeof ref === 'string' && ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined
    if (depth >= 8 || name === undefined || !Object.hasOwn(defs, name)) {
      return undefined
    }
    const next = defs[name]
    branch = isObject(next) ? next : undefined
  }
  return branch
}

/** 与 JSON Schema 基本类型一致；integer 要求安全整数。未知类型不在此判错。 */
function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'object':
      return isObject(value)
    case 'array':
      return Array.isArray(value)
    case 'integer':
      return Number.isSafeInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    default:
      return true
  }
}

/** 字段规则只来自该字段自己的 schema 分支；取值本身不进入诊断。 */
function fieldRule(params: JsonObject, property: unknown, value: unknown): ParameterIssueRule | undefined {
  const branch = branchOf(params, property)
  if (!branch) {
    return undefined
  }
  const types = Array.isArray(branch.type) ? branch.type : branch.type === undefined ? [] : [branch.type]
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    return 'invalid_value'
  }
  if (Array.isArray(branch.enum) && !(branch.enum as unknown[]).includes(value)) {
    return 'one_of'
  }
  if (typeof value === 'number') {
    const format =
      typeof branch.format === 'string' && Object.hasOwn(INTEGER_FORMATS, branch.format)
        ? INTEGER_FORMATS[branch.format]
        : undefined
    const minimum = Math.max(typeof branch.minimum === 'number' ? branch.minimum : -Infinity, format?.[0] ?? -Infinity)
    const maximum = Math.min(typeof branch.maximum === 'number' ? branch.maximum : Infinity, format?.[1] ?? Infinity)
    if (value < minimum || value > maximum) {
      return 'range'
    }
  }
  return undefined
}

/**
 * 仅在原生根校验已拒绝后调用：方法须属于本机安装 schema 的已评审分支，否则不给字段诊断。
 * parameter_help 与 runtime_describe 的 params_schema 来自同一次 describeHerdrParams。
 */
export function herdrParameterDiagnostic(document: JsonObject, request: JsonObject): ParameterDiagnostic | undefined {
  if (typeof request.method !== 'string') {
    return undefined
  }
  let params: JsonObject
  try {
    params = describeHerdrParams(document, request.method)
  } catch {
    return undefined
  }
  // 顶层通常是指向 $defs 的引用，字段表必须沿引用解析后读取。
  const root = branchOf(params, params)
  if (!root) {
    return undefined
  }
  const properties = isObject(root.properties) ? root.properties : {}
  const required = Array.isArray(root.required)
    ? root.required.filter((name): name is string => typeof name === 'string')
    : []
  const optional = Object.keys(properties).filter((name) => !required.includes(name))
  const values = isObject(request.params) ? request.params : undefined
  const issues: Issue[] = []
  if (!values) {
    issues.push({ path: '/params', rule: 'object' })
  } else {
    for (const name of required) {
      if (!Object.hasOwn(values, name)) {
        issues.push({ path: '/params/' + name, rule: 'required' })
      }
    }
    for (const name of Object.keys(properties)) {
      if (Object.hasOwn(values, name)) {
        const rule = fieldRule(params, properties[name], values[name])
        if (rule) {
          issues.push({ path: '/params/' + name, rule })
        }
      }
    }
    if (root.additionalProperties === false && Object.keys(values).some((name) => !Object.hasOwn(properties, name))) {
      issues.push({ path: '/params', rule: 'invalid_value' })
    }
  }
  if (issues.length === 0) {
    issues.push({ path: '/params', rule: 'invalid_value' })
  }
  const allowed: JsonObject = {}
  for (const name of Object.keys(properties)) {
    const branch = branchOf(params, properties[name])
    if (Array.isArray(branch?.enum)) {
      allowed[name] = branch.enum
    }
  }
  const window = herdrLineWindow(request.method)
  return {
    issues: issues.slice(0, MAX_ISSUES),
    parameter_help: {
      source: 'herdr_installed_schema',
      required,
      optional,
      ...(Object.keys(allowed).length > 0 ? { allowed_values: allowed } : {}),
      ...(window
        ? {
            rules: [
              `${window.parameter} is a runtime window (native_max_lines=${window.native_max_lines}), not a schema bound.`
            ]
          }
        : {})
    }
  }
}
