// 唯一产品入口按固定role/ref加载真实资源；JSON不能重建opaque native来源或执行任意模块。
import { privateDirectory } from './first-config.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openGatewayState, createManagementSessionAuthority } from '../runtime/index.js'
import {
  createManagementSessionPersistence,
  MANAGEMENT_SESSIONS_MAX_BYTES
} from '../runtime/management-session-store.js'
import { composeConnectorSessions } from '../runtime/provider-sessions.js'
import type {
  GatewayRuntimeOptions,
  ProviderGatewayRuntimeOptions,
  ManagementSessionAuthority
} from '../runtime/index.js'
import type { VersionOffer } from '../wire/types.js'
import type { GatewayIdentitySource } from '../mcp/management.js'
import type { ManagementWriteHttpOptions } from '../admin/index.js'
import { loadCredential } from '../transport/index.js'
import { GatewayError } from '../contracts.js'
import { CliError, selectedNativeProviders, type ConnectorConfig, type GatewayConfig } from './config.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'
import { openCallerSource } from './caller-source.js'
import { REGISTRY_MAX_BYTES } from './token-registry.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { createRuntimeCliRuntime } from './runtime.js'
import { SimplePairingHttp, PairingReplayCache } from './simple-pairing.js'
import type { CliSetup } from './setup-runtime.js'
import { boundedJson, object, fields, WIRE_MAJOR, WIRE_MINOR } from '../wire/index.js'
import { readRuntimeConfig } from './runtime-config.js'
import { migrateSetupLuvusGrant } from './setup-luvus-grant.js'
import { canonicalLoopbackHost } from '../mcp/listen.js'
import { createManagementResources } from './management-resources.js'
import { loadProductManagementAssets } from './management-assets.js'
import { openProtectedManagementSource } from './management-source.js'
import {
  createManagementPageInitializer,
  MANAGEMENT_COOKIE_NAME,
  type ManagementPageLeaseSource
} from './management-page.js'
import type {
  RuntimeCliGatewayResources,
  RuntimeCliGateway,
  RuntimeCliManagement,
  RuntimeCliConnectorResources,
  RuntimeCliProviderResources
} from './runtime.js'

export type ProductionProviderReference = Readonly<{ reference: string; value: unknown }>
export type ProductionGatewayManagement = Omit<RuntimeCliManagement, 'session' | 'http'> & {
  http?: Pick<ManagementWriteHttpOptions, 'assets' | 'publicError'>
}
export type ProductionManagementHost = ProductionGatewayManagement & {
  // 必须验证这一个Request的既有受保护管理员会话；null交付无秘密的只读页面。
  resolveLease: ManagementPageLeaseSource
  bootstrap_challenge?: 'basic'
}
type ProductionGatewayCommon = Pick<RuntimeCliGatewayResources, 'catalog'> & {
  management?: ProductionGatewayManagement
  started?(gateway: RuntimeCliGateway): void
  release(): Promise<void>
}
export type ProductionGatewayResources = ProductionGatewayCommon &
  (
    | { kind?: 'luvus'; providers: GatewayRuntimeOptions['providers'] }
    | {
        kind: 'mixed'
        providers: GatewayRuntimeOptions['providers']
        hosted: NonNullable<GatewayRuntimeOptions['hosted']>
      }
    | {
        kind: 'provider'
        providers: ProviderGatewayRuntimeOptions['providers']
        session: ProviderGatewayRuntimeOptions['session']
      }
  )
export type ProductionConnectorResources =
  | Omit<RuntimeCliConnectorResources, 'transport'>
  | Omit<RuntimeCliProviderResources, 'transport'>
export type ProductionCliSources = {
  // 现有管理员仍须独立交付；默认值明确拒绝，不从MCP token升级。
  administrator?: GatewayIdentitySource['administrator']
  // 只允许静态受信宿主注入，不接入argv、URL或JSON配置。
  management?: ProductionManagementHost
  gateway?(
    config: GatewayConfig,
    references: readonly ProductionProviderReference[],
    authority: ManagementSessionAuthority
  ): Promise<ProductionGatewayResources>
  connector?(
    config: ConnectorConfig,
    references: readonly ProductionProviderReference[]
  ): Promise<ProductionConnectorResources>
}

// 只组合已有Wire协商声明。
export function productionOffer(): VersionOffer {
  return {
    major: WIRE_MAJOR,
    // 跟随当前实现支持的 minor：写死旧值会让较新能力（如 device_platform）永远协商不到。
    minor: WIRE_MINOR,
    capabilities: ['rpc', 'provider_fence', 'terminal_execution_state', 'dispatch_refusal', 'device_platform'],
    required: ['rpc']
  }
}

