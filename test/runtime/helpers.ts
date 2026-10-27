// 用自建 Unix listener、合成非生产身份和真实双库/Wire 工厂建立隔离回归，不接触用户原生实例。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fixture as localFixture } from '../connector/luvus/helpers.js'
import { management } from '../storage/helpers.js'
import { until } from '../transport/helpers.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { createGatewayRuntime } from '../../src/runtime/gateway.js'
import { createConnectorRuntime } from '../../src/runtime/connector.js'
import {
  ConnectorAttemptBook,
  CONNECTOR_MAX_DEADLINE_MS,
  createConnectorAdmissionBackend
} from '../../src/runtime/connector-attempts.js'
import type { LuvusConnectorAdmissionSource } from '../../src/runtime/connector-attempts.js'
import { LuvusDispatchClaims, readLinuxLuvusPeer } from '../../src/connector/luvus/index.js'
import { contractRef, assertBinding, fail } from '../../src/wire/index.js'
import type { AttemptBinding } from '../../src/wire/types.js'
import type { NativeBinding, TrustedNativeContext } from '../../src/native-contract/index.js'
import type { GatewayIdentitySource } from '../../src/mcp/management.js'
import type { GatewayHostedProviders } from '../../src/runtime/types.js'
import type { GatewayRuntimeOptions } from '../../src/runtime/types.js'

