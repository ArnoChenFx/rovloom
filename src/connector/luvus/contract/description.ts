// 从真实编译句柄保留的安装原字节提取描述；不编译 schema、不建立执行许可，不把 generic 参数冒称完整。
import { contracts, UHP } from './internal.js'
import { fail, object, parse, pointer } from './json.js'
import type { CompiledContract, Json, JsonObject, MethodDescriptor } from './types.js'

const maps = new Set(['$defs', 'properties', 'patternProperties', 'dependentSchemas'])
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const singles = new Set(['if', 'then', 'else', 'not', 'items', 'additionalProperties', 'contains', 'propertyNames'])
const annotations = new Set(['$comment', 'title', 'description', 'default', 'examples'])
export type LuvusSchemaDescription = Readonly<{
  params_schema?: JsonObject
  schema_annotations?: readonly Readonly<{ document_uri: string; pointer: string; text: string }>[]
}>

/** 仅识别 JSON 对象；无法证明的投影保持缺失，执行仍用完整原 schema。 */
function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

/** 只在所有根条件均为明确方法选择器时提取参数，不忽略额外 if/else 或 envelope 级断言。 */
function parameterParts(request: JsonObject, method: string): unknown[] | undefined {
  const rootKeys = new Set([
    '$id',
    '$schema',
    '$comment',
    'title',
    'description',
    '$defs',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'allOf'
  ])
  if (Object.keys(request).some((key) => !rootKeys.has(key)) || !Array.isArray(request.allOf)) {
    return undefined
  }
  const params = record(request.properties)?.params
  if (params === undefined) {
    return undefined
  }
  const parts: unknown[] = [params]
  for (const raw of request.allOf) {
    const branch = record(raw)
    const condition = record(branch?.if)
    const properties = record(condition?.properties)
    const selector = record(properties?.method)
    if (
      !branch ||
      !condition ||
      !properties ||
      !selector ||
      Object.keys(branch).some((key) => key !== 'if' && key !== 'then' && !annotations.has(key)) ||
      Object.keys(condition).some((key) => key !== 'properties' && !annotations.has(key)) ||
      Object.keys(properties).some((key) => key !== 'method') ||
      Object.keys(selector).some((key) => key !== 'const' && key !== 'enum' && !annotations.has(key)) ||
      (selector.const === undefined) === (selector.enum === undefined)
    ) {
      return undefined
    }
    if (selector.const !== method && !(Array.isArray(selector.enum) && selector.enum.includes(method))) {
      continue
    }
    const then = record(branch.then)
    const fields = record(then?.properties)
    if (
      !then ||
      !fields ||
      fields.params === undefined ||
      Object.keys(then).some((key) => key !== 'properties' && key !== 'required' && !annotations.has(key)) ||
      Object.keys(fields).some((key) => key !== 'params') ||
      (then.required !== undefined && (!Array.isArray(then.required) || then.required.some((key) => key !== 'params')))
    ) {
      return undefined
    }
    parts.push(fields.params)
  }
  return parts.length > 1 ? parts : undefined
}

/** 所有可执行引用重定位到独立 $defs，保留引用旁约束、组合条件和注释；literal 值不当作 schema 遍历。 */
function closedParameters(
  documents: ReadonlyMap<string, unknown>,
  uri: string,
  parts: unknown[],
  maximum: number
): JsonObject {
  const defs: Record<string, Json> = {}
  const relocated = new Map<string, string>()
  function walk(value: unknown, base: string): Json {
    if (typeof value === 'boolean') {
      return value
    }
    const source = object(value, 'schema_unavailable')
    const result: Record<string, Json> = {}
    for (const [key, child] of Object.entries(source)) {
      // 引用均按原文档定位后重写；无需复制资源 ID 或未被实际引用的定义。
      if (key === '$id' || key === '$defs') {
        continue
      }
      if (key === '$ref') {
        const target = new URL(String(child), base)
        const fragment = decodeURIComponent(target.hash.slice(1))
        target.hash = ''
        const address = target.href + '#' + fragment
        let name = relocated.get(address)
        if (name === undefined) {
          if (relocated.size >= maximum || !documents.has(target.href)) {
            fail('schema_unavailable', 'describe')
          }
          name = 'native_' + relocated.size
          relocated.set(address, name)
          defs[name] = walk(pointer(documents.get(target.href), fragment), target.href)
        }
        result[key] = '#/$defs/' + name
      } else if (maps.has(key)) {
        result[key] = Object.fromEntries(
          Object.entries(object(child, 'schema_unavailable')).map(([name, schema]) => [name, walk(schema, base)])
        )
      } else if (arrays.has(key)) {
        if (!Array.isArray(child)) {
          fail('schema_unavailable', 'describe')
        }
        result[key] = child.map((schema) => walk(schema, base))
      } else if (singles.has(key)) {
        result[key] = walk(child, base)
      } else {
        result[key] = structuredClone(child)
      }
    }
    return result
  }
  const allOf = parts.map((part) => walk(part, uri))
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', allOf, $defs: defs }
}

/** catalog 在当前来源和方法授权之后调用；返回独立数据，列表仍只返回原来的摘要。 */
export function describeLuvusSchema(compiled: CompiledContract, method: MethodDescriptor): LuvusSchemaDescription {
  const data = contracts.get(compiled)
  if (!data) {
    fail('schema_unavailable', 'describe')
  }
  if (!data.schemaDocuments) {
    const bundle = object(
      parse(data.schemaSource, {
        ...data.limits,
        object_bytes: data.limits.bundle_bytes,
        object_nodes: data.limits.bundle_nodes
      }),
      'schema_unavailable'
    )
    data.schemaDocuments = new Map(Object.entries(object(bundle.documents, 'schema_unavailable')))
    data.schemaSource = ''
  }
  const documents = data.schemaDocuments
  const uri = UHP + 'request.schema.json'
  const request = object(documents.get(uri), 'schema_unavailable')
  const notes: { document_uri: string; pointer: string; text: string }[] = []
  for (const name of ['request', 'response']) {
    const documentUri = UHP + name + '.schema.json'
    const document = record(documents.get(documentUri))
    for (const keyword of ['$comment', 'description']) {
      const text = document?.[keyword]
      if (typeof text === 'string') {
        notes.push({ document_uri: documentUri, pointer: '#/' + keyword, text })
      }
    }
  }
  const parts = method.schema_status === 'conditional_branch' ? parameterParts(request, method.method) : undefined
  return {
    ...(notes.length ? { schema_annotations: notes } : {}),
    ...(parts ? { params_schema: closedParameters(documents, uri, parts, data.limits.references) } : {})
  }
}
