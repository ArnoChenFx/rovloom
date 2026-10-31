/**
 * 从 core 发布的 OpenRPC 文档编译本仓库审核过的参数/结果校验器。
 * 发布的 schema 只当输入：参数根加 additionalProperties:false，结果对象逐层收紧，
 * 已知上游缺陷按方法逐条修正，并保留可核对的契约身份。
 */
import { createHash } from 'node:crypto'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject, Options, ValidateFunction } from 'ajv'
import type { ParameterDiagnostic, ParameterIssueRule } from '../../mcp/diagnostic.js'
import { NativeRequestPreflightError } from '../preflight.js'
import { ProviderAdapterError } from '../provider-error.js'
import { boundedJson, fail, hash, parseJson } from '../../wire/index.js'
import type { JsonObject } from '../../wire/types.js'
import { HERDR_CORE_BLOCKED_PARAMS, HERDR_CORE_FENCE_PARAMS, HERDR_CORE_METHODS, herdrCoreControl } from './methods.js'

/** 输入上限远大于 0.1.14 的 63 KB 文档，同时拒绝把任意大文件当 schema。 */
export const HERDR_CORE_SCHEMA_INPUT_LIMIT = 1024 * 1024
/** 单条说明的上限：core 的 OpenRPC 每条都远小于它，超限拒绝而不是截断。 */
export const HERDR_CORE_DESCRIPTION_MAX_BYTES = 1024
/** 整份文档里说明与默认值的总量上限；只做注释，不参与校验。 */
export const HERDR_CORE_DESCRIPTIONS_MAX_BYTES = 256 * 1024
const NODE_LIMIT = 200_000
const ISSUE_LIMIT = 8

/** 说明文本只做注释：换行与制表符保留，其它 C0/DEL 一律拒绝，不静默清洗。 */
function annotation(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > HERDR_CORE_DESCRIPTION_MAX_BYTES) {
    fail('herdr_core_schema_text_invalid')
  }
  for (const character of value) {
    const code = character.codePointAt(0)!
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) {
      fail('herdr_core_schema_text_invalid')
    }
  }
  return value
}

/** 整份文档的说明预算：累计超过上限即拒绝整份契约，不按方法截断。 */
type AnnotationBudget = { bytes: number }

/** 与 Herdr 编译器同一套严格选项；本处不需要 standalone 代码生成。 */
const AJV_OPTIONS: Options = Object.freeze({
  strict: true,
  strictRequired: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  inlineRefs: false
})

/**
 * 上游 0.1.14 的 ListResult 把 machines 标成 required，但未配置机器时 core 不输出该字段
 * （spike 的 5/5 真实样本都不符）。只对这一条按证据放宽，其余 required 不动。
 */
const RESULT_REQUIRED_RELAXED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'terminal.list': Object.freeze(['machines'])
})

export type HerdrCoreContract = Readonly<{
  /** 去掉 info.version 后的内容摘要；同一文档重建必须得到同一值。 */
  identity: string
  version: string
  methods: readonly string[]
  paramsSchema(method: string): JsonObject
  resultSchema(method: string): JsonObject
  /** core 发布的方法说明；只作注释，不参与校验。 */
  methodDescription(method: string): string | null
  /** 参数不合格抛 NativeRequestPreflightError（只含路径与规则）。 */
  validateParams(method: string, params: unknown): JsonObject
  /** 结果不合格抛 ProviderAdapterError('herdr_core_result_invalid')，不当作空成功。 */
  validateResult(method: string, result: unknown): JsonObject
}>

/** 规范化 JSON：键排序、无空白，只用于契约身份，不参与校验。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** 契约身份不含 info.version：版本字符串变了不代表行为或接口变了，反之亦然。 */
export function herdrCoreContractIdentity(document: JsonObject): string {
  const copy = structuredClone(document)
  const info = copy.info
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    delete (info as JsonObject).version
  }
  return createHash('sha256').update(canonical(copy)).digest('hex')
}

