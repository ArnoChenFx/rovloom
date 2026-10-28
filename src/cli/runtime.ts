// 唯一CLI组合实际角色工厂；受保护身份、策略、凭据和native来源由宿主解析，不从argv补造。
import { createGatewayRuntime, createProviderGatewayRuntime } from '../runtime/gateway.js'
import { createConnectorRuntime } from '../runtime/connector.js'
import { createProviderConnectorRuntime } from '../runtime/connector-host.js'
import type { GatewayRuntimeOptions, ProviderGatewayRuntimeOptions, ConnectorRuntimeOptions } from '../runtime/types.js'
import type { ConnectorHostOptions } from '../runtime/connector-host.js'
import type { ManagementSessionAuthority } from '../runtime/management-session.js'
import { scopeManagementService } from './management-scope.js'
import { RuntimeGatewayService } from '../mcp/runtime-service.js'
import type { ProviderSessionGroup } from '../runtime/provider-sessions.js'
import type { GatewayCatalog } from '../mcp/catalog.js'
import { luvusCatalogProvider } from '../connector/luvus/catalog-provider.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import {
  StoreManagementWriteService,
  createManagementHandler,
  createManagementSessionAdapter,
  startManagementListener,
  type ManagementWriteOptions,
  type ManagementWriteHttpOptions,
  type ManagementSessionSource
} from '../admin/index.js'
import type { ConnectorConfig, GatewayConfig } from './config.js'
import type { CliRuntime, CliServiceHost } from './run.js'

export type RuntimeCliManagement = Pick<ManagementWriteOptions, 'pairingPolicy' | 'providerEnable'> & {
  port: number
  // 绑定地址缺省回环；通配只用于容器等隔离环境，通知的仍是规范回环地址。
  hostname?: '127.0.0.1' | '0.0.0.0'
  // 只通知实际回环地址，不建立管理员身份、CSRF证明或执行许可。
  listening?(url: string): void
} & (
    | {
        // 直接消费现有受保护会话源；同一identities和实际Origin由唯一组合点绑定。
        session: { sessions: ManagementSessionSource; cookie_name: string; authority?: ManagementSessionAuthority }
        http?: Omit<ManagementWriteHttpOptions, 'service' | 'origin' | 'authenticate' | 'verifyCsrf'>
      }
    | {
        session?: never
        http: Omit<ManagementWriteHttpOptions, 'service' | 'origin'>
      }
  )
export type RuntimeCliGateway =
  | Awaited<ReturnType<typeof createGatewayRuntime>>
  | Awaited<ReturnType<typeof createProviderGatewayRuntime>>
type GatewayResources = {
  setupRequired?: boolean
  authentication: HttpAuthenticationProvider
  catalog?: GatewayCatalog
  management?: RuntimeCliManagement
  reconfigure?: Promise<void>
  listening?(url: string): void | Promise<void>
  // 资源所有者在唯一工厂建立后绑定已提交身份变更通知，不能创建第二个Gateway。
  started?(gateway: RuntimeCliGateway): void
}
export type RuntimeCliGatewayResources = GatewayResources &
  ({ kind?: 'luvus'; options: GatewayRuntimeOptions } | { kind: 'provider'; options: ProviderGatewayRuntimeOptions })
export type RuntimeCliConnectorResources = Omit<ConnectorRuntimeOptions, 'transport'> & {
  kind?: 'luvus'
  transport: Omit<ConnectorRuntimeOptions['transport'], 'url'>
}
export type RuntimeCliProviderResources = Omit<ConnectorHostOptions, 'transport'> & {
  kind: 'provider'
  providers?: ProviderSessionGroup['providers']
  transport: Omit<ConnectorHostOptions['transport'], 'url'>
  // 来源被后台替换时结束当前连接周期（见 HerdrConnectorResources.session_replaced）。
  session_replaced?(listener: () => void): () => void
}
export type RuntimeCliHost = {
  gateway?(config: GatewayConfig): Promise<RuntimeCliGatewayResources>
  connector?(config: ConnectorConfig): Promise<RuntimeCliConnectorResources | RuntimeCliProviderResources>
  service?: CliServiceHost
}

