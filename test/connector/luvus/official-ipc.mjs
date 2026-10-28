/** 显式运行官方二进制的隔离 IPC 验收；不由默认测试启动，不提供生产认证或公开入口。 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../../src/store.ts'
import { Router } from '../../../src/router.ts'
import { persistentBackend, commitLuvusResponse } from '../../../src/wire/persistence.ts'
import { createLuvusWireAdapter } from '../../../src/wire/native.ts'
import { compileBundle, createNativeValidator } from '../../../src/connector/luvus/contract/index.ts'
import { assertBinding, boundedJson, contractRef } from '../../../src/wire/index.ts'
import {
  LuvusRpcAdapter,
  LuvusAdapterError,
  createLuvusResultAccess,
  DispatchClaims,
  readLinuxLuvusPeer
} from '../../../src/connector/luvus/index.ts'

const binaryHash = '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9'
const schemaHash = '00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6'
const version = '0.14.3'
// 每个方法单独审过效果；原生 access=read 不能自动推导为无副作用。
const effects = Object.freeze({ 'task.add': 'execute', 'task.update': 'execute', 'automation.list': 'read' })
const methods = Object.keys(effects)

/** 真实验收和离线回归共用异步 schema 接缝；仅等待工厂并核对结果，不启动 native。 */
export async function compileOfficialSchema(schema) {
  const compiled = await compileBundle(schema, {
    identity: { binary_sha256: binaryHash, schema_sha256: schemaHash, revision: 'official-ipc-0.14.3-1' }
  })
  assert(compiled.ok, 'official_schema_compile_failed')
  return compiled
}

/** 只对已知有界字节求摘要，报告不包含真实 native 正文、token 或私有路径。 */
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 用于二进制和 endpoint 的本次身份快照；后续变化会拒绝当前实例来源。 */
function stamp(path) {
  const s = lstatSync(path, { bigint: true })
  assert(!s.isSymbolicLink())
  return [s.dev, s.ino, s.uid, s.gid, s.mode, s.size, s.ctimeNs].join(':')
}

/** 有界等待本次自有资源，不重连、不重发原生副作用。 */
async function until(check, milliseconds = 5000) {
  const end = Date.now() + milliseconds
  while (!check()) {
    assert(Date.now() < end, 'owned_resource_timeout')
    await new Promise(/* 只让出本次启动/退出轮询，不触及原生调用。 */ (done) => setTimeout(done, 25))
  }
}