/** 只接受本仓库已审核的文档形状；多余顶层字段不解释。 */
function document(input: string | Uint8Array): JsonObject {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength
  if (bytes === 0 || bytes > HERDR_CORE_SCHEMA_INPUT_LIMIT) {
    fail('herdr_core_schema_input_limit')
  }
  const value = parseJson(input, HERDR_CORE_SCHEMA_INPUT_LIMIT)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('herdr_core_schema_invalid')
  }
  const root = value as JsonObject
  if (typeof root.openrpc !== 'string' || !root.info || typeof root.info !== 'object' || Array.isArray(root.info)) {
    fail('herdr_core_schema_invalid')
  }
  const info = root.info as JsonObject
  if (typeof info.version !== 'string' || !Array.isArray(root.methods)) {
    fail('herdr_core_schema_invalid')
  }
  const components = root.components
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    fail('herdr_core_schema_invalid')
  }
  const schemas = (components as JsonObject).schemas
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
    fail('herdr_core_schema_invalid')
  }
  return root
}

/** 审核 schema 的本地基础 URI；组件按名字注册在这里。 */
const SCHEMA_URI = 'urn:rovloom:herdr-core:schema'

type TransformState = { nodes: number; budget?: AnnotationBudget }

/** 只把本地组件引用改写成本仓库注册的绝对引用；外部引用明确拒绝。 */
function referenceName(ref: unknown): string {
  if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/') || /~(?![01])|%/.test(ref)) {
    fail('herdr_core_schema_ref_unsupported')
  }
  return ref.slice('#/components/schemas/'.length).replaceAll('~1', '/').replaceAll('~0', '~')
}

/** 直接照抄的判定关键字：这些值不是 schema，改写会破坏语义。 */
const VERBATIM = new Set([
  'type',
  'enum',
  'const',
  'required',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'uniqueItems',
  'multipleOf',
  'minProperties',
  'maxProperties',
  '$id',
  '$schema'
])
/** 值是 schema 或 schema 表的关键字；逐项展开，未知关键字直接拒绝。 */
const SUBSCHEMA = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'])
const SUBSCHEMA_LIST = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const SUBSCHEMA_MAP = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs'])

/** 逐层收紧对象并改写引用；递归类型保持引用，不展开成无限树。 */
function transform(input: JsonObject, state: TransformState): JsonObject {
  state.nodes += 1
  if (state.nodes > NODE_LIMIT) {
    fail('herdr_core_schema_too_large')
  }
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'description') {
      // 说明保留下来给控制端看：它是注释，不参与校验，也不改写调用方参数。
      out.description = annotation(value)
      if (state.budget) {
        state.budget.bytes += Buffer.byteLength(out.description as string)
        if (state.budget.bytes > HERDR_CORE_DESCRIPTIONS_MAX_BYTES) {
          fail('herdr_core_schema_text_too_large')
        }
      }
      continue
    }
    if (key === 'default') {
      // 默认值只作为注释交付；本仓库不应用默认值，避免被误当成已生效。
      out.default = value
      if (state.budget) {
        state.budget.bytes += Buffer.byteLength(boundedJson(value, HERDR_CORE_DESCRIPTION_MAX_BYTES))
        if (state.budget.bytes > HERDR_CORE_DESCRIPTIONS_MAX_BYTES) {
          fail('herdr_core_schema_text_too_large')
        }
      }
      continue
    }
    if (key === 'title' || key === '$comment' || key === 'examples') {
      continue
    }
    if (key === '$ref') {
      return { $ref: `${SCHEMA_URI}#/$defs/${referenceName(value)}` }
    }
    if (VERBATIM.has(key)) {
      out[key] = value
      continue
    }
    if (SUBSCHEMA.has(key)) {
      if (value === true || value === false) {
        out[key] = value
        continue
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('herdr_core_schema_invalid')
      }
      out[key] = transform(value as JsonObject, state)
      continue
    }
    if (SUBSCHEMA_LIST.has(key)) {
      if (!Array.isArray(value) || !value.length) {
        fail('herdr_core_schema_invalid')
      }
      out[key] = value.map(
        /** 每个分支独立展开，任一分支不可理解即整体拒绝。 */ (branch) => {
          if (branch === true || branch === false) {
            return branch
          }
          if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
            fail('herdr_core_schema_invalid')
          }
          return transform(branch as JsonObject, state)
        }
      )
      continue
    }
    if (SUBSCHEMA_MAP.has(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('herdr_core_schema_invalid')
      }
      const map: JsonObject = {}
      for (const [name, subschema] of Object.entries(value as JsonObject)) {
        // JSON Schema 允许布尔 schema（true/false）；这里原样保留，不当成未声明。
        if (subschema === true || subschema === false) {
          map[name] = subschema
          continue
        }
        if (!subschema || typeof subschema !== 'object' || Array.isArray(subschema)) {
          fail('herdr_core_schema_invalid')
        }
        map[name] = transform(subschema as JsonObject, state)
      }
      out[key] = map
      continue
    }
    // 未知关键字不忽略：strict 模式下它本来也会失败，这里给出固定错误码。
    fail('herdr_core_schema_keyword_unsupported')
  }
  if (out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = false
  }
  return out
}

