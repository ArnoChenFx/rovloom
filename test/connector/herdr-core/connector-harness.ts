/**
 * herdr-core Connector 测试的公共夹具：真实 framed 连接、真实审核契约与同形附着来源。
 * 身份核对（/proc）在 connector.test.ts 里单独对真实进程失败关闭，这里只省略那一步。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openHerdrCoreClient } from '../../../src/connector/herdr-core/client.js'
import { herdrCorePinnedEndpoint } from '../../../src/connector/herdr-core/identity.js'
import type { HerdrCoreAttachment } from '../../../src/connector/herdr-core/installation.js'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'
import { publishSchema, schemaReference } from '../../../src/connector/schema-store.js'
import { boundedJson, contractRef, hash } from '../../../src/wire/index.js'
import type { Connection } from '../../../src/transport/index.js'
import type { AttemptBinding, ContractSource, JsonObject, V2Target } from '../../../src/wire/types.js'
import { privateHerdrTestRoot } from '../herdr/private-root.js'
import type { FakeCore } from './fake-core.js'

export const OPENRPC = readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
export const DOCUMENT = boundedJson(JSON.parse(OPENRPC.toString('utf8')))
export const CONTRACT = compileHerdrCoreContract(DOCUMENT)

export const target: V2Target & { profile: 'session' } = {
  machine_id: 'm1',
  provider_id: 'herdr-core',
  profile: 'session',
  session: 'test'
}
export const source: ContractSource = Object.freeze({
  provider_kind: 'herdr-core',
  protocol_family: 'herdr-core-jsonrpc',
  binary_version: '0.1.14',
  binary_sha256: 'a'.repeat(64),
  schema_sha256: hash(DOCUMENT),
  schema_origin: 'live_instance',
  schema_command: 'rpc.discover',
  server_version: '0.1.14',
  native_protocol_version: '1',
  runtime_generation: null,
  adapter_revision: 'adapter-herdr-core-1',
  classification_revision: '0.1.14@29e6d37',
  support_basis: 'schema_and_version'
})
export const reference = contractRef(source)

/** 只在 0700 临时目录里建立可读的 schema 文件与配置。 */
export function fixture(core: FakeCore) {
  const root = privateHerdrTestRoot('rovloom-hc-connector-')
  const schemaPath = schemaReference(root, source.schema_sha256)
  mkdirSync(dirname(schemaPath), { recursive: true, mode: 0o700 })
  publishSchema(schemaPath, Buffer.from(DOCUMENT, 'utf8'))
  const config = {
    version: 1 as const,
    target,
    binding_revision: 1,
    config_ref: 'herdr-core_ref',
    expected_source: source,
    schema_ref: schemaPath,
    connector: {
      session: 'test',
      endpoint: { runtime_dir: core.directory },
      principal_id: 'principal_a',
      claims: {
        path: join(root, 'claims.db'),
        mode: 'create' as const,
        ledger_id: 'claim_ledger',
        limits: { entries: 16, bytes: 1_048_576 }
      }
    }
  }
  return { root, config }
}

/** 真实连接 + 真实契约，只省略 /proc 身份核对；生产路径仍使用 HerdrCoreInstallation。 */
export async function attachment(core: FakeCore): Promise<HerdrCoreAttachment> {
  const client = await openHerdrCoreClient(core.socket)
  const record = Object.freeze({
    wire: Object.freeze({ source, support_status: 'validated' as const }),
    contract: CONTRACT
  })
  return Object.freeze({
    record: () => record,
    client: () => client,
    assert: () => {},
    source: /** 只承认本测试的完整目标与契约摘要。 */ (binding: AttemptBinding) =>
      binding.provider_kind === 'herdr-core' &&
      boundedJson(binding.target) === boundedJson(target) &&
      binding.contract_ref === reference,
    endpoint: () => herdrCorePinnedEndpoint({ runtime_dir: core.directory }, 'test'),
    close: () => client.close()
  })
}

export function connection(): Connection {
  return {
    machine_id: 'm1',
    recovery_generation: 'recovery_1',
    connection_epoch: 'epoch_1',
    authenticated: true,
    active: true,
    negotiated: { major: 2, minor: 0, capabilities: ['rpc'] }
  } as Connection
}

/** 构造与 Gateway 编码结果同形的原始请求；Connector 的准入与 Wire codec 仍完整校验。 */
export function request(method: string, params: JsonObject, id = '1', deadline = Date.now() + 60_000): string {
  return boundedJson({
    protocol_major: 2,
    protocol_minor: 0,
    message_id: 'message_' + id,
    machine_id: 'm1',
    recovery_generation: 'recovery_1',
    connection_epoch: 'epoch_1',
    type: 'request',
    payload: {
      attempt: {
        call_id: 'call_' + id,
        attempt_id: 'attempt_' + id,
        native_request_id: 'native_' + id,
        target,
        provider_kind: 'herdr-core',
        binding_revision: 1,
        contract_ref: reference,
        registration: { deadline }
      },
      expected_binding_revision: 1,
      native_request: { method, params },
      validation: 'strict'
    }
  })
}

/** 假 core 的终端事实：与审核结果 schema 同形。 */
export const CORE_ID = '0f0e0d0c0b0a0908'
export const CREATED_MS = 1793335137041
