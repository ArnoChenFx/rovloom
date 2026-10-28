// 管理来源测试只生成自有短期身份记录、摘要和目录；不注册账号、不配对设备或调用原生程序。
import { createHash } from 'node:crypto'
import { publishSchema, schemaReference } from '../../src/connector/schema-store.ts'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensurePrivateDirectory } from '../../src/storage/files.ts'
import { writeSetupFile } from '../../src/cli/setup-files.ts'
import { dirname, join } from 'node:path'
import * as configSchema from '../../src/cli/config.ts'
import { runtimeReference } from '../../src/cli/runtime-files.ts'

export const managementProof = 'SYNTHETIC_MANAGEMENT_PROOF_'.padEnd(64, 'm')
export const mcpProof = 'SYNTHETIC_MCP_PROOF_'.padEnd(64, 'c')

/** 本机内核分配测试端口；不读取或探测用户listener。 */
async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address !== 'object') {
    throw new Error('fixture_port_unavailable')
  }
  const value = address.port
  server.close()
  await once(server, 'close')
  return value
}

/** 所有JSON均为明确合成的既有记录；上游证明原值只存在于本测试内存。 */
export async function gatewaySmokeFixture() {
  const parent = process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
  const root = mkdtempSync(join(parent, '.rovloom-product-gateway-'))
  try {
    ensurePrivateDirectory(root)
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  const state = join(root, 'gateway')
  const refs = dirname(runtimeReference(state, 'management'))
  ensurePrivateDirectory(state)
  ensurePrivateDirectory(refs)
  const ports = new Set()
  while (ports.size < 3) {
    ports.add(await port())
  }
  const [mcpPort, devicePort, managementPort] = [...ports]
  const template = configSchema.configTemplate('gateway')
  const config = {
    ...template,
    state_dir: state,
    mcp_port: mcpPort,
    ...('device_port' in template ? { device_port: devicePort, management_port: managementPort } : {})
  }
  const configPath = join(root, 'gateway.json')
  const sourcePath = join(refs, 'management.json')
  const callerPath = join(refs, config.authentication_ref + '.json')
  const clock = { now: Date.now() }
  const target = {
    machine_id: 'fixture_machine',
    provider_id: 'fixture_provider',
    profile: 'session',
    session: 'fixture'
  }
  const policy = { revision: 'fixture_policy', grants: [{ target, methods: ['ping'], actions: ['read'] }] }
  const lease = {
    caller: { principal_id: 'fixture_admin' },
    management_session_ref: 'fixture_existing_session',
    issued_at: clock.now - 1000,
    expires_at: clock.now + 600_000
  }
  const admin = {
    principal_id: lease.caller.principal_id,
    session_ref: lease.management_session_ref,
    assurance: 'administrator',
    policy_revision: 'fixture_admin_policy',
    grants: [
      { action: 'gateway_read' },
      { action: 'devices_read', machine_id: target.machine_id },
      { action: 'devices_rename', machine_id: target.machine_id },
      { action: 'devices_revoke', machine_id: target.machine_id },
      { action: 'permissions_read', machine_id: target.machine_id }
    ]
  }
  const source = {
    schema_version: 1,
    kind: 'management-session-source',
    port: managementPort,
    sessions: [
      { credential_sha256: createHash('sha256').update(managementProof).digest('hex'), lease, administrator: admin }
    ],
    pairing_policy_refs: []
  }
  const callers = {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource: `http://127.0.0.1:${mcpPort}/mcp`,
    local_policy: policy,
    callers: [
      {
        principal: { id: lease.caller.principal_id, policy },
        token_sha256: createHash('sha256').update(mcpProof).digest('hex'),
        issued_at: lease.issued_at,
        expires_at: lease.expires_at
      }
    ]
  }
  const written = new Set()
  const write = /** 复用同fd私有校验和原子发布；只替换本例此前成功创建的文件。 */ (path, bytes) => {
    writeSetupFile(path, bytes, written.has(path))
    written.add(path)
  }
  const save = /** 所有JSON仅为本例合成记录，不修复已有对象权限或接受用户文件。 */ (path, value) =>
    write(path, JSON.stringify(value))
  save(configPath, configSchema.configDocument(config))
  save(callerPath, callers)
  save(sourcePath, source)
  const configureProviders = /** 夹具沿实际程序管理接口装配；schema 原字节按内容寻址落盘，不再内嵌进条目。 */ (
    entries
  ) => {
    const providers = entries.map(
      /** 把夹具准备的 schema 文件发布到内容寻址位置，并只保留引用。 */ (entry) => {
        if (!entry.value.contract?.schema_bundle_ref) {
          return entry
        }
        const { schema_bundle_ref: reference, ...pin } = entry.value.contract
        const bytes = readFileSync(runtimeReference(state, reference))
        const target = schemaReference(state, createHash('sha256').update(bytes).digest('hex'))
        publishSchema(target, bytes)
        return { ...entry, value: { ...entry.value, contract: { ...pin, schema_ref: target } } }
      }
    )
    save(runtimeReference(state, 'providers'), { schema_version: 1, role: 'gateway', providers })
  }
  configureProviders([])
  return {
    root,
    configureProviders,
    state,
    refs,
    config,
    configPath,
    sourcePath,
    callerPath,
    clock,
    target,
    lease,
    admin,
    source,
    callers,
    origin: `http://127.0.0.1:${managementPort}`,
    save,
    write,
    request: /** 固定实际Origin和Host；Basic值只在测试内存，不能作为URL或CLI参数。 */ (
      authorization = 'Basic ' + Buffer.from(lease.caller.principal_id + ':' + managementProof).toString('base64'),
      init = {}
    ) =>
      new Request(`http://127.0.0.1:${managementPort}/`, {
        ...init,
        headers: { host: `127.0.0.1:${managementPort}`, authorization, ...init.headers }
      }),
    close: /** 清理本例独占目录，不访问其他配置、会话或原生root。 */ () =>
      rmSync(root, { recursive: true, force: true })
  }
}