// 未配对的本地Gateway可以真实监听，但不授予任何MCP身份、管理员或原生权限。
function unpairedCaller() {
  return {
    setupRequired: true,
    identities: {
      principal: /* 未配对没有caller身份。 */ () => null,
      administrator: /* 未配对没有管理员。 */ () => null
    } as GatewayIdentitySource,
    authentication: { authenticate: /* 拒绝全部未建立的Bearer身份。 */ () => null },
    localPolicies: /* 没有设备或原生授权。 */ () => ({ revision: 'unpaired', grants: [] }),
    /* 无外部身份源需要释放。 */
    close() {}
  }
}

// 身份状态缺失表示首次待配对；损坏或权限错误仍拒绝，不采用默认账号或测试凭据兑底。
// 配对前的管理员签发会在运行中创建调用方注册表：未配对状态每次身份/认证读取都重新探测，文件出现即热切换。
function bootstrappingCaller(config: GatewayConfig, administrator?: GatewayIdentitySource['administrator']) {
  const path = runtimeReference(config.state_dir, 'mcp-callers')
  const probe = (): boolean => {
    try {
      readRuntimeJson(path, REGISTRY_MAX_BYTES)
      return true
    } catch (error) {
      if (error instanceof CliError && error.code === 'backend_unavailable') {
        return false
      }
      throw error
    }
  }
  let current: ReturnType<typeof managedCaller> = probe() ? managedCaller(config, administrator) : unpairedCaller()
  const promote = (): void => {
    if (!current.setupRequired || !probe()) {
      return
    }
    const next = managedCaller(config, administrator)
    const previous = current
    current = next
    previous.close()
  }
  return {
    get setupRequired() {
      promote()
      return current.setupRequired
    },
    identities: {
      principal: (who: Parameters<GatewayIdentitySource['principal']>[0]) => {
        promote()
        return current.identities.principal(who)
      },
      administrator: (who: Parameters<GatewayIdentitySource['administrator']>[0], ref: string) => {
        promote()
        return current.identities.administrator(who, ref)
      }
    } as GatewayIdentitySource,
    authentication: {
      authenticate: async (request: Request, signal: AbortSignal) => {
        promote()
        return current.authentication.authenticate(request, signal)
      }
    },
    localPolicies: () => {
      promote()
      return current.localPolicies()
    },
    close() {
      current.close()
    }
  }
}

// 身份状态缺失表示首次待配对；损坏或权限错误仍拒绝，不采用默认账号或测试凭据兜底。
function managedCaller(config: GatewayConfig, administrator?: GatewayIdentitySource['administrator']) {
  const path = runtimeReference(config.state_dir, 'mcp-callers')
  try {
    readRuntimeJson(path, REGISTRY_MAX_BYTES)
  } catch (error) {
    if (error instanceof CliError && error.code === 'backend_unavailable') {
      return unpairedCaller()
    }
    throw error
  }
  // 本机 caller 的资源地址用规范回环地址，不写通配绑定地址。
  const hostname = canonicalLoopbackHost(config.mcp_hostname)
  return {
    ...openCallerSource(path, new URL(`http://${hostname}:${config.mcp_port}/mcp`).href, administrator),
    setupRequired: false
  }
}

