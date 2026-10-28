/** 固定官方 schema 与脱敏原生值回放；授权与原生 socket 来源仍由各测试单独声明。 */
import { readFileSync } from 'node:fs'
import { compileHerdrSchemas } from '../../../src/connector/herdr/compiler-api.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { HERDR_READONLY_REVIEW as review } from '../../../src/connector/herdr/readonly.js'
import type { HerdrReadonlyBackend, HerdrSchemas } from '../../../src/connector/herdr/readonly.js'
import { contractRef, hash } from '../../../src/wire/index.js'
import type { AttemptBinding, AuthenticatedContext, ContractSource, JsonObject } from '../../../src/wire/types.js'
import type { LedgerInvalidation } from '../../../src/storage/model.js'

export const raw = readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url))
const bundle = JSON.parse(raw.toString())
export const exchanges: { request: JsonObject; response: JsonObject }[] = JSON.parse(
  readFileSync(new URL('../../fixtures/herdr/0.9.5/readonly.json', import.meta.url), 'utf8')
)
export const source: ContractSource = {
  provider_kind: 'herdr',
  protocol_family: 'herdr-json',
  binary_version: review.version,
  binary_sha256: review.binary_sha256,
  schema_sha256: review.schema_sha256,
  schema_origin: 'installed_cli',
  schema_command: 'herdr api schema --json',
  server_version: review.version,
  native_protocol_version: String(review.protocol),
  runtime_generation: null,
  adapter_revision: review.adapter_revision,
  classification_revision: review.classification_revision,
  support_basis: 'schema_and_version'
}

// 测试直接编译固定原文的完整根；这不是生产独立 worker 的硬编译预算证明。
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false
})
ajv.addKeyword({ keyword: 'schemas', schemaType: 'object', valid: true })
for (const [name, minimum, maximum] of [
  ['uint', 0, Number.MAX_SAFE_INTEGER],
  ['uint64', 0, Number.MAX_SAFE_INTEGER],
  ['uint32', 0, 4294967295],
  ['uint16', 0, 65535],
  ['int32', -2147483648, 2147483647]
] as const) {
  ajv.addFormat(name, {
    type: 'number',
    validate: /** 将原生整数格式限制在安全整数及对应上下界内。 */ (value: number) =>
      Number.isSafeInteger(value) && value >= minimum && value <= maximum
  })
}
ajv.addFormat('float', { type: 'number', validate: Number.isFinite })
const schemaId = 'urn:rovloom:herdr:0.9.5'
ajv.addSchema({ $id: schemaId, $schema: bundle.$schema, schemas: bundle.schemas })
const requestRoot = ajv.compile({ $ref: schemaId + '#/schemas/request' })
const successRoot = ajv.compile({ $ref: schemaId + '#/schemas/success_response' })
const errorRoot = ajv.compile({ $ref: schemaId + '#/schemas/error_response' })
export const schemas: HerdrSchemas = Object.freeze({
  protocol: review.protocol,
  schema_sha256: hash(raw),
  dialect: bundle.$schema,
  request: requestRoot,
  response: /** 验证完整成功或错误根，不把方法 envelope 当作完整 schema。 */ (value: JsonObject) =>
    successRoot(value) || errorRoot(value)
})

/** 组件测试通过真实异步 Worker 取得不可复制品牌；离线 codec 仍使用上面的直接完整根。 */
export const compiledSchemas = await compileHerdrSchemas(raw)

/** 克隆脱敏原生值，避免一个反例污染后续 fixture。 */
export function fixture(index = 0) {
  return structuredClone(exchanges[index]!)
}

/** 合成 Store/认证接缝仍使用真实共享 provider gate，不注入放行替身。 */
export function backendFixture() {
  const binding: AttemptBinding = {
    machine_id: 'machine1',
    recovery_generation: 'recovery1',
    connection_epoch: 'connection1',
    call_id: 'call1',
    attempt_id: 'attempt1',
    native_request_id: 'readonly-fixture',
    target: { machine_id: 'machine1', provider_id: 'herdr1', profile: 'session', session: 'synthetic' },
    provider_kind: 'herdr',
    binding_revision: 1,
    contract_ref: contractRef(source),
    registration: { deadline: 1000 }
  }
  const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...identity } = binding
  const record = {
    binding,
    principal_id: 'principal1',
    method: 'ping',
    mode: 'strict' as const,
    transport: 'rpc' as const,
    native_request: { method: 'ping', params: {} }
  }
  const wire = { source, support_status: 'validated' as const }
  const token = Object.freeze({ synthetic_endpoint_receipt: true })
  const context: AuthenticatedContext = {
    phase: 'authenticated',
    direction: 'gateway_to_connector',
    connection: {
      machine_id: binding.machine_id,
      recovery_generation: binding.recovery_generation,
      connection_epoch: binding.connection_epoch,
      authenticated: true,
      active: true,
      negotiated: { major: 2, minor: 0, capabilities: ['rpc'] }
    },
    resolveProvider: /** 返回本测试唯一明确的 provider 配置，不从消息建立生产绑定。 */ () => ({
      machine_id: binding.machine_id,
      provider_id: binding.target.provider_id,
      kind: 'herdr',
      binding_revision: 1,
      config_ref: 'config1',
      enabled: true
    }),
    resolveContract: /** 按合成 registry 返回固定来源记录，真实 gate 仍单独检查它。 */ () => wire
  }
  const backend: HerdrReadonlyBackend = {
    attempt: /** 仅按原 call/attempt 精确匹配返回原锚点。 */ (call, attempt) =>
      call === binding.call_id && attempt === binding.attempt_id ? record : undefined,
    now: /** 返回固定测试时钟，避免真实时间影响期限边界。 */ () => 100,
    currentPrincipal: /** 返回本测试原调用者，供当前内容授权检查。 */ () => record.principal_id,
    contentStatus: /** 仅在此 fixture 模拟内容仍可用，不改变 Store 保留逻辑。 */ () => 'available',
    responseAnchor: /** 返回原固定期限和派发状态，不能把测试响应作为锚点来源。 */ () => ({
      binding,
      method: record.method,
      mode: record.mode,
      state: 'dispatching',
      content_status: 'available',
      content_expires_at: 1000,
      dedup_expires_at: 2000
    }),
    subscribeInvalidation: /** 在合成接缝中登记通知，真实 Store 集成另行验证。 */ (listener) => {
      listeners.add(listener)
      return /** 关闭 adapter 后解除本轮监听。 */ () => {
        listeners.delete(listener)
      }
    },
    context: /** 复用本测试当前认证上下文，让反例显式改变其连接或策略。 */ () => context,
    contract: /** 返回同一固定契约及完整根校验器，检查对象来源一致性。 */ () => ({ wire, schemas: compiledSchemas }),
    nativeSource: /** 返回明确合成的本机角色与 token，机制测试不声称实际安装证据。 */ () => ({
      role: 'local_installation',
      binding,
      token
    })
  }
  const listeners = new Set<(event: LedgerInvalidation) => void>()
  return {
    binding,
    identity,
    record,
    wire,
    context,
    backend,
    listeners,
    emit: /** 模拟已提交的账本通知，不生成生产授权。 */ (event: LedgerInvalidation) => {
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
}
