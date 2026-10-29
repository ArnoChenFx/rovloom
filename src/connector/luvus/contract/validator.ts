// 根据固定 Luvus 契约及宿主可信来源校验能力、请求、响应与流，并管理内存许可和仅响应上下文。
import { validateTarget } from '../../../contracts.js'
import { candidates, contracts, responseContexts, SCOPES, UHP, views } from './internal.js'
import type { ResponseRules } from './internal.js'
import { attempt, equal, fail, object, snapshot, text } from './json.js'
import type {
  CapabilityView,
  CheckedRequest,
  CheckedResponse,
  CompiledContract,
  DispatchCandidate,
  DispatchPermit,
  JsonObject,
  MethodDescriptor,
  NativeBinding,
  NativeMethodContract,
  NativeValidator,
  ParameterValidation,
  RawRequestCandidate,
  TrustedNativeContext
} from './types.js'

// 拒绝未登记的契约对象，并取得已编译的校验器和固定限额。
function data(contract: CompiledContract) {
  const value = contracts.get(contract)
  if (!value) {
    fail('invalid_contract_handle')
  }
  return value
}

// 校验宿主提供的可信来源标志和 Luvus 绑定格式，并按需比较完整预期身份；本函数不执行认证。
export function verifySource(source: TrustedNativeContext, expected?: NativeBinding): NativeBinding {
  if (!source || source.authenticated !== true || source.source_verified !== true) {
    fail('native_source_untrusted', 'source')
  }
  const legacy = snapshot(source.binding) as unknown as NativeBinding
  const { caller_policy_revision: _caller, local_policy_revision: _local, ...current } = legacy
  const binding = Object.freeze(current) as NativeBinding
  if (binding.kind !== 'luvus') {
    fail('native_source_untrusted', 'source', 'runtime_kind')
  }
  if (
    !(
      typeof binding.binding_revision === 'string' &&
      binding.binding_revision.length > 0 &&
      binding.binding_revision.length <= 128
    ) &&
    !(Number.isSafeInteger(binding.binding_revision) && (binding.binding_revision as number) >= 0)
  ) {
    fail('invalid_context')
  }
  if ((binding.target as unknown as JsonObject)?.profile === 'access_machines') {
    fail('profile_not_exposed', 'binding')
  }
  validateTarget(binding.target)
  for (const field of [
    'provider_id',
    'contract_source_ref',
    'connection_epoch',
    'recovery_generation',
    'capability_revision',
    'classification_revision'
  ] as const) {
    if (typeof binding[field] !== 'string' || !binding[field].length || binding[field].length > 512) {
      fail('invalid_context')
    }
  }
  if (
    !binding.contract ||
    !/^[a-f0-9]{64}$/.test(binding.contract.binary_sha256) ||
    !/^[a-f0-9]{64}$/.test(binding.contract.schema_sha256) ||
    !binding.contract.revision
  ) {
    fail('invalid_context')
  }
  if (
    binding.target.profile === 'session'
      ? typeof binding.server_generation !== 'string' || !binding.server_generation.length
      : binding.server_generation !== null
  ) {
    fail('invalid_context')
  }
  if (expected && !equal(binding, expected)) {
    fail('native_identity_mismatch', 'binding')
  }
  return binding
}

// 按契约 URI 运行对应 schema，缺失校验器或数据不符均返回固定错误。
function validate(contract: CompiledContract, uri: string, value: unknown, code: string): void {
  const check = data(contract).validators.get(uri)
  if (!check) {
    fail('schema_unavailable', 'validation', 'missing_document')
  }
  if (!check(value)) {
    fail(code, 'schema', check.errors?.[0]?.keyword)
  }
}

// 在契约 JSON 限额内复制输入，避免后续校验依赖调用方可变对象。
function copy(contract: CompiledContract, value: unknown): JsonObject {
  return object(snapshot(value, data(contract).limits))
}

// 只接受当前契约创建的能力句柄，拒绝同形对象或另一契约的视图。
function viewData(contract: CompiledContract, view: CapabilityView) {
  const stored = views.get(view)
  if (!stored || stored.contract !== contract) {
    fail('invalid_capability_handle')
  }
  return stored
}

