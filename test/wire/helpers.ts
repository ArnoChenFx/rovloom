// 加载离线 P0 schema 和记录，提供隔离的 Wire 测试身份、门禁及断言工具。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedEnvelope,
  CodecContext,
  NativePayloadValidator,
  VersionOffer,
  ValidationMode,
  ContractSource,
  ProviderBinding
} from '../../src/wire/types.js'
import { contractRef } from '../../src/wire/provider.js'
import { WireError } from '../../src/wire/validation.js'

export const bundle = JSON.parse(
  readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
)
export const transcript: Record<string, any>[] = JSON.parse(
  readFileSync(new URL('../fixtures/luvus/0.14.3/linux/transcript.json', import.meta.url), 'utf8')
)
export const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false
})
for (const [url, schema] of Object.entries(bundle.documents)) {
  ajv.addSchema(schema as AnySchema, url)
}
for (const url of Object.keys(bundle.documents)) {
  assert(ajv.getSchema(url))
}
export const nativeRequest = ajv.getSchema(bundle.request.$id)!
export const nativeResponse = ajv.getSchema(bundle.response.$id)!
// 创建固定 P0 schema 的测试校验器；方法表与授权由原生模块测试覆盖。
export function fixtureValidator(): NativePayloadValidator {
  return {
    // 使用离线请求根 schema 校验完整原生请求。
    validateRequest(r) {
      if (!nativeRequest(r)) {
        throw new WireError('native_request_invalid')
      }
    },
    // 核对原生 ID，再校验响应 schema。
    validateResponse(r, c) {
      if (r.id !== c.binding.native_request_id) {
        throw new WireError('native_id_mismatch')
      }
      if (!nativeResponse(r)) {
        throw new WireError('native_response_invalid')
      }
    }
  }
}
export const identity = {
  machine_id: 'machine_1',
  recovery_generation: 'recovery_1',
  connection_epoch: 'connection_1'
}
export const source: ContractSource = {
  provider_kind: 'luvus',
  protocol_family: 'uhp',
  binary_version: '0.14.3',
  binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
  schema_sha256: transcript.find(
    /* 定位安装版 schema 的采集记录以读取固定来源摘要。 */ (r) => r.label === 'installed-schema'
  )!.raw_stdout_sha256,
  schema_origin: 'installed_cli',
  schema_command: 'luvus uhp schema',
  server_version: '0.14.3',
  native_protocol_version: '1.0',
  runtime_generation: null,
  adapter_revision: 'synthetic_adapter_1',
  classification_revision: 'synthetic_review_1',
  support_basis: 'live_catalog'
}
export const provider: ProviderBinding = {
  machine_id: identity.machine_id,
  provider_id: 'provider_1',
  kind: 'luvus',
  config_ref: 'config_1',
  binding_revision: 1,
  enabled: true
}
export const attempt: AttemptIdentity = {
  call_id: 'call_1',
  attempt_id: 'attempt_1',
  native_request_id: 'proxy-ping',
  target: {
    machine_id: identity.machine_id,
    provider_id: provider.provider_id,
    profile: 'session',
    session: 'p0-issue3'
  },
  provider_kind: 'luvus',
  binding_revision: 1,
  contract_ref: contractRef(source),
  registration: {
    deadline: 1000
  }
}
export const binding: AttemptBinding = { ...identity, ...attempt }
export const offer: VersionOffer = {
  major: 2,
  minor: 0,
  capabilities: ['rpc', 'late_evidence'],
  required: ['rpc']
}
// 构造含独立 provider、契约、调用锚点和双端权限的认证测试上下文。
export function context(
  direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector',
  native = fixtureValidator(),
  anchor = binding,
  method = 'ping',
  mode: ValidationMode = 'strict'
): Extract<CodecContext, { phase: 'authenticated' }> {
  return {
    phase: 'authenticated',
    direction,
    connection: {
      ...identity,
      authenticated: true,
      active: true,
      negotiated: { major: 2, minor: 0, capabilities: [...offer.capabilities] as any }
    },
    validators: { luvus: native },
    // 返回固定测试 provider 的独立副本。
    resolveProvider: () => ({ ...provider }),
    // 返回明确标为已验证的固定测试契约来源。
    resolveContract: () => ({ source: { ...source }, support_status: 'validated' }),
    // 返回测试登记锚点及传输配置。
    resolveAttempt: () => ({
      binding: anchor,
      method,
      mode
    })
  }
}
// 为指定载荷补齐固定版本、消息标识和认证连接字段。
export function frame<K extends AuthenticatedEnvelope['type']>(
  type: K,
  payload: Extract<AuthenticatedEnvelope, { type: K }>['payload']
): Extract<AuthenticatedEnvelope, { type: K }> {
  return {
    protocol_major: 2,
    protocol_minor: 0,
    type,
    message_id: 'message_1',
    ...identity,
    payload
  } as any
}
// 移除原生请求 ID，模拟由可信调用登记随后注入 ID 的请求正文。
export function withoutId(value: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...request } = value
  return request
}
export const request = frame('request', {
  attempt,
  expected_binding_revision: 1,
  native_request: { method: 'ping', params: {} },
  validation: 'strict'
})
export const ping = JSON.parse(
  transcript.find(/* 查找真实 P0 ping 记录以构造响应夹具。 */ (v) => v.label === 'proxy-ping')!.stdout
)
export const response = frame('response', { attempt, native_response: ping })
// 执行待拒绝操作，并要求抛出的结构化错误码与预期完全一致。
export function rejects(action: () => unknown, code: string): void {
  assert.throws(
    action,
    /* 判断异常是否为携带预期错误码的 Error 实例。 */ (e: unknown) =>
      e instanceof Error && 'code' in e && e.code === code,
    code
  )
}
