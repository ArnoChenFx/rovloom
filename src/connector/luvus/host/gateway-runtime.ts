/** Luvus 的来源注册表、远端 epoch 与 Wire 装配；公共调度只接收会话和预检。 */
import { GatewayError } from '../../../contracts.js'
import type { ProviderSnapshot, ProviderBinding, V2Target } from '../../../wire/types.js'
import { boundedJson, contractRef, fail, LIMITS, uint, validateProvider, validateTarget } from '../../../wire/index.js'
import type { Session, Readiness } from '../../../transport/common.js'
import type { Connection, SocketChannel } from '../../../transport/index.js'
import { closeSession } from '../../../transport/common.js'
import { composeGatewaySessions, type ProviderSessionGroup } from '../../../runtime/provider-sessions.js'
import { createProviderGatewayRuntime } from '../../../runtime/gateway.js'
import type { GatewayHostedProviders, GatewayProviderServices, RuntimeProviderBinding } from '../../../runtime/types.js'
import { createLuvusRequestPreflight, luvusValidation } from '../preflight.js'
import { createDeviceLifecycleAdapter } from '../persistence.js'
import type {
  GatewayRuntimeOptions,
  RuntimeProvider,
  RemoteLuvusRuntimeProvider,
  RuntimeCatalogProvider
} from './runtime-types.js'

