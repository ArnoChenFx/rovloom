// 在独立子进程中检验认证拒绝的日志边界；此路径不得依赖原生 schema 初始化。
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// mock secret 只经 stdin 进入，不放入 URL、环境或 argv。
const secret = readFileSync(0, 'utf8')
const runtimeWorker = globalThis.Worker
// 认证拒绝之前禁止启动 schema Worker，防止通用业务 fixture 的初始化污染此反例。
globalThis.Worker = new Proxy(runtimeWorker, {
  /* 动态导入和握手期间如意外依赖编译 Worker，立即使这个隔离用例失败。 */ construct() {
    throw new Error('fixture_pre_auth_worker_forbidden')
  }
})
try {
  const [
    { Store },
    { Router },
    { createGateway, createConnector },
    { WireError },
    { CredentialLifecycle },
    { PairingAdmin }
  ] = await Promise.all([
    import('../../src/store.js'),
    import('../../src/router.js'),
    import('../../src/transport/index.js'),
    import('../../src/wire/index.js'),
    import('./memory-identity.js'),
    import('./memory-pairing.js')
  ])
  const now = /* 仅为本次内存身份和账本提供相同的固定可信时间。 */ () => 1000
  const store = new Store(':memory:', now, {
    /* 配对仅作用于本进程内存测试库，不代表生产管理权限。 */ management: () => ({
      actor: 'synthetic_admin',
      confirmation_id: randomUUID()
    })
  })
  let gateway: ReturnType<typeof createGateway> | undefined
  let client: ReturnType<typeof createConnector> | undefined
  let nativeTouched = false
  // 未认证请求不应创建原生会话或触发任何原生准备、执行。
  function unreachable(): never {
    nativeTouched = true
    throw new Error('fixture_pre_auth_native_forbidden')
  }
  try {
    const canonical = new Map<string, string>()
    const credentials = new CredentialLifecycle(
      {
        /* 从当前内存 Store 取恢复代次，不从 Wire 自报建立信任。 */ generation: () => store.generation(),
        /* 真实租期校验通过后才可建立 Store epoch；本反例不应到达这里。 */ connect: (machine) =>
          store.connect(machine, canonical.get(machine) ?? ''),
        /* 复用真实 Store 的连接 fence 校验。 */ assert: (identity) => store.assertConnection(identity),
        /* 只断开本 fixture 精确匹配的连接。 */ disconnect: (identity) =>
          store.disconnect(identity.machine_id, identity.connection_epoch)
      },
      now
    )
    const admin = new PairingAdmin(store, credentials, {
      /* 仅允许本隔离 fixture 自建配对。 */ authorize() {},
      /* 原始测试凭据只保存在本进程内存 custody。 */ installCanonical: (machine, credential) => {
        canonical.set(machine, credential)
      }
    })
    const machine = admin.register('log-fixture')
    const credential = admin.redeem(admin.issue(machine.machine_id))
    if (secret === credential.credential) {
      throw new Error('fixture_credential_collision')
    }
    let refused = false
    const authenticate = credentials.authenticate.bind(credentials)
    credentials.authenticate = /* 确认实际凭据校验收到原输入并拒绝，不能用 TLS 或 framing 失败冒充。 */ (
      machineId,
      generation,
      value
    ) => {
      if (value !== secret) {
        throw new Error('fixture_credential_changed')
      }
      try {
        return authenticate(machineId, generation, value)
      } catch (error) {
        refused = error instanceof WireError && error.code === 'invalid_device_credential'
        throw error
      }
    }
    const principal = { id: 'synthetic', policy: { revision: 'caller1', grants: [] } }
    const router = new Router(store)
    gateway = createGateway({
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      identity: credentials,
      store,
      router,
      /* caller 来自固定测试宿主，不能由帧中的字段指定。 */ principal: () => principal,
      session: unreachable,
      limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 150 }
    })
    client = createConnector({
      url: gateway.url,
      developmentLoopback: true,
      /* 只替换配对凭据中的随机 mock secret，保留原设备和代次。 */ credential: () => ({
        ...credential,
        credential: secret
      }),
      session: unreachable,
      nativeInput: unreachable,
      /* 即使意外调度原生执行，也必须让本测试失败。 */ execute: async () => unreachable(),
      limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 150, reconnect_ms: 20, reconnect_max_ms: 200 },
      /* 使用固定退避随机值，避免认证反例依赖随机等待。 */ random: () => 1,
      now
    })
    const until = performance.now() + 4000
    while (client.status().reconnects === 0) {
      if (performance.now() >= until) {
        throw new Error('fixture_wait_timeout')
      }
      await new Promise(/* 让出事件循环以完成实际握手拒绝。 */ (resolve) => setTimeout(resolve, 5))
    }
    if (
      !refused ||
      nativeTouched ||
      gateway.status().devices.length !== 0 ||
      JSON.stringify(store.auditRecords()).includes(secret)
    ) {
      throw new Error('fixture_authentication_failed')
    }
  } finally {
    client?.stop()
    gateway?.stop()
    store.close()
  }
} finally {
  globalThis.Worker = runtimeWorker
}
process.stdout.write('mock fixture closed\n')
