// 维护固定工具目录、严格参数 schema 和 JSON 预算；原生契约与授权仍由业务服务负责。
import { Ajv } from 'ajv'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ToolArguments, ToolName } from './types.js'
import { canonical } from '../contracts.js'
import { cliMessages, type CliLanguage, type MessageKey } from '../cli/messages.js'

export { MCP_REVISION, PRODUCT_VERSION } from './version.js'
export const MAX_MCP_BYTES = 65_536
export const MAX_RESULT_BYTES = 16_384
export const MAX_WAIT_MS = 5_000
export const TOOLS_PAGE_SIZE = 5

const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' }
const text = { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }
const cursor = { type: 'string', minLength: 1, maxLength: 1024 }
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const wait = { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS }
const page = { cursor, limit: { type: 'integer', minimum: 1, maximum: 100 } }
const object = /* 构造拒绝额外字段的对象 schema，保持声明和实际参数校验一致。 */ (
  properties: Record<string, object>,
  required: string[] = []
) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false
})
const target = {
  oneOf: [
    object({ machine_id: id, provider_id: id, profile: { const: 'session' }, session: text }, [
      'machine_id',
      'provider_id',
      'profile',
      'session'
    ]),
    object({ machine_id: id, provider_id: id, profile: { const: 'host' } }, ['machine_id', 'provider_id', 'profile'])
  ]
}
const targetProperties = { target, expected_binding_revision: revision }
const targetRequired = ['target', 'expected_binding_revision']

const schemas: Record<ToolName, Tool['inputSchema']> = {
  machines_list: object(page),
  machines_get: {
    ...object({ machine_id: id, name: text }),
    oneOf: [
      { properties: { machine_id: id }, required: ['machine_id'] },
      { properties: { name: text }, required: ['name'] }
    ]
  },
  providers_list: object({ machine_id: id, ...page }, ['machine_id']),
  providers_get: object({ machine_id: id, provider_id: id }, ['machine_id', 'provider_id']),
  runtime_discover: object({ ...targetProperties, ...page }, targetRequired),
  runtime_describe: object({ ...targetProperties, method: text }, [...targetRequired, 'method']),
  runtime_call: object(
    {
      ...targetProperties,
      contract_ref: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      native_request: object({ method: text, params: {} }, ['method']),
      deadline: revision,
      wait_ms: wait,
      validation: { enum: ['strict', 'raw-contract'] },
      client_request_key: id
    },
    [...targetRequired, 'contract_ref', 'native_request', 'deadline']
  ),
  runtime_call_get: object({ call_id: id, wait_ms: wait }, ['call_id']),
  runtime_call_cancel: object({ call_id: id }, ['call_id']),
  runtime_result_read: object(
    { result_id: id, cursor, max_bytes: { type: 'integer', minimum: 1, maximum: MAX_RESULT_BYTES } },
    ['result_id']
  ),
  runtime_response_discard: object({ call_id: id }, ['call_id'])
}

// 工具描述按显示语言取自共享词典；键名与 ToolName 一一对应，缺省英文。
export function toolDescription(name: ToolName, language: CliLanguage = 'en'): string {
  return cliMessages(language)[('mcp.tool.' + name) as MessageKey]
}

const readOnly = new Set<ToolName>([
  'machines_list',
  'machines_get',
  'providers_list',
  'providers_get',
  'runtime_discover',
  'runtime_describe',
  'runtime_call_get',
  'runtime_result_read'
])
const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true })
const validators = new Map(
  Object.entries(schemas).map(
    /* 预编译固定工具 schema，不允许请求临时引入外部校验规则。 */ ([name, schema]) => [name, ajv.compile(schema)]
  )
)

// 返回静态工具名称副本，供目录分页和宿主发现使用。
export function toolNames(): ToolName[] {
  return Object.keys(schemas) as ToolName[]
}

// 生成独立 schema 副本和工具元数据，外部修改不能污染运行时校验器。
export function toolDefinition(name: ToolName, language: CliLanguage = 'en'): Tool {
  return {
    name,
    description: toolDescription(name, language),
    inputSchema: structuredClone(schemas[name]),
    outputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object' },
        gateway_error: object(
          { code: { type: 'string' }, outcome: { const: 'not_dispatched' }, details: { type: 'object' } },
          ['code']
        ),
        delivery: { type: 'object' }
      },
      additionalProperties: false,
      anyOf: [{ required: ['data'] }, { required: ['gateway_error'] }]
    },
    annotations: {
      readOnlyHint: readOnly.has(name),
      destructiveHint: !readOnly.has(name),
      // 原生方法的幂等性必须由服务核验，不能按工具名推断。
      idempotentHint: readOnly.has(name),
      openWorldHint: true
    }
  }
}

// 只认可目录自有名称，避免继承属性被当成工具。
export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name)
}

// 复制并有界校验 JSON 参数，拒绝访问器与循环，再补充保守等待默认值。
export function parseToolArguments<K extends ToolName>(name: K, value: unknown): ToolArguments[K] {
  // 复用现有 JSON 边界；不触发 getter，也不允许后续共享对象改变请求。
  const encoded = canonical(value)
  if (Buffer.byteLength(encoded) > MAX_MCP_BYTES) {
    throw new Error('invalid_arguments')
  }
  const snapshot: unknown = JSON.parse(encoded)
  if (!validators.get(name)?.(snapshot)) {
    throw new Error('invalid_arguments')
  }
  const args = snapshot as Record<string, unknown>
  if (name === 'runtime_call') {
    // validation 不在此补默认：Luvus 通用方法须用 raw-contract，由准入按 provider 和方法选择。
    args.wait_ms ??= 0
  }
  if (name === 'runtime_call_get') {
    args.wait_ms ??= 0
  }
  if (name === 'runtime_result_read') {
    args.max_bytes ??= 4096
  }
  return args as ToolArguments[K]
}