// 从已登记能力视图取得方法描述，未广告的方法不能进入请求校验。
function method(contract: CompiledContract, view: CapabilityView, name: string): MethodDescriptor {
  const descriptor = viewData(contract, view).methods.get(name)
  if (!descriptor) {
    fail(name.startsWith('machine.') ? 'profile_not_exposed' : 'method_not_advertised', 'discovery')
  }
  return descriptor
}

// 核对终端能力和特性列表的唯一性、字符串长度及安全整数预算，要求执行帧预算为正。
function validateTerminalCapabilities(value: JsonObject): void {
  const terminal = object(value.terminal, 'capability_invalid')
  for (const key of ['capabilities', 'features']) {
    const items = terminal[key]
    if (
      !Array.isArray(items) ||
      !items.every(
        /* 限定每个终端能力项为非空短字符串，防止任意值或超长广告进入视图。 */ (x) =>
          typeof x === 'string' && x.length > 0 && x.length <= 128
      ) ||
      new Set(items).size !== items.length
    ) {
      fail('capability_invalid', 'discovery', 'terminal')
    }
  }
  for (const source of [value.limits, terminal.limits]) {
    for (const limit of Object.values(object(source, 'capability_invalid'))) {
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
        fail('capability_invalid', 'discovery', 'limits')
      }
    }
  }
  // 这些是执行帧的硬上界；缺失或零不能解释为不设限。
  for (const limit of [
    object(value.limits).frame_bytes,
    object(terminal.limits).request_bytes,
    object(terminal.limits).response_bytes
  ]) {
    if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
      fail('capability_invalid', 'discovery', 'frame_limit')
    }
  }
}

// session 取广告中的通用帧与适用终端方向预算的较小值；host 返回 null，通用对象预算仍另行检查。
function frameBytes(
  contract: CompiledContract,
  view: CapabilityView,
  terminal: boolean,
  direction: 'request' | 'response'
): number | null {
  if (view.binding.target.profile !== 'session') {
    return null
  }
  const caps = viewData(contract, view).capabilities
  let maxBytes = object(caps.limits).frame_bytes as number
  if (terminal) {
    const limits = object(object(caps.terminal).limits)
    maxBytes = Math.min(maxBytes, limits[`${direction}_bytes`] as number)
  }
  return maxBytes
}
// 计入结尾 LF 后检查完整原生帧字节数，防止仅计算 JSON 而越过在线限额。
function frameLimit(
  contract: CompiledContract,
  view: CapabilityView,
  value: JsonObject,
  code: string,
  terminal: boolean,
  direction: 'request' | 'response'
): void {
  const maxBytes = frameBytes(contract, view, terminal, direction)
  // 固定 UHP 的完整帧包含结尾 LF。
  if (maxBytes !== null && Buffer.byteLength(JSON.stringify(value)) + 1 > maxBytes) {
    fail(code, 'validation', 'frame_limit')
  }
}

