/** 使用真实 provider gate、品牌 schema 与 Store 检查精确 ping 的正反向接缝。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boundedJson, providerFor } from '../../../src/wire/index.js'
import { createHerdrCodec, createHerdrReadonlyAdapter } from '../../../src/connector/herdr/readonly.js'
import { persistentHerdrBackend, commitHerdrResponse } from '../../../src/connector/herdr/persistence.js'
import { Store } from '../../../src/store.js'
import { createHerdrWireAdapter } from '../../../src/connector/herdr/wire.js'
import type { JsonObject } from '../../../src/wire/types.js'
import type { Adapter } from '../../../src/transport/common.js'
import { connected, management, responseFrame } from '../../storage/helpers.js'
import { backendFixture, fixture, schemas, source } from './helpers.js'

/** 为每个反例准备合成完整来源与私有 permit；没有原生 socket 或 Store 写入。 */
function prepared() {
  const state = backendFixture()
  const adapter = createHerdrReadonlyAdapter(state.backend)
  const context = adapter.resolve(state.identity)
  const request = { ...state.record.native_request, id: state.binding.native_request_id }
  adapter.encodeRequest(request, context)
  return { ...state, adapter, context, request }
}

test(
  'reviewed ordinary gate passes the shared provider and result-boundary contract',
  /** 核对普通结果边界和真实固定来源 provider gate，不导入派生源码。 */ () => {
    const state = prepared()
    assert.equal(state.adapter.validator.validateRequest(state.request, state.context), undefined)
    assert.equal(providerFor(state.binding, state.backend.context('principal1', 'gateway_to_connector')).kind, 'herdr')
  }
)

