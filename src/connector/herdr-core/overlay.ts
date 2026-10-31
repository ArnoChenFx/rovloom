/**
 * 说明覆盖层：core 的 OpenRPC 原文照旧缓存、照旧计入契约摘要；控制端看到的字段说明在
 * describe（以及预检的 parameter_help）里按 rovloom 的**实际行为**改写。
 * 覆盖只写事实与来源，不写请求值，也不放宽任何规则。
 */
import type { JsonObject } from '../../wire/types.js'
import type { ParameterDiagnostic } from '../../mcp/diagnostic.js'
import {
  HERDR_CORE_CONTROL_METHODS,
  HERDR_CORE_DOC_MAX_BYTES,
  HERDR_CORE_EDIT_MAX,
  HERDR_CORE_EDIT_MAX_BYTES,
  HERDR_CORE_EVENTS_MAX_LIMIT,
  HERDR_CORE_EVENTS_MAX_TIMEOUT_MS,
  HERDR_CORE_EVENTS_PARAMS_SCHEMA,
  HERDR_CORE_EXEC_MAX_SECONDS,
  HERDR_CORE_FILE_MAX_BASE64,
  HERDR_CORE_INTERRUPT_DEFAULT_SECONDS,
  HERDR_CORE_KEY_MAX_LENGTH,
  HERDR_CORE_KEYS_MAX,
  HERDR_CORE_LABELS_MAX,
  HERDR_CORE_LABEL_MAX_LENGTH,
  HERDR_CORE_PUT_MAX_BASE64,
  HERDR_CORE_READ_MAX_LINES,
  HERDR_CORE_RUN_MAX_ARGV,
  HERDR_CORE_RUN_MAX_ARGV_BYTES,
  HERDR_CORE_RUN_MAX_ENV,
  HERDR_CORE_RUN_MAX_LINE_BYTES,
  HERDR_CORE_SEND_MAX_BYTES,
  HERDR_CORE_SYNTHETIC_METHODS,
  HERDR_CORE_WAIT_MAX_SECONDS,
  herdrCoreControl,
  herdrCoreRequestTimeout
} from './methods.js'
import type { HerdrCoreContract } from './schema.js'

/** 控制档的终端参数：裸地址或名字都行；`machine/t7` 走 core 的机器表，一律拒绝。 */
const TERMINAL_CONTROL =
  'Bare local address like `t7`, or a terminal name (1-32 of `a-z 0-9 - _ .`, starting with a letter or digit). `machine/t7` is rejected. rovloom reads `terminal.get` first and sends the resolved address.'
const CORE_ID =
  'Optional. Current core id from `server.status`. When given, a replaced core is rejected; omitting it means "whatever core is connected now".'
const CREATED_MS =
  'Optional. Terminal incarnation `created_ms` from `terminal.get`/`terminal.list`. When given, a reused address is rejected; omitting it means "the terminal under this name/address now".'
const PARENT_ADDRESS =
  'Bare local address like `t7`, or a terminal name. `machine/t7` is rejected; rovloom resolves the name to an address before starting.'
const PARENT_CREATED_MS =
  'Optional. Parent `created_ms` from `terminal.get`/`terminal.list`; when given, a reused parent address is rejected.'

/** 秒数上限的统一说法：core 自己的默认值与最大值都不适用。 */
function secondsRule(rule: string): string {
  return `Seconds, ${rule}, at most ${HERDR_CORE_WAIT_MAX_SECONDS} (rovloom cap; core's own default and maximum do not apply).`
}

/** 各方法 `timeout` 的实际规则（以 methods.ts 的复核为准）。 */
const TIMEOUT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'terminal.send': secondsRule('greater than 0. Required with `wait=true`; must be omitted otherwise'),
  'terminal.run': secondsRule('greater than 0. Required with `wait=true`; must be omitted otherwise'),
  'terminal.wait': secondsRule(
    `greater than 0. Optional, but give it: without it rovloom only waits ${
      herdrCoreRequestTimeout('terminal.wait', {}) / 1000
    } s locally and the call ends as outcome_unknown`
  ),
  'terminal.interrupt': secondsRule(
    `0 or more. Optional; omitted means core's ${HERDR_CORE_INTERRUPT_DEFAULT_SECONDS} s observation`
  ),
  'machine.exec': secondsRule('greater than 0. Required; rovloom requires it explicitly')
})

/** 每个方法要改写的字段说明；没有条目的字段保留 core 原文。 */
export const HERDR_CORE_PARAM_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze(
  Object.fromEntries([
    ...HERDR_CORE_CONTROL_METHODS.map(
      /** 控制档：终端、core_id、created_ms 三个栅栏字段都按 rovloom 的规则写。 */ (method) => [
        method,
        Object.freeze({
          terminal: TERMINAL_CONTROL,
          core_id: CORE_ID,
          created_ms: CREATED_MS,
          ...(TIMEOUT_DESCRIPTIONS[method] ? { timeout: TIMEOUT_DESCRIPTIONS[method] } : {})
        })
      ]
    ),
    ['server.stop', Object.freeze({ core_id: CORE_ID })],
    ['server.restart', Object.freeze({ core_id: CORE_ID })],
    [
      'terminal.run',
      Object.freeze({
        parent: PARENT_ADDRESS,
        parent_created_ms: PARENT_CREATED_MS,
        timeout: TIMEOUT_DESCRIPTIONS['terminal.run']!
      })
    ],
    ['terminal.wait', Object.freeze({ timeout: TIMEOUT_DESCRIPTIONS['terminal.wait']! })],
    ['machine.exec', Object.freeze({ timeout: TIMEOUT_DESCRIPTIONS['machine.exec']! })]
  ] as [string, Readonly<Record<string, string>>][])
)

