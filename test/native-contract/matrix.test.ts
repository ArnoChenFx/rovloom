// 将原生契约验收矩阵转换为真实校验与授权调用，统计已实现阶段并显式列出后续验收范围。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { checkDispatch, compileBundle, parseNativeJson } from '../../src/native-contract/index.js'
import { auth, clone, G, identity, json, request, source, sourceFor, T, unwrap, validator, view } from './helpers.js'

// 将接口无关场景转为真实内存工厂；不把 JSON 中的可信标志直接当作生产认证。
const matrix: any = JSON.parse(
  readFileSync(new URL('../fixtures/native-contract/matrix.json', import.meta.url), 'utf8')
)
const seeds = new Map<string, any>()
// 在测试样本中按 JSON Pointer 读取选定节点。
function pointer(value: any, path: string): any {
  for (const piece of path.split('/').slice(1)) {
    value = value[piece.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return value
}
for (const [name, spec] of Object.entries(matrix.seeds) as [string, any][]) {
  let value: any
  if ('value' in spec) {
    value = spec.value
  } else {
    assert(spec.artifact.startsWith('test/fixtures/luvus/0.14.3/linux/'))
    value = json(spec.artifact.split('/').at(-1))
    if (spec.select) {
      const chosen = value.filter(
        /* 从原始记录中筛选所有选择字段均匹配的证据行。 */ (row: any) =>
          Object.entries(spec.select).every(
            /* 核对单个选择字段与预期值相同。 */ ([key, expected]) => row[key] === expected
          )
      )
      assert.equal(chosen.length, 1)
      value = JSON.parse(chosen[0][spec.json_field])
    }
    value = pointer(value, spec.pointer ?? '')
  }
  seeds.set(name, value)
}
// 复制场景种子并按路径应用替换或删除，生成独立测试样本。
function specimen(c: any): any {
  let value = clone(seeds.get(c.seed))
  for (const change of c.mutations ?? []) {
    if (change.path === '') {
      value = clone(change.value)
      continue
    }
    const at = change.path.lastIndexOf('/')
    const parent = pointer(value, change.path.slice(0, at))
    const key = change.path
      .slice(at + 1)
      .replace(/~1/g, '/')
      .replace(/~0/g, '~')
    if (change.op === 'remove') {
      if (Array.isArray(parent)) {
        parent.splice(Number(key), 1)
      } else {
        delete parent[key]
      }
    } else {
      parent[key] = clone(change.value)
    }
  }
  return value
}
// 核对场景的接受结论、错误码及要求的参数覆盖状态。
function assertCase(c: any, result: any): void {
  assert.equal(result.ok, c.expected.verdict === 'accept', `${c.id}: ${JSON.stringify(result)}`)
  if (!result.ok) {
    assert.equal(result.error.code, c.expected.code, c.id)
  } else if (c.expected.validation) {
    assert.equal(result.value.validation, c.expected.validation, c.id)
  } else if (c.expected.coverage) {
    assert.equal(
      result.value.schema_status,
      c.expected.coverage === 'generic_params_only' ? 'generic_params_only' : 'conditional_branch',
      c.id
    )
  }
}
const session = view()
// 将 bundle 各别名重新指向当前文档表，使单独变更的约束参与真实编译。
function syncAliases(b: any): void {
  const docs = b.documents
  for (const key of ['request', 'response', 'event', 'event_catalog']) {
    b[key] = docs[b[key].$id]
  }
  for (const key of Object.keys(b.terminal.documents)) {
    if (docs[key]) {
      b.terminal.documents[key] = docs[key]
    } else {
      delete b.terminal.documents[key]
    }
  }
  for (const key of ['request', 'response', 'event', 'control_frame']) {
    b.terminal[key] = docs[b.terminal[key].$id]
  }
  for (const key of Object.keys(b.terminal.methods)) {
    b.terminal.methods[key] =
      docs[`https://luvus.dev/protocol/uhp/v1/schema/terminal/methods/${key.replace(/_/g, '-')}.schema.json`]
  }
  b.access.descriptor = docs[b.access.descriptor.$id]
}
// 构造契约编译场景并阻止网络解析，保留专门的摘要和别名冲突反例。
async function bundleCase(c: any): Promise<any> {
  const b: any = c.generator ? clone(seeds.get('bundle')) : specimen(c)
  if (c.generator === 'ref_chain_33') {
    const defs = b.documents['https://luvus.dev/protocol/uhp/v1/request.schema.json'].$defs
    for (let i = 0; i < 34; i++) {
      defs[`chain${i}`] = i === 33 ? { type: 'object' } : { $ref: `#/$defs/chain${i + 1}` }
    }
  }
  if (c.id !== 'B-alias-mismatch') {
    syncAliases(b)
  }
  let serialized = JSON.stringify(b)
  if (c.generator === 'bundle_bytes_over_2mib') {
    serialized += ' '.repeat(2_097_153)
  }
  const expected = {
    ...identity,
    schema_sha256: c.id === 'B-hash-mismatch' ? '3'.repeat(64) : createHash('sha256').update(serialized).digest('hex')
  }
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = /* 记录任何意外网络访问并抛错，确保契约引用仅在本地闭包解析。 */ (() => {
    requests++
    throw Error('禁止网络 resolver')
  }) as typeof fetch
  try {
    const checked = await compileBundle(serialized, { identity: expected })
    assert.equal(requests, 0)
    return checked
  } finally {
    globalThis.fetch = previousFetch
  }
}
// 构造能力发现或来源过时场景，逐项验证各绑定版本的失效效果。
function capabilityCase(c: any): any {
  const value = specimen(c)
  if (c.id === 'C-stale') {
    const candidate = request(session, {
      id: 'stale',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    })
    let result: any
    for (const field of [
      'provider_id',
      'binding_revision',
      'contract_source_ref',
      'connection_epoch',
      'recovery_generation',
      'capability_revision',
      'classification_revision'
    ]) {
      const authorization: any = clone(auth(candidate))
      authorization.source.binding[field] = 'changed'
      result = checkDispatch(candidate, authorization)
      assertCase(c, result)
    }
    return result
  }
  const profile = c.context?.target_profile ?? (value.result.profile === 'host' ? 'host' : 'session')
  const trusted: any = source(profile === 'host' ? 'host' : 'session', value.result.server_generation ?? G)
  if (profile === 'access_machines') {
    trusted.binding.target.profile = profile
  } else if (profile === 'session' && value.result.session) {
    trusted.binding.target.session = value.result.session
  }
  const bound = validator.bindCapabilities(value, trusted)
  if (c.id === 'C-unknown-access') {
    const isolated = unwrap(bound)
    const method = value.result.method_contracts[0].method
    assert(validator.checkRawRequest(isolated, { id: 'healthy', method: 'pane.list', params: {} }).ok)
    return validator.checkRawRequest(isolated, { id: 'isolated', method, params: {} })
  }
  return bound
}
// 按场景选择形状校验或绑定请求校验，覆盖响应 ID、类型、模式和身份约束。
function responseCase(c: any): any {
  const value = specimen(c)
  if (c.id === 'R-id-mismatch') {
    const checked = request(session, { id: 'u.other', method: 'ping', params: {} })
    return validator.checkResponse(checked, value, sourceFor(checked.binding))
  }
  if (['R-terminal-method'].includes(c.id)) {
    const method = c.context?.method ?? 'terminal.backend.control'
    const params: any = { server_generation: G, terminal_id: T, pane_id: '3' }
    if (method.endsWith('capture')) {
      Object.assign(params, { mode: 'visible', lines: 1, ansi: false })
    }
    const checked = request(session, { id: value.id, method, params })
    return validator.checkResponse(checked, value, sourceFor(checked.binding))
  }
  return validator.checkResponseShape(value, c.seed.startsWith('terminal_') ? 'terminal' : 'general')
}
// 遍历所有通用参数方法，断言请求阶段均被接受（派发授权由静态方法表测试覆盖）。
function genericCases(c: any): void {
  for (const descriptor of session.methods.filter(
    /* 仅选择缺少方法专用参数 schema 的方法描述。 */ (entry) => entry.schema_status === 'generic_params_only'
  )) {
    const candidate = request(session, {
      id: 'generic-all',
      method: descriptor.method,
      params: {
        unannounced: ['synthetic'],
        ...(descriptor.method === 'module.action.invoke' ? { action: 'synthetic' } : {})
      }
    })
    assertCase(c, { ok: true, value: candidate })
  }
}
const implementedStages = new Set(['bundle', 'capabilities', 'request', 'response', 'parse'])
export const implementedMatrixIds: string[] = matrix.cases
  .filter(/* 选择当前纯模块已实现阶段的矩阵场景。 */ (c: any) => implementedStages.has(c.stage))
  .map(/* 提取已实现矩阵场景的唯一编号。 */ (c: any) => c.id)
for (const c of matrix.cases.filter(
  /* 仅为当前纯模块支持的阶段注册实际测试。 */ (c: any) => implementedStages.has(c.stage)
)) {
  test(
    `矩阵 ${c.id} ${c.expected.verdict}`,
    /* 根据场景阶段调用真实编译、校验或授权入口，并核对统一预期。 */ async () => {
      if (c.generator === 'all_generic_methods') {
        genericCases(c)
        return
      }
      let result: any
      if (c.stage === 'bundle') {
        result = await bundleCase(c)
      } else if (c.stage === 'capabilities') {
        result = capabilityCase(c)
      } else if (c.stage === 'request') {
        result = validator.checkRequest(session, specimen(c))
      } else if (c.stage === 'response') {
        result = responseCase(c)
      } else if (c.stage === 'parse') {
        result = parseNativeJson(
          c.generator === 'depth_65' ? '['.repeat(65) + '0' + ']'.repeat(65) : Buffer.from(specimen(c).bytes_hex, 'hex')
        )
      } else {
        throw Error(`unhandled matrix stage ${c.stage}`)
      }
      assertCase(c, result)
    }
  )
}
test(
  '85 矩阵的纯模块与后续持久化验收分列，无静默 skip',
  /* 核对全部矩阵与已实现数量，要求延后场景均明确归属于后续验收阶段（派发授权由静态方法表测试覆盖）。 */ () => {
    assert.equal(matrix.cases.length, 85)
    assert.equal(implementedMatrixIds.length, 66)
    const deferred = matrix.cases.filter(
      /* 筛出尚未由当前纯模块实现的矩阵场景。 */ (c: any) => !implementedStages.has(c.stage)
    )
    assert.equal(deferred.length, 19)
    assert(
      deferred.every(
        /* 确认延后场景仅属于迟到结果或结果持久化验收。 */ (c: any) => ['late', 'result'].includes(c.stage)
      )
    )
  }
)
