/** 离线验证共享普通方法审核与真实原 gate 的授权组合；合成来源只供测试，不启动原生或导入 JSON 许可。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkDispatch, compileBundle, createNativeValidator } from '../../src/native-contract/index.js'
import type { NativeBinding, TrustedNativeContext } from '../../src/native-contract/index.js'
import type { NativeContractRecord, TrustedAttempt } from '../../src/integration/luvus-wire.js'
import { boundedJson, contractRef } from '../../src/wire/index.js'
import type { ContractSource } from '../../src/wire/types.js'
import { FIXED_LUVUS_SCHEMA_SHA256, FIXED_LUVUS_SHA256 } from '../../src/runtime/native-control.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.js'
import {
  assertLuvusOperationsContract,
  createLuvusOperationsValidation
} from '../../src/runtime/luvus-operations-validation.js'
import { LUVUS_OPERATION_METHODS } from '../../src/runtime/luvus-operations.js'

const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
const result = await compileBundle(schema, {
  identity: {
    binary_sha256: FIXED_LUVUS_SHA256,
    schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
    revision: MANAGED_LUVUS_REVISION
  }
})
assert(result.ok)
const compiled = result.value

/** 每个场景复制原官方能力 envelope，session 与 generation 仅换为明确的合成测试值。 */
function record(): NativeContractRecord {
  const capabilities = JSON.parse(
    readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
  )
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = 'generation1'
  const source: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: FIXED_LUVUS_SHA256,
    schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: 'generation1',
    adapter_revision: MANAGED_LUVUS_REVISION,
    classification_revision: MANAGED_LUVUS_CLASSIFICATION,
    support_basis: 'live_catalog'
  }
  return {
    wire: { source, support_status: 'validated' },
    compiled,
    capabilities,
    capability_revision: createHash('sha256').update(boundedJson(capabilities.result)).digest('hex')
  }
}

/** 构造完整合成 attempt 与来源，以当前实际编译句柄运行原生 gate，不模拟网络认证。 */
function fixture(method = 'workspace.rename', params: Record<string, unknown> = { workspace_id: 'a', name: 'chosen' }) {
  const contract = record()
  const target = { machine_id: 'machine1', provider_id: 'provider1', profile: 'session' as const, session: 'synthetic' }
  const attempt: TrustedAttempt = {
    binding: {
      machine_id: target.machine_id,
      connection_epoch: 'epoch1',
      recovery_generation: 'recovery1',
      call_id: 'call1',
      attempt_id: 'attempt1',
      native_request_id: 'request1',
      target,
      provider_kind: 'luvus',
      binding_revision: 1,
      contract_ref: contractRef(contract.wire.source),
      registration: {
        deadline: 200
      }
    },
    principal_id: 'principal1',
    method,
    mode: method === 'pane.list' ? 'strict' : 'raw-contract',
    native_request: { id: 'request1', method, params }
  }
  const native: NativeBinding = {
    kind: 'luvus',
    provider_id: target.provider_id,
    binding_revision: 1,
    contract_source_ref: attempt.binding.contract_ref,
    target: { machine_id: target.machine_id, profile: 'session', session: target.session },
    server_generation: 'generation1',
    connection_epoch: 'epoch1',
    recovery_generation: 'recovery1',
    capability_revision: contract.capability_revision,
    classification_revision: MANAGED_LUVUS_CLASSIFICATION,
    contract: compiled.identity
  }
  const source: TrustedNativeContext = { binding: native, authenticated: true, source_verified: true }
  return { contract, attempt, native, source }
}