// 只把可信资源交给已存在的角色工厂；Gateway监听设备通道，MCP listener继续由runCli唯一持有。
export function createRuntimeCliRuntime(host: RuntimeCliHost): CliRuntime {
  const runtime: CliRuntime = { service: host.service }
  if (host.gateway) {
    runtime.gateway = /* 先建立唯一常驻宿主，再装配MCP及独立管理面；失败时释放已交付资源。 */ async (config) => {
      const resource = await host.gateway!(config)
      const managementOptions = resource.management ? { ...resource.management } : undefined
      const gateway =
        resource.kind === 'provider'
          ? await createProviderGatewayRuntime(resource.options)
          : await createGatewayRuntime(resource.options)
      let service: RuntimeGatewayService | undefined
      let management: ReturnType<typeof startManagementListener> | undefined
      let closing: Promise<void> | undefined
      const close = /* MCP由调用者先停；随后关闭管理listener、清理游标，最后释放设备通道及唯一writer。 */ () => {
        // 先同步封锁新MCP请求，不能在异步释放管理面/角色资源期间继续准入。
        service?.close()
        closing ??= Promise.resolve().then(
          /* 无论管理关闭是否失败，都必须回收真实Gateway资源。 */ async () => {
            try {
              management?.stop()
            } finally {
              await gateway.close()
            }
          }
        )
        return closing
      }
      try {
        resource.started?.(gateway)
        service = new RuntimeGatewayService({
          runtime: gateway,
          identities: resource.options.identities,
          catalog:
            resource.catalog ??
            /** 原生 Luvus 目录走同一 provider 端口，公共分页与门禁在 MCP 层统一处理。 */
            (gateway.catalog
              ? luvusCatalogProvider({
                  store: gateway.store,
                  provider: gateway.catalog
                })
              : undefined),
          // 管理页的连接、认证与 provider 就绪来自同一个实际传输的只读观测。
          transportObservations: gateway.transport.observations,
          managementCapabilities: managementOptions
            ? /* 只观察已装配端口及当前持久状态，不在提示读取时执行启用证明或确认。 */ (target) => {
                const capabilities = ['devices_rename', 'devices_disconnect', 'devices_revoke'] as const
                const provider = target.provider_id
                  ? gateway.store.provider(target.machine_id, target.provider_id)
                  : undefined
                return provider && (provider.enabled || typeof managementOptions.providerEnable === 'function')
                  ? [...capabilities, 'providers_manage']
                  : capabilities
              }
            : undefined
        })
        if (managementOptions) {
          const options = managementOptions
          const writes = new StoreManagementWriteService({
            store: gateway.store,
            identities: resource.options.identities,
            reads: service.management,
            transport: gateway.transport,
            pairingPolicy: options.pairingPolicy,
            providerEnable: options.providerEnable
          })
          management = startManagementListener({
            port: options.port,
            hostname: options.hostname,
            maxRequestBodySize: 16_384,
            handler: /* 同一listener挂现行读写handler，不复制管理协议或创建默认session。 */ (origin) => {
              const authentication = options.session
                ? createManagementSessionAdapter({
                    ...options.session,
                    identities: resource.options.identities,
                    origin
                  })
                : options.http
              const authority = options.session?.authority
              if (
                authority &&
                (authority.sessions !== options.session!.sessions ||
                  authority.identities !== resource.options.identities)
              ) {
                throw new Error('management_identity_source_mismatch')
              }
              const scoped = authority
                ? scopeManagementService(writes, authority, options.session!.cookie_name)
                : undefined
              const handler = createManagementHandler({
                ...options.http,
                authenticate: authentication.authenticate,
                verifyCsrf: authentication.verifyCsrf,
                service: scoped?.service ?? writes,
                origin
              })
              return scoped ? scoped.handler(handler) : handler
            }
          })
          options.listening?.(management.url)
        }
        return {
          service,
          authentication: resource.authentication,
          setupRequired: resource.setupRequired,
          reconfigure: resource.reconfigure,
          listening: resource.listening?.bind(resource),
          ...(management ? { managementUrl: management.url } : {}),
          closed: gateway.closed,
          close
        }
      } catch (error) {
        await close()
        throw error
      }
    }
  }
  if (host.connector) {
    runtime.connector = /* 唯一配置固定出站端点；宿主只交付凭据、Wire/native session与持久claims。 */ async (
      config
    ) => {
      const url = new URL('/connector', config.gateway_url).href
      const resource = await host.connector!(config)
      try {
        const transport = resource.transport
        // 兼容结构类型交付的旧options，但类型外夹带的冲突地址必须在任何连接/凭据读取前拒绝。
        if ('url' in transport && transport.url !== url) {
          throw new Error('runtime_connector_target_mismatch')
        }
        const options = {
          transport: { ...transport, url },
          session: resource.session.bind(resource),
          release: resource.release.bind(resource)
        }
        // provider中性宿主消费其真实Wire会话；不能把Herdr或空后端伪装成Luvus IPC。
        if (resource.kind === 'provider') {
          const running = await createProviderConnectorRuntime({
            ...options,
            session: resource.session.bind(resource),
            release_timeout_ms: resource.release_timeout_ms,
            provider_snapshot: resource.provider_snapshot
          })
          if (resource.session_replaced) {
            const unsubscribe = resource.session_replaced(() => running.transport.disconnect())
            void running.closed.then(unsubscribe, unsubscribe)
          }
          return running
        }
        const running = await createConnectorRuntime({
          ...options,
          ...(resource.provider_snapshot === true ? { provider_snapshot: true as const } : {}),
          session: resource.session.bind(resource)
        })
        // 来源（用户的 Luvus）被后台重建后结束当前连接周期，下一个认证 epoch 才会取到新实例。
        if (resource.session_replaced) {
          const unsubscribe = resource.session_replaced(() => running.transport.disconnect())
          void running.closed.then(unsubscribe, unsubscribe)
        }
        return running
      } catch (error) {
        await resource.release()
        throw error
      }
    }
  }
  return runtime
}
