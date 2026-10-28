// Worker 内执行完整 schema 预检与 Ajv 编译，输出有界 standalone 生成物。
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema, ValidateFunction } from 'ajv'
import { attempt, ContractFault, equal, fail, hash, limits, object, parse, pointer, snapshot, text } from './json.js'
import { UHP } from './internal.js'
import standaloneModule from 'ajv/dist/standalone/index.js'
import { AJV_OPTIONS, AJV_VERSION, ARTIFACT_VERSION, CODE_LIMIT, GENERATOR_VERSION } from './compiler-protocol.js'
import type { CompilerArtifact } from './compiler-protocol.js'
import ajvPackage from 'ajv/package.json' with { type: 'json' }
import type { Check, CompileOptions, ContractIdentity, JsonObject, Limits } from './types.js'

const DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const ANNOTATIONS = new Set([
  '$id',
  '$schema',
  '$ref',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'const',
  'enum',
  'type',
  'required',
  'dependentRequired',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties'
])
const MAPS = new Set(['$defs', 'properties', 'patternProperties', 'dependentSchemas'])
const ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SINGLES = new Set(['if', 'then', 'else', 'not', 'items', 'additionalProperties', 'contains', 'propertyNames'])
// 将字段名转义为 JSON Pointer 路径片段。
const escaped = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

type SchemaEdges = Map<string, Array<{ key: string; weight: number }>>

// 预检文档闭包中的关键字、引用目标与引用预算，再检查图中的环和深度。
function preflight(documents: Record<string, unknown>, budget: Limits): void {
  const edges: SchemaEdges = new Map()
  let refs = 0
  // 登记 schema 节点及结构或引用边，遇到不支持的语义立即拒绝。
  const visit = (schema: unknown, uri: string, path: string): string => {
    const key = uri + '#' + path
    const next: Array<{ key: string; weight: number }> = []
    edges.set(key, next)
    if (typeof schema === 'boolean') {
      return key
    }
    const value = object(schema, 'schema_unavailable')
    // 安装版保留了未引用的属性字典；它不是可执行参数 schema，禁止 $ref 指向它。
    if (uri === `${UHP}schema/terminal/common.schema.json` && path === '/$defs/locatorProperties') {
      if (!equal(Object.keys(value).sort(), ['expected_root', 'pane_id', 'server_generation', 'terminal_id'])) {
        fail('schema_unavailable', 'compile', 'unsupported_keyword')
      }
      for (const [name, nested] of Object.entries(value)) {
        next.push({ key: visit(nested, uri, `${path}/${name}`), weight: 0 })
      }
      return key
    }
    if (path && Object.hasOwn(value, '$id')) {
      fail('schema_unavailable', 'compile', 'unsupported_reference')
    }
    if (value.$schema !== undefined && value.$schema !== DIALECT) {
      fail('schema_unavailable', 'compile', 'unsupported_dialect')
    }
    for (const [keyword, child] of Object.entries(value)) {
      if (!ANNOTATIONS.has(keyword) && !MAPS.has(keyword) && !ARRAYS.has(keyword) && !SINGLES.has(keyword)) {
        fail(
          'schema_unavailable',
          'compile',
          keyword.includes('Ref') || keyword.includes('Anchor') ? 'unsupported_reference' : 'unsupported_keyword'
        )
      }
      if (MAPS.has(keyword)) {
        for (const [name, nested] of Object.entries(object(child, 'schema_unavailable'))) {
          next.push({
            key: visit(nested, uri, `${path}/${escaped(keyword)}/${escaped(name)}`),
            weight: 0
          })
        }
      } else if (ARRAYS.has(keyword)) {
        if (!Array.isArray(child)) {
          fail('schema_unavailable', 'compile', 'invalid_schema')
        }
        child.forEach(
          /* 遍历组合 schema 数组，将每项登记为零权重结构边。 */ (nested, i) =>
            next.push({ key: visit(nested, uri, `${path}/${keyword}/${i}`), weight: 0 })
        )
      } else if (SINGLES.has(keyword)) {
        next.push({ key: visit(child, uri, `${path}/${keyword}`), weight: 0 })
      }
    }
    if (value.$ref !== undefined) {
      if (++refs > budget.references) {
        fail('schema_unavailable', 'compile', 'reference_limit')
      }
      let resolved: URL
      try {
        resolved = new URL(text(value.$ref, 'schema_unavailable'), uri)
      } catch {
        fail('schema_unavailable', 'compile', 'unsupported_reference')
      }
      const fragment = resolved.hash.slice(1)
      resolved.hash = ''
      const targetUri = resolved.href
      if (!Object.hasOwn(documents, targetUri)) {
        fail('schema_unavailable', 'compile', 'missing_document')
      }
      let fragmentPath: string
      try {
        fragmentPath = decodeURIComponent(fragment)
      } catch {
        fail('schema_unavailable', 'compile', 'missing_fragment')
      }
      if (targetUri === `${UHP}schema/terminal/common.schema.json` && fragmentPath === '/$defs/locatorProperties') {
        fail('schema_unavailable', 'compile', 'unsupported_reference')
      }
      pointer(documents[targetUri], fragmentPath)
      next.push({ key: targetUri + '#' + fragmentPath, weight: 1 })
    }
    return key
  }

  for (const [uri, schema] of Object.entries(documents)) {
    visit(schema, uri, '')
  }
  checkReferenceDepth(edges, budget.reference_depth)
}

