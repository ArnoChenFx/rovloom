/**
 * 已审核的参数子集：Rovloom 对 Luvus 普通方法的字段规则（类型、必填、枚举、范围、互斥与依赖）。
 * 执行校验（operations.ts）、runtime_describe 的 params_schema 与拒绝诊断（parameter-help.ts）共用这里的同一份定义；
 * 与安装版原生 schema 分别标注来源，不覆盖原生 generic_params_only 结论。
 */
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import type { ParameterIssueRule } from '../../mcp/diagnostic.js'
import type { JsonObject } from '../../wire/types.js'

export const WAIT_OUTPUT_MATCH_BYTES = 4096
const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const panePattern = [
  '[1-9][0-9]{0,8}',
  '[1-3][0-9]{9}',
  '4[01][0-9]{8}',
  '42[0-8][0-9]{7}',
  '429[0-3][0-9]{6}',
  '4294[0-8][0-9]{5}',
  '42949[0-5][0-9]{4}',
  '429496[0-6][0-9]{3}',
  '4294967[01][0-9]{2}',
  '42949672[0-8][0-9]',
  '429496729[0-5]'
].join('|')
const STATES = ['idle', 'working', 'blocked', 'done']
const DIRECTIONS = ['auto', 'right', 'down']

// 字符数 maxLength 不能代替 UTF-8 字节上限，因此字节由 x-maxUtf8Bytes 强制；NUL 一律拒绝。
function text(maxBytes: number, options: { empty?: boolean; description?: string } = {}): JsonObject {
  return {
    type: 'string',
    ...(options.empty ? {} : { minLength: 1 }),
    pattern: '^[^\\u0000]*$',
    'x-maxUtf8Bytes': maxBytes,
    ...(options.description ? { description: options.description } : {})
  }
}
const PANE: JsonObject = {
  type: 'string',
  pattern: '^(?:' + panePattern + ')$',
  description: 'Positive u32 pane ID, 1..4294967295.'
}
const REVISION: JsonObject = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const LINES: JsonObject = { type: 'integer', minimum: 1, maximum: 1000 }
const TIMEOUT: JsonObject = { type: 'number', minimum: 0, maximum: 3600 }
const BOOLEAN: JsonObject = { type: 'boolean' }
const TERMINAL: JsonObject = { type: 'string', pattern: '^[0-9a-f]{32}$' }
const NAME: JsonObject = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' }
const STATE_LIST: JsonObject = {
  type: 'array',
  minItems: 1,
  maxItems: 4,
  uniqueItems: true,
  items: { enum: STATES }
}
// 工作区按 0 基、标签按 1 基接受数字位置；稳定 ID 为文本。两者由 anyOf 表达，范围与互斥仍由同一 schema 约束。
const WORKSPACE_INDEX: JsonObject = {
  anyOf: [
    { type: 'string', pattern: '^0*(?:0|' + panePattern + ')$' },
    { type: 'integer', minimum: 0, maximum: 4294967295 }
  ]
}
const TAB_INDEX: JsonObject = {
  anyOf: [
    { type: 'string', pattern: '^0*(?:' + panePattern + ')$' },
    { type: 'integer', minimum: 1, maximum: 4294967295 }
  ]
}
// 固定 Luvus 0.14.3 的具名按键；大小写不敏感，逐字符展开为字符类。
const caseless = (value: string) =>
  [...value]
    .map((char) =>
      /[a-z]/i.test(char) ? '[' + char.toLowerCase() + char.toUpperCase() + ']' : char.replace('+', '\\+')
    )
    .join('')
const NAMED_KEYS = [
  'enter',
  'return',
  'cr',
  'esc',
  'escape',
  'tab',
  'space',
  'backspace',
  'bs',
  'delete',
  'del',
  'up',
  'down',
  'right',
  'left',
  'home',
  'end',
  'pageup',
  'pgup',
  'pagedown',
  'pgdn'
]
const KEY: JsonObject = {
  type: 'string',
  anyOf: [
    { pattern: '^(?:' + NAMED_KEYS.map(caseless).join('|') + ')$' },
    { pattern: '^(?:' + caseless('ctrl+') + '|' + caseless('c-') + ')[a-zA-Z]$' },
    { pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]$' }
  ]
}

/** 对象只接受列出的字段；mutex 表示最多一个，exactly 表示恰好一个（用于稳定 ID 与位置选择器）。 */
function atMostOne(names: readonly string[]): JsonObject {
  return { not: { required: [...names] } }
}
function exactlyOne(names: readonly string[]): JsonObject {
  return { oneOf: names.map((name) => ({ required: [name] })) }
}
function object(properties: Record<string, JsonObject>, required: readonly string[] = [], extra: JsonObject = {}) {
  return {
    $schema: SCHEMA_DIALECT,
    type: 'object',
    additionalProperties: false,
    required: [...required],
    properties,
    ...extra
  }
}

const SELECTOR_WORKSPACE = { workspace: WORKSPACE_INDEX, workspace_id: text(256) }
const SELECTOR_TAB = { tab: TAB_INDEX, tab_id: text(256) }
const PANE_ONLY = { pane: PANE }