// 校验协议、目标身份、方法目录与访问提示的一致性，生成可信方法索引。
function shapeCapabilities(
  value: JsonObject,
  binding: Pick<NativeBinding, 'target' | 'server_generation'>
): Map<string, NativeMethodContract> {
  const protocol = object(value.protocol, 'capability_invalid')
  if (
    protocol.name !== 'luvus-uhp' ||
    protocol.major !== 1 ||
    !Number.isSafeInteger(protocol.minor) ||
    (protocol.minor as number) < 0
  ) {
    fail('capability_invalid', 'discovery', 'protocol')
  }
  if (
    !Array.isArray(value.methods) ||
    !value.methods.length ||
    value.methods.length > 1024 ||
    !value.methods.every(
      /* 只接受协议允许字符集与长度范围内的方法名。 */ (m) =>
        typeof m === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(m)
    ) ||
    new Set(value.methods).size !== value.methods.length ||
    !Array.isArray(value.method_contracts) ||
    value.method_contracts.length !== value.methods.length
  ) {
    fail('capability_invalid', 'discovery', 'method_catalog')
  }
  if (binding.target.profile === 'session') {
    if (
      value.type !== 'uhp_capabilities' ||
      value.session !== binding.target.session ||
      value.server_generation !== binding.server_generation
    ) {
      fail('capability_invalid', 'discovery', 'identity')
    }
  } else if (value.type !== 'uhp_host_capabilities' || value.profile !== 'host' || value.transport !== 'stdio_proxy') {
    fail('capability_invalid', 'discovery', 'profile')
  }
  const result = new Map<string, NativeMethodContract>()
  const seen = new Set<string>()
  for (const raw of value.method_contracts) {
    const row = object(raw, 'capability_invalid')
    if (typeof row.method !== 'string' || !value.methods.includes(row.method) || seen.has(row.method)) {
      fail('capability_invalid', 'discovery', 'method_contract')
    }
    seen.add(row.method)
    if (
      !SCOPES.has(row.scope as string) ||
      !['read', 'write'].includes(row.access as string) ||
      typeof row.idempotent !== 'boolean'
    ) {
      // 未理解的授权语义只隔离此方法；不能把它投影成已审核能力。
      continue
    }
    // 诊断扩展不参与授权；描述和分类仅比较明确理解的原生字段。
    result.set(row.method, {
      method: row.method,
      access: row.access,
      scope: row.scope,
      idempotent: row.idempotent
    } as NativeMethodContract)
  }
  if (value.access !== undefined) {
    const access = object(value.access, 'capability_invalid')
    const methodList = value.methods as readonly unknown[]
    if (
      !['read_only', 'control'].includes(access.mode as string) ||
      !Array.isArray(access.allowed_methods) ||
      new Set(access.allowed_methods).size !== access.allowed_methods.length ||
      !access.allowed_methods.every(
        /* 要求访问广告中的每个方法均已出现在当前方法目录中。 */ (m) => methodList.includes(m)
      )
    ) {
      fail('capability_invalid', 'discovery', 'access')
    }
  }
  if (binding.target.profile === 'session') {
    const limits = object(value.limits, 'capability_invalid')
    if (!Number.isSafeInteger(limits.frame_bytes) || (limits.frame_bytes as number) <= 0) {
      fail('capability_invalid', 'discovery', 'frame_limit')
    }
    if (value.terminal !== undefined) {
      validateTerminalCapabilities(value)
    }
  }
  return result
}

// 补充 schema 之外的 UTF-8 字节限额及请求中的原生 generation 绑定。
function requestSemantics(request: JsonObject, view: CapabilityView): void {
  const params = object(request.params, 'native_request_invalid')
  for (const [methodName, field, max] of [
    ['task.add', 'title', 256],
    ['task.add', 'prompt', 32768],
    ['task.update', 'prompt', 32768]
  ] as const) {
    if (request.method === methodName && typeof params[field] === 'string' && Buffer.byteLength(params[field]) > max) {
      fail('native_request_invalid', 'request', 'utf8_limit')
    }
  }
  if (params.server_generation !== undefined && params.server_generation !== view.binding.server_generation) {
    fail('native_identity_mismatch', 'request')
  }
}
const TERMINAL_RESULTS: Record<string, string> = {
  inventory: 'terminal_backend_inventory',
  snapshot: 'terminal_backend_snapshot',
  validate: 'terminal_backend_validation',
  processes: 'terminal_backend_processes',
  capture: 'terminal_backend_capture',
  create: 'terminal_backend_created',
  wait_change: 'terminal_backend_change',
  wait_output: 'terminal_backend_output',
  type_literal: 'terminal_backend_action',
  paste_text: 'terminal_backend_action',
  submit_text: 'terminal_backend_action',
  send_key: 'terminal_backend_action',
  set_title: 'terminal_backend_action',
  notify: 'terminal_backend_action',
  close: 'terminal_backend_action'
}

// 从候选提取结果类型及可选的三个原生身份字段；封存路径另行限制身份值的类型与大小。
function responseRules(candidate: DispatchCandidate): ResponseRules {
  const terminal = candidate.method.startsWith('terminal.backend.')
  const expected = !terminal ? undefined : TERMINAL_RESULTS[candidate.method.slice('terminal.backend.'.length)]
  const identities: Record<string, import('./types.js').Json> = {}
  if (terminal) {
    const params = object(candidate.request.params)
    for (const name of ['server_generation', 'terminal_id', 'pane_id']) {
      if (params[name] !== undefined) {
        identities[name] = params[name]!
      }
    }
  }
  return {
    terminal,
    bind_native_identity: terminal,
    ...(expected ? { expected_type: expected } : {}),
    identities
  }
}
// 核对成功结果的类型和模式，并比较响应中出现的适用身份字段与原请求及绑定代次。
function validateBoundResult(rules: ResponseRules, binding: NativeBinding, result: JsonObject): void {
  if ((rules.terminal || rules.expected_type) && result.type !== rules.expected_type) {
    fail('native_result_mismatch', 'response')
  }
  if (rules.bind_native_identity) {
    for (const name of ['server_generation', 'terminal_id', 'pane_id']) {
      if (
        result[name] !== undefined &&
        rules.identities[name] !== undefined &&
        result[name] !== rules.identities[name]
      ) {
        fail('native_identity_mismatch', 'response')
      }
    }
    if (result.server_generation !== undefined && result.server_generation !== binding.server_generation) {
      fail('native_identity_mismatch', 'response')
    }
  }
}
// 将候选提取为统一结果约束，使持有请求与仅响应两条路径复用相同的结果语义检查。
function validateResponseResult(candidate: DispatchCandidate, result: JsonObject): void {
  validateBoundResult(responseRules(candidate), candidate.binding, result)
}

