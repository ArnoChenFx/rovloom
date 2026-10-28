/** 真实双角色发布验收的短期合成状态；不替代原生 installation、peer、process 或 root 门禁。 */
import assert from 'node:assert/strict'
import { readNetwork } from '../ci/read-network.mjs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const herdrSmokePin = Object.freeze({
  version: '0.9.5',
  url: 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64',
  binary_sha256: '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d',
  schema_sha256: '9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b'
})

/** 官方fixture固定源；最大64MiB和90秒只限制测试下载，不放宽产品预算。 */
export async function downloadHerdrSmokeBinary(path) {
  assert.equal(process.platform, 'linux', 'dual_role_native_platform_unsupported')
  assert.equal(process.arch, 'x64', 'dual_role_native_arch_unsupported')
  const binary = await readNetwork(herdrSmokePin.url, { maxBytes: 67_108_864, timeoutMs: 90_000 })
  assert.equal(createHash('sha256').update(binary).digest('hex'), herdrSmokePin.binary_sha256)
  writeFileSync(path, binary, { mode: 0o700, flag: 'wx' })
}

/** 只分配本轮回环端口，不探测或复用任何现有listener。 */
async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = server.address()
  assert(value && typeof value === 'object')
  server.close()
  await once(server, 'close')
  return value.port
}