// 默认Gateway打开真实双库并可等待首次配对；程序管理的provider仍由固定工厂核验。
export function createProductionCliRuntime(sources: ProductionCliSources = {}, setup?: CliSetup) {
  const pairingReplays = new PairingReplayCache()
  const runtime = createRuntimeCliRuntime({
    gateway: /* 常规启动只打开已配置资源，不注册设备、签发enrollment/token或bootstrap管理cookie。 */ async (config) => {
      privateDirectory(config.state_dir)
      privateDirectory(join(config.state_dir, 'managed'))
      // 会话绑定与管理员记录分开放置：前者只含摘要，后者含凭据摘要与租期。
      const sessionStorePath = runtimeReference(config.state_dir, 'management-sessions')
      const settings = readRuntimeConfig(config)
      if (settings.provider_config_refs.length && !sources.gateway) {
        throw new CliError('backend_unavailable', 3)
      }
      if (sources.management && typeof sources.administrator !== 'function') {
        throw new CliError('backend_unavailable', 3)
      }
      let protectedManagement: ReturnType<typeof openProtectedManagementSource> | undefined
      const caller = bootstrappingCaller(
        config,
        /* 逐次询问原独立管理来源，不从MCP提升权限。 */ (who, session) =>
          protectedManagement?.administrator(who, session) ?? sources.administrator?.(who, session) ?? null
      )

      let authority: ManagementSessionAuthority
      try {
        if (config.management_enabled && !sources.management) {
          // 没有管理员文件时也启用受保护模式（零个管理员，登录前一律 401），rovloom admin create 之后无需重启。
          protectedManagement = openProtectedManagementSource(config, 'management', { allowMissing: true })
          if (protectedManagement.management.port !== config.management_port) {
            throw new CliError('invalid_config')
          }
        }
        authority = createManagementSessionAuthority(caller.identities, {
          // 管理会话的 cookie 摘要绑定落盘：配对触发的重载与进程重启后，已登录浏览器不必重输密码。
          persist: createManagementSessionPersistence({
            // 每个管理员最多并存 8 条绑定，合法文档会超过默认 16 KiB；读写统一使用会话文件的预算，
            // 否则超限写入被 save() 吞掉，重启后只能恢复前一部分绑定。
            read: () => readSetupJson(sessionStorePath, MANAGEMENT_SESSIONS_MAX_BYTES),
            // 存在性与内容解析必须分开判断：文件损坏时 readSetupJson 会抛错，
            // 若用它决定是否覆盖，损坏文件将永久阻止后续写入，每次重启都会掉线。
            write: (value) =>
              writeSetupJson(sessionStorePath, value, existsSync(sessionStorePath), MANAGEMENT_SESSIONS_MAX_BYTES)
          })
        })
        protectedManagement?.bindAuthority(authority)
      } catch (error) {
        protectedManagement?.close()
        caller.close()
        throw error
      }
      let provider: ProductionGatewayResources | undefined
      let state: ReturnType<typeof openGatewayState> | undefined
      // 单码直连配对面：state 打开后立即建立；Store 受保护写端口的授权回调经此转发。
      let simple: SimplePairingHttp | undefined
      // 配对发布落盘后唤醒本轮重开；每个 Gateway 化身各自一份，未配对时永不兑现。
      let resolveActivation: (() => void) | undefined
      const activationReload = new Promise<void>((resolve) => {
        resolveActivation = resolve
      })
      let closing: Promise<void> | undefined
      const release = /* 关闭所有交付者并最终回收同一双库；不因某个provider释放失败遗留writer。 */ () => {
        closing ??= Promise.resolve().then(
          /* shutdown始终撤去会话和caller来源，外部provider仍须报告其真实物理释放结果。 */ async () => {
            try {
              try {
                await simple?.close()
              } finally {
                await provider?.release()
              }
            } finally {
              authority.close()
              protectedManagement?.close()
              caller.close()
              state?.close()
            }
          }
        )
        return closing
      }
      try {
        provider = await sources.gateway?.(config, settings.providers.map(migrateSetupLuvusGrant), authority)
        if (sources.gateway && !provider) {
          throw new CliError('invalid_config')
        }
        // 核对所有原条目，但不把中性provider放入Luvus原生注册表或丢弃其session。
        const declared = provider
          ? [
              ...provider.providers,
              ...(provider.kind === 'mixed'
                ? provider.hosted.flatMap(
                    /** 仅收集原宿主的完整条目供引用校验，运行时仍保留明确分组。 */ (group) => group.providers
                  )
                : [])
            ]
          : []
        if (
          provider &&
          (declared.length !== settings.provider_config_refs.length ||
            new Set(declared.map(/* 每个配置引用只能由其自身来源履行一次。 */ (entry) => entry.binding.config_ref))
              .size !== settings.provider_config_refs.length ||
            declared.some(
              /* 实际来源仍须逐个属于配置选择，受信resolver也不能附带未声明provider。 */ (entry) =>
                !settings.provider_config_refs.includes(entry.binding.config_ref)
            ))
        ) {
          throw new CliError('invalid_config')
        }
        let gateway: RuntimeCliGateway | undefined
        state = openGatewayState({
          state_directory: config.state_dir,
          store: {
            // 受保护写端口只认 SimplePairingHttp 登记过的一次性许可（provider 首次定义）。
            management: (request) => {
              if (!simple) {
                throw new GatewayError('management_authorization_required')
              }
              return simple.authorizeManagement(request)
            }
          },
          changed: /* 只在身份提交后断开同一runtime的设备通道，正常启动不调用它。 */ (machine) => {
            if (!gateway) {
              throw new CliError('backend_unavailable', 3)
            }
            gateway.transport.disconnect(machine)
          }
        })
        simple = new SimplePairingHttp(
          state,
          config,
          /* 发布落盘后重开以加载新 provider 与 caller 来源。 */ () => resolveActivation?.(),
          pairingReplays
        )
        protectedManagement?.bindResources(
          /* 管理员授权按 Store 当前设备/provider 生成。 */ () => state!.store.resources()
        )
        const anonymousManagement: ProductionManagementHost | undefined =
          config.management_enabled && !protectedManagement && !sources.management
            ? {
                port: config.management_port,
                resolveLease: /* 匿名页面不创建管理员会话。 */ async () => null,
                http: { assets: loadProductManagementAssets() }
              }
            : undefined
        const configuredManagement = protectedManagement?.management ?? sources.management ?? anonymousManagement
        if (configuredManagement && provider?.management) {
          throw new CliError('invalid_config')
        }
        const managementHost = configuredManagement ?? provider?.management
        const management = managementHost
          ? {
              port: managementHost.port,
              hostname: config.management_hostname,
              listening: managementHost.listening?.bind(managementHost),
              pairingPolicy: managementHost.pairingPolicy?.bind(managementHost),
              providerEnable: managementHost.providerEnable?.bind(managementHost),
              http: {
                resources: protectedManagement
                  ? createManagementResources({
                      config,
                      store: state.store,
                      authorize: (identity) =>
                        protectedManagement!.isFullAdministrator(identity.caller, identity.management_session_ref),
                      disconnect: (machine) => gateway?.transport.disconnect(machine),
                      codes: simple.codes
                    })
                  : undefined,
                assets: managementHost.http?.assets,
                publicError: managementHost.http?.publicError?.bind(managementHost.http),
                initializePage: configuredManagement
                  ? createManagementPageInitializer(
                      authority,
                      configuredManagement.resolveLease.bind(configuredManagement),
                      {
                        challenge: () => configuredManagement.bootstrap_challenge
                      }
                    )
                  : undefined
              },
              session: { sessions: authority.sessions, cookie_name: MANAGEMENT_COOKIE_NAME, authority }
            }
          : undefined
        const pairingHttp = simple
        const options = {
          lifecycle: state.lifecycle,
          channels: state.channels,
          identities: authority.identities,
          localPolicies: caller.localPolicies,
          listener: {
            hostname: settings.device_listener.hostname,
            port: settings.device_listener.port,
            offer: productionOffer(),
            setupRequest:
              /* 固定同一设备listener的专用配对handler，不替换WebSocket认证；已配对网关也保持可用以加入新设备。 */ (
                request: Request
              ) => pairingHttp.handle(request)
          },
          release
        }
        const common = {
          setupRequired: caller.setupRequired,
          reconfigure: activationReload,
          listening: /* 真实MCP地址公布后按需签发一机一码（--issue-code）并打印完整加入命令。 */ async () => {
            await setup?.gatewayListening(async () => {
              const issued = pairingHttp.codes.create()
              const base = gateway!.transport.url.replace(/\/connector$/, '')
              return base + '#' + issued.code
            })
          },
          authentication: caller.authentication,
          catalog: provider?.catalog,
          management,
          started: /* 绑定唯一已建立runtime，不在配置中记录端口对象或派发许可。 */ (active: RuntimeCliGateway) => {
            gateway = active
            provider?.started?.(active)
          }
        }
        if (provider?.kind === 'provider') {
          return {
            ...common,
            kind: 'provider' as const,
            options: { ...options, providers: provider.providers, session: provider.session.bind(provider) }
          }
        }
        return {
          ...common,
          options: {
            ...options,
            providers: provider?.providers ?? [],
            ...(provider?.kind === 'mixed' ? { hosted: provider.hosted } : {})
          }
        }
      } catch (error) {
        await release()
        throw error
      }
    },
    connector: /* 只把程序保管的设备凭据接到真实session所有者；缺provider实现绝不创建心跳stub。 */ async (config) => {
      privateDirectory(config.state_dir)
      privateDirectory(join(config.state_dir, 'managed'))
      const settings = readRuntimeConfig(config)
      if (!sources.connector) {
        throw new CliError('backend_unavailable', 3)
      }
      if (!config.gateway_url || settings.providers.length === 0) {
        throw new CliError('configuration_required')
      }
      const path = runtimeReference(config.state_dir, settings.credential_ref)
      const credential = /* 启动和每次认证均读取同一既有凭据，固定错误不反射路径或秘密。 */ () => {
        try {
          return loadCredential(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new CliError('configuration_required')
          }
          throw new CliError('backend_unavailable', 3)
        }
      }
      // 先验证静态认证输入，缺失或非法时不得启动provider所属的native child。
      credential()
      const control = join(config.state_dir, 'control')
      const managedRoot = join(control, 'luvus-root.json')
      const isolated = settings.providers.some(
        /* 只对首次引导的固定控制记录选择独立账本目录，native仍由既有root工厂逐项复验。 */ (entry) =>
          !!entry.value &&
          typeof entry.value === 'object' &&
          'native' in entry.value &&
          !!entry.value.native &&
          typeof entry.value.native === 'object' &&
          (('root_record' in entry.value.native && entry.value.native.root_record === managedRoot) ||
            // 用户自己的 Luvus 没有 Connector 拥有的 root，但同样把 claim 账本放在控制目录。
            ('mode' in entry.value.native && entry.value.native.mode === 'user'))
      )
      const pairing = readSetupJson(runtimeReference(config.state_dir, 'pairing'))
      if (isolated || pairing !== undefined) {
        const paired = object(pairing)
        fields(paired, ['schema_version', 'attempt_id', 'machine_id', 'gateway_url', 'phase'])
        const device = credential()
        // 已保管的设备secret不得因修改业务URL发送给另一origin；安装设置变更也不能静默忽略或重建root。
        if (
          paired.schema_version !== 1 ||
          paired.phase !== 'configured' ||
          paired.gateway_url !== config.gateway_url ||
          paired.machine_id !== device.machine_id
        ) {
          throw new CliError('configuration_required')
        }
        const kinds = selectedNativeProviders(config)
        if (
          settings.providers.length !== kinds.length ||
          kinds.some(
            /* 选择变化应先给明确待配置错误，不读取另一种来源的不存在journal。 */ (kind) =>
              !settings.providers.some(
                /* 每个kind恰有原准备条目；重复或缺失不得按相同总数通过。 */ (entry) =>
                  object(entry.value).kind === kind
              )
          )
        ) {
          throw new CliError('configuration_required')
        }
        for (const kind of kinds) {
          const prepared = object(
            readRuntimeJson(
              runtimeReference(config.state_dir, kind === 'luvus' ? 'native-setup' : 'herdr-setup'),
              1_048_576
            )
          )
          fields(prepared, [
            'schema_version',
            'attempt_id',
            'machine_id',
            'phase',
            'settings',
            'reference',
            'local',
            'remote'
          ])
          const entry = settings.providers.find(
            /* 每个准备记录必须对应当前registry的原条目，不能只比较相同条目总数。 */ (value) =>
              value.reference === prepared.reference
          )
          if (
            prepared.schema_version !== 1 ||
            prepared.phase !== 'prepared' ||
            prepared.attempt_id !== paired.attempt_id ||
            prepared.machine_id !== paired.machine_id ||
            boundedJson(prepared.settings) !== boundedJson(config.native ?? {}) ||
            !entry ||
            object(entry.value).kind !== kind ||
            boundedJson(entry.value, 1_048_576) !== boundedJson(prepared.local, 1_048_576)
          ) {
            throw new CliError('configuration_required')
          }
        }
      }
      let resource: ProductionConnectorResources
      try {
        resource = await sources.connector(isolated ? { ...config, state_dir: control } : config, settings.providers)
      } catch (error) {
        try {
          setup?.nativeFailed(error)
        } catch {
          // TTY取消、权限或输出故障只影响补充诊断，不能替换原工厂失败及其未完成清理owner。
        }
        throw error
      }
      try {
        // 资源准备可能跨异步边界；期间撤去凭据也必须立即释放本次资源并退出。
        credential()
        const transport = {
          credential,
          offer: productionOffer()
        }
        if (resource.kind === 'provider') {
          return {
            kind: 'provider' as const,
            transport,
            /** 混合资源已持有原组合；单一 provider 仍用同一原 owner 包装隔离生命周期。 */
            session(connection) {
              const current = resource.session(connection)
              if (
                current.fenceProvider ||
                !resource.providers?.length ||
                !connection.negotiated.capabilities.includes('provider_fence')
              ) {
                return current
              }
              return composeConnectorSessions(
                connection,
                [{ providers: resource.providers, session: current }],
                Date.now
              )
            },
            release: resource.release.bind(resource),
            release_timeout_ms: resource.release_timeout_ms,
            provider_snapshot: resource.provider_snapshot,
            ...(resource.session_replaced ? { session_replaced: resource.session_replaced.bind(resource) } : {})
          }
        }
        return {
          transport,
          ...(resource.provider_snapshot === true ? { provider_snapshot: true as const } : {}),
          session: resource.session.bind(resource),
          release: resource.release.bind(resource),
          ...(resource.session_replaced ? { session_replaced: resource.session_replaced.bind(resource) } : {})
        }
      } catch (error) {
        await resource.release()
        throw error
      }
    }
  })
  if (setup) {
    runtime.prepare = setup.prepare.bind(setup)
  }
  return runtime
}