/** 每个普通方法一份已审核 schema；方法未出现即不属于已审核子集。 */
const REVIEWED: Readonly<Record<string, JsonObject>> = Object.freeze({
  'session.snapshot': object({}),
  'workspace.list': object({}),
  'tab.list': object({}),
  'pane.current': object({}),
  'agent.list': object({}),
  'agent.sessions': object({}),
  'workspace.new': object({ if_revision: REVISION }),
  'tab.new': object({ if_revision: REVISION }),
  'workspace.open': object({ path: text(4096), focus: BOOLEAN, if_revision: REVISION }, ['path']),
  'workspace.get': object({ ...SELECTOR_WORKSPACE }, [], atMostOne(['workspace', 'workspace_id'])),
  'workspace.focus': object(
    { ...SELECTOR_WORKSPACE, if_revision: REVISION },
    [],
    exactlyOne(['workspace', 'workspace_id'])
  ),
  'workspace.close': object(
    { ...SELECTOR_WORKSPACE, if_revision: REVISION },
    [],
    exactlyOne(['workspace', 'workspace_id'])
  ),
  'workspace.rename': object(
    { name: text(256, { empty: true }), ...SELECTOR_WORKSPACE, if_revision: REVISION },
    ['name'],
    exactlyOne(['workspace', 'workspace_id'])
  ),
  'tab.get': object({ ...SELECTOR_WORKSPACE, ...SELECTOR_TAB }, [], {
    allOf: [atMostOne(['workspace', 'workspace_id']), atMostOne(['tab', 'tab_id'])]
  }),
  'tab.focus': object({ ...SELECTOR_TAB, if_revision: REVISION }, [], exactlyOne(['tab', 'tab_id'])),
  'tab.close': object({ ...SELECTOR_TAB, if_revision: REVISION }, [], exactlyOne(['tab', 'tab_id'])),
  'tab.rename': object(
    { name: text(256, { empty: true }), ...SELECTOR_TAB, if_revision: REVISION },
    ['name'],
    exactlyOne(['tab', 'tab_id'])
  ),
  'pane.list': object({ all_tabs: BOOLEAN }),
  'pane.get': object({ ...PANE_ONLY }, ['pane']),
  'pane.status': object({ ...PANE_ONLY }, ['pane']),
  'pane.focus': object({ ...PANE_ONLY }, ['pane']),
  'pane.close': object({ ...PANE_ONLY }, ['pane']),
  'pane.rename': object({ pane: PANE, name: text(256, { empty: true }) }, ['pane', 'name']),
  'pane.run': object({ pane: PANE, command: text(65536) }, ['pane', 'command']),
  'wait.output': object(
    {
      pane: PANE,
      match: text(WAIT_OUTPUT_MATCH_BYTES, {
        description: 'Literal substring, 1..4096 UTF-8 bytes, without NUL. maxLength counts characters, not bytes.'
      }),
      timeout_s: TIMEOUT
    },
    ['pane', 'match']
  ),
  'pane.split': object({ pane: PANE, direction: { enum: DIRECTIONS } }, ['pane']),
  'agent.get': object({ target: text(128) }, ['target']),
  'agent.explain': object({ target: text(128) }, ['target']),
  'agent.read': object({ target: text(128), lines: LINES, source: { enum: ['visible', 'recent'] } }, ['target']),
  'pane.read': object({ pane: PANE, lines: LINES }, ['pane']),
  'agent.resume': object({ session_id: text(256) }, ['session_id']),
  'agent.start': object(
    {
      name: NAME,
      kind: NAME,
      pane: PANE,
      anchor: PANE,
      direction: { enum: DIRECTIONS },
      timeout_s: TIMEOUT,
      args: { type: 'array', maxItems: 128, items: text(16384, { empty: true }) }
    },
    ['name', 'kind'],
    atMostOne(['pane', 'anchor'])
  ),
  'agent.prompt': object(
    {
      target: text(128),
      text: text(262144),
      terminal_id: TERMINAL,
      strict: BOOLEAN,
      wait: BOOLEAN,
      until: STATE_LIST,
      timeout_s: TIMEOUT
    },
    ['target', 'text'],
    {
      // 有 until 或 timeout_s 时 wait 必须为 true；等价写法避免 if/then 关键字被误判为 thenable。
      anyOf: [
        { not: { anyOf: [{ required: ['until'] }, { required: ['timeout_s'] }] } },
        { required: ['wait'], properties: { wait: { const: true } } }
      ]
    }
  ),
  'agent.send': object({ target: text(128), text: text(262144), terminal_id: TERMINAL, strict: BOOLEAN }, [
    'target',
    'text'
  ]),
  'agent.keys': object(
    {
      target: text(128),
      keys: { type: 'array', minItems: 1, items: KEY },
      terminal_id: TERMINAL,
      if_content_revision: { type: 'integer', minimum: 0, maximum: 4294967295 }
    },
    ['target', 'keys'],
    { dependentRequired: { terminal_id: ['if_content_revision'], if_content_revision: ['terminal_id'] } }
  ),
  'agent.wait': object(
    { pane: PANE, status: { enum: STATES }, statuses: STATE_LIST, timeout_s: TIMEOUT },
    ['pane'],
    exactlyOne(['status', 'statuses'])
  )
})