function prepareLuvusGateway(options: GatewayRuntimeOptions) {
  const store = options.lifecycle.store
  const providers = new Map<string, RuntimeProviderBinding & { max_response_bytes: number }>()
  const nativeProviders = new Map<string, RuntimeProvider>()
  const remoteProviders = new Map<string, RemoteLuvusRuntimeProvider>()
  const machineModes = new Map<string, 'local' | 'remote'>()
  const contracts = new Map<string, RuntimeProvider['contract']>()
  let closing = false
  let sessionCleanupFailed = false
  const key = (target: Pick<V2Target, 'machine_id' | 'provider_id'>) => target.machine_id + '/' + target.provider_id
  for (const provider of options.providers) {
    const binding = structuredClone(provider.binding)
    validateProvider(binding)
    validateTarget(provider.target)
    if (provider.target.machine_id !== binding.machine_id || provider.target.provider_id !== binding.provider_id) {
      fail('provider_binding_mismatch')
    }
    const responseBudget = LIMITS.frame_bytes
    uint(responseBudget)
    if (!responseBudget || responseBudget > LIMITS.frame_bytes) {
      fail('transport_limit')
    }
    const name = key(binding)
    const remote =
      'remote_luvus' in provider && provider.remote_luvus === true
        ? (provider as RemoteLuvusRuntimeProvider)
        : undefined
    const native = remote ? undefined : (provider as RuntimeProvider)
    {
      const mode = remote ? 'remote' : 'local'
      const previousMode = machineModes.get(binding.machine_id)
      if (previousMode && previousMode !== mode) {
        fail('runtime_provider_machine_mode_conflict')
      }
      machineModes.set(binding.machine_id, mode)
    }
    const ref = native ? contractRef(native.contract.wire.source) : undefined
    const previous = ref ? contracts.get(ref) : undefined
    // 同一引用不证明 live capability 相同；冲突必须拒绝，不能让另一实例的后写覆盖当前来源。
    if (
      providers.has(name) ||
      (previous &&
        boundedJson({
          wire: previous.wire,
          identity: previous.compiled.identity,
          capabilities: previous.capabilities,
          revision: previous.capability_revision
        }) !==
          boundedJson({
            wire: native!.contract.wire,
            identity: native!.contract.compiled.identity,
            capabilities: native!.contract.capabilities,
            revision: native!.contract.capability_revision
          }))
    ) {
      fail('runtime_provider_conflict')
    }
    if (
      binding.kind !== 'luvus' ||
      boundedJson(store.provider(binding.machine_id, binding.provider_id)) !== boundedJson(binding)
    ) {
      fail('provider_binding_mismatch')
    }
    const requestShape = native ? createLuvusRequestPreflight(native.contract.compiled) : undefined
    providers.set(name, {
      ...provider,
      admissionOptions(request, admission) {
        return luvusValidation('luvus', request, admission)
      },
      preflightRequest(request, admission) {
        const live = nativeProviders.get(name)
        if (live?.catalog_methods && !live.catalog_methods.includes(request.method as string)) {
          throw new GatewayError('forbidden')
        }
        const expected = provider.contract_ref ?? (live ? contractRef(live.contract.wire.source) : undefined)
        if ((expected !== undefined && admission?.contract_ref !== expected) || (remoteProviders.has(name) && !live)) {
          fail('contract_unavailable')
        }
        requestShape?.(request)
        provider.preflightRequest?.(request, admission)
      },
      max_response_bytes: responseBudget,
      binding: Object.freeze(binding),
      target: Object.freeze(structuredClone(provider.target))
    })
    if (native && ref) {
      nativeProviders.set(name, native)
      if (!previous) {
        contracts.set(ref, native.contract)
      }
    } else if (remote) {
      remoteProviders.set(name, remote)
    }
  }
  /** 按持久原请求选择独立 native 来源，不能从响应或 caller JSON 建立来源。 */
  function source(callId: string, attemptId: string, fenced: ReadonlySet<string>) {
    const attempt = store.attempt(callId, attemptId)
    const current =
      attempt && !fenced.has(key(attempt.binding.target))
        ? nativeProviders.get(key(attempt.binding.target))?.source(attempt.binding)
        : undefined
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    return current
  }

  const group: GatewayHostedProviders = {
    providers: [...providers.values()],
    session(connection: Connection, channel: SocketChannel, services: GatewayProviderServices): Session {
      const { localProvider } = services
      const remoteEpochs = new Map<
        string,
        {
          epoch: ReturnType<RemoteLuvusRuntimeProvider['open']>
          live?: RuntimeProvider
        }
      >()
      const isolated = connection.negotiated.capabilities.includes('provider_fence')
      const fencedNative = new Set<string>()
      /** 同一来源只关闭自己的 epoch；其它 provider 的目录与契约仍由其原 owner 持有。 */
      function fenceNativeProvider(binding: ProviderBinding): void {
        const name = key(binding)
        const configured = providers.get(name)
        if (!configured || boundedJson(configured.binding) !== boundedJson(binding)) {
          fail('provider_binding_mismatch')
        }
        if (fencedNative.has(name)) {
          return
        }
        fencedNative.add(name)
        const state = remoteEpochs.get(name)
        if (!state) {
          return
        }
        try {
          state.epoch.close()
        } finally {
          remoteEpochs.delete(name)
          if (state.live && nativeProviders.get(name) === state.live) {
            nativeProviders.delete(name)
            const ref = contractRef(state.live.contract.wire.source)
            if (
              ![...nativeProviders.values()].some(
                /** 相同契约仍被其它活来源使用时保留其原引用。 */ (provider) =>
                  contractRef(provider.contract.wire.source) === ref
              )
            ) {
              contracts.delete(ref)
            }
          }
        }
      }
      /** 全角色关闭仍逐项回收全部原 epoch，即使一项失败也不跳过其它 owner。 */
      function closeRemoteEpochs(): void {
        let failed = false
        for (const name of remoteEpochs.keys()) {
          try {
            fenceNativeProvider(providers.get(name)!.binding)
          } catch {
            failed = true
            sessionCleanupFailed = true
          }
        }
        if (failed) {
          fail('runtime_session_close_failed')
        }
      }
      /** 已失效来源永不复查为 ready；独立来源 getter 的失败只收紧对应 provider。 */
      function providerReady(provider: RuntimeProviderBinding): boolean {
        if (fencedNative.has(key(provider.binding))) {
          return false
        }
        try {
          return provider.ready() === true
        } catch (error) {
          if (isolated) {
            return false
          }
          throw error
        }
      }
      /** 每个来源操作都回到当前 SocketChannel 与唯一 Store，不信任帧中的 authenticated 标志。 */
      function assertRemoteCurrent(provider: RemoteLuvusRuntimeProvider): void {
        if (
          closing ||
          boundedJson(channel.connection()) !== boundedJson(connection) ||
          !localProvider(provider.target)
        ) {
          fail('remote_luvus_epoch_unavailable')
        }
        store.assertConnection(connection)
        if (
          closing ||
          boundedJson(channel.connection()) !== boundedJson(connection) ||
          !localProvider(provider.target)
        ) {
          fail('remote_luvus_epoch_unavailable')
        }
      }
      /** 只接纳本 socket 所属机器的固定 pin；schema/opaque 由 Gateway 本地工厂创建，消息不能注册 provider。 */
      function acceptProviderSnapshot(snapshot: ProviderSnapshot): void {
        const name = key(snapshot.target)
        const configured = providers.get(name)
        if (
          fencedNative.has(name) ||
          !configured ||
          snapshot.target.machine_id !== connection.machine_id ||
          boundedJson(configured.binding) !== boundedJson(snapshot.binding) ||
          boundedJson(configured.target) !== boundedJson(snapshot.target) ||
          !localProvider(snapshot.target)
        ) {
          fail('provider_binding_mismatch')
        }
        const remote = remoteEpochs.get(name)
        if (!remote) {
          fail('remote_luvus_binding_mismatch')
        }
        const live = remote.epoch.accept(snapshot)
        const ref = contractRef(live.contract.wire.source)
        const previous = contracts.get(ref)
        if (
          previous &&
          boundedJson({
            wire: previous.wire,
            identity: previous.compiled.identity,
            capabilities: previous.capabilities,
            revision: previous.capability_revision
          }) !==
            boundedJson({
              wire: live.contract.wire,
              identity: live.contract.compiled.identity,
              capabilities: live.contract.capabilities,
              revision: live.contract.capability_revision
            })
        ) {
          fail('runtime_provider_conflict')
        }
        assertRemoteCurrent(remoteProviders.get(name)!)
        contracts.set(ref, live.contract)
        nativeProviders.set(name, live)
        remote.live = live
      }
      const backendServices: Omit<Parameters<typeof createDeviceLifecycleAdapter>[2], 'connection'> = {
        localProvider,
        /** 仅查受保护契约注册表中的固定来源。 */
        contract: (ref) => contracts.get(ref),
        nativeSource: /** 只从原账本取 attempt，再排除本 epoch 已永久失效的来源。 */ (call, attempt) =>
          source(call, attempt, fencedNative),
        /** 分类权限从固定 provider 的独立宿主读取，普通请求不能提升 Owner/custody。 */
        validateAttempt(attempt, binding) {
          const provider = nativeProviders.get(key(attempt.binding.target))
          if (!provider) {
            fail('provider_binding_unavailable')
          }
          if (provider.catalog_methods && !provider.catalog_methods.includes(attempt.method)) {
            throw new GatewayError('forbidden')
          }
          provider.validateAttempt?.(attempt, binding)
          if (closing) {
            throw new GatewayError('runtime_closed')
          }
        },
        currentPrincipal: services.currentPrincipal
      }
      let owned: Session | undefined
      try {
        for (const [name, provider] of remoteProviders) {
          if (provider.binding.machine_id === connection.machine_id) {
            const epoch = provider.open(
              connection,
              /** 真实通道、canonical binding 与当前 epoch 逐次复验。 */ () => assertRemoteCurrent(provider)
            )
            remoteEpochs.set(name, { epoch })
          }
        }
        const parts: ProviderSessionGroup[] = []
        let composed = false
        try {
          const nativeEntries = [...providers.values()].filter(
            /** 原生与远端Luvus保持同一个原注册表和原adapter。 */ (provider) =>
              provider.binding.machine_id === connection.machine_id
          )
          {
            const scopes =
              isolated && nativeEntries.length
                ? nativeEntries.map(/** 每个原 provider 独立持有同一真实后端的 Wire 状态。 */ (provider) => [provider])
                : [nativeEntries]
            for (const entries of scopes) {
              parts.push({
                providers: entries,
                session: {
                  ...createDeviceLifecycleAdapter(options.lifecycle, channel, backendServices),
                  /** 仅投影此原实例的健康，不改变其 canonical binding 或权限。 */ readiness() {
                    const state = nativeReadiness(entries)
                    return {
                      ...state,
                      providers: state.providers.filter(
                        /** 独立 adapter 只报告其原实例。 */ (provider) =>
                          entries.some(
                            /** 按同机器唯一 provider ID 匹配，不拼接 tuple。 */ (entry) =>
                              entry.binding.provider_id === provider.local.provider_id
                          )
                      )
                    }
                  },
                  /** 仍由原远端 pin/epoch 接纳实际快照。 */ acceptProviderSnapshot(snapshot) {
                    if (
                      !entries.some(
                        /** 不允许跨原实例导入来源。 */ (entry) =>
                          entry.binding.provider_id === snapshot.binding.provider_id
                      )
                    ) {
                      fail('provider_binding_mismatch')
                    }
                    acceptProviderSnapshot(snapshot)
                  },
                  /** 只撤去此原实例来源；原 Wire 的许可由 transport 关闭。 */ close() {
                    if (isolated) {
                      for (const entry of entries) {
                        fenceNativeProvider(entry.binding)
                      }
                    }
                  }
                }
              })
            }
          }
          if (!parts.length) {
            fail('runtime_session_unavailable')
          }
          if (parts.length === 1 && (!isolated || !parts[0]!.providers.length)) {
            owned = parts[0]!.session
          } else {
            composed = true
            owned = composeGatewaySessions(
              connection,
              parts,
              /** 使用唯一Store的可信单调时间，不引入独立业务时钟。 */ () => store.clock()
            )
          }
        } catch (error) {
          for (const part of composed ? [] : parts.reverse()) {
            try {
              closeSession(part.session)
            } catch {
              /* 每个已交付owner都必须尝试关闭。 */
            }
          }
          throw error
        }
        /** Luvus原组只报告自己的来源，不递归读取组合会话或借用Herdr就绪。 */
        function nativeReadiness(entries: readonly RuntimeProviderBinding[]): Readiness {
          return {
            providers: entries.map(
              /** 原Luvus就绪逐项核对canonical配置和当前政策。 */ (provider) => ({
                expected: store.provider(provider.binding.machine_id, provider.binding.provider_id) ?? provider.binding,
                local: provider.binding,
                native_ready: providerReady(provider) && !closing && !!localProvider(provider.target) && !closing
              })
            )
          }
        }
        return {
          ...owned!,
          close() {
            try {
              owned!.close()
            } finally {
              closeRemoteEpochs()
            }
          }
        }
      } catch (error) {
        try {
          closeSession(owned)
        } finally {
          closeRemoteEpochs()
        }
        throw error
      }
    }
  }
  return {
    group,
    nativeProviders,
    remoteProviders,
    isClosed() {
      return closing
    },
    close() {
      closing = true
      if (sessionCleanupFailed) {
        fail('runtime_session_close_failed')
      }
    }
  }
}