/**
 * 把参数 schema 里对本地组件的引用就地展开：控制端只看 describe 的 `params_schema`，
 * 悬空 `$ref` 等于看不到允许值（例如 `if` 只能是 idle/working）。参数里不应出现递归，
 * 出现就按契约不符拒绝，不交一份解不开的 schema。
 */
function inlineReferences(schema: JsonObject, components: JsonObject, visiting: readonly string[] = []): JsonObject {
  const ref = schema.$ref
  if (ref !== undefined) {
    const name =
      typeof ref === 'string' && ref.startsWith(`${SCHEMA_URI}#/$defs/`) ? ref.slice(SCHEMA_URI.length + 8) : undefined
    if (name === undefined || visiting.includes(name) || !components[name]) {
      fail('herdr_core_schema_ref_unsupported')
    }
    return inlineReferences(components[name] as JsonObject, components, [...visiting, name])
  }
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) {
      out[key] = value.map(
        /** 数组里的每一项都可能是 schema。 */ (entry) =>
          entry && typeof entry === 'object' && !Array.isArray(entry)
            ? inlineReferences(entry as JsonObject, components, visiting)
            : entry
      )
      continue
    }
    if (value && typeof value === 'object') {
      out[key] = inlineReferences(value as JsonObject, components, visiting)
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * 参数根由本仓库拼出：按名传参、只列已声明参数、根上禁止多余字段。
 * 被一律拒绝的参数（caller/on/parent/…）不进 schema：控制端不该看到一个调不通的可选参数。
 */
function paramsSchema(method: JsonObject, budget: AnnotationBudget, components: JsonObject): JsonObject {
  const list = method.params
  if (!Array.isArray(list)) {
    fail('herdr_core_schema_invalid')
  }
  const properties: JsonObject = {}
  const required: string[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('herdr_core_schema_invalid')
    }
    const param = entry as JsonObject
    if (typeof param.name !== 'string' || !param.schema || typeof param.schema !== 'object') {
      fail('herdr_core_schema_invalid')
    }
    if (HERDR_CORE_BLOCKED_PARAMS.includes(param.name)) {
      // 审核表里一律拒绝的参数不出现在控制端的参数清单里。
      continue
    }
    if (Object.hasOwn(properties, param.name)) {
      fail('herdr_core_schema_invalid')
    }
    properties[param.name] = transform(param.schema as JsonObject, { nodes: 0, budget })
    if (param.required === true) {
      required.push(param.name)
    }
  }
  // 控制档的终端栅栏字段由 rovloom 追加：调用方必须带它认定的 (core_id, created_ms)，
  // core 不认识这两个字段，执行端在发请求前显式剥离（不依赖 core 静默忽略未知字段）。
  const name = method.name
  if (name === 'terminal.run') {
    // 模板形态由调用方显式声明，执行端据此用 templates.list 核对 argv[0]。
    if (Object.hasOwn(properties, 'template')) {
      fail('herdr_core_schema_invalid')
    }
    properties.template = { type: 'boolean' }
    // 父终端的栅栏：与地址一起给出调用方认定的 created_ms；只在带 parent 时必需（审核函数里核对）。
    if (Object.hasOwn(properties, 'parent_created_ms')) {
      fail('herdr_core_schema_invalid')
    }
    properties.parent_created_ms = { type: 'integer', minimum: 0, format: 'uint64' }
  }
  // machine.exec 的 timeout 在 OpenRPC 里是可选的（core 默认 60 秒），但 rovloom 要求显式给出；
  // 参数根也标成 required，控制端在 describe 里就能看到这个约束。
  if (name === 'machine.exec' && !required.includes('timeout')) {
    required.push('timeout')
  }
  // core 生命周期没有原生参数，只有 rovloom 自有的 core_id 栅栏。
  if (name === 'server.restart' || name === 'server.stop') {
    if (Object.hasOwn(properties, 'core_id')) {
      fail('herdr_core_schema_invalid')
    }
    properties.core_id = { type: 'string', pattern: '^[a-f0-9]{8,64}$' }
    required.push('core_id')
  }
  if (typeof name === 'string' && herdrCoreControl(name)) {
    for (const field of HERDR_CORE_FENCE_PARAMS) {
      if (Object.hasOwn(properties, field)) {
        fail('herdr_core_schema_invalid')
      }
      properties[field] =
        field === 'core_id'
          ? { type: 'string', pattern: '^[a-f0-9]{8,64}$' }
          : { type: 'integer', minimum: 0, format: 'uint64' }
      required.push(field)
    }
  }
  return inlineReferences(
    {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false
    },
    components
  )
}