// 结构边权重为 0，$ref 边权重为 1；限制引用链长度，同时拒绝任何递归环。
function checkReferenceDepth(edges: SchemaEdges, maxDepth: number): void {
  const active = new Set<string>()
  const lengths = new Map<string, number>()
  type Walk = { key: string; index: number; longest: number; references: number; weight: number }
  for (const key of edges.keys()) {
    if (lengths.has(key)) {
      continue
    }
    const stack: Walk[] = [{ key, index: 0, longest: 0, references: 0, weight: 0 }]
    active.add(key)
    // 显式栈避免合法结构嵌套叠加引用后耗尽 JS 调用栈；引用预算在下行时就拒绝。
    while (stack.length) {
      const current = stack[stack.length - 1]!
      const next = edges.get(current.key)
      if (!next) {
        fail('schema_unavailable', 'compile', 'missing_fragment')
      }
      const edge = next[current.index++]
      if (!edge) {
        lengths.set(current.key, current.longest)
        active.delete(current.key)
        stack.pop()
        const parent = stack[stack.length - 1]
        if (parent) {
          parent.longest = Math.max(parent.longest, current.weight + current.longest)
        }
        continue
      }
      if (active.has(edge.key)) {
        fail('schema_unavailable', 'compile', 'reference_cycle')
      }
      const references = current.references + edge.weight
      const cached = lengths.get(edge.key)
      if (references + (cached ?? 0) > maxDepth) {
        fail('schema_unavailable', 'compile', 'reference_limit')
      }
      if (cached !== undefined) {
        current.longest = Math.max(current.longest, edge.weight + cached)
      } else {
        active.add(edge.key)
        stack.push({ key: edge.key, index: 0, longest: 0, references, weight: edge.weight })
      }
    }
  }
}

// 核对 bundle 的重复入口均与文档表一致，并限制为当前 Luvus UHP 协议版本。
function aliases(bundle: JsonObject, docs: Record<string, unknown>): void {
  // 要求别名目标存在且内容完全相同，防止别名与实际编译文档分叉。
  const same = (uri: string, value: unknown) => {
    if (!Object.hasOwn(docs, uri) || !equal(value, docs[uri])) {
      fail('schema_unavailable', 'compile', 'alias_mismatch')
    }
  }
  for (const key of ['request', 'response', 'event', 'event_catalog']) {
    if ((key === 'event' || key === 'event_catalog') && bundle[key] === undefined) {
      continue
    }
    const value = object(bundle[key], 'schema_unavailable')
    same(text(value.$id, 'schema_unavailable'), value)
  }
  const terminal = bundle.terminal === undefined ? undefined : object(bundle.terminal, 'schema_unavailable')
  if (terminal) {
    for (const [uri, value] of Object.entries(object(terminal.documents, 'schema_unavailable'))) {
      same(uri, value)
    }
    for (const key of ['request', 'response', 'event', 'control_frame']) {
      const value = object(terminal[key], 'schema_unavailable')
      same(text(value.$id, 'schema_unavailable'), value)
    }
    for (const [name, value] of Object.entries(object(terminal.methods, 'schema_unavailable'))) {
      same(`${UHP}schema/terminal/methods/${name.replace(/_/g, '-')}.schema.json`, value)
    }
  }
  if (bundle.access !== undefined) {
    const access = object(bundle.access, 'schema_unavailable')
    const descriptor = object(access.descriptor, 'schema_unavailable')
    same(text(descriptor.$id, 'schema_unavailable'), descriptor)
  }
  const protocol = object(bundle.protocol, 'schema_unavailable')
  if (
    protocol.name !== 'luvus-uhp' ||
    protocol.major !== 1 ||
    !Number.isSafeInteger(protocol.minor) ||
    (protocol.minor as number) < 0 ||
    (terminal && !equal(terminal.protocol, bundle.protocol))
  ) {
    fail('schema_unavailable', 'compile', 'incompatible_protocol')
  }
}