function dispatch(input: ReturnType<typeof fixture>, now = 100) {
  const validate = createLuvusOperationsValidation(input.contract, () => input.source)
  validate(input.attempt, input.native)
  const validator = createNativeValidator(compiled)
  const view = validator.bindCapabilities(input.contract.capabilities, input.source)
  assert(view.ok)
  const candidate = validator.checkRawRequest(view.value, input.attempt.native_request)
  assert(candidate.ok)
  return checkDispatch(candidate.value, {
    source: input.source,
    principal_id: input.attempt.principal_id,
    mode: input.attempt.mode === 'strict' ? 'strict' : 'raw_contract',
    now
  })
}
test(
  'shared Luvus contract review binds actual installation, source revisions and compiled identity',
  /** 逐项破坏实际来源、协议与修订，诊断版本不参与接纳。 */ () => {
    assert.doesNotThrow(/** 原官方固定输入保持可用。 */ () => assertLuvusOperationsContract(record()))
    for (const [field, value] of [
      ['binary_sha256', 'a'.repeat(64)],
      ['schema_sha256', 'b'.repeat(64)],
      ['provider_kind', 'herdr'],
      ['protocol_family', 'herdr-json'],
      ['schema_origin', 'advertisement'],
      ['schema_command', 'other schema'],
      ['native_protocol_version', '2.0'],
      ['support_basis', 'schema_and_version'],
      ['adapter_revision', 'unreviewed'],
      ['classification_revision', 'unreviewed'],
      ['runtime_generation', 'generation2']
    ]) {
      const contract = record()
      Object.assign(contract.wire.source, { [field!]: value })
      assert.throws(
        /** 固定 pin 不由待审核输入覆盖。 */ () => assertLuvusOperationsContract(contract),
        /luvus_operations_source_mismatch/
      )
    }
    for (const field of ['binary_sha256', 'schema_sha256', 'revision'] as const) {
      const contract = record()
      contract.compiled = { ...compiled, identity: { ...compiled.identity, [field]: 'changed' } }
      assert.throws(
        /** compiled 摘要和修订也必须与来源完全一致。 */ () => assertLuvusOperationsContract(contract),
        /luvus_operations_source_mismatch/
      )
    }
  }
)

test(
  'shared Luvus method compatibility rejects only the dependent operation',
  /** 缺少或变化的可选方法不阻断 provider；相关方法独立失败，健康方法继续产生原授权。 */ () => {
    for (const change of ['missing', 'duplicate', 'access', 'scope', 'idempotent']) {
      const input = fixture()
      const caps = input.contract.capabilities as { result: { method_contracts: Record<string, unknown>[] } }
      const rows = caps.result.method_contracts
      const index = rows.findIndex(/** 只改变本次依赖的窗口重命名能力。 */ (row) => row.method === 'workspace.rename')
      const row = rows[index]!
      if (change === 'missing') {
        rows.splice(index, 1)
      } else if (change === 'duplicate') {
        rows.push({ ...row })
      } else if (change === 'access') {
        row.access = 'read'
      } else if (change === 'scope') {
        row.scope = 'admin'
      } else if (change === 'idempotent') {
        row.idempotent = true
      }
      assert.doesNotThrow(/** provider 保留其它能力的来源。 */ () => assertLuvusOperationsContract(input.contract))
      const authority = createLuvusOperationsValidation(input.contract, /** 合成当前来源。 */ () => input.source)
      assert.throws(
        /** 仅相关方法拒绝。 */ () => authority(input.attempt, input.native),
        /luvus_operations_contract_mismatch/
      )
      const healthy = fixture('pane.list', {})
      assert.doesNotThrow(/** 相同 provider 的健康方法继续通过。 */ () => authority(healthy.attempt, input.native))
    }
    const input = record()
    input.wire.source.binary_version = 'future-diagnostic-version'
    input.wire.source.server_version = 'different-server-version'
    assert.doesNotThrow(/** 版本标签不参与接口兼容判断。 */ () => assertLuvusOperationsContract(input))
    assert.equal(LUVUS_OPERATION_METHODS.length, 36)
  }
)

test('strict 与 generic 共用来源和参数校验，不产生 Owner 或 raw grant', () => {
  for (const input of [fixture(), fixture('pane.list', {})]) {
    const result = dispatch(input)
    assert(result.ok)
    assert(!Object.hasOwn(result.value, 'raw_grant_id'))
  }
  const input = fixture('pane.run', { pane: '1', command: 'printf fixture' })
  assert(dispatch(input).ok)
  input.attempt.native_request.params = { command: 'printf fixture' }
  assert.throws(() => dispatch(input), /luvus_operation_params_invalid/)
})

test('当前来源、原请求方法、验证模式和参数仍必须一致', () => {
  const input = fixture()
  const validate = createLuvusOperationsValidation(input.contract, () => input.source)
  for (const candidate of [
    { ...input.attempt, method: 'uhp.token.create' },
    { ...input.attempt, native_request: { ...input.attempt.native_request, method: 'workspace.close' } },
    { ...input.attempt, mode: 'strict' as const },
    { ...input.attempt, native_request: { ...input.attempt.native_request, params: { workspace_id: 'a' } } }
  ]) {
    assert.throws(() => validate(candidate, input.native), /luvus_operation_(unreviewed|params_invalid)/)
  }
  input.source = { ...input.source, source_verified: false }
  assert.throws(() => validate(input.attempt, input.native), /luvus_operation_unreviewed/)
})