test(
  'repeated resolution preserves the permit',
  /** 重复解析原 binding 后回放响应，检查 permit 保持一致。 */ () => {
    const state = prepared()
    const next = state.adapter.resolve(state.identity)
    assert.deepEqual(next, state.context)
    assert.doesNotThrow(
      /** 用重复解析返回的上下文验证原 permit 对应响应。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, next)
    )
  }
)

test(
  'background evidence needs no current reader while actual delivery does',
  /** 移除当前读者，核对后台证据仍有效而内容交付失败。 */ () => {
    const state = prepared()
    state.backend.currentPrincipal = /** 模拟后台处理回包时没有当前 caller。 */ () => undefined
    const next = state.adapter.resolve(state.identity)
    assert.doesNotThrow(
      /** 在没有当前读者时校验原私有来源的响应。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, next)
    )
    assert.throws(
      /** 尝试向不存在的当前读者交付内容。 */ () => state.adapter.checkResult(next),
      /attempt_binding_mismatch/
    )
  }
)

for (const key of ['connection_epoch', 'recovery_generation'] as const) {
  test(
    `old ${key} evidence cannot attach to the current connection or reuse its permit`,
    /** 切换连接或恢复代次，检查旧证据拒绝及新状态不继承 permit。 */ () => {
      const state = prepared()
      const wire = state.backend.context('principal1', 'connector_to_gateway')
      wire.connection[key] = 'new-value'
      assert.throws(
        /** 将旧句柄回包交给已变化的当前连接上下文。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, state.context),
        /attempt_binding_mismatch/
      )
      assert.throws(
        /** 在可信连接变化后重新解析旧身份。 */ () => state.adapter.resolve(state.identity),
        /attempt_binding_mismatch/
      )
      state.binding[key] = 'new-value'
      const next = state.adapter.resolve(state.identity)
      assert.throws(
        /** 向新句柄提交旧响应，检查没有原 permit 时拒绝。 */ () =>
          state.adapter.decodeResponse(Buffer.from(JSON.stringify(fixture().response) + '\n'), next),
        /dispatch_permit_unavailable/
      )
      assert.throws(
        /** 建立新句柄后再次提交旧句柄证据，防止旧状态被重绑。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, state.context),
        /attempt_binding_mismatch/
      )
    }
  )
}

for (const change of ['disabled', 'revision'] as const) {
  test(
    `provider ${change} still blocks evidence under the reviewed-provider gate`,
    /** 模拟 provider 禁用或 revision 改变，验证真实固定来源测试仍保留共享身份门禁。 */ () => {
      const state = prepared()
      const wire = state.backend.context('principal1', 'connector_to_gateway')
      const resolver = wire.resolveProvider!
      wire.resolveProvider = /** 只替换本轮 provider 的 enabled 或 revision，保留其余完整 binding。 */ (target) => ({
        ...resolver(target)!,
        ...(change === 'disabled' ? { enabled: false } : { binding_revision: 2 })
      })
      assert.throws(
        /** 使用失效 provider 上下文验证原响应。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, state.context),
        change === 'disabled' ? /provider_disabled/ : /provider_binding_mismatch/
      )
    }
  )
}

test(
  'source replacement remains invalid for evidence',
  /** 替换 endpoint token，验证证据来源隔离。 */ () => {
    const state = prepared()
    state.backend.nativeSource = /** 每次返回不同的私有 endpoint token，模拟本机实例替换。 */ () => ({
      role: 'local_installation',
      binding: state.binding,
      token: {}
    })
    assert.throws(
      /** 来源替换后重复解析，检查旧状态拒绝复用。 */ () => state.adapter.resolve(state.identity),
      /native_source_untrusted/
    )
    assert.throws(
      /** 来源替换后提交原句柄的回包证据。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, state.context),
      /native_source_untrusted/
    )
  }
)

test(
  'unprepared or released state cannot accept even a schema-valid native response',
  /** 覆盖未准备、已释放及重新解析状态，确保合法 schema 不会补造 permit。 */ () => {
    const state = backendFixture()
    const adapter = createHerdrReadonlyAdapter(state.backend)
    const first = adapter.resolve(state.identity)
    assert.throws(
      /** 编码前提交合法回包，检查缺少 dispatch permit。 */ () =>
        adapter.validator.validateResponse(fixture().response, first),
      /dispatch_permit_unavailable/
    )
    adapter.release(first)
    assert.throws(
      /** 释放后没有登记状态可取。 */ () => adapter.validator.validateResponse(fixture().response, first),
      /native_context_unavailable/
    )
    const next = adapter.resolve(state.identity)
    assert.throws(
      /** 向重新解析的句柄提交回包，确认不继承已释放状态的 permit。 */ () =>
        adapter.decodeResponse(Buffer.from(JSON.stringify(fixture().response) + '\n'), next),
      /dispatch_permit_unavailable/
    )
  }
)

for (const status of ['expired', 'discarded', 'unavailable'] as const) {
  test(
    `retention ${status} permits only native validation and never content delivery`,
    /** 分别模拟过期、discard 和不可用，区分证据校验与内容读取。 */ () => {
      const state = prepared()
      state.backend.contentStatus = /** 返回当前子场景固定保留状态，不更新原期限。 */ () => status
      assert.doesNotThrow(
        /** 在测试 backend 仍保留原 attempt 时校验响应证据。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, state.context)
      )
      assert.throws(
        /** 按当前保留状态检查内容交付必须拒绝。 */ () => state.adapter.checkResult(state.context),
        /content_unavailable/
      )
    }
  )
}

/** 用自有临时 SQLite、真实品牌编译器和固定来源构造准入/派发链；原生响应来自脱敏 fixture。 */
function stored(prepare = true, requestValue = { method: 'ping', params: {} as JsonObject }) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-herdr-store-'))
  let now = 100
  const store = new Store(join(directory, 'db'), /** 只由测试推进可信时钟。 */ () => now, {
    management,
    retention: { result_ttl: 50 }
  })
  const device = connected(store)
  const state = backendFixture()
  state.record.method = requestValue.method
  state.record.native_request = requestValue
  const provider = {
    machine_id: device.machine_id,
    provider_id: 'herdr',
    kind: 'herdr' as const,
    config_ref: 'owned-synthetic-herdr',
    binding_revision: 1,
    enabled: true
  }
  store.defineProvider(provider)
  const target = {
    machine_id: device.machine_id,
    provider_id: provider.provider_id,
    profile: 'session' as const,
    session: 'synthetic'
  }
  const options = {
    binding_revision: 1,
    contract_ref: state.binding.contract_ref,
    timeoutMs: 20
  }
  const call = store.createCall('principal1', target, state.record.native_request, options)
  const binding = store.dispatch('principal1', call.call_id, device.epoch)
  const { machine_id: _machine, connection_epoch: _epoch, recovery_generation: _generation, ...identity } = binding
  state.context.connection = {
    ...state.context.connection,
    machine_id: device.machine_id,
    connection_epoch: device.epoch,
    recovery_generation: store.generation(),
    negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'] }
  }
  const local = { ...provider }
  const token = Object.freeze({ owned_synthetic_socket: true })
  const backend = persistentHerdrBackend(store, {
    ...state.backend,
    localProvider: /** 本机配置独立于 Store 持有，可测试相同 kind 的错误实例。 */ () => local,
    nativeSource: /** 来源只绑定本轮 Store 派发事实，不从响应建立。 */ (value) =>
      boundedJson(value) === boundedJson(binding) ? { role: 'local_installation', binding, token } : undefined
  })
  const adapter = createHerdrReadonlyAdapter(backend)
  const context = adapter.resolve(identity)
  const request = { ...requestValue, id: binding.native_request_id }
  if (prepare) {
    adapter.encodeRequest(request, context)
  }
  const frame = responseFrame(binding, {
    result: requestValue.method === 'workspace.report_metadata' ? { type: 'ok' } : fixture().response.result
  })
  return {
    ...state,
    store,
    target,
    options,
    local,
    provider,
    backend,
    binding,
    identity,
    adapter,
    context,
    request,
    frame,
    advance: /** 时间推进不触发其它设备、会话或模型调用。 */ (value: number) => {
      now = value
    },
    close: /** 关闭真实 Store/adapter 并删除本轮自有数据库。 */ () => {
      adapter.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

/** 合成有期限自定义元数据意图；不调用原生 workspace，也不使用模型凭据或私人数据。 */
function metadataRequest(value: string | null = 'synthetic note') {
  return {
    method: 'workspace.report_metadata',
    params: { workspace_id: 'w1', source: 'rovloom', tokens: { rovloom_note: value }, seq: 1, ttl_ms: 100 }
  }
}

for (const value of ['synthetic note', null]) {
  test(
    `reviewed metadata ${value === null ? 'clear' : 'write'} shares Wire, native codec and real Store commit`,
    /** 写入与清除均经完整 schema、同一 permit 和真实 Store；合成 Ok 不声称原生状态已改变。 */ () => {
      const state = stored(false, metadataRequest(value))
      const wire = createHerdrWireAdapter(state.backend, state.adapter)
      try {
        const request = {
          ...state.frame,
          type: 'request' as const,
          message_id: 'metadata-request',
          payload: {
            attempt: state.identity,
            expected_binding_revision: 1,
            native_request: metadataRequest(value),
            validation: 'strict' as const
          }
        }
        assert.deepEqual(wire.decode(wire.encode(request, 'gateway_to_connector'), 'gateway_to_connector'), request)
        assert.deepEqual(
          JSON.parse(Buffer.from(state.adapter.encodeRequest(state.request, state.context)).toString()),
          state.request
        )
        const response = state.frame.payload.native_response
        assert.deepEqual(response, { id: state.binding.native_request_id, result: { type: 'ok' } })
        assert.deepEqual(
          wire.decode(wire.encode(state.frame, 'connector_to_gateway'), 'connector_to_gateway'),
          state.frame
        )
        wire.checkResult(state.binding, response)
        wire.checkResultRetention(state.binding, response)
        const result = state.store.commitEvidence(
          state.binding,
          /** 事务内用原 permit 重新规划证据，不接受 caller 制造的提交计划。 */ () => wire.planEvidence(state.frame)
        )
        assert.equal(result.state, 'responded')
        assert.deepEqual(JSON.parse(result.response!), response)
      } finally {
        wire.close()
        state.close()
      }
    }
  )
}

test(
  'metadata parameters follow the complete official schema while Store only classifies the RPC intent',
  /** Store 不复制参数 schema；完整安装根在实际发送前拒绝错误类型、缺省必填与官方越界。 */ () => {
    const state = stored(false, metadataRequest())
    try {
      const params = metadataRequest().params
      const invalid: JsonObject[] = [
        {},
        { ...params, workspace_id: null },
        { ...params, source: 1 },
        { ...params, tokens: [] },
        { ...params, tokens: { 'invalid.key': 'value' } },
        { ...params, tokens: { ['x'.repeat(33)]: 'value' } },
        { ...params, tokens: { rovloom_note: false } },
        { ...params, seq: -1 },
        { ...params, seq: 1.5 },
        { ...params, seq: Number.MAX_SAFE_INTEGER + 1 },
        { ...params, ttl_ms: 0 },
        { ...params, ttl_ms: 86_400_001 }
      ]
      for (const missing of ['workspace_id', 'source', 'tokens']) {
        const incomplete: JsonObject = { ...params }
        delete incomplete[missing]
        invalid.push(incomplete)
      }
      for (const value of invalid) {
        const request = { method: 'workspace.report_metadata', params: value }
        assert.throws(
          /** 完整原生 request 根拒绝官方 schema 不接受的参数。 */ () =>
            createHerdrCodec(source, schemas).encode({ ...request, id: 'metadata-invalid' }),
          /herdr_native_request_invalid|invalid_integer/
        )
        if (typeof value.seq === 'number' && Math.abs(value.seq) > Number.MAX_SAFE_INTEGER) {
          assert.throws(
            /** 共享规范摘要仍拒绝无法精确表示的整数，不为 Herdr 绕过 JSON 基础边界。 */ () =>
              state.store.createCall('principal1', state.target, request, state.options),
            /invalid_integer/
          )
        } else {
          assert.doesNotThrow(
            /** Store 只登记方法与参数记录，不把登记当作 schema 合法或发送许可。 */ () =>
              state.store.createCall('principal1', state.target, request, state.options)
          )
        }
      }
      const upper = {
        method: 'workspace.report_metadata',
        params: {
          workspace_id: 'owned-workspace',
          source: 'owned-app',
          tokens: { custom_note: '汉字'.repeat(128), another: null }
        }
      }
      assert.doesNotThrow(
        /** 不额外限制命名空间、ID、内容长度或强制可选序号与 TTL。 */ () =>
          createHerdrCodec(source, schemas).encode({ ...upper, id: 'metadata-upper' })
      )
      assert.doesNotThrow(
        /** 真实 Store 也登记相同官方参数范围内的意图。 */ () =>
          state.store.createCall('principal1', state.target, upper, state.options)
      )
    } finally {
      state.close()
    }
  }
)

test(
  'real Store classifies an Agent request but full native schema failure never creates a dispatch permit',
  /** 建档与派发锚点不是原生发送许可；真实品牌 schema 拒绝缺少 prompt 正文的请求。 */ () => {
    const state = stored(false, { method: 'agent.prompt', params: { target: 'owned-agent' } })
    try {
      assert.equal(state.store.call('principal1', state.binding.call_id).state, 'dispatching')
      assert.throws(
        /** 实际原生字节准备前必须经过完整 request 根。 */ () =>
          state.adapter.encodeRequest(state.request, state.context),
        /herdr_native_request_invalid/
      )
      assert.throws(
        /** request 根失败后合法原生错误也不能自行建立 permit。 */ () =>
          state.adapter.decodeResponse(
            Buffer.from(
              JSON.stringify({
                id: state.binding.native_request_id,
                error: { code: 'synthetic', message: 'synthetic' }
              }) + '\n'
            ),
            state.context
          ),
        /dispatch_permit_unavailable/
      )
      assert.equal(state.store.call('principal1', state.binding.call_id).state, 'dispatching')
    } finally {
      state.close()
    }
  }
)

test(
  'metadata dispatch and delivery require its own current grants and the original request body',
  /** ping 授权不能扩展到元数据；原请求正文、当前派发权和当前读权分别检查。 */ () => {
    const state = stored(false, metadataRequest())
    try {
      assert.throws(
        /** 原 binding 不能改写 token 内容后重新编码。 */ () =>
          state.adapter.encodeRequest(
            { ...metadataRequest('different'), id: state.binding.native_request_id },
            state.context
          ),
        /attempt_request_mismatch/
      )
      state.adapter.encodeRequest(state.request, state.context)
      assert.deepEqual(
        state.adapter.decodeResponse(
          Buffer.from(JSON.stringify(state.frame.payload.native_response) + '\n'),
          state.context
        ),
        state.frame.payload.native_response
      )
    } finally {
      state.close()
    }
  }
)

test(
  'metadata accepts its original id and official Ok shape or the complete native error root',
  /** 完整官方 schema 负责结果字段范围；其它方法结果和未准备状态不能变成元数据成功。 */ () => {
    const state = stored(false, metadataRequest())
    try {
      const response = state.frame.payload.native_response
      assert.throws(
        /** schema 合法的 Ok 不能自行创建派发许可。 */ () =>
          state.adapter.decodeResponse(Buffer.from(JSON.stringify(response) + '\n'), state.context),
        /dispatch_permit_unavailable/
      )
      state.adapter.encodeRequest(state.request, state.context)
      for (const wrong of [
        { ...response, id: 'another' },
        { ...response, result: fixture().response.result },
        { ...response, result: { type: 1 } },
        { ...response, error: { code: 'unknown_workspace', message: 'synthetic' } },
        { id: response.id, error: { code: 'unknown_workspace', message: 1 } }
      ]) {
        assert.throws(
          /** 保持完整 response 根与请求特定类型校验；不能隐式采纳其它结果。 */ () =>
            state.adapter.decodeResponse(Buffer.from(JSON.stringify(wrong) + '\n'), state.context)
        )
      }
      const error = { id: response.id, error: { code: 'unknown_workspace', message: 'synthetic native error' } }
      assert.deepEqual(state.adapter.decodeResponse(Buffer.from(JSON.stringify(error) + '\n'), state.context), error)
      const extended = { ...response, result: { type: 'ok', synthetic_extension: 'preserved' } }
      assert.deepEqual(
        state.adapter.decodeResponse(Buffer.from(JSON.stringify(extended) + '\n'), state.context),
        extended
      )
      assert.throws(
        /** 共享纯分类通过也不能绕过完整 request 根。 */ () =>
          createHerdrCodec(source, { ...schemas, request: /** 模拟完整根拒绝。 */ () => false }).encode(state.request),
        /herdr_native_request_invalid/
      )
      assert.throws(
        /** 完整 response 根拒绝优先于正确的 Ok 类型。 */ () =>
          createHerdrCodec(source, { ...schemas, response: /** 模拟完整根拒绝。 */ () => false }).decode(
            Buffer.from(JSON.stringify(response) + '\n'),
            state.request
          ),
        /herdr_native_response_invalid/
      )
    } finally {
      state.close()
    }
  }
)

for (const cleanup of ['ttl', 'discard', 'late'] as const) {
  test(
    `real Store metadata ${cleanup} keeps the original response rule without rebuilding cleared params`,
    /** 真实回收后只验证原 ID/Ok；不保留 token 正文、延长期限或从空参数重建新请求。 */ () => {
      const state = stored(true, metadataRequest('synthetic note that must leave the cached request'))
      try {
        const before = state.adapter.stats().attempt_bytes
        const anchor = state.store.responseAnchor(state.binding)
        if (cleanup === 'discard') {
          state.store.discardResponse('principal1', state.binding.call_id)
        } else {
          state.advance(cleanup === 'ttl' ? 150 : 120)
          state.store.expire()
        }
        const response = state.frame.payload.native_response
        assert.deepEqual(
          state.adapter.decodeResponse(Buffer.from(JSON.stringify(response) + '\n'), state.context),
          response
        )
        const result = commitHerdrResponse(state.store, state.adapter, state.frame)
        const retained = state.store.responseAnchor(state.binding)
        assert.equal(retained.content_expires_at, anchor.content_expires_at)
        assert.equal(retained.dedup_expires_at, anchor.dedup_expires_at)
        if (cleanup === 'late') {
          assert.equal(result.state, 'responded')
          assert.deepEqual(JSON.parse(result.response!), response)
          assert(
            state.store
              .auditRecords()
              .some(/** 迟到 Ok 只记录原调用证据。 */ (entry) => entry.action === 'late_evidence')
          )
        } else {
          assert.equal(result.response, null)
          assert.equal(state.backend.attempt(state.binding.call_id, state.binding.attempt_id), undefined)
          assert.equal(state.adapter.stats().executions, 0)
          assert.equal(state.adapter.stats().responses, 1)
          assert(state.adapter.stats().attempt_bytes < before)
          assert.throws(
            /** 回收态不能重新编码原写入。 */ () => state.adapter.encodeRequest(state.request, state.context),
            /content_unavailable/
          )
          assert.throws(
            /** 已回收的响应不能交付。 */ () => state.adapter.checkResult(state.context),
            /content_unavailable/
          )
        }
        state.advance(anchor.dedup_expires_at)
        assert.equal(state.adapter.stats().responses, 0)
        assert.throws(
          /** 原去重期限到达即撤销密封响应规则。 */ () =>
            state.adapter.decodeResponse(Buffer.from(JSON.stringify(response) + '\n'), state.context),
          /native_context_unavailable/
        )
      } finally {
        state.close()
      }
    }
  )
}

test(
  'real Store admits exact reviewed ping and persistent backend checks local configuration and shutdown',
  /** 真实 Store 正向建档并提交真实 codec 验过的 fixture；本测试不声称运行原生 binary。 */ () => {
    const state = stored()
    try {
      assert.deepEqual(
        state.backend.context('principal1', 'gateway_to_connector').resolveProvider!(state.target),
        state.provider
      )
      state.local.config_ref = 'different-protected-instance'
      assert.throws(
        /** 同 kind 不同本机配置不得混用。 */ () => state.adapter.encodeRequest(state.request, state.context),
        /provider_binding_mismatch/
      )
      state.local.config_ref = state.provider.config_ref
      const bytes = Buffer.from(JSON.stringify(state.frame.payload.native_response) + '\n')
      assert.deepEqual(state.adapter.decodeResponse(bytes, state.context), state.frame.payload.native_response)
      const result = commitHerdrResponse(state.store, state.adapter, state.frame)
      assert.equal(result.state, 'responded')
      assert.deepEqual(JSON.parse(result.response!), state.frame.payload.native_response)
      state.store.close()
      assert.throws(
        /** Store 关闭同步撤销 adapter 及监听。 */ () => state.adapter.resolve(state.identity),
        /native_adapter_closed/
      )
    } finally {
      state.close()
    }
  }
)

for (const cleanup of ['ttl', 'discard', 'late'] as const) {
  test(
    `real Store ${cleanup} accepts original ping evidence without reviving forbidden content`,
    /** 原生 permit 经真实 Store 回收/迟到事务仍只提交合法证据，不恢复原请求或内容期限。 */ () => {
      const state = stored()
      try {
        const anchor = state.store.responseAnchor(state.binding)
        if (cleanup === 'discard') {
          state.store.discardResponse('principal1', state.binding.call_id)
        } else {
          state.advance(cleanup === 'ttl' ? 150 : 120)
          state.store.expire()
        }
        const result = commitHerdrResponse(state.store, state.adapter, state.frame)
        assert.equal(state.store.responseAnchor(state.binding).content_expires_at, anchor.content_expires_at)
        assert.equal(state.store.responseAnchor(state.binding).dedup_expires_at, anchor.dedup_expires_at)
        if (cleanup === 'late') {
          assert.equal(result.state, 'responded')
          assert.equal(
            state.store
              .auditRecords()
              .some(/** 固定审计记录迟到证据，不代表重复派发。 */ (entry) => entry.action === 'late_evidence'),
            true
          )
          assert.deepEqual(JSON.parse(result.response!), state.frame.payload.native_response)
        } else {
          assert.equal(result.response, null)
          assert.equal(state.backend.attempt(state.binding.call_id, state.binding.attempt_id), undefined)
          assert.equal(state.adapter.stats().executions, 0)
          assert.equal(state.adapter.stats().responses, 1)
          assert.throws(
            /** 回收后的原 permit 不能恢复当前内容交付。 */ () => state.adapter.checkResult(state.context),
            /content_unavailable/
          )
        }
      } finally {
        state.close()
      }
    }
  )
}

for (const invalid of [
  { request: { method: 'events.subscribe', params: {} } },
  { request: { method: 'pane.unknown', params: {} } },
  { request: { method: 'ping' } },
  { request: { method: 'ping', params: {}, extra: true } },
  { validation: 'raw-contract' as const },
  { host: true }
]) {
  test(
    `real Herdr Store admission refuses unreviewed intent ${JSON.stringify(invalid)}`,
    /** 建档严格匹配 session、契约、模式和完整 ping 空参对象，未知值不能成为派发锚点。 */ () => {
      const state = stored()
      try {
        assert.throws(
          /** 每个反例都走真实 Store writer，不修改数据库或生产源码。 */ () =>
            state.store.createCall(
              'principal1',
              'host' in invalid
                ? { machine_id: state.target.machine_id, provider_id: state.target.provider_id, profile: 'host' }
                : state.target,
              'request' in invalid ? invalid.request! : { method: 'ping', params: {} },
              {
                ...state.options,
                ...('validation' in invalid ? { validation: invalid.validation } : {})
              }
            ),
          /provider_support_candidate/
        )
      } finally {
        state.close()
      }
    }
  )
}

for (const cleanup of ['ttl', 'discard'] as const) {
  test(
    `synthetic ${cleanup} releases request anchor and keeps only the already permitted ping response`,
    /** 合成许可前提下覆盖请求已不可恢复的路径；不宣称真实 Store 的 Herdr 正向接通。 */ () => {
      const state = prepared()
      try {
        const before = state.adapter.stats().attempt_bytes
        if (cleanup === 'ttl') {
          state.backend.now = /** 原内容期限到达，但去重期限仍有效。 */ () => 1000
        } else {
          state.emit({ kind: 'content', machine_id: state.binding.machine_id, call_id: state.binding.call_id })
        }
        state.backend.attempt = /** 内容回收后不再保留请求锚点。 */ () => undefined
        assert.equal(state.adapter.stats().executions, 0)
        assert.equal(state.adapter.stats().responses, 1)
        assert(state.adapter.stats().attempt_bytes < before)
        const context = state.adapter.resolve(state.identity)
        assert.deepEqual(context, state.context)
        assert.deepEqual(
          state.adapter.decodeResponse(Buffer.from(JSON.stringify(fixture().response) + '\n'), context),
          fixture().response
        )
        assert.throws(
          /** 最小响应上下文不能重新派发。 */ () => state.adapter.encodeRequest(state.request, context),
          /content_unavailable/
        )
        assert.throws(
          /** 最小响应上下文不能复活交付权。 */ () => state.adapter.checkResult(context),
          /content_unavailable/
        )
      } finally {
        state.adapter.close()
        assert.equal(state.listeners.size, 0)
      }
    }
  )
}

test(
  'one Herdr response checks only its selected persistent content anchor while idle expiry remains independent',
  /** 多个活调用不会令一次响应遍历其它持久 receipt；当前调用仍强查未通知 discard 与固定期限。 */ () => {
    const state = backendFixture()
    const records = new Map<string, typeof state.record>()
    const discarded = new Set<string>()
    let checks = 0
    const token = Object.freeze({ synthetic_local_installation: true })
    for (let i = 0; i < 20; i++) {
      const record = structuredClone(state.record)
      record.binding.call_id = 'call' + i
      record.binding.attempt_id = 'attempt' + i
      record.binding.native_request_id = 'native' + i
      records.set(record.binding.call_id, record)
    }
    state.backend.attempt = /** 未通知的当前 discard 已从外部 ledger 释放正文。 */ (call) =>
      discarded.has(call) ? undefined : records.get(call)
    state.backend.contentStatus = /** 计量持久边界调用次数，不依赖定时性能或假 native 延迟。 */ (binding) => {
      checks++
      return discarded.has(binding.call_id) ? 'discarded' : 'available'
    }
    state.backend.nativeSource = /** 共享合成本机 owner，仍按每个完整 binding 提供独立投影。 */ (binding) => ({
      role: 'local_installation',
      binding,
      token
    })
    const anchor = state.backend.responseAnchor
    state.backend.responseAnchor = /** 每次仍核对被操作调用的原固定锚点。 */ (binding) => ({
      ...anchor(binding)!,
      binding,
      content_status: discarded.has(binding.call_id) ? 'discarded' : 'available'
    })
    const adapter = createHerdrReadonlyAdapter(state.backend)
    try {
      const contexts = []
      for (const record of records.values()) {
        const {
          machine_id: _machine,
          recovery_generation: _recovery,
          connection_epoch: _epoch,
          ...identity
        } = record.binding
        const context = adapter.resolve(identity)
        adapter.encodeRequest({ ...record.native_request, id: record.binding.native_request_id }, context)
        contexts.push(context)
      }
      checks = 0
      assert.equal(adapter.stats().executions, 20)
      assert.equal(checks, 0)
      const context = contexts[0]!
      const response = { ...fixture().response, id: context.binding.native_request_id }
      const bytes = Buffer.from(JSON.stringify(response) + '\n')
      assert.deepEqual(adapter.decodeResponse(bytes, context), response)
      assert.equal(checks, 1)
      discarded.add(context.binding.call_id)
      checks = 0
      assert.deepEqual(adapter.decodeResponse(bytes, context), response)
      assert.equal(checks, 1)
      assert.equal(adapter.stats().executions, 19)
      assert.equal(adapter.stats().responses, 1)
      assert.throws(
        /** 当前 discard 不因减少全局扫描而恢复读取或重新派发。 */ () => adapter.checkResult(context),
        /content_unavailable/
      )
      state.backend.now = /** 固定内容截止仍主动回收所有原文，不读取外部 receipt 或延长期限。 */ () => 1000
      checks = 0
      assert.equal(adapter.stats().executions, 0)
      assert.equal(adapter.stats().responses, 20)
      assert.equal(checks, 0)
    } finally {
      adapter.close()
    }
  }
)

test(
  'minimal response context rejects changed anchor retention and expires without refreshing dedup',
  /** 回收后固定期限不可变，改锚点或达到原去重期限均不能延长证据能力。 */ () => {
    const state = prepared()
    try {
      state.emit({ kind: 'content', machine_id: state.binding.machine_id, call_id: state.binding.call_id })
      state.backend.attempt = /** 模拟请求原文已不可恢复。 */ () => undefined
      const anchor = state.backend.responseAnchor
      state.backend.responseAnchor = /** 模拟错误地延长固定内容期限。 */ (binding) => ({
        ...anchor(binding)!,
        content_expires_at: 1001
      })
      assert.throws(
        /** 原期限变更拒绝旧能力。 */ () => state.adapter.decodeResponse(Buffer.alloc(0), state.context),
        /attempt_binding_mismatch/
      )
      state.backend.responseAnchor = anchor
      state.backend.now = /** 达到原去重截止时间，不从新回复刷新。 */ () => 2000
      assert.equal(state.adapter.stats().responses, 0)
      assert.throws(
        /** 到期后没有旧句柄可取。 */ () => state.adapter.decodeResponse(Buffer.alloc(0), state.context),
        /native_context_unavailable/
      )
    } finally {
      state.adapter.close()
      assert.equal(state.listeners.size, 0)
    }
  }
)

for (const kind of ['closed', 'content', 'fence'] as const) {
  test(
    `reentrant ${kind} notification during resolution cannot register a handle after invalidation`,
    /** 原生宿主回调同步触发回收时，真实组件也不能在关闭或 fence 后登记上下文。 */ () => {
      const state = backendFixture()
      const anchor = state.backend.responseAnchor
      state.backend.responseAnchor = /** 在真实组件读取锚点期间注入同步通知，不放行生产 provider gate。 */ (
        binding
      ) => {
        const result = anchor(binding)
        state.emit(kind === 'closed' ? { kind } : { kind, machine_id: binding.machine_id, call_id: binding.call_id })
        return result
      }
      const adapter = createHerdrReadonlyAdapter(state.backend)
      try {
        assert.throws(
          /** 在所有 callbacks 完成后仍须核对关闭与本轮失效代次。 */ () => adapter.resolve(state.identity),
          kind === 'closed' ? /native_adapter_closed/ : /attempt_context_invalidated/
        )
        if (kind !== 'closed') {
          assert.equal(adapter.stats().executions, 0)
          assert.equal(adapter.stats().responses, 0)
        }
      } finally {
        adapter.close()
        assert.equal(state.listeners.size, 0)
      }
    }
  )
}

test(
  'independent Store retention windows need not place dedup after content expiry',
  /** 保持 Store 各期限独立；相等或较短的去重窗口不能被 adapter 擅自改成无效配置。 */ () => {
    for (const expires of [500, 1000]) {
      const state = backendFixture()
      const anchor = state.backend.responseAnchor
      state.backend.responseAnchor = /** 使用仍在未来、但不大于内容期限的原锚点去重期限。 */ (binding) => ({
        ...anchor(binding)!,
        dedup_expires_at: expires
      })
      const adapter = createHerdrReadonlyAdapter(state.backend)
      try {
        adapter.resolve(state.identity)
        assert.equal(adapter.stats().executions, 1)
        state.backend.now = /** 达到各自原截止时间后精确释放，不延长任何窗口。 */ () => expires
        assert.equal(adapter.stats().executions, 0)
      } finally {
        adapter.close()
      }
    }
  }
)

test(
  'Herdr Wire shares its native permit with the real Store and transport Adapter interface',
  /** 普通 Wire 请求、原生 fixture 响应和真实 Store 提交共用一个 core，不依赖源码派生或第二账本。 */ () => {
    const state = stored(false)
    const wire: Adapter = createHerdrWireAdapter(state.backend, state.adapter)
    try {
      const request = {
        ...state.frame,
        type: 'request' as const,
        message_id: 'wire-request',
        payload: {
          attempt: state.identity,
          expected_binding_revision: 1,
          native_request: { method: 'ping', params: {} },
          validation: 'strict' as const
        }
      }
      const raw = wire.encode(request, 'gateway_to_connector')
      assert.deepEqual(wire.decode(raw, 'gateway_to_connector'), request)
      assert.equal(wire.observeMessage(request, 'gateway_to_connector'), 'new')
      assert.equal(wire.observeMessage(request, 'gateway_to_connector'), 'duplicate')
      assert.throws(
        /** 相同 message ID 对应不同摘要不能变成第二个调用。 */ () =>
          wire.observeMessage(
            { ...request, payload: { ...request.payload, expected_binding_revision: 2 } },
            'gateway_to_connector'
          )
      )
      const encoded = wire.encode(state.frame, 'connector_to_gateway')
      assert.deepEqual(wire.decode(encoded, 'connector_to_gateway'), state.frame)
      wire.checkResult(state.binding, state.frame.payload.native_response)
      wire.checkResultRetention(state.binding, state.frame.payload.native_response)
      const result = state.store.commitEvidence(
        state.binding,
        /** 现有事务内重新规划响应证据。 */ () => wire.planEvidence(state.frame)
      )
      assert.equal(result.state, 'responded')
      wire.release(state.binding)
      assert.equal(state.adapter.stats().executions, 0)
      assert.throws(
        /** 释放后合法旧响应也不能复用旧 permit。 */ () => wire.decode(encoded, 'connector_to_gateway'),
        /dispatch_permit_unavailable/
      )
    } finally {
      wire.close()
      assert.equal(wire.stats().closed, true)
      state.close()
    }
  }
)

test(
  'Herdr bridge cancellation authorizes only the Wire wait and rejects native stream or object paths',
  /** cancel 只是现有 Wire 的等待治理；本切片无原生 cancel、流或对象实现。 */ () => {
    const state = stored()
    const wire = createHerdrWireAdapter(state.backend, state.adapter)
    try {
      const cancel = {
        ...state.frame,
        type: 'cancel' as const,
        payload: { attempt: state.identity, reason: 'caller_cancelled' as const }
      }
      assert.equal(JSON.parse(wire.encode(cancel, 'gateway_to_connector')).type, 'cancel')
      assert.equal(state.adapter.stats().executions, 1)
      wire.release(state.binding)
      assert.equal(state.adapter.stats().executions, 0)
      assert.equal(state.store.call('principal1', state.binding.call_id).state, 'dispatching')
    } finally {
      wire.close()
      state.close()
    }
  }
)

for (const unknown of [false, true]) {
  test(
    `Herdr dispatch refusal uses the negotiated codec and preserves prior unknown=${unknown}`,
    /** 真实 Wire/Store 与品牌 schema；原生来源为合成接缝，不写入终端、不生成 dispatch permit。 */ () => {
      const state = stored(false, { method: 'pane.send_text', params: { pane_id: 'owned', text: 'synthetic input' } })
      const connection = state.backend.context('principal1', 'connector_to_gateway').connection
      connection.negotiated.capabilities.push('dispatch_refusal')
      const wire = createHerdrWireAdapter(state.backend, state.adapter)
      const refusal = {
        ...state.frame,
        type: 'dispatch_refused' as const,
        message_id: 'herdr-refusal',
        payload: { attempt: state.identity, code: 'terminal_execution_disabled' as const }
      }
      try {
        const ack = { id: state.binding.native_request_id, result: { type: 'ok' } }
        assert.throws(
          /** 拒绝帧之前没有原生执行许可。 */ () => wire.checkResult(state.binding, ack),
          /dispatch_permit_unavailable/
        )
        const raw = wire.encode(refusal, 'connector_to_gateway')
        assert.deepEqual(wire.decode(raw, 'connector_to_gateway'), refusal)
        assert.equal(wire.observeMessage(refusal, 'connector_to_gateway'), 'new')
        assert.equal(wire.observeMessage(refusal, 'connector_to_gateway'), 'duplicate')
        assert.throws(
          /** 拒绝编解码不能补造原生执行许可。 */ () => wire.checkResult(state.binding, ack),
          /dispatch_permit_unavailable/
        )
        assert.throws(
          /** 拒绝仅允许 Connector 向 Gateway 发送。 */ () => wire.encode(refusal, 'gateway_to_connector'),
          /wrong_direction/
        )
        assert.throws(
          /** 旧 epoch 不得影响当前调用。 */ () =>
            wire.decode(JSON.stringify({ ...refusal, connection_epoch: 'old_epoch' }), 'connector_to_gateway'),
          /connection_binding_mismatch/
        )
        assert.throws(
          /** 固定拒绝码不能携带任意原生异常或回包。 */ () =>
            wire.decode(
              JSON.stringify({ ...refusal, payload: { ...refusal.payload, code: 'synthetic_other' } }),
              'connector_to_gateway'
            ),
          /invalid_enum/
        )
        connection.negotiated.capabilities = ['rpc', 'late_evidence']
        assert.throws(
          /** 未协商时仍不能接收拒绝帧。 */ () => wire.decode(raw, 'connector_to_gateway'),
          /unsupported_capability/
        )
        connection.negotiated.capabilities.push('dispatch_refusal')
        state.store.accepted(state.binding)
        if (unknown) {
          state.store.stop('principal1', state.binding.call_id)
        }
        assert.equal(state.store.commitDispatchRefusal(state.binding, refusal.payload.code), !unknown)
        assert.equal(
          state.store.call('principal1', state.binding.call_id).state,
          unknown ? 'outcome_unknown' : 'not_dispatched'
        )
      } finally {
        wire.close()
        state.close()
      }
    }
  )
}
