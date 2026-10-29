/** 从已安装 Herdr 的官方 request 根描述窗口与 Agent 操作，描述数据和执行校验共用同一来源。 */
import type { HerdrInstallation } from './installation.js'
import { HERDR_READONLY_REVIEW, isReviewedHerdrSource } from './review.js'
import { herdrResponseRule } from './methods.js'
import { boundedJson, contractRef, fail, object, uint, validateTarget } from '../../wire/index.js'
import type { ContractSource, JsonObject, V2Target } from '../../wire/types.js'

/** 可选分支先按普通对象读取，未知形状只影响该分支。 */
function schemaObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

/** 只解析本文件内的纯引用分支；循环、外部引用和附加约束均不能被忽略后冒称已理解。 */
function localBranch(document: JsonObject, input: unknown): JsonObject | undefined {
  let branch = schemaObject(input)
  const visited = new Set<string>()
  while (branch?.$ref !== undefined) {
    const ref = branch.$ref
    if (
      typeof ref !== 'string' ||
      !ref.startsWith('#/') ||
      /~(?![01])|%/.test(ref) ||
      visited.has(ref) ||
      visited.size >= 32 ||
      Object.keys(branch).some(
        /** 引用旁的断言不能被目录提取器丢弃。 */ (key) => !['$ref', '$comment', 'title', 'description'].includes(key)
      )
    ) {
      return undefined
    }
    visited.add(ref)
    let value: unknown = document
    for (const token of ref.slice(2).split('/')) {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~')
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
        return undefined
      }
      value = (value as JsonObject)[key]
    }
    branch = schemaObject(value)
  }
  return branch
}

/** 从实际 union 提取唯一方法；无法理解或歧义分支不替代其它健康方法。 */
function methodBranches(document: JsonObject): Map<string, JsonObject> {
  const request = object(object(document.schemas).request)
  if (!Array.isArray(request.oneOf)) {
    fail('herdr_schema_root_unavailable')
  }
  const methods = new Map<string, JsonObject>()
  const seen = new Set<string>()
  for (const value of request.oneOf) {
    const branch = localBranch(document, value)
    const properties = schemaObject(branch?.properties)
    const method = schemaObject(properties?.method)?.const
    if (!branch || typeof method !== 'string') {
      continue
    }
    if (seen.has(method)) {
      methods.delete(method)
    } else {
      methods.set(method, branch)
      seen.add(method)
    }
  }
  return methods
}

/** 只重定位实际参数引用闭包，无法准确描述的单个方法不进入目录。 */
function branchParams(document: JsonObject, branch: JsonObject): JsonObject | undefined {
  const request = object(object(document.schemas).request)
  const definitions = schemaObject(request.$defs) ?? {}
  const selected = structuredClone(schemaObject(branch.properties)?.params)
  if (!schemaObject(selected)) {
    return undefined
  }
  const defs: JsonObject = {}
  const visited = new Set<string>()

  /** 保留递归、枚举、必填项及数字边界，不生成宽松替代 schema。 */
  function relocate(value: unknown): boolean {
    if (Array.isArray(value)) {
      return value.every(relocate)
    }
    if (value === null || typeof value !== 'object') {
      return true
    }
    const record = value as JsonObject
    const ref = record.$ref
    if (ref !== undefined) {
      const prefix = '#/schemas/request/$defs/'
      if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
        return false
      }
      const name = ref.slice(prefix.length)
      if (!Object.hasOwn(definitions, name)) {
        return false
      }
      record.$ref = '#/$defs/' + name
      if (!visited.has(name)) {
        visited.add(name)
        defs[name] = structuredClone(definitions[name])!
        if (!relocate(defs[name])) {
          return false
        }
      }
    }
    return Object.values(record).every(relocate)
  }
  return relocate(selected) ? { ...object(selected), $schema: document.$schema!, $defs: defs } : undefined
}

/** 运行时行窗口只属于这两个原生读取方法；它是原生运行时约束而非 params_schema 上界，describe 与拒绝诊断共用此处。 */
export function herdrLineWindow(method: string) {
  return method === 'pane.read' || method === 'agent.read'
    ? ({ parameter: 'lines', selection: 'last_lines', native_max_lines: 1000, guarantees_frame_fit: false } as const)
    : undefined
}

/** 仅为方法描述重定位官方参数引用，执行时仍使用原始完整安装 schema。 */
export function describeHerdrParams(document: JsonObject, method: string): JsonObject {
  const branch = methodBranches(document).get(method)
  if (!branch) {
    fail('herdr_method_unreviewed')
  }
  const params = branchParams(document, branch)
  if (!params) {
    fail('herdr_schema_reference_unavailable')
  }
  return params
}

/** 纯展示函数保留本机安装或配置契约的证据边界；不发行来源品牌、派发或读取许可。 */
export function describeHerdrContract(
  input: Readonly<{
    target: V2Target
    binding_revision: number
    source: ContractSource
    document: JsonObject
    source_basis: 'local_installation' | 'configured_connector_contract'
  }>
) {
  validateTarget(input.target)
  uint(input.binding_revision, true)
  if (!isReviewedHerdrSource(input.source)) {
    fail('herdr_contract_unreviewed')
  }
  const { source, document } = input
  const branches = methodBranches(document)
  return {
    target: structuredClone(input.target),
    binding_revision: input.binding_revision,
    provider_kind: 'herdr' as const,
    contract_ref: contractRef(source),
    source: structuredClone(source),
    source_basis: input.source_basis,
    methods: HERDR_READONLY_REVIEW.methods.flatMap(
      /** 可选或不兼容方法独立隐藏；健康描述携带真实参数与原生结果类型。 */ (method) => {
        const branch = branches.get(method)
        const params = branch && branchParams(document, branch)
        return params
          ? [
              {
                method,
                params_schema: params,
                response_types: herdrResponseRule(method),
                transport: 'rpc',
                limits: {
                  request_frame_bytes: HERDR_READONLY_REVIEW.frame_bytes,
                  response_frame_bytes: HERDR_READONLY_REVIEW.frame_bytes,
                  frame_size_basis: 'utf8_json_including_lf',
                  response_pagination: 'unavailable',
                  response_objects: false,
                  ...(herdrLineWindow(method) ? { line_window: herdrLineWindow(method) } : {})
                },
                completion:
                  method === 'agent.prompt' || method === 'agent.wait' ? 'native_agent_state_only' : 'native_response'
              }
            ]
          : []
      }
    )
  }
}

/** 描述精确配置目标的已接入操作；当前 caller 可见性仍由原 Gateway 宿主逐次过滤。 */
export function describeHerdrTarget(installation: HerdrInstallation, target: V2Target) {
  if (boundedJson(target) !== boundedJson(installation.config.target)) {
    fail('herdr_local_binding_mismatch')
  }
  return describeHerdrContract({
    target,
    binding_revision: installation.config.binding_revision,
    source: installation.record().wire.source,
    document: installation.schemaDocument(),
    source_basis: 'local_installation'
  })
}