/** 静态 Luvus 接线；两种 provider 共用公共 Gateway 宿主。 */
export async function createGatewayRuntime(options: GatewayRuntimeOptions) {
  let prepared: ReturnType<typeof prepareLuvusGateway>
  try {
    prepared = prepareLuvusGateway(options)
  } catch (error) {
    await options.release()
    throw error
  }
  const { group, nativeProviders, remoteProviders } = prepared
  const runtime = await createProviderGatewayRuntime({
    ...options,
    providers: group.providers,
    session: group.session,
    provider_snapshot_machines: [
      ...new Set([...remoteProviders.values()].map((provider) => provider.binding.machine_id))
    ],
    async release() {
      try {
        prepared.close()
      } finally {
        await options.release()
      }
    }
  })
  const { store, principal } = runtime
  const active = runtime.transport
  const key = (target: V2Target) => target.machine_id + '/' + target.provider_id
  const localProvider = (target: V2Target) => {
    const expected = group.providers.find((provider) => boundedJson(provider.target) === boundedJson(target))?.binding
    const current = store.provider(target.machine_id, target.provider_id)
    return expected && current && boundedJson(expected) === boundedJson(current) ? current : undefined
  }
  const catalog: RuntimeCatalogProvider = Object.freeze({
    /** 目录复用唯一 Store 与当前实际认证 epoch；Owner 无 token 到期，实例/连接寿命逐次复核。 */
    resolve(target, requesting) {
      const provider = nativeProviders.get(key(target))
      const binding = localProvider(target)
      const connection = active.currentConnection(target.machine_id)
      if (!provider?.catalogSource || !binding?.enabled || !connection) {
        return undefined
      }
      if (boundedJson(principal()) !== boundedJson(requesting)) {
        fail('principal_changed')
      }
      const native = provider.catalogSource(connection)
      store.assertConnection(connection)
      if (
        boundedJson(principal()) !== boundedJson(requesting) ||
        boundedJson(active.currentConnection(target.machine_id) ?? null) !== boundedJson(connection) ||
        boundedJson(localProvider(target) ?? null) !== boundedJson(binding) ||
        prepared.isClosed()
      ) {
        fail('runtime_catalog_unavailable')
      }
      return Object.freeze({
        record: provider.contract,
        source: native,
        local_provider: binding,
        // 该字段满足既有目录有限整数格式；它不建立委托寿命，真实 Owner/epoch 失效即拒绝。
        expires_at: Number.MAX_SAFE_INTEGER,
        ...(provider.catalog_methods ? { supported_methods: provider.catalog_methods } : {})
      })
    }
  })
  return Object.freeze({ ...runtime, catalog })
}