/** 结果按方法声明的成功类型收紧；上游已证实的缺陷只按表放宽。 */
function resultSchema(
  root: JsonObject,
  name: string,
  method: JsonObject,
  components: JsonObject,
  budget: AnnotationBudget
): JsonObject {
  const result = method.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('herdr_core_schema_invalid')
  }
  const schema = (result as JsonObject).schema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    fail('herdr_core_schema_invalid')
  }
  const resolved = transform(schema as JsonObject, { nodes: 0, budget })
  const relaxed = RESULT_REQUIRED_RELAXED[name]
  const ref = resolved.$ref
  const target = typeof ref === 'string' ? (components[ref.split('/').at(-1)!] as JsonObject | undefined) : undefined
  if (relaxed && target && Array.isArray(target.required)) {
    // 只对这一条按真实样本放宽；改的是本仓库注册的副本，不动发布文档。
    target.required = (target.required as string[]).filter(
      /** 只去掉有证据的字段，其它 required 保持不变。 */ (field) => !relaxed.includes(field)
    )
    if (!(target.required as string[]).length) {
      delete target.required
    }
  }
  return resolved
}

const INTEGER_FORMATS = new Set(['uint', 'uint64', 'uint32', 'uint16', 'uint8', 'int32'])

/** Ajv 错误映射到公共诊断的闭合规则集；不回显请求值。 */
function issue(error: ErrorObject): ParameterDiagnostic['issues'][number] {
  const missing = (error.params as { missingProperty?: unknown }).missingProperty
  if (error.keyword === 'required' && typeof missing === 'string') {
    return { path: `/${missing}`, rule: 'required' }
  }
  const rule: ParameterIssueRule =
    error.keyword === 'pattern'
      ? 'pattern'
      : error.keyword === 'enum' || error.keyword === 'const'
        ? 'one_of'
        : error.keyword === 'minimum' ||
            error.keyword === 'maximum' ||
            error.keyword === 'exclusiveMinimum' ||
            error.keyword === 'exclusiveMaximum' ||
            (error.keyword === 'format' && INTEGER_FORMATS.has(String(error.params.format)))
          ? 'range'
          : 'invalid_value'
  return { path: error.instancePath || '/', rule }
}

/** 参数拒绝只给固定路径与规则，不带原生值、参数正文或底层文本。 */
function preflight(validate: ValidateFunction): never {
  const issues = (validate.errors ?? []).slice(0, ISSUE_LIMIT).map(issue)
  throw new NativeRequestPreflightError({ issues })
}

/**
 * 编译审核校验器。只编译本仓库方法表里声明的方法；表外方法即使文档里有也不进入契约。
 */