/** 一个已审核的数值上限：`max` 与单位；`min` 只在有下界时给出。 */
export type HerdrCoreLimit = Readonly<{
  max?: number
  min?: number
  /** 下界为「大于它」时用这个（例如 timeout 必须大于 0）。 */
  exclusiveMin?: number
  unit: 'seconds' | 'milliseconds' | 'bytes' | 'lines' | 'count' | 'characters'
}>

/**
 * 每个方法**确实有**的数值上限；数值一律来自 methods.ts 的常量，不在这里写字面量。
 * `terminal.get` 这类没有上限的方法不能出现在表里（help 里也不该出现 timeout）。
 */
export const HERDR_CORE_LIMITS: Readonly<Record<string, Readonly<Record<string, HerdrCoreLimit>>>> = Object.freeze({
  'terminal.send': Object.freeze({
    text: { max: HERDR_CORE_SEND_MAX_BYTES, unit: 'bytes' },
    timeout: { max: HERDR_CORE_WAIT_MAX_SECONDS, exclusiveMin: 0, unit: 'seconds' }
  }),
  'terminal.keys': Object.freeze({
    keys: { max: HERDR_CORE_KEYS_MAX, min: 1, unit: 'count' },
    key: { max: HERDR_CORE_KEY_MAX_LENGTH, min: 1, unit: 'characters' }
  }),
  'terminal.interrupt': Object.freeze({ timeout: { max: HERDR_CORE_WAIT_MAX_SECONDS, min: 0, unit: 'seconds' } }),
  'terminal.wait': Object.freeze({ timeout: { max: HERDR_CORE_WAIT_MAX_SECONDS, exclusiveMin: 0, unit: 'seconds' } }),
  'terminal.read': Object.freeze({ lines: { max: HERDR_CORE_READ_MAX_LINES, unit: 'lines' } }),
  'terminal.put': Object.freeze({ data: { max: HERDR_CORE_PUT_MAX_BASE64, unit: 'bytes' } }),
  'terminal.label': Object.freeze({
    labels: { max: HERDR_CORE_LABELS_MAX, unit: 'count' },
    label: { max: HERDR_CORE_LABEL_MAX_LENGTH, unit: 'characters' }
  }),
  'terminal.run': Object.freeze({
    argv: { max: HERDR_CORE_RUN_MAX_ARGV, unit: 'count' },
    argv_bytes: { max: HERDR_CORE_RUN_MAX_ARGV_BYTES, unit: 'bytes' },
    line: { max: HERDR_CORE_RUN_MAX_LINE_BYTES, unit: 'bytes' },
    env: { max: HERDR_CORE_RUN_MAX_ENV, unit: 'count' },
    timeout: { max: HERDR_CORE_WAIT_MAX_SECONDS, exclusiveMin: 0, unit: 'seconds' }
  }),
  'machine.exec': Object.freeze({
    timeout: { max: HERDR_CORE_EXEC_MAX_SECONDS, exclusiveMin: 0, unit: 'seconds' },
    env: { max: HERDR_CORE_RUN_MAX_ENV, unit: 'count' },
    input: { max: HERDR_CORE_FILE_MAX_BASE64, unit: 'bytes' }
  }),
  'file.write': Object.freeze({ data: { max: HERDR_CORE_FILE_MAX_BASE64, unit: 'bytes' } }),
  'file.edit': Object.freeze({
    edits: { max: HERDR_CORE_EDIT_MAX, min: 1, unit: 'count' },
    edits_bytes: { max: HERDR_CORE_EDIT_MAX_BYTES, unit: 'bytes' }
  }),
  'doc.set': Object.freeze({ value: { max: HERDR_CORE_DOC_MAX_BYTES, unit: 'bytes' } }),
  'terminal.events': Object.freeze({
    limit: { max: HERDR_CORE_EVENTS_MAX_LIMIT, min: 1, unit: 'count' },
    timeout_ms: { max: HERDR_CORE_EVENTS_MAX_TIMEOUT_MS, min: 1, unit: 'milliseconds' }
  })
} as Record<string, Record<string, HerdrCoreLimit>>)

