// 用原编译契约与离线合成能力验证纯 shape 检查，拒绝身份和目录漂移且不登记认证或许可句柄。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CapabilityView, NativeBinding } from '../../../../src/connector/luvus/contract/index.js'
import { candidates, responseContexts, views } from '../../../../src/connector/luvus/contract/internal.js'
import { G, json, rejects, source, unwrap, validator } from './helpers.js'

/** 只观察本测试同步调用是否写入真实私有登记表，结束后恢复原方法。 */
function observeRegistrations<K extends object, V>(registry: WeakMap<K, V>, observed: () => void): () => void {
  const original = registry.set
  registry.set = /** 保留原 WeakMap 接收者和登记行为，不制造可用的测试句柄。 */ function (key, value) {
    observed()
    return original.call(this, key, value)
  }
  return /** 无论断言成功或失败都恢复真实登记入口。 */ () => {
    registry.set = original
  }
}

/** 仅投影 shape 所需的目标与代次，明确不提供 caller、政策修订或认证事实。 */
function expected(profile: 'session' | 'host' = 'session'): Pick<NativeBinding, 'target' | 'server_generation'> {
  return {
    target: profile === 'session' ? { machine_id: 'm1', profile, session: 'synthetic' } : { machine_id: 'm1', profile },
    server_generation: profile === 'session' ? G : null
  }
}

/** 复制完整原目录并调整本轮合成身份，不用删减方法清单冒充完整能力检查。 */
function capabilities(profile: 'session' | 'host' = 'session') {
  const response = json(profile === 'session' ? 'session-capabilities.json' : 'host-capabilities.json')
  if (profile === 'session') {
    response.result.session = 'synthetic'
    response.result.server_generation = G
  }
  return response
}

test(
  '能力方法允许诊断扩展并隔离不兼容的单个方法',
  /** 完整响应校验后只投影授权字段，未知诊断字段不污染方法描述或影响健康方法。 */ () => {
    const response = capabilities()
    const row = response.result.method_contracts.find(
      /** 仅扩展 Agent 提示方法。 */ (entry: any) => entry.method === 'agent.prompt'
    )
    row.future_diagnostic = 'optional'
    assert(validator.checkResponseShape(response).ok)
    assert(validator.checkCapabilitiesShape(response, expected()).ok)
    const bound = unwrap(validator.bindCapabilities(response, source()))
    const descriptor = unwrap(validator.describe(bound, 'agent.prompt'))
    assert.equal(Object.hasOwn(descriptor.native_contract, 'future_diagnostic'), false)
    for (const [field, value] of [
      ['scope', 'future-scope'],
      ['access', 'future-access'],
      ['idempotent', null]
    ]) {
      const changed = structuredClone(response)
      const method = changed.result.method_contracts.find(
        /** 每轮只破坏一个方法的授权语义。 */ (entry: any) => entry.method === 'agent.prompt'
      )
      method[field as string] = value
      assert(validator.checkResponseShape(changed).ok)
      assert(validator.checkCapabilitiesShape(changed, expected()).ok)
      const isolated = unwrap(validator.bindCapabilities(changed, source()))
      assert(!validator.describe(isolated, 'agent.prompt').ok)
      assert(validator.describe(isolated, 'pane.list').ok)
      rejects(
        validator.checkRawRequest(isolated, {
          id: 'synthetic',
          method: 'agent.prompt',
          params: { target: 'synthetic', text: 'synthetic' }
        }),
        'method_not_advertised'
      )
      assert(validator.checkRawRequest(isolated, { id: 'synthetic', method: 'pane.list', params: {} }).ok)
    }
  }
)