/** 本例仅在私有空目录生成身份；120秒有效期覆盖真实进程启动和一次ping。 */
export async function createDualRoleFixture({
  sourceRoot = fileURLToPath(new URL('../../', import.meta.url)),
  herdrBinary,
  parent = process.env.LUVUS_TEST_ROOT ?? dirname(resolve(sourceRoot)),
  methods = ['ping'],
  connectorSettings = {},
  attach = false
} = {}) {
  assert.equal(process.platform, 'linux', 'dual_role_native_platform_unsupported')
  assert.equal(process.arch, 'x64', 'dual_role_native_arch_unsupported')
  sourceRoot = resolve(sourceRoot)
  const load = /** 只从明确的受信源码根加载测试装配API，不从provider配置选择模块。 */ (path) =>
    import(pathToFileURL(join(sourceRoot, path)).href)
  const [
    { openGatewayState },
    { saveCredential },
    { inspectHerdrPath },
    { fixedHerdrSource },
    { contractRef },
    { DispatchClaims }
  ] = await Promise.all([
    load('src/runtime/state.ts'),
    load('src/transport/index.ts'),
    load('src/connector/herdr/local.ts'),
    load('src/connector/herdr/review.ts'),
    load('src/wire/index.ts'),
    load('src/connector/claims.ts')
  ])
  const root = mkdtempSync(join(parent, '.dual-role-'))
  const directory = /** 每个隔离根独占创建，绝不修改既有目录权限。 */ (name) => {
    const path = join(root, name)
    mkdirSync(path, { mode: 0o700 })
    return path
  }
  const save = /** 合成状态仅独占写入本轮私有文件。 */ (path, value) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  try {
    inspectHerdrPath(root, 'directory')
    const binary = join(root, 'herdr')
    if (herdrBinary) {
      const stat = lstatSync(herdrBinary)
      assert(stat.isFile() && stat.nlink === 1 && stat.size <= 67_108_864, 'dual_role_native_binary_invalid')
      assert.equal(
        createHash('sha256').update(readFileSync(herdrBinary)).digest('hex'),
        herdrSmokePin.binary_sha256,
        'dual_role_native_binary_digest'
      )
      copyFileSync(herdrBinary, binary)
      chmodSync(binary, 0o700)
    } else {
      await downloadHerdrSmokeBinary(binary)
    }
    const gatewayState = directory('gateway')
    const gatewayRefs = join(gatewayState, 'managed')
    mkdirSync(gatewayRefs, { mode: 0o700 })
    const connectorState = directory('connector')
    const connectorRefs = join(connectorState, 'managed')
    mkdirSync(connectorRefs, { mode: 0o700 })
    const native = {
      home: directory('h'),
      config_home: directory('c'),
      state_home: directory('s'),
      cache_home: directory('a'),
      temporary_home: directory('t'),
      cwd: directory('w')
    }
    const ledger = directory('ledger')
    const ports = new Set()
    while (ports.size < 3) {
      ports.add(await port())
    }
    const [mcpPort, devicePort, managementPort] = [...ports]
    const gatewayConfigPath = join(root, 'gateway.json')
    const connectorConfigPath = join(root, 'connector.json')
    save(gatewayConfigPath, {
      schema_version: 1,
      role: 'gateway',
      data: { directory: gatewayState },
      mcp: { hostname: '127.0.0.1', port: mcpPort },
      devices: { hostname: '127.0.0.1', port: devicePort },
      management: { enabled: true, port: managementPort }
    })
    save(connectorConfigPath, {
      schema_version: 1,
      role: 'connector',
      data: { directory: connectorState },
      gateway: { url: `ws://127.0.0.1:${devicePort}` },
      ...connectorSettings
    })
    const state = openGatewayState({
      state_directory: gatewayState,
      store: {
        management: /** 正式Store仅批准本轮空白状态中的合成设备与provider管理。 */ () => ({
          actor: 'synthetic_smoke_admin',
          confirmation_id: randomUUID()
        })
      },
      changed: /** 种子阶段尚无listener或外部通道可断开。 */ () => {}
    })
    let target
    try {
      const machine = state.store.register('synthetic_release_smoke_only')
      const credential = {
        ...state.store.redeem(state.store.issueEnrollment(machine.machine_id)),
        recovery_generation: state.store.generation()
      }
      saveCredential(join(connectorRefs, 'device.json'), credential)
      target = { machine_id: machine.machine_id, provider_id: 'synthetic_herdr', profile: 'session', session: 'smoke' }
      state.store.defineProvider({
        machine_id: target.machine_id,
        provider_id: target.provider_id,
        kind: 'herdr',
        config_ref: 'synthetic_herdr',
        binding_revision: 1,
        enabled: true
      })
    } finally {
      state.close()
    }
    const principal = 'synthetic_smoke_caller'
    const callerPolicy = {
      revision: 'synthetic_caller_policy',
      grants: [{ target, methods, actions: ['dispatch', 'read'] }]
    }
    const localPolicy = { ...structuredClone(callerPolicy), revision: 'synthetic_local_policy' }
    const proof = randomBytes(48).toString('base64url')
    const managementProof = randomBytes(48).toString('base64url')
    const managementOrigin = `http://127.0.0.1:${managementPort}`
    const managementLease = {
      caller: { principal_id: principal },
      management_session_ref: 'synthetic_smoke_session',
      issued_at: Date.now() - 1000,
      expires_at: Date.now() + 120_000
    }
    save(join(gatewayRefs, 'management.json'), {
      schema_version: 1,
      kind: 'management-session-source',
      port: managementPort,
      sessions: [
        {
          credential_sha256: createHash('sha256').update(managementProof).digest('hex'),
          lease: managementLease,
          administrator: {
            principal_id: managementLease.caller.principal_id,
            session_ref: managementLease.management_session_ref,
            assurance: 'administrator',
            policy_revision: 'synthetic_admin_policy',
            grants: [
              { action: 'gateway_read' },
              { action: 'devices_read', machine_id: target.machine_id },
              { action: 'providers_read', machine_id: target.machine_id, provider_id: target.provider_id }
            ]
          }
        }
      ],
      pairing_policy_refs: []
    })
    const resource = `http://127.0.0.1:${mcpPort}/mcp`
    save(join(gatewayRefs, 'mcp-callers.json'), {
      schema_version: 1,
      kind: 'mcp-caller-source',
      resource,
      local_policy: localPolicy,
      callers: [
        {
          principal: { id: principal, policy: callerPolicy },
          token_sha256: createHash('sha256').update(proof).digest('hex'),
          issued_at: Date.now() - 1000,
          expires_at: Date.now() + 120_000
        }
      ]
    })
    const schemaPath = join(root, 'schema.json')
    copyFileSync(join(sourceRoot, 'test/fixtures/herdr/0.9.5/schema.json'), schemaPath)
    chmodSync(schemaPath, 0o600)
    assert.equal(createHash('sha256').update(readFileSync(schemaPath)).digest('hex'), herdrSmokePin.schema_sha256)
    const source = fixedHerdrSource()
    const config = {
      version: 1,
      target,
      binding_revision: 1,
      config_ref: 'synthetic_herdr',
      expected_source: source,
      schema_ref: schemaPath,
      peer_policy_revision: localPolicy.revision
    }
    const ownerPath = join(ledger, 'owner.json')
    const endpoint = join(native.config_home, 'herdr', 'sessions', 'smoke', 'herdr.sock')
    assert(Buffer.byteLength(endpoint) < 108, 'dual_role_native_socket_path_too_long')
    assert.equal(existsSync(endpoint), false)
    const nativeConfig = join(native.config_home, 'herdr')
    mkdirSync(nativeConfig, { mode: 0o700 })
    // Herdr新建目录会继承宿主umask；本例独占准备私有session，不修改任何既有实例权限。
    mkdirSync(join(nativeConfig, 'sessions'), { mode: 0o700 })
    mkdirSync(join(nativeConfig, 'sessions', target.session), { mode: 0o700 })
    // 只有ping可达；即使server创建终端，合成shell也只读入字节，不启动agent或执行输入。
    const terminal = join(root, 'synthetic-shell')
    writeFileSync(terminal, '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700, flag: 'wx' })
    writeFileSync(
      join(nativeConfig, 'config.toml'),
      'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n' +
        `[terminal]\ndefault_shell = ${JSON.stringify(terminal)}\nshell_mode = "non_login"\nnew_cwd = "current"\n` +
        '[session]\nresume_agents_on_restore = false\n[server]\nheadless_cols = 80\nheadless_rows = 24\n',
      { mode: 0o600, flag: 'wx' }
    )
    const limits = { entries: 128, bytes: 1_048_576 }
    // 与真实 setup 一致：账本在安装期创建一次，之后的每次启动（含 Connector 内部重建资源）都以 open 模式打开。
    const claimsRef = { path: join(ledger, 'claims.sqlite'), mode: 'open', ledger_id: 'synthetic_claims', limits }
    new DispatchClaims({ ...claimsRef, mode: 'create', now: Date.now }).close()
    const connectorValue = {
      kind: 'herdr',
      native: { mode: attach ? 'attach' : 'managed' },
      policies: { caller: callerPolicy, local: localPolicy },
      config: {
        ...config,
        connector: {
          local: {
            target,
            binding_revision: 1,
            config_ref: config.config_ref,
            binary,
            ...native,
            ...(attach ? { attach: true } : {})
          },
          principal_id: principal,
          claims: claimsRef
        }
      }
    }
    save(join(gatewayRefs, 'providers.json'), {
      schema_version: 1,
      role: 'gateway',
      providers: [{ reference: config.config_ref, value: { kind: 'herdr', config } }]
    })
    save(join(connectorRefs, 'providers.json'), {
      schema_version: 1,
      role: 'connector',
      providers: [{ reference: config.config_ref, value: connectorValue }]
    })
    return {
      root,
      source,
      target,
      principal,
      proof,
      resource,
      gatewayState,
      connectorState,
      nativeBinary: binary,
      gatewayConfigPath,
      connectorConfigPath,
      native,
      ownerPath,
      endpoint,
      managementOrigin,
      managementAuthorization: 'Basic ' + Buffer.from(principal + ':' + managementProof).toString('base64'),
      contractRef: contractRef(source),
      close: /** 原生owner仍存在时保留自有根，不能假装清理完成或删除活跃状态。 */ () => {
        if (existsSync(ownerPath)) {
          throw Object.assign(new Error('dual_role_native_owner_still_held'), { retained_directory: root })
        }
        rmSync(root, { recursive: true, force: true })
      }
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
