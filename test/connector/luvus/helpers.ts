/** 为 adapter 测试建立私有安装、合成可信后端和自建 listener，并集中管理测试资源清理。 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileBundle } from '../../../src/connector/luvus/contract/index.js'
import type { CompiledContract, NativeBinding } from '../../../src/connector/luvus/contract/index.js'
import type { NativeWireBackend } from '../../../src/connector/luvus/backend.js'
import type { TrustedAttempt } from '../../../src/wire/backend.js'
import { contractRef } from '../../../src/wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope, ContractSource } from '../../../src/wire/types.js'
import { LuvusRpcAdapter } from '../../../src/connector/luvus/index.js'
import type { LuvusLocalConfig, LuvusRpcHost } from '../../../src/connector/luvus/index.js'
import { bytes, clone, fixtureRoot, G, identity, json, request, unwrap, view } from './contract/helpers.js'

// 每个 fixture 都写入相同受控脚本；编译只与这些固定字节及其来源身份有关，不含临时路径或用例状态。
const script =
  '#!' +
  process.execPath +
  ' --no-env-file\nawait import(' +
  JSON.stringify(new URL('./child-fixture.ts', import.meta.url).href) +
  ')\n'
const binarySha = createHash('sha256').update(script).digest('hex')
const fixedIdentity = Object.freeze({ ...identity, binary_sha256: binarySha })
let compilation: Promise<CompiledContract> | undefined

/** 同一测试模块只编译一次真实完整根，保留原 Worker 品牌；失败不重试，许可和 adapter 仍逐 fixture 创建。 */
function compiledFixture(): Promise<CompiledContract> {
  compilation ??= compileBundle(bytes, { identity: fixedIdentity }).then(
    /** 只缓存真实工厂已接纳的不可变编译句柄，不复制或重建来源品牌。 */ (result) => unwrap(result)
  )
  return compilation
}