/** 每次返回独立副本；调用方修改返回值不能改变之后的执行校验或描述。 */
export function luvusReviewedParams(method: string): JsonObject | undefined {
  return Object.hasOwn(REVIEWED, method) ? structuredClone(REVIEWED[method]!) : undefined
}

/** 固定字段名与取值集合，供提示和投影过滤；只包含已审核 schema 中声明的字段。 */
export function luvusReviewedFields(
  method: string
): { required: string[]; optional: string[]; values: JsonObject } | undefined {
  if (!Object.hasOwn(REVIEWED, method)) {
    return undefined
  }
  const schema = REVIEWED[method]!
  const properties = schema.properties as Record<string, JsonObject>
  const required = [...(schema.required as string[])]
  const names = Object.keys(properties)
  const values: JsonObject = {}
  for (const name of names) {
    const candidate = properties[name]!.enum ?? (properties[name]!.items as JsonObject | undefined)?.enum
    if (Array.isArray(candidate)) {
      values[name] = [...candidate]
    }
  }
  return { required, optional: names.filter((name) => !required.includes(name)), values }
}

// strictRequired 关闭：互斥与依赖分支引用的是同一对象的父级字段名，这些名字都由本表固定，不来自请求。
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
ajv.addKeyword({
  keyword: 'x-maxUtf8Bytes',
  schemaType: 'number',
  type: 'string',
  validate: (maximum: number, value: string) => Buffer.byteLength(value) <= maximum
})
const validators = new Map<string, ValidateFunction>()

/** 同一份已审核 schema 编译一次；执行校验与拒绝诊断都经由它，不另建规则。 */
export function luvusReviewedValidator(method: string): ValidateFunction | undefined {
  if (!Object.hasOwn(REVIEWED, method)) {
    return undefined
  }
  let validate = validators.get(method)
  if (!validate) {
    validate = ajv.compile(REVIEWED[method]!)
    validators.set(method, validate)
  }
  return validate
}

/**
 * 把原始 schema 错误折叠为固定路径与规则；错误正文、取值与键名均不进入结果。
 * primary 是字段自身的违规；secondary 只在没有任何其它解释时作为根路径兜底（未知字段、枚举、对象级互斥）。
 */
export function luvusReviewedIssues(
  method: string,
  params: unknown
): { primary: ReviewedIssue[]; secondary: ReviewedIssue[] } {
  const primary: ReviewedIssue[] = []
  const secondary: ReviewedIssue[] = []
  const validate = luvusReviewedValidator(method)
  if (!validate || validate(params)) {
    return { primary, secondary }
  }
  for (const error of validate.errors ?? []) {
    const { issue, fallback } = issueOf(error)
    if (fallback) {
      secondary.push(issue)
    } else {
      primary.push(issue)
    }
  }
  return { primary, secondary }
}

type ReviewedIssue = { path: string; rule: ParameterIssueRule }

function issueOf(error: ErrorObject): { issue: ReviewedIssue; fallback: boolean } {
  const field = '/params' + error.instancePath
  // 选择器互斥分支里的逐个必填错误只表示"二选一"，由对象级 one_of 表达，不逐个报告分支。
  const inBranch = /\/(?:oneOf|anyOf|not)\//.test(error.schemaPath)
  switch (error.keyword) {
    case 'required':
      if (inBranch) {
        return { issue: { path: '/params', rule: 'one_of' }, fallback: true }
      }
      return { issue: { path: field + '/' + String(error.params.missingProperty), rule: 'required' }, fallback: false }
    case 'dependentRequired':
      return { issue: { path: field + '/' + String(error.params.missingProperty), rule: 'required' }, fallback: false }
    // 未知字段与枚举取值只给根路径，且只在没有字段级解释时出现：提示列出允许值，但不把取值位置当作可定位字段。
    case 'additionalProperties':
    case 'enum':
      return { issue: { path: '/params', rule: 'invalid_value' }, fallback: true }
    case 'oneOf':
    case 'anyOf':
    case 'not':
      return error.instancePath === ''
        ? { issue: { path: '/params', rule: 'one_of' }, fallback: true }
        : { issue: { path: field, rule: 'one_of' }, fallback: false }
    case 'type':
      return error.instancePath === ''
        ? { issue: { path: '/params', rule: 'object' }, fallback: false }
        : { issue: { path: field, rule: 'invalid_value' }, fallback: false }
    case 'pattern':
      return { issue: { path: field, rule: 'pattern' }, fallback: false }
    case 'minimum':
    case 'maximum':
      return { issue: { path: field, rule: 'range' }, fallback: false }
    case 'const':
      return { issue: { path: field, rule: 'required_true' }, fallback: false }
    default:
      return { issue: { path: field, rule: 'invalid_value' }, fallback: false }
  }
}