/** Gateway 和 Connector 独立请求锚点仅经真实认证通道关联；native 来源仍为标明的测试 fixture。 */
export async function runtimeFixture(
  limits: GatewayRuntimeOptions['listener']['limits'] = {},
  extend?: (context: {
    state: ReturnType<typeof openGatewayState>
    caller: ProviderPolicy
    local: ProviderPolicy
    target: import('../../src/wire/types.js').V2Target
    root: string
  }) => Promise<{ hosted: readonly GatewayHostedProviders[]; release(): Promise<void> }>,
  operation?: { method: string; params: Record<string, unknown>; validation: 'strict' | 'raw-contract' }
) {
  const native = await localFixture('ipc', operation?.method, operation?.params, operation?.validation)
  const stateDirectory = join(native.root, 'gateway')
  mkdirSync(stateDirectory, { mode: 0o700 })
  const state = openGatewayState({
    state_directory: stateDirectory,
    store: { management },
    /** 身份提交后正常断开当前真实 socket；从未调用 Store.connect。 */
    changed: (machine) => gateway?.transport.disconnect(machine)
  })
  const machine = state.store.register('isolated_runtime')
  const redeemed = state.store.redeem(state.store.issueEnrollment(machine.machine_id))
  const credential = { ...redeemed, recovery_generation: state.store.generation() }
  const target = { ...native.config.target, machine_id: machine.machine_id }
  const binding = {
    machine_id: machine.machine_id,
    provider_id: target.provider_id,
    kind: 'luvus' as const,
    binding_revision: 1,
    enabled: true,
    config_ref: native.config.config_ref
  }
  state.store.defineProvider(binding)
  const caller: ProviderPolicy = {
    revision: 'caller1',
    grants: [{ target, methods: [native.row.method], actions: ['dispatch', 'read', 'cancel'] }]
  }
  const local: ProviderPolicy = { ...structuredClone(caller), revision: 'local1' }
  let authorized = true
  let deviceScope: string[] | undefined
  const contract = {
    wire: { source: native.origin, support_status: 'validated' as const },
    compiled: native.compiled,
    capabilities: native.capabilities,
    capability_revision: 'caps1'
  }
  const reference = contractRef(native.origin)
  /** 仅将已核验测试 listener 的完整上下文投影成测试来源，不是生产 native 信任实现。 */
  function source(attempt: AttemptBinding): TrustedNativeContext {
    return { authenticated: true, source_verified: native.state.trusted, binding: nativeBinding(attempt) }
  }
  /** 绑定本测试具体设备、epoch、契约及双方政策，不复用 fixture 的原 m1/e1。 */
  function nativeBinding(attempt: Pick<AttemptBinding, 'connection_epoch' | 'recovery_generation'>): NativeBinding {
    return {
      ...native.native,
      target: { machine_id: target.machine_id, profile: 'session', session: target.session },
      provider_id: target.provider_id,
      connection_epoch: attempt.connection_epoch,
      recovery_generation: attempt.recovery_generation
    }
  }
  const identities: GatewayIdentitySource = {
    /** 测试开关可撤销合成 caller；设备凭据不等于 caller 身份。 */
    principal: (identity) =>
      authorized && identity.principal_id === 'synthetic'
        ? {
            id: 'synthetic',
            policy: caller,
            ...(deviceScope ? { device_scope: { mode: 'selected', machine_ids: deviceScope } } : {})
          }
        : null,
    /** 本切片不注入管理会话，普通 caller 无法升级管理员。 */
    administrator: () => null
  }
  let extension: Awaited<ReturnType<NonNullable<typeof extend>>> | undefined
  try {
    extension = await extend?.({ state, caller, local, target, root: native.root })
  } catch (error) {
    state.close()
    await native.close()
    throw error
  }
  const gateway = await createGatewayRuntime({
    lifecycle: state.lifecycle,
    channels: state.channels,
    identities,
    hosted: extension?.hosted,
    providers: [
      {
        catalog_methods: Object.freeze(caller.grants.flatMap((grant) => grant.methods ?? [])),
        binding,
        target,
        contract,
        source,
        /** 目录来源只投影已认证连接及当前双方政策，不编造 attempt 或发行真实原生权限。 */
        catalogSource(connection) {
          return {
            authenticated: true,
            source_verified: native.state.trusted,
            binding: nativeBinding(connection)
          }
        },
        validateAttempt: native.host.backend.validateAttempt,
        ready: /** 仅代表此自建 listener 的测试健康。 */ () => native.state.active
      }
    ],
    listener: {
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      offer: { major: 2, minor: 0, capabilities: ['rpc', 'history_scope'], required: ['rpc'] },
      // 组合双持久身份库时使用产品默认心跳，避免追踪测试制造每秒十次持久校验/心跳写入。
      limits: { heartbeat_ms: 5000, idle_ms: 20_000, ...limits }
    },
    /** 角色显式关闭后释放唯一双库。 */
    async release() {
      try {
        await extension?.release()
      } finally {
        state.close()
      }
    }
  })
  const active = gateway
  const claimsPath = join(native.root, 'claims.db')
  const claims = new LuvusDispatchClaims({
    path: claimsPath,
    mode: 'create',
    ledger_id: 'isolated_runtime_claims',
    limits: { entries: 128, bytes: 1_048_576 },
    now: Date.now
  })
  const book = new ConnectorAttemptBook({ maximum_deadline_ms: CONNECTOR_MAX_DEADLINE_MS, now: Date.now })
  native.respond(
    /** 保留实际请求 ID 的原生 error.data，检测 gateway 是否改写响应。 */
    (socket, raw) => {
      const request = JSON.parse(raw.trim())
      socket.end(JSON.stringify({ ...native.response, id: request.id }) + '\n')
    }
  )
  const connector = await createConnectorRuntime({
    transport: {
      url: active.transport.url,
      developmentLoopback: true,
      credential: /** 仅交付本临时双库签发的短期 fixture 凭据。 */ () => credential,
      offer: { major: 2, minor: 0, capabilities: ['rpc', 'history_scope'], required: ['rpc'] },
      limits: { heartbeat_ms: 5000, idle_ms: 20_000, reconnect_ms: 1000 }
    },
    /** 每个实际 welcome 建立独立准入后端，身份不从业务帧自报取得。 */
    session(connection) {
      const services: LuvusConnectorAdmissionSource = {
        /** 双方 provider 均从各自显式固定配置中解析，不从请求创建。 */
        provider: () => binding,
        localProvider: /** 返回本机独立受保护 binding。 */ () => binding,
        contract: /** 只接受固定安装 schema 的契约引用。 */ (ref) => (ref === reference ? contract : undefined),
        nativeSource: /** 从本机准入锚点找回完整 binding，不读取 Gateway 的 attempt 表。 */ (call, attempt) => {
          const entry = backend.attempt(call, attempt)
          return entry ? source(entry.binding) : undefined
        },
        validateAttempt: native.host.backend.validateAttempt,
        now: Date.now
      }
      const backend: ReturnType<typeof createConnectorAdmissionBackend<LuvusConnectorAdmissionSource>> =
        createConnectorAdmissionBackend({
          connection,
          routes: [{ target, principal_id: 'synthetic' }],
          source: services,
          book
        })
      return {
        backend,
        config: { ...native.config, target, transport: 'ipc' },
        authentication: 'local_owner' as const,
        /** 官方本机 Owner 省略 native auth 字段；同一 socket 证据由 assertEvidence 另行核验。 */
        nativeAuth: async () => ({ kind: 'local_owner' as const }),
        claims,
        verifyPeer: /** 对测试自建 listener 也实测同一 socket 的内核身份。 */ async (socket) =>
          readLinuxLuvusPeer(socket),
        dedupExpires: backend.dedupExpires,
        /** 同 uid 不构成生产来源；此处只核对已明确自建的 fixture listener。 */
        assertEvidence(attempt, evidence) {
          if (
            evidence.peer?.pid !== process.pid ||
            evidence.endpoint.address !== native.endpoint ||
            evidence.transport !== 'ipc'
          ) {
            fail('fixture_evidence_mismatch')
          }
          assertBinding(attempt, backend.attempt(attempt.call_id, attempt.attempt_id)!.binding)
        },
        readiness: /** 使用独立配置的相同 revision，并保持 native fixture 健康可撤销。 */ () => ({
          providers: [{ expected: binding, local: binding, native_ready: native.state.active }]
        }),
        close: /** 关闭 epoch 正文，不动长期 claims 墓碑。 */ () => backend.close()
      }
    },
    /** 仅角色显式关闭才释放长期 claims writer。 */
    async release() {
      claims.close()
    }
  })
  return {
    gateway: active,
    mcp: { runtime: active, identities },
    connector,
    state,
    native,
    target,
    reference,
    caller: { principal_id: 'synthetic' },
    /** 等待双方实际认证且完成 provider readiness。 */
    async ready(signal?: AbortSignal) {
      await until(
        /** 每端都须ready；所属测试已结束时停止轮询，不继续访问旧writer。 */ () => {
          signal?.throwIfAborted()
          return (
            connector.transport.status().phase === 'ready' &&
            active.transport.status().devices.some(/** 当前设备应由真实认证连接建立。 */ (device) => device.ready)
          )
        },
        30_000
      )
    },
    /** 统计真实持久 claims，测试查询不进入产品宿主。 */
    claims() {
      const database = new DatabaseSync(claimsPath, { readOnly: true })
      try {
        return Number(database.prepare('SELECT count(*) AS n FROM luvus_dispatch_claims').get()!.n)
      } finally {
        database.close()
      }
    },
    /** 切换当前测试主体有效性，结果读取必须即时重新核验。 */
    authorize(value: boolean) {
      authorized = value
    },
    deviceScope(value: string[] | undefined) {
      deviceScope = value
    },
    /** 有界等待真实 Gateway 账本回应；回调不授予读取原文权限。 */
    async responded(call: string) {
      await until(
        /** 未知终态立即给出仅含 fixture 状态计数的诊断，不输出请求、响应或凭据。 */ () => {
          const current = state.store.call('synthetic', call)
          if (current.state === 'outcome_unknown') {
            throw new Error(
              'fixture_outcome_unknown_native_' +
                native.state.responses +
                '_connector_' +
                connector.transport.status().phase
            )
          }
          return current.state === 'responded'
        },
        30_000
      )
    },
    /** 停止角色后清除仅属于此 fixture 的私有目录。 */
    async close() {
      try {
        await connector.close()
      } finally {
        try {
          await active.close()
        } finally {
          await native.close()
        }
      }
    }
  }
}

import type { ProviderPolicy } from '../legacy-policy.js'