/** 仅执行操作者显式提供且指纹固定的官方二进制；全部 native 状态来自本轮新目录。 */
export async function officialIpc(binaryPath) {
  assert.equal(process.platform, 'linux')
  assert.equal(typeof binaryPath, 'string', 'explicit_official_binary_required')
  assert.equal(hash(readFileSync(binaryPath)), binaryHash, 'official_binary_hash_mismatch')
  const root = mkdtempSync('/workspace/rovloom-luvus-acceptance-')
  const binary = join(root, 'luvus')
  let binaryStamp
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'home'),
    LUVUS_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'home/config'),
    XDG_DATA_HOME: join(root, 'home/data'),
    XDG_CACHE_HOME: join(root, 'home/cache'),
    XDG_RUNTIME_DIR: join(root, 'home/runtime'),
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8'
  }
  const session = 'rovloom-owned-' + randomUUID().slice(0, 8)
  /** CLI 只读取本轮固定版本/schema/session discovery，不用于代理派发。 */
  function cli(args) {
    const reply = spawnSync(binary, ['--session', session, ...args], {
      cwd: join(root, 'project'),
      env,
      shell: false,
      timeout: 5000,
      maxBuffer: 2_097_152
    })
    assert.equal(reply.status, 0, 'fixed_cli_failed')
    assert(!reply.error, 'fixed_cli_error')
    return reply.stdout
  }
  let libc
  let child
  let pidfd = -1
  let exited = true
  let endpoint
  let endpointStamp
  let store
  let claims
  let claimReader
  let wire
  let responseWire
  const adapters = new Set()
  const ownedTasks = new Set()
  let token
  let tokenExpires = 0
  let peerChecks = 0
  let claimsCommitted = 0
  let claimsEntered = 0
  let claimsDuplicated = 0
  let sourceActive = true
  let hostActive = true
  let discardAllowed = false
  const checks = []
  const uid = process.geteuid()
  const gid = process.getegid()

  /** 持续检查本轮 spawn、pidfd、固定二进制和私有 endpoint，不仅比较 uid 或 PID。 */
  function live() {
    assert(!exited && child.exitCode === null && child.signalCode === null, 'owned_server_exited')
    const poll = Buffer.alloc(8)
    poll.writeInt32LE(pidfd)
    poll.writeInt16LE(1, 4)
    assert.equal(libc.symbols.poll(ptr(poll), 1, 0), 0, 'owned_server_exited')
    assert.equal(stamp(binary), binaryStamp, 'owned_binary_changed')
    assert.equal(lstatSync(root).mode & 0o777, 0o700)
    assert.equal(lstatSync(root).uid, uid)
    if (endpointStamp) {
      assert.equal(stamp(endpoint), endpointStamp, 'owned_endpoint_changed')
    }
  }

  /** 对 adapter 实际使用的同一已连接 socket 读取内核 peer，并核对持续持有的实例。 */
  function peer(socket) {
    live()
    const actual = readLinuxLuvusPeer(socket)
    assert.deepEqual(actual, { pid: child.pid, uid, gid }, 'owned_peer_mismatch')
    peerChecks++
    return actual
  }

  /** 仅用于自有会话引导/核对/清理；auth 缺省只准一次有限委托 token 创建。 */
  async function native(method, params = {}, auth = token) {
    live()
    if (auth === undefined) {
      assert.equal(method, 'uhp.token.create')
      assert.equal(token, undefined)
      assert.deepEqual(params, { scopes: ['read', 'orchestration'], ttl_s: 120 })
    }
    const request = { id: randomUUID(), method, params, ...(auth ? { auth } : {}) }
    const bytes = Buffer.from(JSON.stringify(request) + '\n')
    assert(bytes.length <= 1_048_576)
    return await new Promise(
      /* 一次有界同 socket 原生对照，不缓存密钥/正文到文件。 */ (done, fail) => {
        const socket = createConnection({ path: endpoint })
        const timer = setTimeout(
          /* 超时仅结束本次自有连接，无原生重试。 */ () => socket.destroy(new Error('native_rpc_timeout')),
          5000
        )
        const parts = []
        let count = 0
        socket.once(
          'connect',
          /* 在认证写入前核验实际 peer。 */ () => {
            try {
              peer(socket)
              socket.end(bytes)
            } catch (error) {
              socket.destroy(error)
            }
          }
        )
        socket.on(
          'data',
          /* 按原始字节累计预算；不记录响应正文。 */ (part) => {
            count += part.length
            if (count > 1_048_576) {
              socket.destroy(new Error('native_rpc_limit'))
              return
            }
            parts.push(part)
          }
        )
        socket.once('error', fail)
        socket.once(
          'close',
          /* 严格核对单行 LF、EOF 与原生 id。 */ () => {
            clearTimeout(timer)
            try {
              const raw = Buffer.concat(parts)
              assert(raw.length > 0 && raw.at(-1) === 10 && !raw.subarray(0, -1).includes(10))
              const response = JSON.parse(raw.toString())
              assert.equal(response.id, request.id)
              done(response)
            } catch (error) {
              fail(error)
            }
          }
        )
      }
    )
  }

  try {
    chmodSync(root, 0o700)
    copyFileSync(binaryPath, binary)
    chmodSync(binary, 0o500)
    binaryStamp = stamp(binary)
    for (const name of [
      'home',
      'state',
      'project',
      'home/config',
      'home/data',
      'home/cache',
      'home/runtime',
      'gateway'
    ]) {
      mkdirSync(join(root, name), { mode: 0o700 })
    }
    assert.equal(hash(readFileSync(binary)), binaryHash, 'copied_official_binary_hash_mismatch')
    assert.equal(cli(['--version']).toString().trim(), 'luvus ' + version)
    const schema = cli(['uhp', 'schema'])
    assert.equal(hash(schema), schemaHash)
    const compiled = await compileOfficialSchema(schema)
    const validator = createNativeValidator(compiled.value)
    libc = dlopen('libc.so.6', {
      pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 }
    })
    child = spawn(binary, ['--session', session, 'server'], {
      cwd: join(root, 'project'),
      env,
      shell: false,
      stdio: 'ignore'
    })
    // 从真实直接子进程 spawn 起持有 pidfd；不从旧 JSON/PID 重新认领实例。
    exited = false
    child.once(
      'exit',
      /* 保留本轮直接子进程的退出事实，退出后来源永久失效。 */ () => {
        exited = true
      }
    )
    child.on(
      'error',
      /* 消费启动失败，后续存活门禁拒绝此实例。 */ () => {
        exited = true
      }
    )
    assert(Number.isInteger(child.pid))
    pidfd = libc.symbols.pidfd_open(child.pid, 0)
    assert(pidfd >= 0, 'owned_pidfd_unavailable')
    await until(
      /* 只在本轮私有 state 下发现精确命名的 running session。 */ () => {
        live()
        const list = JSON.parse(cli(['session', 'list', '--json']))
        const rows = list.sessions.filter(/* 排除其它名称及非运行会话。 */ (row) => row.name === session && row.running)
        if (rows.length !== 1) {
          return false
        }
        const path = rows[0].endpoint.address
        assert(path.startsWith(join(root, 'state') + '/') && resolve(path) === path)
        endpoint = path
        endpointStamp = stamp(path)
        return true
      }
    )
    const issued = await native('uhp.token.create', { scopes: ['read', 'orchestration'], ttl_s: 120 })
    assert(issued.result)
    assert.deepEqual(issued.result.scopes, ['read', 'orchestration'])
    token = issued.result.token
    tokenExpires = issued.result.expires_at * 1000
    assert(typeof token === 'string' && tokenExpires > Date.now())
    const capabilities = await native('uhp.capabilities')
    assert(capabilities.result?.server_generation)
    for (const method of ['task.list', 'automation.list', 'module.list']) {
      const reply = await native(method)
      assert(reply.result && !reply.error, 'empty_session_preflight_failed')
      const rows = reply.result.tasks ?? reply.result.automations ?? reply.result.modules
      assert(Array.isArray(rows) && rows.length === 0, 'session_contains_preexisting_work')
    }
    const origin = {
      provider_kind: 'luvus',
      protocol_family: 'uhp',
      binary_version: version,
      binary_sha256: binaryHash,
      schema_sha256: schemaHash,
      schema_origin: 'installed_cli',
      schema_command: 'luvus uhp schema',
      server_version: version,
      native_protocol_version: '1.0',
      runtime_generation: capabilities.result.server_generation,
      adapter_revision: 'official-ipc-2',
      classification_revision: 'official-reviewed-rpc-2',
      support_basis: 'live_catalog'
    }
    const ref = contractRef(origin)
    const actor = 'owned-local-uid-' + uid + '-' + randomUUID()
    let bootstrapOpen = true
    store = new Store(join(root, 'gateway/store.sqlite'), Date.now, {
      retention: { result_ttl: 20_000 },
      management: /* 操作者授权的本轮本机引导，只准一次精确 provider 登记；不是外部管理认证器。 */ (request) => {
        live()
        assert(
          bootstrapOpen &&
            request.action === 'providers_manage' &&
            request.target === managementTarget &&
            request.fence === 'new'
        )
        bootstrapOpen = false
        return { actor, confirmation_id: randomUUID() }
      }
    })
    const machine = store.register('owned-official-luvus')
    const device = store.redeem(store.issueEnrollment(machine.machine_id))
    const epoch = store.connect(device.machine_id, device.credential)
    const provider = {
      machine_id: device.machine_id,
      provider_id: 'owned-luvus',
      kind: 'luvus',
      config_ref: randomUUID(),
      binding_revision: 1,
      enabled: true
    }
    const managementTarget = device.machine_id + '/' + provider.provider_id
    store.defineProvider(provider)
    assert.equal(bootstrapOpen, false)
    const target = { machine_id: device.machine_id, provider_id: provider.provider_id, profile: 'session', session }
    const policies = {
      caller: { revision: 'owned-caller-1', grants: [{ target, methods, actions: ['dispatch', 'read', 'cancel'] }] },
      local: { revision: 'owned-local-1', grants: [{ target, methods, actions: ['dispatch', 'read', 'cancel'] }] }
    }
    const principal = /* 本轮操作身份来自私有 OS 进程和预先授权的固定策略，不接受调用 JSON 身份。 */ () => {
      assert(hostActive && process.geteuid() === uid)
      return { id: actor, policy: policies.caller, permissions: { discard_response: discardAllowed } }
    }
    const connection = {
      machine_id: device.machine_id,
      connection_epoch: epoch,
      recovery_generation: store.generation(),
      authenticated: true,
      active: true,
      negotiated: { major: 2, minor: 0, capabilities: ['rpc'] }
    }
    const bindings = new Map()
    const nativeBinding = {
      kind: 'luvus',
      provider_id: provider.provider_id,
      binding_revision: 1,
      contract_source_ref: ref,
      target: { machine_id: device.machine_id, profile: 'session', session },
      server_generation: capabilities.result.server_generation,
      connection_epoch: epoch,
      recovery_generation: store.generation(),
      capability_revision: 'owned-live-caps-1',
      caller_policy_revision: policies.caller.revision,
      local_policy_revision: policies.local.revision,
      classification_revision: origin.classification_revision,
      contract: compiled.value.identity
    }
    const source = /* 来源只在真实存活实例、自有 token、当前 Store epoch 和原 binding 同时成立时可用。 */ (
      callId,
      attemptId
    ) => {
      try {
        live()
        assert(sourceActive && hostActive && Date.now() < tokenExpires)
        store.assertConnection(connection)
        const b = bindings.get(callId)
        assert(b && b.attempt_id === attemptId)
        const attempt = store.attempt(callId, attemptId)
        assertBinding(b, attempt.binding)
        const current = {
          authenticated: true,
          source_verified: true,
          binding: nativeBinding
        }
        return current
      } catch {
        return undefined
      }
    }
    const backend = persistentBackend(store, {
      connection: /* Store 实际 credential connect 的本地连接，不冒称 #6 认证通道验收。 */ () => {
        principal()
        store.assertConnection(connection)
        return connection
      },
      localProvider: /* 固定配置只服务本轮完整 Target。 */ () => provider,
      contract: /* 绑定本次官方安装 schema 及同一实测实例的在线能力。 */ (key) =>
        key === ref
          ? {
              wire: { source: origin, support_status: 'validated' },
              compiled: compiled.value,
              capabilities,
              capability_revision: 'owned-live-caps-1'
            }
          : undefined,
      nativeSource: source,
      policies: /* 每次取得同一受保护宿主的当前双方授权。 */ () => structuredClone(policies),
      authority: /* 逐方法使用人工审过的效果；保留 potentially_sensitive 和当前 read 授权。 */ (attempt, _binding) => {
        assert(methods.includes(attempt.method), 'unreviewed_method')
        const view = validator.bindCapabilities(
          capabilities,
          source(attempt.binding.call_id, attempt.binding.attempt_id)
        )
        assert(view.ok, 'owned_capability_source_invalid')
        const description = validator.describe(view.value, attempt.method)
        assert(description.ok && description.value.schema_status === 'conditional_branch')
        return { owner: false, raw_requested: false }
      },
      currentPrincipal: /* 原许可和当前本地进程身份必须一致。 */ () => principal().id
    })
    wire = createLuvusWireAdapter(backend)
    responseWire = createLuvusWireAdapter(backend)
    const claimsPath = join(root, 'gateway/claims.sqlite')
    claims = new DispatchClaims({
      path: claimsPath,
      mode: 'create',
      ledger_id: 'owned-official-ipc',
      limits: { entries: 128, bytes: 1_048_576 },
      now: /* 复用本轮 Store 的可信时钟和回拨治理。 */ () => store.clock()
    })
    claimReader = new DatabaseSync(claimsPath, { readOnly: true })
    const router = new Router(store, /* 每次返回当前本地策略快照。 */ () => structuredClone(policies.local))
    const config = {
      target,
      binding_revision: 1,
      config_ref: provider.config_ref,
      binary,
      binary_sha256: binaryHash,
      state_root: join(root, 'state'),
      home: join(root, 'home'),
      cwd: join(root, 'project'),
      transport: 'ipc'
    }
    const host = {
      backend,
      verifyPeer: /* 同一连接内核证明；没有 CLI provenance 放行回调。 */ async (socket) => peer(socket),
      nativeAuth: /* 只返回本次引导取得的限期 token；退出、过期或 binding 变化均拒绝，无 Owner 回退。 */ async (
        binding,
        evidence
      ) => {
        const current = source(binding.call_id, binding.attempt_id)
        assert(current && evidence.transport === 'ipc')
        assert.deepEqual(evidence.peer, { pid: child.pid, uid, gid })
        assert(store.attempt(binding.call_id, binding.attempt_id).method && Date.now() < tokenExpires)
        return token
      },
      claimDispatch: /* 独立 SQLite FULL 事务提交唯一 claim；原 Wire 还在实际写入前复核当前许可。 */ async (
        binding,
        evidence
      ) => {
        assert(source(binding.call_id, binding.attempt_id))
        assert.deepEqual(evidence.peer, { pid: child.pid, uid, gid })
        assert.equal(evidence.endpoint.address, endpoint)
        assert.equal(stamp(endpoint), endpointStamp)
        const record = store.attempt(binding.call_id, binding.attempt_id)
        assertBinding(binding, record.binding)
        assert.equal(store.provider(target.machine_id, target.provider_id).config_ref, provider.config_ref)
        assert(store.clock() < binding.registration.deadline)
        claimsEntered++
        try {
          claims.claim(binding, store.responseAnchor(binding).dedup_expires_at)
        } catch (error) {
          if (error instanceof LuvusAdapterError && error.code === 'dispatch_already_claimed') {
            claimsDuplicated++
          }
          throw error
        }
        const persisted = claimReader
          .prepare('SELECT binding_digest FROM luvus_dispatch_claims WHERE call_id=? AND attempt_id=?')
          .get(binding.call_id, binding.attempt_id)
        assert.deepEqual(
          Buffer.from(persisted.binding_digest),
          createHash('sha256').update(boundedJson(binding)).digest()
        )
        claimsCommitted++
      }
    }
    /** 真实 Router/Store 登记、原 Wire 许可及 adapter 派发；不重建原读取上下文。 */
    function prepare(method, params, stopAfterClaim = false) {
      const call = router.create(
        principal(),
        target,
        { method, params },
        { binding_revision: 1, contract_ref: ref, timeoutMs: 10_000 }
      )
      const binding = router.dispatch(principal(), call.call_id, epoch)
      bindings.set(call.call_id, binding)
      const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
      const frame = {
        protocol_major: 2,
        protocol_minor: 0,
        message_id: randomUUID(),
        machine_id,
        recovery_generation,
        connection_epoch,
        type: 'request',
        payload: { attempt, expected_binding_revision: 1, validation: 'strict', native_request: { method, params } }
      }
      const raw = wire.encode(frame, 'gateway_to_connector')
      responseWire.decode(raw, 'gateway_to_connector')
      const adapter = new LuvusRpcAdapter(
        config,
        stopAfterClaim
          ? {
              ...host,
              claimDispatch:
                /* 持久登记后注入受控本地终止，保证首个请求不写 native；用于跨 adapter 实例重放验证。 */ async (
                  ...args
                ) => {
                  await host.claimDispatch(...args)
                  throw new LuvusAdapterError('acceptance_stop_after_claim')
                }
            }
          : host
      )
      adapters.add(adapter)
      return { call, binding, frame, attempt, raw, adapter }
    }
    const interrupted = prepare('task.update', { id: 'acceptance-no-such-task' }, true)
    await assert.rejects(
      /* SQLite 已提交，但 beforeWrite 前停止这次本地等待。 */ () => interrupted.adapter.dispatch(interrupted.raw),
      /acceptance_stop_after_claim/
    )
    const claimReplay = new LuvusRpcAdapter(config, host)
    adapters.add(claimReplay)
    await assert.rejects(
      /* 新 adapter 沿真实 peer/auth 到达同一 SQLite 唯一 fence，不能再次写 native。 */ () =>
        claimReplay.dispatch(interrupted.raw)
    )
    assert.equal(claimsEntered, 2)
    assert.equal(claimsCommitted, 1)
    assert.equal(claimsDuplicated, 1)
    assert.equal(claimReader.prepare('SELECT count(*) AS n FROM luvus_dispatch_claims').get().n, 1)
    store.stop(actor, interrupted.call.call_id)
    checks.push({
      check: 'durable_claim_blocks_fresh_adapter_before_native_write',
      entered: claimsEntered,
      committed: claimsCommitted,
      duplicated: claimsDuplicated
    })
    let last
    /** 经原 Wire 真实编码/解码，再在实际 Store 事务中提交返回；响应 id 原样保持。 */
    async function execute(method, params) {
      const p = prepare(method, params)
      const result = await p.adapter.dispatch(p.raw)
      assert.equal(result.native_response.id, p.binding.native_request_id)
      const response = {
        ...p.frame,
        message_id: randomUUID(),
        type: 'response',
        payload: { attempt: p.attempt, native_response: result.native_response }
      }
      const envelope = wire.decode(responseWire.encode(response, 'connector_to_gateway'), 'connector_to_gateway')
      const committed = commitLuvusResponse(store, wire, envelope)
      assert.equal(committed.state, 'responded')
      assert.deepEqual(JSON.parse(committed.response), result.native_response)
      last = { ...p, response: result.native_response }
      return result.native_response
    }
    const automations = await execute('automation.list', {})
    assert.equal(automations.result?.type, 'automation_list')
    assert.deepEqual(automations.result.automations, [])
    checks.push({
      check: 'second_strict_rpc_family_automation_list',
      method: 'automation.list',
      empty_owned_session: true
    })
    const paths = Array.from(
      { length: 64 },
      /* 唯一合成路径仅作 ledger 字符串，不访问这些文件。 */ (_, index) =>
        'synthetic-' + String(index).padStart(2, '0') + '-' + 'p'.repeat(1011)
    )
    assert(paths.every(/* 固定在原生单路径上限内。 */ (path) => Buffer.byteLength(path) === 1024))
    const prompt = '合成🌍'.repeat(2457)
    const added = await execute('task.add', { title: 'Rovloom owned synthetic pagination acceptance', prompt, paths })
    assert(added.result?.task)
    const task = added.result.task
    ownedTasks.add(task.id)
    assert.equal(task.status, 'queued')
    assert.equal(task.assignee, null)
    assert.deepEqual(task.paths, paths)
    assert.equal(task.prompt, prompt)
    const note = '页🌍'.repeat(585)
    for (let i = 0; i < 6; i++) {
      const updated = await execute('task.update', { id: task.id, note, output: note })
      assert.equal(updated.result.task.status, 'queued')
      assert.equal(updated.result.task.assignee, null)
      assert.equal(updated.result.task.notes.length, i + 1)
      assert.equal(updated.result.task.outputs.length, i + 1)
    }
    const access = createLuvusResultAccess({
      store,
      principal,
      localPolicies: /* 当前双方 ACL 分开进入 Router 门禁。 */ () => structuredClone(policies.local)
    })
    const meta = access.open(last.call.call_id)
    assert(meta.bytes > 65_535)
    const pages = []
    let cursor = 0
    while (true) {
      const page = access.read(meta.result_id, cursor, 65_535)
      assert.equal(page.expires, meta.expires)
      assert.equal(page.hash, meta.hash)
      assert.equal(page.bytes, meta.bytes)
      const bytes = Buffer.from(page.data, 'base64')
      assert(bytes.length <= 65_535)
      pages.push(bytes)
      cursor = page.next_cursor
      if (page.eof) {
        break
      }
    }
    const body = Buffer.concat(pages)
    assert.equal(body.length, meta.bytes)
    assert.equal(hash(body), meta.hash)
    assert.deepEqual(JSON.parse(body.toString()), last.response)
    assert.deepEqual(access.open(last.call.call_id), meta)
    checks.push({
      check: 'native_to_adapter_original_wire_store_pages_hash',
      bytes: body.length,
      pages: pages.length
    })
    assert.throws(
      /* 读取授权不能代替独立 discard_response 权限。 */ () => access.discard(last.call.call_id),
      /forbidden/
    )
    discardAllowed = true
    access.discard(last.call.call_id)
    assert.throws(/* 真实 Store 正文及句柄被丢弃后，不能交付任何旧页。 */ () => access.read(meta.result_id, 0, 1))
    assert.equal(store.call(actor, last.call.call_id).response, null)
    checks.push({ check: 'separate_discard_authorization_and_body_removal', passed: true })
    await execute('task.update', { id: task.id })
    const contentExpires = store.call(actor, last.call.call_id).content_expires
    const early = access.open(last.call.call_id)
    assert.equal(early.expires, contentExpires)
    await until(/* 正文期限按实际墙钟到达，不推进 Store 时钟。 */ () => Date.now() >= contentExpires, 25_000)
    store.expire()
    assert.throws(
      /* 句柄与正文同期限，到期后不能通过旧句柄交付，也不能显式重开。 */ () => access.read(early.result_id, 0, 1)
    )
    assert.throws(/* 原许可或当前 native 来源都不能恢复过期正文。 */ () => access.open(last.call.call_id))
    assert.equal(store.call(actor, last.call.call_id).response, null)
    checks.push({ check: 'actual_result_ttl_handle_and_body_expire_together', passed: true })
    await execute('task.update', { id: task.id })
    const closedMeta = access.open(last.call.call_id)
    assert(access.read(closedMeta.result_id, 0, 1))
    const beforeReplay = claimsCommitted
    const replay = new LuvusRpcAdapter(config, host)
    adapters.add(replay)
    await assert.rejects(/* 新 adapter 也不能重新认领已持久发送的 attempt。 */ () => replay.dispatch(last.raw))
    assert.equal(claimsCommitted, beforeReplay)
    checks.push({ check: 'completed_attempt_replay_refused', claims: claimsCommitted })
    // task.delete 的 installed schema 不完整；只在本地受限清理口使用，不冒充 strict adapter 成功。
    const deleted = await native('task.delete', { id: task.id })
    assert(deleted.result && !deleted.error)
    ownedTasks.delete(task.id)
    const empty = await native('task.list')
    assert.deepEqual(empty.result.tasks, [])
    wire.close()
    assert.throws(
      /* Store 句柄正文尚有效时，关闭真实原 Wire 会立即拒绝后续读取。 */ () => access.read(closedMeta.result_id, 0, 1)
    )
    assert(store.readResult(actor, closedMeta.result_id, 0, 1).data)
    checks.push({ check: 'original_wire_close_refuses_live_store_handle', passed: true })
    return {
      native_version: version,
      binary_sha256: binaryHash,
      schema_sha256: schemaHash,
      same_socket_peer_checks: peerChecks,
      trusted_source: 'owned_child_held_pidfd_and_same_socket_so_peercred',
      scopes: ['read', 'orchestration'],
      checks,
      production_auth_channel: false,
      cli_provenance_accepted: false
    }
  } finally {
    try {
      for (const id of ownedTasks) {
        try {
          await native('task.delete', { id })
        } catch {
          /* 仅清理本轮 id；失败仍停止自己 spawn 的会话。 */
        }
      }
      sourceActive = false
      hostActive = false
      for (const adapter of adapters) {
        adapter.close()
      }
      wire?.close()
      responseWire?.close()
      claimReader?.close()
      claims?.close()
      store?.close()
    } finally {
      try {
        if (child) {
          if (!exited) {
            child.kill('SIGTERM')
          }
          await until(/* 等待本轮直接子进程退出，未退出则保留目录供调查。 */ () => exited)
        }
      } finally {
        if (pidfd >= 0) {
          libc.symbols.close(pidfd)
        }
        libc?.close()
      }
      rmSync(root, { recursive: true })
    }
  }
}

if (import.meta.main) {
  const summary = await officialIpc(process.argv[2])
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
}
