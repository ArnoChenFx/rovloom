/**
 * 说明覆盖层：core 的 OpenRPC 原文照旧缓存、照旧计入契约摘要；控制端看到的字段说明在
 * describe（以及预检的 parameter_help）里按 rovloom 的**实际行为**改写。
 * 覆盖只写事实与来源，不写请求值，也不放宽任何规则。
 */
import type { JsonObject } from '../../wire/types.js'
import type { ParameterDiagnostic } from '../../mcp/diagnostic.js'
import { HERDR_CORE_CONTROL_METHODS, herdrCoreControl } from './methods.js'
import type { HerdrCoreContract } from './schema.js'

/** 控制档的终端参数：只接受裸地址。名字会被 label 改写，machine/t7 属于远端路由。 */
const TERMINAL_CONTROL = 'Bare local address like `t7` only. rovloom rejects a terminal name and `machine/t7` here.'
const CORE_ID = 'Current core id from `server.status` (`core_id`). rovloom rejects a stale or missing value.'
const CREATED_MS =
  'Terminal incarnation `created_ms` from `terminal.get` or `terminal.list`; it pins the terminal that existed when you read it.'
const PARENT_ADDRESS = 'Bare local address of the parent terminal, like `t7`; a name is rejected.'
const PARENT_CREATED_MS = 'Parent `created_ms` from `terminal.get` or `terminal.list`.'

/** 每个方法要改写的字段说明；没有条目的字段保留 core 原文。 */
export const HERDR_CORE_PARAM_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze(
  Object.fromEntries([
    ...HERDR_CORE_CONTROL_METHODS.map(
      /** 控制档：终端、core_id、created_ms 三个栅栏字段都按 rovloom 的规则写。 */ (method) => [
        method,
        Object.freeze({ terminal: TERMINAL_CONTROL, core_id: CORE_ID, created_ms: CREATED_MS })
      ]
    ),
    ['server.stop', Object.freeze({ core_id: CORE_ID })],
    ['server.restart', Object.freeze({ core_id: CORE_ID })],
    ['terminal.run', Object.freeze({ parent: PARENT_ADDRESS, parent_created_ms: PARENT_CREATED_MS })]
  ] as [string, Readonly<Record<string, string>>][])
)

/** 覆盖后的参数 schema（深拷贝）：只改 `properties.*.description`。 */
export function describeHerdrCoreParams(contract: HerdrCoreContract, method: string): JsonObject {
  const copy = contract.paramsSchema(method)
  const overrides = HERDR_CORE_PARAM_DESCRIPTIONS[method]
  const properties = copy.properties
  if (overrides && properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [field, description] of Object.entries(overrides)) {
      const branch = (properties as JsonObject)[field]
      if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
        ;(branch as JsonObject).description = description
      }
    }
  }
  return copy
}

/** 字段清单与固定规则：与 describe 用同一份覆盖层，不含请求值。 */
export function herdrCoreParameterHelp(
  contract: HerdrCoreContract,
  method: string
): ParameterDiagnostic['parameter_help'] {
  const schema = describeHerdrCoreParams(contract, method)
  const properties = schema.properties
  const names =
    properties && typeof properties === 'object' && !Array.isArray(properties) ? Object.keys(properties) : []
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []
  const rules: string[] = ['Omitted `params` is the same as `params: {}`.']
  if (herdrCoreControl(method)) {
    rules.push('`terminal` must be a bare local address like `t7`; a name or `machine/t7` is rejected.')
    rules.push('`core_id` comes from `server.status`; `created_ms` comes from `terminal.get` or `terminal.list`.')
  }
  if (method === 'server.stop' || method === 'server.restart') {
    rules.push('`core_id` comes from `server.status`; a stale value is rejected.')
  }
  if (method === 'terminal.run') {
    rules.push('`parent` must be a bare local address like `t7`; `parent_created_ms` comes from `terminal.get`.')
  }
  return {
    source: 'herdr_core_published_schema',
    required,
    optional: names.filter((name) => !required.includes(name)),
    rules
  }
}