// 实时广告与离线 schema 共同决定描述信息；描述本身不授予执行权限。
function describeCapability(
  binding: NativeBinding,
  name: string,
  hint: NativeMethodContract,
  paths: readonly string[] | undefined
): MethodDescriptor {
  let transport: MethodDescriptor['transport'] = 'unclassified'
  let schemaStatus: MethodDescriptor['schema_status'] = 'unavailable'
  if (paths) {
    if (binding.target.profile === 'host') {
      transport = 'host_stdio_proxy'
    } else {
      transport = 'single_request_rpc'
    }
    schemaStatus = paths.length ? 'conditional_branch' : 'generic_params_only'
  }
  return Object.freeze({
    method: name,
    profile: binding.target.profile,
    transport,
    schema_status: schemaStatus,
    branch_paths: paths ?? Object.freeze([]),
    classification_status: 'not_evaluated',
    native_contract: hint
  })
}

// 从真实请求或派发许可取得原候选，拒绝伪造的上下文。
function candidateOf(context: CheckedRequest | DispatchPermit): DispatchCandidate {
  if (context.kind === 'permit') {
    if (!candidates.has(context.candidate)) {
      fail('invalid_permit_handle')
    }
    return context.candidate
  }
  if (context.kind !== 'request' || !candidates.has(context)) {
    fail('invalid_request_handle')
  }
  return context
}

