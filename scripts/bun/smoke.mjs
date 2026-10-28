/** 验证构建后核心、认证通道与管理页边界及 SQLite 重开；不建立真实设备或管理员身份。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { toolchain } from './toolchain.mjs'

toolchain()
// 必须导入构建后的 JavaScript，不能回到源码 .ts。
const contracts = await import('../../dist/src/contracts.js')
const { Store } = await import('../../dist/src/store.js')
const { Router } = await import('../../dist/src/router.js')
const protocol = await import('../../dist/src/protocol.js')
const native = await import('../../dist/src/connector/luvus/contract/index.js')
const wire = await import('../../dist/src/wire/index.js')
const integration = await import('../../dist/src/connector/luvus/wire.js')
const persistence = await import('../../dist/src/wire/persistence.js')
const luvusPersistence = await import('../../dist/src/connector/luvus/persistence.js')
const transport = await import('../../dist/src/transport/index.js')
assert.equal(typeof transport.createGateway, 'function')
assert.equal(typeof transport.createConnector, 'function')
assert.equal(typeof transport.loadCredential, 'function')
assert.equal(typeof transport.createPairingDelivery, 'function')
assert.equal(typeof transport.ChannelRegistry, 'function')
assert.equal(typeof transport.createDeviceLifecycle, 'function')
assert.equal(typeof luvusPersistence.createDeviceLifecycleAdapter, 'function')
// Herdr 产物复用共享 Wire 错误身份；导入本身不启动或连接原生实例。
const herdr = await import('../../dist/src/connector/herdr/readonly.js')
assert.equal(typeof herdr.createHerdrReadonlyAdapter, 'function')
assert.equal(typeof herdr.persistentHerdrBackend, 'function')
assert.equal(typeof herdr.commitHerdrResponse, 'function')
const herdrCompiler = await import('../../dist/src/connector/herdr/compiler-api.js')
const herdrInstallation = await import('../../dist/src/connector/herdr/installation.js')
const herdrRuntime = await import('../../dist/src/connector/herdr/runtime.js')
const herdrDiscovery = await import('../../dist/src/connector/herdr/discovery.js')
const herdrProvider = await import('../../dist/src/connector/herdr/provider.js')
const providerRuntime = await import('../../dist/src/runtime/gateway.js')
const connectorRuntime = await import('../../dist/src/runtime/connector-host.js')
const admission = await import('../../dist/src/runtime/connector-attempts.js')
const resultsRuntime = await import('../../dist/src/runtime/results.js')
assert.equal(typeof herdrCompiler.compileHerdrSchemas, 'function')
assert.equal(typeof herdrCompiler.isCompiledHerdrSchemas, 'function')
assert.equal(typeof herdrInstallation.HerdrInstallation, 'function')
assert.equal(typeof herdrRuntime.createHerdrRuntime, 'function')
assert.equal(typeof herdrDiscovery.describeHerdrParams, 'function')
assert.equal(typeof herdrDiscovery.describeHerdrTarget, 'function')
assert.equal(typeof herdrDiscovery.describeHerdrContract, 'function')
assert.equal(typeof herdrProvider.parseHerdrProviderRefConfig, 'function')
assert.equal(typeof herdrProvider.readHerdrProviderRefConfig, 'function')
assert.equal(typeof herdrProvider.createHerdrGatewayResources, 'function')
assert.equal(typeof herdrProvider.createHerdrConnectorResources, 'function')
assert.equal(typeof providerRuntime.createProviderGatewayRuntime, 'function')
assert.equal(typeof connectorRuntime.createProviderConnectorRuntime, 'function')
assert.equal(typeof admission.createConnectorAdmissionBackend, 'function')
assert.equal(typeof resultsRuntime.createProviderResultAccess, 'function')
// 官方 schema 在产物内通过固定 Worker 编译；这些离线值不构造真实安装或原生身份。
const herdrSchemaBytes = readFileSync(new URL('../../test/fixtures/herdr/0.9.5/schema.json', import.meta.url))
const herdrSchemaDocument = JSON.parse(herdrSchemaBytes.toString('utf8'))
const herdrWorkflowBranches = herdrSchemaDocument.schemas.request.oneOf.filter(
  /** 完整原生工作流按官方方法族核对，不能只保留早期 ping/metadata 两项。 */ (branch) => {
    const method = branch.properties.method.const
    return ['ping', 'session.snapshot'].includes(method) || /^(?:workspace|tab|pane|agent)\./u.test(method)
  }
)
assert.deepEqual(
  herdr.HERDR_READONLY_REVIEW.methods,
  herdrWorkflowBranches.map(/** 使用固定 schema 的原始顺序。 */ (branch) => branch.properties.method.const)
)
for (const branch of herdrWorkflowBranches) {
  const described = herdrDiscovery.describeHerdrParams(herdrSchemaDocument, branch.properties.method.const)
  assert.equal(described.$schema, herdrSchemaDocument.$schema)
  assert.equal(described.$ref, branch.properties.params.$ref.replace('#/schemas/request/$defs/', '#/$defs/'))
  assert(Object.hasOwn(described.$defs, described.$ref.slice('#/$defs/'.length)))
  assert(!JSON.stringify(described).includes('#/schemas/request/'))
}
assert.deepEqual(herdrSchemaDocument, JSON.parse(herdrSchemaBytes.toString('utf8')))
const herdrSchemas = await herdrCompiler.compileHerdrSchemas(herdrSchemaBytes)
assert(herdrCompiler.isCompiledHerdrSchemas(herdrSchemas))
assert(!herdrCompiler.isCompiledHerdrSchemas({ ...herdrSchemas }))
for (const exchange of JSON.parse(
  readFileSync(new URL('../../test/fixtures/herdr/0.9.5/readonly.json', import.meta.url), 'utf8')
)) {
  assert.equal(herdrSchemas.request(exchange.request), true)
  assert.equal(herdrSchemas.response(exchange.response), true)
}
// 缺少 RPC 必需根才拒绝本次编译；后续合法未知原字节必须经过实际 Worker 编译并可用。
const missingHerdrRoot = structuredClone(herdrSchemaDocument)
delete missingHerdrRoot.schemas.request
await assert.rejects(
  herdrCompiler.compileHerdrSchemas(JSON.stringify(missingHerdrRoot)),
  /herdr_schema_schema_root_unavailable/u
)
const unknownHerdrBytes = Buffer.concat([herdrSchemaBytes, Buffer.from('\n')])
const unknownHerdrSchemas = await herdrCompiler.compileHerdrSchemas(unknownHerdrBytes)
assert.equal(unknownHerdrSchemas.schema_sha256, createHash('sha256').update(unknownHerdrBytes).digest('hex'))
assert.notEqual(unknownHerdrSchemas.schema_sha256, herdrSchemas.schema_sha256)
assert(unknownHerdrSchemas.request({ id: 'built-unknown', method: 'ping', params: {} }))
assert(!unknownHerdrSchemas.request({ id: 'built-unknown', method: 'agent.prompt', params: {} }))
assert.equal(herdrSchemas.request({ id: 'built', method: 'future.method', params: {} }), false)
assert.equal(herdrSchemas.response({ id: 'built', result: {} }), false)
assert.throws(
  /** 用未受信来源触发产物错误，核对跨入口共享 GatewayError 身份。 */
  () => herdr.createHerdrCodec({}, {}),
  contracts.GatewayError
)
const webui = await import('../../dist/src/webui/index.js')
assert.equal(typeof webui.mountWebUi, 'function')
assert.equal(typeof webui.createManagementHttpRead, 'function')
const admin = await import('../../dist/src/admin/index.js')
assert.equal(typeof admin.startManagementReadListener, 'function')
assert.equal(typeof admin.StoreManagementWriteService, 'function')
assert.equal(typeof admin.createManagementHandler, 'function')
assert.throws(
  /** 产物没有默认身份，缺少可信会话适配器时不能开端口。 */
  () => admin.startManagementReadListener({ service: { /** 未配置认证时此服务不应被调用。 */ execute() {} }, port: 0 }),
  /management_authentication_required/u
)
const managementAssets = admin.loadManagementAssets(new URL('../../dist/webui/', import.meta.url).pathname)
assert(managementAssets.has('/rovloom-mark-transparent.png'))
assert(managementAssets.has('/theme.js'))
const managementShell = readFileSync(new URL('../../dist/webui/index.html', import.meta.url), 'utf8')
assert(managementShell.indexOf('src="./theme.js"') < managementShell.indexOf('href="./manage.css"'))
assert(!managementAssets.has('/browser.js.map'))
assert.deepEqual(webui.parseRoute('#machine=a%2Fb'), { machineId: 'a/b', cursor: null, providerCursor: null })
await assert.rejects(webui.unavailableRead(), { problem: 'unavailable' })
const browserEntry = readFileSync(new URL('../../dist/webui/browser.js', import.meta.url), 'utf8')
assert(!browserEntry.includes('node:'))
assert(!browserEntry.includes('webUiFixture'))
assert(readFileSync(new URL('../../dist/webui/index.html', import.meta.url), 'utf8').includes('Rovloom 管理'))
assert(readFileSync(new URL('../../dist/webui/manage.css', import.meta.url), 'utf8').includes(':focus-visible'))
for (const asset of ['rovloom-mark-transparent.png', 'rovloom-logo.png']) {
  assert.deepEqual(
    readFileSync(new URL(`../../dist/webui/${asset}`, import.meta.url)),
    readFileSync(new URL(`../../docs/assets/brand/${asset}`, import.meta.url))
  )
}
assert(
  readFileSync(new URL('../../dist/webui/index.html', import.meta.url), 'utf8').includes(
    'href="./rovloom-mark-transparent.png"'
  )
)
assert.equal(typeof luvusPersistence.persistentBackend, 'function')
assert.equal(typeof persistence.commitNativeResponse, 'function')
const mcp = await import('../../dist/src/mcp/index.js')
assert.equal(typeof mcp.createMcpFacade, 'function')
assert.equal(typeof mcp.RuntimeGatewayService, 'function')
const cli = await import('../../dist/src/cli/index.js')
const localLuvus = await import('../../dist/src/connector/luvus/index.js')
assert.equal(typeof localLuvus.LuvusRpcAdapter, 'function')
assert.equal(typeof localLuvus.createLuvusCatalog, 'function')
assert.equal(typeof mcp.startHttpFacade, 'function')
assert.equal(typeof cli.runCli, 'function')
assert.equal(typeof cli.createTransportCliRuntime, 'function')
assert.equal(typeof cli.resolveRoleConfigPath, 'function')
assert.equal(typeof mcp.createHttpFacade, 'function')
assert.equal(mcp.MCP_REVISION, '2025-11-25')
assert.equal(cli.parseConfig(cli.configDocument(cli.configTemplate('gateway'))).role, 'gateway')
assert.equal(cli.parseConfig(cli.configDocument(cli.configTemplate('connector'))).role, 'connector')
// 从同一构建入口查询角色帮助；未注入后端时不启动任何真实服务。
for (const role of ['gateway', 'connector']) {
  const help = spawnSync(process.execPath, ['--no-env-file', 'dist/src/cli/main.js', role, '--help'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: process.env.PATH ?? '' }
  })
  assert.equal(help.status, 0, help.stderr)
  assert.equal(help.stdout, '')
  assert.match(help.stderr, /^Rovloom /u)
}
assert.deepEqual(
  Object.keys(contracts).sort(),
  ['GatewayError', 'canonical', 'digest', 'validateRequest', 'validateTarget'].sort()
)
assert.deepEqual(
  Object.keys(protocol).sort(),
  ['MAX_FRAME_BYTES', 'PROTOCOL_MAJOR', 'PROTOCOL_MINOR', 'decodeFrame', 'encodeFrame'].sort()
)
assert.equal(typeof Router, 'function')
assert.equal(protocol.PROTOCOL_MAJOR, 2)
assert.equal(typeof integration.createLuvusWireAdapter, 'function')
assert.equal(typeof wire.decodeWireFrame, 'function')
assert.deepEqual(
  Object.keys(native).sort(),
  [
    'DEFAULT_LIMITS',
    'LUVUS_TABLE_METHODS',
    'checkDispatch',
    'checkResultBoundary',
    'checkResultRetention',
    'compileBundle',
    'createNativeValidator',
    'luvusMethod',
    'parseNativeJson'
  ].sort()
)
const bytes = readFileSync(new URL('../../test/fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
// 构建产物的普通坏 bundle 不能污染编译服务，随后仍须完成完整有效编译。
const malformed = await native.compileBundle('{}', {
  identity: { binary_sha256: 'a'.repeat(64), schema_sha256: contracts.digest('{}'), revision: 'artifact-rejection' }
})
assert.deepEqual(malformed, {
  ok: false,
  error: { origin: 'contract', code: 'schema_unavailable', stage: 'compile', reason: 'invalid_schema' }
})
const compiled = await native.compileBundle(bytes, {
  identity: {
    binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
    schema_sha256: contracts.digest(bytes.toString('utf8')),
    revision: 'artifact-smoke'
  }
})
assert(compiled.ok)
assert.equal(compiled.value.documents.length, 29)
const response = {
  id: 'artifact',
  error: { code: 'synthetic', message: 'synthetic', data: { preserved: true } }
}
const checked = native.createNativeValidator(compiled.value).checkResponseShape(response)
assert(checked.ok)
assert.deepEqual(checked.value.response, response)
// 仅用 P0 fixture 测试跨构建入口的私有 handle 身份，不建立网络或真实权限。
const capabilities = JSON.parse(
  readFileSync(new URL('../../test/fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url))
)
const origin = {
  provider_kind: 'luvus',
  protocol_family: 'uhp',
  binary_version: '0.14.3',
  binary_sha256: compiled.value.identity.binary_sha256,
  schema_sha256: compiled.value.identity.schema_sha256,
  schema_origin: 'installed_cli',
  schema_command: 'luvus uhp schema',
  server_version: '0.14.3',
  native_protocol_version: '1.0',
  runtime_generation: capabilities.result.server_generation,
  adapter_revision: 'artifact',
  classification_revision: 'review',
  support_basis: 'live_catalog'
}
const target = {
  machine_id: 'machine',
  provider_id: 'provider',
  profile: 'session',
  session: capabilities.result.session
}
const connection = {
  machine_id: 'machine',
  recovery_generation: 'recovery',
  connection_epoch: 'epoch',
  authenticated: true,
  active: true,
  negotiated: { major: 2, minor: 0, capabilities: ['rpc'] }
}
const attempt = {
  call_id: 'call',
  attempt_id: 'attempt',
  native_request_id: 'artifact',
  target,
  provider_kind: 'luvus',
  binding_revision: 1,
  contract_ref: wire.contractRef(origin),
  registration: {
    deadline: 1000
  }
}
const binding = {
  machine_id: 'machine',
  recovery_generation: 'recovery',
  connection_epoch: 'epoch',
  ...attempt
}
const row = {
  binding,
  principal_id: 'principal',
  method: 'task.add',
  mode: 'strict',
  transport: 'rpc',
  native_request: { method: 'task.add', params: { title: 'artifact' } }
}
const provider = {
  machine_id: 'machine',
  provider_id: 'provider',
  kind: 'luvus',
  config_ref: 'artifact',
  binding_revision: 1,
  enabled: true
}
const proof = {
  authenticated: true,
  source_verified: true,
  binding: {
    kind: 'luvus',
    provider_id: 'provider',
    binding_revision: 1,
    contract_source_ref: attempt.contract_ref,
    target: { machine_id: 'machine', profile: 'session', session: target.session },
    server_generation: origin.runtime_generation,
    connection_epoch: 'epoch',
    recovery_generation: 'recovery',
    capability_revision: 'caps',
    classification_revision: 'review',
    contract: compiled.value.identity
  }
}
const adapter = integration.createLuvusWireAdapter({
  /** 为构建产物的隔离 adapter 提供固定 mock 连接，不接入真实设备。 */
  connection: () => connection,
  /** 提供已固定的 mock attempt，验证跨构建入口的私有 handle 关联。 */
  attempt: () => row,
  /** 提供 Gateway 侧的 mock provider registry，限定产物 smoke 的目标实例。 */
  provider: () => provider,
  /** 提供独立本机侧的 mock provider 配置，验证双端 binding 核对。 */
  localProvider: () => provider,
  /** 把固定离线 bundle 与合成来源组成 smoke 契约记录，不授予生产许可。 */
  contract: () => ({
    wire: { source: origin, support_status: 'validated' },
    compiled: compiled.value,
    capabilities,
    capability_revision: 'caps'
  }),
  /** 提供仅限 smoke 的原生来源证明，供真实 validator 校验来源关联。 */
  nativeSource: () => proof,
  /** 提供 smoke 专用 caller ID，不从业务输入构造 principal。 */
  currentPrincipal: () => 'principal',
  /** 固定 smoke 可信时间，使许可和期限判断可重复。 */
  now: () => 100,
  /** 将 smoke 内容状态固定为可读，仅用于结果门禁验证。 */
  contentStatus: () => 'available'
})
const base = {
  protocol_major: 2,
  protocol_minor: 0,
  message_id: 'message',
  machine_id: 'machine',
  recovery_generation: 'recovery',
  connection_epoch: 'epoch'
}
adapter.encode(
  {
    ...base,
    type: 'request',
    payload: {
      attempt,
      expected_binding_revision: 1,
      native_request: row.native_request,
      validation: 'strict'
    }
  },
  'gateway_to_connector'
)
adapter.decode(
  JSON.stringify({ ...base, type: 'response', payload: { attempt, native_response: response } }),
  'connector_to_gateway'
)
adapter.checkResult(binding)
const heartbeat = { ...base, type: 'heartbeat', payload: { sequence: 0 } }
const heartbeatContext = { phase: 'authenticated', direction: 'gateway_to_connector', connection }
assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(heartbeat, heartbeatContext), heartbeatContext), heartbeat)
assert.throws(
  /** 用旧 major 帧触发拒绝，确认产物未回退旧 Wire 执行协议。 */
  () => protocol.decodeFrame(JSON.stringify({ ...heartbeat, protocol_major: 1 }), heartbeatContext),
  /protocol_major_unsupported/
)
const { provider_id: _providerId, ...missingProvider } = target
assert.throws(
  /** 删除 provider 字段后尝试解码，确认产物不能补造缺失目标。 */
  () =>
    adapter.decode(
      JSON.stringify({
        ...base,
        type: 'request',
        payload: {
          attempt: { ...attempt, target: missingProvider },
          expected_binding_revision: 1,
          native_request: row.native_request,
          validation: 'strict'
        }
      }),
      'gateway_to_connector'
    ),
  /invalid_frame_fields/
)
const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-artifact-'))
try {
  const store = new Store(join(dir, 'db'))
  const machine = store.register('artifact')
  assert.equal(store.machine(machine.machine_id).name, 'artifact')
  // 共享 chunk 必须保留不同构建入口之间的类身份。
  assert.throws(
    /** 查询缺失机器，确认构建后的 Store 保持拒绝语义。 */
    () => store.machine('missing'),
    contracts.GatewayError
  )
  store.close()
  const reopened = new Store(join(dir, 'db'))
  assert.equal(reopened.machine(machine.machine_id).name, 'artifact')
  reopened.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
const service = await import('../../dist/src/service/index.js')
assert.equal(typeof service.createNativeServiceBackend, 'function')
assert.equal(service.parseServiceCommand(['gateway', '--config', '/untouched'], 'linux'), undefined)
assert.deepEqual(service.parseServiceCommand(['service', 'stop', '--role', 'connector'], 'linux'), {
  action: 'stop',
  role: 'connector'
})

console.log(
  `Built ESM foundation/native/wire/integration/Herdr runtime, 29 UHP documents, ${herdrWorkflowBranches.length} Herdr methods with original roots/description closures, generic runtime/MCP imports, v2 boundaries, SQLite reopen and service/update/admin seams: pass`
)