export function compileHerdrCoreContract(input: string | Uint8Array): HerdrCoreContract {
  const root = document(input)
  const methods = new Map<string, JsonObject>()
  for (const entry of root.methods as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('herdr_core_schema_invalid')
    }
    const method = entry as JsonObject
    const name = method.name
    if (typeof name !== 'string' || method.paramStructure !== 'by-name') {
      fail('herdr_core_schema_invalid')
    }
    if (!Object.hasOwn(HERDR_CORE_METHODS, name)) {
      continue
    }
    if (methods.has(name)) {
      fail('herdr_core_schema_invalid')
    }
    methods.set(name, method)
  }
  // 方法表里每个方法都必须能在文档里找到，缺项说明文档与审核表不一致。
  for (const name of Object.keys(HERDR_CORE_METHODS)) {
    if (!methods.has(name)) {
      fail('herdr_core_schema_method_missing')
    }
  }
  const budget: AnnotationBudget = { bytes: 0 }
  const components: JsonObject = {}
  for (const [name, schema] of Object.entries((root.components as JsonObject).schemas as JsonObject)) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      fail('herdr_core_schema_invalid')
    }
    components[name] = transform(schema as JsonObject, { nodes: 0, budget })
  }
  const params = new Map<string, JsonObject>()
  const results = new Map<string, JsonObject>()
  const descriptions = new Map<string, string>()
  for (const [name, method] of methods) {
    params.set(name, paramsSchema(method, budget, components))
    // rpc.discover 的结果引用外部 meta schema，本仓库不解析也不冒称已审核。
    results.set(
      name,
      name === 'rpc.discover' ? { type: 'object' } : resultSchema(root, name, method, components, budget)
    )
    if (method.description !== undefined) {
      descriptions.set(name, annotation(method.description))
      budget.bytes += Buffer.byteLength(descriptions.get(name)!)
      if (budget.bytes > HERDR_CORE_DESCRIPTIONS_MAX_BYTES) {
        fail('herdr_core_schema_text_too_large')
      }
    }
  }
  const ajv = new Ajv2020(AJV_OPTIONS)
  try {
    ajv.addSchema({ $id: SCHEMA_URI, $defs: components })
  } catch {
    fail('herdr_core_schema_ref_unsupported')
  }
  for (const [name, minimum, maximum] of [
    ['uint', 0, Number.MAX_SAFE_INTEGER],
    ['uint64', 0, Number.MAX_SAFE_INTEGER],
    ['uint32', 0, 4294967295],
    ['uint16', 0, 65535],
    ['uint8', 0, 255],
    ['int32', -2147483648, 2147483647]
  ] as const) {
    ajv.addFormat(name, {
      type: 'number',
      validate: /** 保留原生整数上下界，同时拒绝精度损失。 */ (value: number) =>
        Number.isSafeInteger(value) && value >= minimum && value <= maximum
    })
  }
  ajv.addFormat('double', { type: 'number', validate: Number.isFinite })
  ajv.addFormat('float', { type: 'number', validate: Number.isFinite })
  const compiledParams = new Map<string, ValidateFunction>()
  const compiledResults = new Map<string, ValidateFunction>()
  try {
    for (const [name, schema] of params) {
      compiledParams.set(name, ajv.compile(schema))
    }
    for (const [name, schema] of results) {
      compiledResults.set(name, ajv.compile(schema))
    }
  } catch {
    // 不可解析的引用或不可编译的文档一律当作契约不符，不退化成宽松校验。
    fail('herdr_core_schema_compile_failed')
  }
  /** 只返回本次传入的方法，表外方法与未知方法都明确拒绝。 */
  function pick<T>(table: Map<string, T>, method: string): T {
    const value = table.get(method)
    if (!value) {
      fail('herdr_core_schema_method_missing')
    }
    return value
  }
  const version = (root.info as JsonObject).version as string
  return Object.freeze({
    identity: herdrCoreContractIdentity(root),
    version,
    methods: Object.freeze([...methods.keys()]),
    paramsSchema: /** 只交付已展开的副本，调用方不能改已编译校验器。 */ (method: string) =>
      structuredClone(pick(params, method)),
    /** core 自己写的方法说明（只做注释）；没有说明时返回 null，不编造。 */
    methodDescription: (method: string) => descriptions.get(method) ?? null,
    resultSchema: /** 同上；结果 schema 已逐层收紧。 */ (method: string) => structuredClone(pick(results, method)),
    validateParams: /** 先有界序列化再校验，避免把巨大对象交给 Ajv。 */ (method: string, input: unknown) => {
      const value = parseJson(boundedJson(input, HERDR_CORE_SCHEMA_INPUT_LIMIT))
      const validate = pick(compiledParams, method)
      if (!validate(value)) {
        preflight(validate)
      }
      return value as JsonObject
    },
    validateResult: /** 结果同样有界；不合格结果是协议不符，不能当作空成功。 */ (method: string, input: unknown) => {
      const value = parseJson(boundedJson(input, HERDR_CORE_SCHEMA_INPUT_LIMIT))
      const validate = pick(compiledResults, method)
      if (!validate(value)) {
        throw new ProviderAdapterError('herdr_core_result_invalid')
      }
      return value as JsonObject
    }
  })
}

/** 文档字节的摘要，用于记录本次实际加载的 schema 来源。 */
export function herdrCoreSchemaDigest(input: string | Uint8Array): string {
  return hash(typeof input === 'string' ? input : Buffer.from(input))
}