/** 上限的固定句子：只出现在该方法确实有这条上限的 help 里。 */
const LIMIT_RULES: Readonly<Record<string, (limit: HerdrCoreLimit) => string>> = Object.freeze({
  timeout: (limit) =>
    `\`timeout\` is in seconds${limit.min === 0 ? ', 0 or more' : ', greater than 0'} and at most ${limit.max}.`,
  text: (limit) => `\`text\` is at most ${limit.max} UTF-8 bytes.`,
  keys: (limit) =>
    `\`keys\` has ${limit.min ?? 1}-${limit.max} entries, each at most ${HERDR_CORE_KEY_MAX_LENGTH} characters.`,
  key: (limit) => `Each key name is at most ${limit.max} characters.`,
  lines: (limit) => `\`lines\` is at most ${limit.max}.`,
  data: (limit) => `\`data\` is at most ${limit.max} bytes (base64 text).`,
  labels: (limit) =>
    `\`labels\` has at most ${limit.max} entries, each value at most ${HERDR_CORE_LABEL_MAX_LENGTH} characters.`,
  label: (limit) => `Each label value is at most ${limit.max} characters.`,
  argv: (limit) =>
    `\`argv\` has at most ${limit.max} entries and ${HERDR_CORE_RUN_MAX_ARGV_BYTES} UTF-8 bytes in total.`,
  argv_bytes: (limit) => `\`argv\` is at most ${limit.max} UTF-8 bytes in total.`,
  line: (limit) => `\`line\` is at most ${limit.max} UTF-8 bytes.`,
  env: (limit) => `\`env\` has at most ${limit.max} entries.`,
  input: (limit) => `\`input\` is at most ${limit.max} bytes (base64 text).`,
  edits: (limit) => `\`edits\` has ${limit.min ?? 1}-${limit.max} entries.`,
  edits_bytes: (limit) => `All \`edits\` together are at most ${limit.max} UTF-8 bytes.`,
  value: (limit) => `\`value\` is at most ${limit.max} bytes when serialized.`,
  limit: (limit) => `\`limit\` is ${limit.min ?? 1}-${limit.max}.`,
  timeout_ms: (limit) => `\`timeout_ms\` is ${limit.min ?? 1}-${limit.max} milliseconds.`
})

/** 参数 schema 的副本上补数值上限：只是交付给控制端的描述，不参与实际校验。 */
function applyLimits(properties: JsonObject, method: string): void {
  const limits = HERDR_CORE_LIMITS[method]
  if (!limits) {
    return
  }
  for (const [field, limit] of Object.entries(limits)) {
    // `argv_bytes`/`edits_bytes`/`key`/`label` 是句子里的聚合上限，不对应单个属性。
    const branch = properties[field]
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
      continue
    }
    const schema = branch as JsonObject
    // 交付副本里的类型可能是 `["number","null"]` 这样的联合；数值上限只加在数值分支上。
    const types = Array.isArray(schema.type) ? (schema.type as unknown[]) : [schema.type]
    if (!types.includes('number') && !types.includes('integer')) {
      continue
    }
    if (limit.max !== undefined) {
      schema.maximum = limit.max
    }
    if (limit.min !== undefined) {
      schema.minimum = limit.min
    }
    if (limit.exclusiveMin !== undefined) {
      schema.exclusiveMinimum = limit.exclusiveMin
    }
  }
}

/** 覆盖后的参数 schema（深拷贝）：改 `properties.*.description` 与数值上限。 */
export function describeHerdrCoreParams(contract: HerdrCoreContract, method: string): JsonObject {
  const copy = HERDR_CORE_SYNTHETIC_METHODS.includes(method)
    ? structuredClone(HERDR_CORE_EVENTS_PARAMS_SCHEMA)
    : contract.paramsSchema(method)
  const overrides = HERDR_CORE_PARAM_DESCRIPTIONS[method]
  const properties = copy.properties
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    if (overrides) {
      for (const [field, description] of Object.entries(overrides)) {
        const branch = (properties as JsonObject)[field]
        if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
          ;(branch as JsonObject).description = description
        }
      }
    }
    applyLimits(properties as JsonObject, method)
  }
  return copy
}

/** 字段清单、固定规则与数值上限：与 describe 用同一份覆盖层，不含请求值。 */
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
    rules.push('`terminal` is a bare local address like `t7` or a terminal name; `machine/t7` is rejected.')
    rules.push(
      '`core_id` and `created_ms` are optional: give them to reject a replaced core or a reused address, omit them to use the terminal under that name/address now.'
    )
  }
  if (method === 'server.stop' || method === 'server.restart') {
    rules.push('`core_id` is required here: it comes from `server.status`; a stale value is rejected.')
  }
  if (method === 'terminal.run') {
    rules.push('`parent` is an address or a name; `parent_created_ms` is optional and checked when given.')
  }
  const limits = HERDR_CORE_LIMITS[method]
  if (limits) {
    for (const [field, limit] of Object.entries(limits)) {
      const sentence = LIMIT_RULES[field]
      if (sentence) {
        rules.push(sentence(limit))
      }
    }
  }
  return {
    source: 'herdr_core_published_schema',
    required,
    optional: names.filter((name) => !required.includes(name)),
    ...(limits ? { limits: structuredClone(limits) } : {}),
    rules
  }
}