// 只在 Worker 内校验完整闭包并生成官方 standalone 代码，不生成宿主权限句柄。
export function compileArtifact(bytes: Uint8Array | string, options: CompileOptions): Check<CompilerArtifact> {
  const result = attempt<CompilerArtifact>(
    'compile',
    /* 依次完成预算校验、文档预检和 Ajv 编译，成功后登记方法分支覆盖信息。 */ () => {
      if (ajvPackage.version !== AJV_VERSION) {
        fail('schema_unavailable', 'compile', 'compiler_version_mismatch')
      }
      const budget = limits(options.limits)
      const identity = object(snapshot(options.identity), 'schema_unavailable') as unknown as ContractIdentity
      if (
        !identity ||
        !/^[a-f0-9]{64}$/.test(identity.binary_sha256) ||
        !/^[a-f0-9]{64}$/.test(identity.schema_sha256) ||
        typeof identity.revision !== 'string' ||
        !identity.revision.length ||
        identity.revision.length > 128
      ) {
        fail('schema_unavailable', 'compile', 'invalid_identity')
      }
      let bundle: JsonObject
      try {
        bundle = object(
          parse(bytes, {
            ...budget,
            object_bytes: budget.bundle_bytes,
            object_nodes: budget.bundle_nodes
          }),
          'schema_unavailable'
        )
      } catch (error) {
        if (error instanceof ContractFault) {
          fail(
            'schema_unavailable',
            'compile',
            error.failure.code === 'object_limit'
              ? 'bundle_limit'
              : error.failure.code === 'schema_unavailable'
                ? 'invalid_schema'
                : error.failure.code
          )
        }
        throw error
      }
      if (hash(bytes) !== identity.schema_sha256) {
        fail('schema_unavailable', 'compile', 'digest_mismatch')
      }
      const documents = object(bundle.documents, 'schema_unavailable')
      const entries = Object.entries(documents)
      if (!entries.length || entries.length > budget.documents) {
        fail('schema_unavailable', 'compile', 'document_limit')
      }
      const ids = new Set<string>()
      for (const [uri, value] of entries) {
        if (
          !uri.startsWith(UHP) ||
          new URL(uri).href !== uri ||
          new URL(uri).hash ||
          new URL(uri).search ||
          Buffer.byteLength(JSON.stringify(value)) > budget.document_bytes
        ) {
          fail('schema_unavailable', 'compile', 'invalid_document')
        }
        const doc = object(value, 'schema_unavailable')
        const id = doc.$id ?? uri
        if (typeof id !== 'string' || ids.has(id)) {
          fail('schema_unavailable', 'compile', 'duplicate_id')
        }
        ids.add(id)
        if (id !== uri) {
          fail('schema_unavailable', 'compile', 'duplicate_id')
        }
        if (doc.$schema !== DIALECT) {
          fail('schema_unavailable', 'compile', 'unsupported_dialect')
        }
      }

      // 只在已提供的文档闭包内解析引用；预检和别名核对完成后才交给 Ajv。
      preflight(documents, budget)
      aliases(bundle, documents)
      const validators = new Map<string, ValidateFunction>()
      const ajv = new Ajv2020(AJV_OPTIONS)
      try {
        for (const [uri, doc] of entries) {
          ajv.addSchema(doc as AnySchema, uri)
        }
        for (const [uri] of entries) {
          const validate = ajv.getSchema(uri)
          if (!validate) {
            fail('schema_unavailable', 'compile', 'invalid_schema')
          }
          validators.set(uri, validate)
        }
        const catalog: JsonObject =
          bundle.event_catalog === undefined ? { properties: {} } : object(bundle.event_catalog, 'schema_unavailable')
        for (const name of Object.keys(object(catalog.properties, 'schema_unavailable'))) {
          // 片段只编译一次，standalone 复用同一缓存；全部完整根仍已编译。
          const check = ajv.getSchema(`${text(catalog.$id, 'schema_unavailable')}#/properties/${escaped(name)}`)
          if (!check) {
            fail('schema_unavailable', 'compile', 'invalid_schema')
          }
          validators.set(`event:${name}`, check)
        }
      } catch (error) {
        if (error instanceof ContractFault) {
          throw error
        }
        fail('schema_unavailable', 'compile', 'invalid_schema')
      }
      const request = object(bundle.request, 'schema_unavailable')
      const props = object(request.properties, 'schema_unavailable')
      const methodEnum = object(props.method, 'schema_unavailable').enum
      if (
        !Array.isArray(methodEnum) ||
        methodEnum.some(/* 发现方法枚举中不是字符串的条目。 */ (m) => typeof m !== 'string') ||
        new Set(methodEnum).size !== methodEnum.length
      ) {
        fail('schema_unavailable', 'compile', 'invalid_method_catalog')
      }

      // 空分支表示仅有 generic params，不能因方法在 enum 中就声称参数完整校验。
      const requestMethods = methodEnum as readonly string[]
      const branches = new Map<string, readonly string[]>()
      if (!Array.isArray(request.allOf)) {
        fail('schema_unavailable', 'compile', 'invalid_method_catalog')
      }
      for (const method of requestMethods) {
        const paths: string[] = []
        request.allOf.forEach(
          /* 为当前方法收集命中的条件分支路径，保留没有专用分支的参数缺口。 */ (raw, i) => {
            const condition = object(
              object(object(raw, 'schema_unavailable').if, 'schema_unavailable').properties,
              'schema_unavailable'
            ).method
            const test = object(condition, 'schema_unavailable')
            if (test.const === method || (Array.isArray(test.enum) && test.enum.includes(method))) {
              paths.push(`#/allOf/${i}`)
            }
          }
        )
        branches.set(method, Object.freeze(paths))
      }
      const exports: Record<string, string> = {}
      const schemas: Array<[string, string]> = []
      const catalog: JsonObject =
        bundle.event_catalog === undefined ? { properties: {} } : object(bundle.event_catalog, 'schema_unavailable')
      for (const key of validators.keys()) {
        const name = 'v' + schemas.length
        exports[name] = key.startsWith('event:')
          ? `${text(catalog.$id, 'schema_unavailable')}#/properties/${escaped(key.slice(6))}`
          : key
        schemas.push([key, name])
      }
      const standalone = standaloneModule as unknown as (compiler: Ajv2020, refs: Record<string, string>) => string
      let code: string
      try {
        code = standalone(ajv, exports)
      } catch {
        fail('schema_unavailable', 'compile', 'code_generation_failed')
      }
      if (Buffer.byteLength(code) > CODE_LIMIT) {
        fail('schema_unavailable', 'compile', 'generated_code_limit')
      }
      return {
        version: ARTIFACT_VERSION,
        generator: GENERATOR_VERSION,
        ajv: AJV_VERSION,
        identity,
        limits: budget,
        documents: entries.map(/* 保留完整文档目录供宿主核对导出覆盖。 */ ([uri]) => uri),
        request_methods: [...requestMethods],
        branches: [...branches].map(/* 将只读分支清单复制为纯 JSON。 */ ([name, paths]) => [name, [...paths]]),
        schemas,
        code,
        code_sha256: hash(code),
        options_sha256: hash(JSON.stringify(AJV_OPTIONS))
      }
    }
  )
  // 普通输入拒绝统一成准确编译错误；未知内部异常仍由严格宿主协议判为故障。
  if (result.ok || result.error.origin !== 'contract' || result.error.code !== 'schema_unavailable') {
    return result
  }
  return {
    ok: false,
    error: {
      origin: 'contract',
      code: 'schema_unavailable',
      stage: 'compile',
      reason: result.error.reason ?? 'invalid_schema'
    }
  }
}