/** 建立仅使用仓库证据、合成许可和受控 Bun 子进程的私有 fixture，并返回显式清理入口。 */
export async function fixture(
  transport: 'ipc' | 'cli' = 'ipc',
  method = 'task.add',
  requestParams?: Record<string, unknown>,
  mode: 'strict' | 'raw-contract' = 'strict'
) {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url)), '.luvus-adapter-')
  )
  const home = join(root, 'home')
  const stateRoot = join(root, 'state')
  const cwd = join(root, 'project')
  for (const path of [
    home,
    stateRoot,
    cwd,
    ...['config', 'data', 'cache', 'runtime'].map(
      /* 在测试 HOME 下构造固定 XDG 私有目录路径。 */ (name) => join(home, name)
    )
  ]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const binary = join(root, 'test-luvus')
  writeFileSync(binary, script, { mode: 0o700 })
  const installedIdentity = { ...fixedIdentity }
  const compiled = await compiledFixture()
  const params =
    requestParams ??
    (method === 'task.add'
      ? { title: 'synthetic' }
      : method === 'ping'
        ? {}
        : { server_generation: G, terminal_id: '1'.repeat(32), pane_id: '3' })
  const candidate =
    mode === 'raw-contract'
      ? request(view(), { id: 'native_1', method, params }, true)
      : request(view(), { id: 'native_1', method, params })
  const origin: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: binarySha,
    schema_sha256: identity.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: G,
    adapter_revision: 'local-adapter-test',
    classification_revision: 'review1',
    support_basis: 'live_catalog'
  }
  const binding: AttemptBinding = {
    machine_id: 'm1',
    provider_kind: 'luvus',
    binding_revision: 1,
    recovery_generation: 'recovery1',
    connection_epoch: 'e1',
    call_id: 'call1',
    attempt_id: 'attempt1',
    native_request_id: 'native_1',
    contract_ref: contractRef(origin),
    target: { machine_id: 'm1', provider_id: 'p1', profile: 'session', session: 'synthetic' },
    registration: {
      deadline: 30_100
    }
  }
  const row: TrustedAttempt = {
    binding,
    principal_id: 'synthetic',
    method,
    mode,
    native_request: { method, params }
  }
  const native: NativeBinding = {
    ...candidate.binding,
    contract: installedIdentity,
    contract_source_ref: binding.contract_ref
  }
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = G
  const state = {
    active: true,
    enabled: true,
    read: true,
    trusted: true,
    now: 100,
    claims: 0,
    auth: 'test-only-token',
    responses: 0
  }
  const provider = /* 返回随启用状态变化的合成本地 provider，供 Wire 当前绑定复核使用。 */ () => ({
    machine_id: 'm1',
    provider_id: 'p1',
    binding_revision: 1,
    kind: 'luvus' as const,
    enabled: state.enabled,
    config_ref: 'config1'
  })
  const source = /* 返回克隆的合成原生来源，避免消费者修改 fixture 内部身份。 */ () => ({
    authenticated: true,
    source_verified: state.trusted,
    binding: clone(native)
  })
  const backend: NativeWireBackend = {
    connection: /* 提供可撤销的合成认证连接状态及所需协议能力。 */ () => ({
      machine_id: 'm1',
      recovery_generation: 'recovery1',
      connection_epoch: 'e1',
      authenticated: true,
      active: state.active as true,
      negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'] }
    }),
    attempt: /* 仅对完整匹配的 call 和 attempt 返回已登记测试意图。 */ (call, attempt) =>
      call === binding.call_id && attempt === binding.attempt_id ? row : undefined,
    provider,
    localProvider: provider,
    contract: /* 仅对当前来源引用返回 fixture 编译句柄和在线能力。 */ (ref) =>
      ref === binding.contract_ref
        ? {
            wire: { source: origin, support_status: 'validated' },
            compiled,
            capabilities,
            capability_revision: 'caps1'
          }
        : undefined,
    nativeSource: source,
    validateAttempt: /* raw 只由测试显式选择，每次仍绑定本轮真实 attempt、当前 native 上下文和固定期限。 */ () => {},
    currentPrincipal: /* 根据测试读取开关切换当前 principal，模拟结果读取权限撤销。 */ () =>
      state.read ? 'synthetic' : 'other',
    now: /* 返回可控测试时钟，供期限和时间回退用例使用。 */ () => state.now,
    contentStatus: /* 将合成结果标记为可用，使测试聚焦当前 principal 和策略门禁。 */ () => 'available'
  }
  const endpoint = join(stateRoot, 'rpc.sock')
  const settings: Record<string, unknown> = {
    endpoint,
    schema: fileURLToPath(new URL('schema-bundle.json', fixtureRoot))
  }
  /** 更新受控子进程设置文件；只写入本 fixture 的私有 cwd。 */
  function configure(update: Record<string, unknown> = {}) {
    Object.assign(settings, update)
    writeFileSync(join(cwd, 'settings.json'), JSON.stringify(settings))
  }
  configure()
  const transcript = json('transcript.json') as Array<{ kind: string; channel?: string; wire?: string }>
  const validation = transcript.find(
    /** 在仓库 transcript 中定位关闭流后的终端校验响应。 */
    (entry) => entry.kind === 'receive' && entry.channel === 'validate-after-stream-close'
  )!
  const response =
    method === 'terminal.backend.validate'
      ? { ...JSON.parse(validation.wire!), id: 'native_1' }
      : {
          id: 'native_1',
          error: { code: 'synthetic', message: 'preserve', data: { deep: ['汉字', { revision: 7 }] } }
        }
  let respond: /* 声明测试 listener 收到完整请求后的可替换响应处理器。 */ (
    socket: Socket,
    input: string
  ) => void = /* 向自建 socket 返回单帧合成响应并正常结束连接。 */ (socket) =>
    socket.end(JSON.stringify(response) + '\n')
  const sockets = new Set<Socket>()
  let received = ''
  const server = createServer(
    /* 登记自有连接并累积输入，在收到 LF 后交给当前测试响应器。 */ (socket) => {
      sockets.add(socket)
      // transcript可合计多连接，是否收到完整请求必须按当前socket独立判断。
      let request = ''
      let handled = false
      socket.on('error', /* 消费故意中断测试连接产生的错误，避免 fixture 自身未处理事件。 */ () => {})
      socket.on(
        'close',
        /* 连接关闭后从 fixture 的自有 socket 集合移除，避免清理阶段重复持有。 */ () => sockets.delete(socket)
      )
      socket.on(
        'data',
        /* 记录自建 listener 收到的原始请求，并在完整帧到达时计数和调用响应器。 */ (data) => {
          const part = data.toString()
          received += part
          request += part
          if (!handled && request.includes('\n')) {
            handled = true
            state.responses++
            respond(socket, request)
          }
        }
      )
    }
  )
  await new Promise<void>(
    /* 等待私有 listener 就绪，绑定失败时拒绝 fixture 创建。 */ (resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    }
  )
  chmodSync(endpoint, 0o600)
  const config: LuvusLocalConfig = {
    target: binding.target as LuvusLocalConfig['target'],
    binding_revision: 1,
    config_ref: 'config1',
    binary,
    binary_sha256: binarySha,
    state_root: stateRoot,
    home,
    cwd,
    transport,
    // 夹具模拟所有者显式关闭；省略即开启的默认值由专门用例覆盖。
    allow_terminal_execution: false
  }
  const host: LuvusRpcHost = {
    backend,
    // 合成 peer 回调只用于本测试自建 listener；不冒称生产 SO_PEERCRED 实现。
    verifyPeer: /* 只为本 fixture 自建 listener 提供合成 peer，不代表生产身份验证实现。 */ async () => ({
      pid: process.pid,
      uid: process.geteuid!(),
      gid: process.getegid!()
    }),
    verifyProxy: /* 确认受控代理已有 pid；本钩子仅用于测试，不能替代生产来源证明。 */ async (child) => {
      if (!child.pid) {
        throw new Error('test child missing')
      }
    },
    nativeAuth: /* 返回本用例配置的合成认证串，不读取真实凭据。 */ async () => state.auth,
    claimDispatch: /* 计数并拒绝第二次测试 claim，模拟唯一派发登记门禁。 */ async () => {
      if (state.claims++ !== 0) {
        throw new Error('duplicate test claim')
      }
    }
  }
  const adapter = new LuvusRpcAdapter(config, host)
  const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...attempt } = binding
  const envelope: Extract<AuthenticatedEnvelope, { type: 'request' }> = {
    protocol_major: 2,
    protocol_minor: 0,
    message_id: 'request1',
    machine_id: 'm1',
    recovery_generation: 'recovery1',
    connection_epoch: 'e1',
    type: 'request',
    payload: { attempt, expected_binding_revision: 1, validation: mode, native_request: row.native_request }
  }
  return {
    root,
    home,
    cwd,
    stateRoot,
    endpoint,
    binary,
    config,
    host,
    backend,
    adapter,
    binding,
    row,
    envelope,
    origin,
    native,
    capabilities,
    compiled,
    state,
    response,
    source,
    input: /* 序列化当前可变测试请求，以便每次派发经过真实 Wire 解码。 */ () => JSON.stringify(envelope),
    configure,
    received: /* 返回自建 listener 实际收到的完整原始请求文本。 */ () => received,
    respond: /* 替换自建 listener 的响应器，用于注入超时、撤销和输出边界。 */ (callback: typeof respond) => {
      respond = callback
    },
    observed: /* 读取受控子进程记录的 argv 与环境，不访问用户运行态。 */ () =>
      JSON.parse(readFileSync(join(cwd, 'observed.json'), 'utf8')),
    cancel: /* 构造与当前已登记 attempt 一致的 Wire 取消帧。 */ () =>
      JSON.stringify({
        ...envelope,
        type: 'cancel',
        message_id: 'cancel1',
        payload: { attempt, reason: 'caller_cancelled' }
      }),
    /** 关闭 adapter、自有 socket 和 listener 后删除私有目录，避免留下测试资源。 */
    async close() {
      adapter.close()
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>(
        /* 等待私有 listener 完成关闭，再允许 fixture 删除目录。 */ (resolve) =>
          server.close(/* 在 listener 关闭回调中结算清理等待。 */ () => resolve())
      )
      rmSync(root, { recursive: true, force: true })
    }
  }
}