test(
  '197 项 session 与 17 项 host 能力仅校验 shape，不读取认证标志或创建私有句柄',
  /** 真登记表计数应始终为零；成功的 Check<void> 和同形 JSON 都不是可用能力视图。 */ () => {
    let registrations = 0
    const counted = /** 所有能力、候选、响应和仅响应登记都应保持未触发。 */ () => {
      registrations++
    }
    const restore = [
      observeRegistrations(views, counted),
      observeRegistrations(candidates, counted),
      observeRegistrations(responseContexts, counted)
    ]
    try {
      const session = capabilities()
      const host = capabilities('host')
      assert.equal(session.result.methods.length, 197)
      assert.equal(host.result.methods.length, 17)
      const target = expected()
      Object.defineProperty(target, 'authenticated', {
        /** 无关认证标志不得被纯 shape 检查读取。 */ get() {
          throw new Error('authentication_flag_must_not_be_read')
        }
      })
      Object.defineProperty(target, 'source_verified', {
        /** 无关来源标志也不能成为 shape 成功的前提。 */ get() {
          throw new Error('source_flag_must_not_be_read')
        }
      })
      const checked = validator.checkCapabilitiesShape(session, target)
      assert.equal(unwrap(checked), undefined)
      assert.equal(unwrap(validator.checkCapabilitiesShape(host, expected('host'))), undefined)
      const request = { id: 'shape-only', method: 'task.add', params: { title: 'synthetic' } }
      for (const fake of [checked, checked.ok ? checked.value : undefined, session, { binding: target, methods: [] }]) {
        rejects(validator.describe(fake as CapabilityView, 'task.add'), 'invalid_capability_handle')
        rejects(validator.checkRequest(fake as CapabilityView, request), 'invalid_capability_handle')
      }
      rejects(validator.bindCapabilities(session, { ...source(), authenticated: false }), 'native_source_untrusted')
      assert.equal(registrations, 0)
    } finally {
      for (const reset of restore) {
        reset()
      }
    }
    const bound = unwrap(validator.bindCapabilities(capabilities(), source()))
    assert.equal(bound.methods.length, 197)
    assert.equal(unwrap(validator.describe(bound, 'task.add')).method, 'task.add')
  }
)

for (const identity of ['session', 'generation'] as const) {
  test(
    `纯能力 shape 拒绝错误 ${identity}`,
    /** 原能力目录合法也不能替代预期 session 或当前 generation 的独立比对。 */ () => {
      const response = capabilities()
      response.result[identity === 'session' ? 'session' : 'server_generation'] = 'other_identity'
      rejects(validator.checkCapabilitiesShape(response, expected()), 'capability_invalid')
    }
  )
}

for (const catalog of ['protocol', 'methods', 'method_contracts'] as const) {
  test(
    `纯能力 shape 拒绝错误 ${catalog}`,
    /** 全目录复用原协议、唯一方法与逐方法契约检查，不只验证允许调用的子集。 */ () => {
      const response = capabilities()
      if (catalog === 'protocol') {
        response.result.protocol.major = 2
      } else if (catalog === 'methods') {
        response.result.methods[1] = response.result.methods[0]
      } else {
        response.result.method_contracts[1] = response.result.method_contracts[0]
      }
      rejects(validator.checkCapabilitiesShape(response, expected()), 'capability_invalid')
    }
  )
}

for (const terminal of ['features', 'request_bytes', 'response_bytes'] as const) {
  test(
    `纯能力 shape 拒绝错误 terminal ${terminal}`,
    /** 保留终端能力唯一性和执行所需正字节限额，不因目录检查而跳过在线预算。 */ () => {
      const response = capabilities()
      if (terminal === 'features') {
        response.result.terminal.features.push(response.result.terminal.features[0])
      } else {
        response.result.terminal.limits[terminal] = 0
      }
      rejects(validator.checkCapabilitiesShape(response, expected()), 'capability_invalid')
    }
  )
}

test(
  '纯能力 shape 保留原响应 schema、有界复制及非行为 JSON 检查',
  /** 无效信封、大对象和 getter 在生成任何能力事实前拒绝。 */ () => {
    const malformed = capabilities()
    malformed.id = 42
    rejects(validator.checkCapabilitiesShape(malformed, expected()), 'native_response_invalid')
    const oversized = capabilities()
    oversized.extra = 'x'.repeat(1_048_576)
    rejects(validator.checkCapabilitiesShape(oversized, expected()), 'object_limit')
    const behavior = capabilities()
    let invoked = 0
    Object.defineProperty(behavior, 'result', {
      /** 原快照器必须拒绝行为属性而不执行它。 */ get() {
        invoked++
        throw new Error('getter_must_not_run')
      }
    })
    rejects(validator.checkCapabilitiesShape(behavior, expected()), 'invalid_json')
    assert.equal(invoked, 0)
  }
)