// 为一个已登记契约创建校验入口，所有可信状态均保存在私有句柄表中。
export function createNativeValidator(contract: CompiledContract): NativeValidator {
  data(contract)
  // 复制并校验响应族 schema。
  function responseShape(input: unknown, family: 'general' | 'terminal', bound: boolean): CheckedResponse {
    const response = copy(contract, input)
    validate(contract, `${UHP}response.schema.json`, response, 'native_response_invalid')
    if (family === 'terminal') {
      validate(contract, `${UHP}schema/terminal/response.schema.json`, response, 'native_response_invalid')
    }
    return Object.freeze({ response, identity: contract.identity, bound })
  }
  // 已收录方法检查完整根；未知方法仅复用 raw 的最小信封，后续门禁仍独立决定是否可执行。
  function requestShape(request: JsonObject, allowRaw: boolean): string {
    const name = text(request.method, 'native_request_invalid')
    const known = data(contract).requestMethods.includes(name)
    if (known || !allowRaw) {
      validate(contract, `${UHP}request.schema.json`, request, 'native_request_invalid')
    } else {
      if (
        Object.keys(request).some(
          /* 检测请求外壳中的未知字段，避免额外权限或身份数据被静默接纳。 */ (k) =>
            !['id', 'method', 'params', 'auth'].includes(k)
        ) ||
        typeof request.id !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(request.id) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(name) ||
        !request.params ||
        typeof request.params !== 'object' ||
        Array.isArray(request.params) ||
        (request.auth !== undefined && (typeof request.auth !== 'string' || !/^[!-~]{1,256}$/.test(request.auth)))
      ) {
        fail('native_request_invalid', 'request', 'minimal_envelope')
      }
    }
    return name
  }
  // 校验能力、信封、参数和帧预算并保留实际覆盖状态；仅 allowRaw 时允许 unavailable 候选。
  function checkedRequest(
    view: CapabilityView,
    input: unknown,
    allowRaw: boolean
  ): CheckedRequest | RawRequestCandidate {
    viewData(contract, view)
    const request = copy(contract, input)
    const name = requestShape(request, allowRaw)
    const descriptor = method(contract, view, name)
    requestSemantics(request, view)
    frameLimit(contract, view, request, 'native_request_invalid', name.startsWith('terminal.backend.'), 'request')
    let validation: ParameterValidation = 'unavailable'
    if (descriptor.schema_status === 'conditional_branch') {
      validation = 'schema'
    } else if (descriptor.schema_status === 'generic_params_only') {
      validation = 'generic'
    }
    const result = Object.freeze({
      kind: validation === 'unavailable' ? 'raw_request' : 'request',
      request,
      binding: view.binding,
      method: name,
      validation,
      schema_status: descriptor.schema_status
    }) as CheckedRequest | RawRequestCandidate
    candidates.set(result, { view, descriptor })
    return result
  }
  const api: NativeValidator = {
    // 登记前检查既有请求结构；成功不绑定原生来源，也不登记候选或 permit。
    checkRequestShape(input) {
      return attempt(
        'request',
        /** 已知方法使用完整已编译根，未知方法保留最小信封，不采用默认值或类型转换。 */ () => {
          requestShape(copy(contract, input), true)
        }
      )
    },
    // 只核对有界能力数据和预期身份，不读取认证标志、政策修订或登记任何许可句柄。
    checkCapabilitiesShape(input, expected) {
      return attempt(
        'capabilities',
        /* 预期值仅含目标和代次；复用原响应 schema 及完整目录检查，不调用来源认证。 */ () => {
          const binding = snapshot(
            { target: expected.target, server_generation: expected.server_generation },
            data(contract).limits
          ) as unknown as Pick<NativeBinding, 'target' | 'server_generation'>
          validateTarget(binding.target)
          if (
            binding.target.profile === 'session'
              ? typeof binding.server_generation !== 'string' || !binding.server_generation.length
              : binding.server_generation !== null
          ) {
            fail('invalid_context')
          }
          const response = responseShape(input, 'general', false).response
          shapeCapabilities(object(response.result, 'capability_invalid'), binding)
        }
      )
    },
    // 把独立验证的原生来源与能力广告绑定为当前契约的内存视图。
    bindCapabilities(input, source) {
      return attempt(
        'capabilities',
        /* 在统一错误边界内核对契约身份、广告 schema 和方法目录，再登记冻结能力视图。 */ () => {
          const binding = verifySource(source)
          if (!equal(binding.contract, contract.identity)) {
            fail('capability_stale', 'discovery', 'contract')
          }
          const response = responseShape(input, 'general', false).response
          const value = object(response.result, 'capability_invalid')
          const hints = shapeCapabilities(value, binding)
          const methods = new Map<string, MethodDescriptor>()
          for (const [name, hint] of hints) {
            const paths = data(contract).branches.get(name)
            const descriptor = describeCapability(binding, name, hint, paths)
            methods.set(name, descriptor)
          }
          const view = Object.freeze({ binding, methods: Object.freeze([...methods.values()]) })
          views.set(view, { contract, capabilities: value, methods })
          return view
        }
      )
    },
    // 返回能力视图中的方法描述，描述信息本身不授予执行权限。
    describe(view, name) {
      return attempt(
        'describe',
        /* 在统一错误边界内查询当前视图的方法，保留不可用与未广告的拒绝结果。 */ () => method(contract, view, name)
      )
    },
    // 按现行参数 schema 校验请求，保留 schema/generic 覆盖状态供派发门禁判断。
    checkRequest(view, input) {
      return attempt(
        'request',
        /* 校验 bundle 已收录方法的参数并保留覆盖状态，不创建 validation=unavailable 候选。 */ () =>
          checkedRequest(view, input, false) as CheckedRequest
      )
    },
    // 允许未收录方法产生 unavailable 候选，已有 schema/generic 结果不降级，raw 授权另过门禁。
    checkRawRequest(view, input) {
      return attempt(
        'request',
        /* 允许未收录方法形成 unavailable 候选，仍执行能力、帧预算及请求语义检查。 */ () =>
          checkedRequest(view, input, true)
      )
    },
    // 只校验指定响应族的结构，不声称其已与请求、许可或原生来源绑定。
    checkResponseShape(input, family = 'general') {
      return attempt(
        'response',
        /* 先限定响应族，再生成尚未绑定原请求的结构校验句柄。 */ () => {
          if (!['general', 'terminal'].includes(family)) {
            fail('invalid_context')
          }
          return responseShape(input, family, false)
        }
      )
    },
    // 复核原请求上下文、来源、在线帧预算及结果约束，登记绑定后的响应句柄。
    checkResponse(context, input, source) {
      return attempt(
        'response',
        /* 核对候选能力、完整来源、ID、帧预算和成功结果语义；RPC 响应登记不保留请求关联。 */ () => {
          const candidate = candidateOf(context)
          const stored = candidates.get(candidate)!
          viewData(contract, stored.view)
          verifySource(source, candidate.binding)
          const terminal = candidate.method.startsWith('terminal.backend.')
          const checked = responseShape(input, terminal ? 'terminal' : 'general', true)
          frameLimit(contract, stored.view, checked.response, 'native_response_invalid', terminal, 'response')
          const request = candidate.request
          // schema 合法之后仍须绑定原请求 ID、结果类型和适用的原生实例标识。
          if (checked.response.id !== request.id) {
            fail('native_id_mismatch', 'response')
          }
          if (checked.response.result !== undefined) {
            validateResponseResult(candidate, object(checked.response.result))
          }
          return checked
        }
      )
    },
    // 从真实非流 RPC 许可封存最小响应约束，身份值或总编码大小超限即失败，不能从 JSON 重建。
    sealResponseContext(permit) {
      return attempt(
        'response_context',
        /* 拒绝流与控制候选，并只复制绑定、ID、方法、帧预算和有界身份匹配字段。 */ () => {
          const candidate = candidateOf(permit)
          const original = candidates.get(candidate)!
          viewData(contract, original.view)
          const rules = responseRules(candidate)
          if (
            Object.values(rules.identities).some(
              /* 要求保留的身份约束为最多 256 字节的字符串，防止借 matcher 保存任意正文。 */ (value) =>
                typeof value !== 'string' || Buffer.byteLength(value) > 256
            )
          ) {
            fail('response_context_unavailable')
          }
          const retained = {
            contract,
            binding: snapshot(candidate.binding) as unknown as NativeBinding,
            native_id: text(candidate.request.id),
            method: candidate.method,
            frame_bytes: frameBytes(contract, original.view, rules.terminal, 'response'),
            rules: snapshot(rules) as unknown as ResponseRules
          }
          // 编码计量只纳入契约身份，不重复计算共享 schema；总量超限即拒绝，不裁剪身份约束。
          const bytes = Buffer.byteLength(JSON.stringify({ ...retained, contract: contract.identity }))
          if (bytes > data(contract).limits.object_bytes) {
            fail('response_context_limit')
          }
          const context = Object.freeze({ kind: 'response_context' as const, retained_bytes: bytes })
          responseContexts.set(context, retained)
          return context
        }
      )
    },
    // 用密封元数据校验迟到响应并仅返回校验结论，不产生读取或派发能力。
    checkResponseOnly(context, input, source) {
      return attempt(
        'response_context',
        /* 要求句柄属于同一编译契约，核对宿主可信来源及完整绑定后检查固定帧预算与结果约束。 */ () => {
          const retained = responseContexts.get(context)
          if (!retained || retained.contract !== contract) {
            fail('invalid_response_context')
          }
          verifySource(source, retained.binding)
          const checked = responseShape(input, retained.rules.terminal ? 'terminal' : 'general', true)
          if (
            retained.frame_bytes !== null &&
            Buffer.byteLength(JSON.stringify(checked.response)) + 1 > retained.frame_bytes
          ) {
            fail('native_response_invalid', 'response', 'frame_limit')
          }
          if (checked.response.id !== retained.native_id) {
            fail('native_id_mismatch', 'response')
          }
          if (checked.response.result !== undefined) {
            validateBoundResult(retained.rules, retained.binding, object(checked.response.result))
          }
          // 只返回验证结果，不能取得 CheckedResponse/payload 或用它开流。
        }
      )
    },
    // 删除密封响应句柄的私有登记，使其不能继续验证迟到响应。
    releaseResponseContext(context) {
      return attempt(
        'response_context',
        /* 确认密封句柄属于当前契约后删除登记，复制对象不能替代原句柄。 */ () => {
          const retained = responseContexts.get(context)
          if (!retained || retained.contract !== contract) {
            fail('invalid_response_context')
          }
          responseContexts.delete(context)
        }
      )
    }
  }
  return Object.freeze(api)
}
