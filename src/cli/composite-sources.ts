// 唯一CLI只组合原owner资源；协议路由、执行许可及会话隔离均交给现有runtime。
import { createLuvusConnectorSessions } from '../connector/luvus/host/connector-runtime.js'
import { composeConnectorSessions } from '../runtime/provider-sessions.js'
import type { GatewayHostedProviders } from '../runtime/types.js'
import type { ProviderSessionGroup } from '../runtime/provider-sessions.js'
import { closeSession } from '../transport/common.js'
import type { ConnectorWireSession } from '../transport/index.js'
import { boundedJson } from '../wire/index.js'
import type { ProviderCatalogProvider } from '../mcp/catalog.js'
import { luvusCatalogProvider } from '../connector/luvus/catalog-provider.js'
import type { GatewayConfig, ConnectorConfig } from './config.js'
import { CliError } from './config.js'
import { ProviderUnavailableError } from './provider-unavailable.js'
import type { ManagementSessionAuthority } from '../runtime/management-session.js'
import type { RuntimeCliGateway } from './runtime.js'
import type {
  ProductionCliSources,
  ProductionProviderReference,
  ProductionGatewayResources,
  ProductionConnectorResources
} from './production.js'

export type ProductionSourceGroup = Readonly<{
  kind: 'luvus' | 'herdr' | 'herdr-core'
  source: ProductionCliSources
  references: readonly ProductionProviderReference[]
}>

export class ProductionSourcesStartupError extends CliError {
  /** 清理失败保留原owner和同一release供受信宿主观察，普通CLI只看到固定错误码。 */
  constructor(
    readonly startupError: unknown,
    readonly shutdown: { release(): Promise<void> },
    readonly cleanupError: unknown
  ) {
    super('backend_unavailable', 3)
  }
}

/** 每个原owner只释放一次，部分启动和关闭失败都继续清理其余owner并保留同一失败结果。 */
function ownership() {
  const resources: { release(): Promise<void> }[] = []
  const sessions: { close(): void }[] = []
  let stopping = false
  let closing: Promise<void> | undefined
  const release = /** 先同步封锁新epoch，再逆序停止会话和释放原资源。 */ (): Promise<void> => {
    stopping = true
    closing ??= Promise.resolve().then(
      /** 先封锁新会话，再逐项释放全部原资源并保留失败。 */ async () => {
        const errors: unknown[] = []
        for (const session of [...sessions].reverse()) {
          try {
            session.close()
          } catch (error) {
            errors.push(error)
          }
        }
        for (const resource of [...resources].reverse()) {
          try {
            await resource.release()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) {
          throw new AggregateError(errors, 'production_sources_release_failed')
        }
      }
    )
    void closing.catch(/** 同一拒绝仍交由角色或startup shutdown观察，不产生无人消费的拒绝。 */ () => {})
    return closing
  }
  return {
    resources,
    sessions,
    release,
    assertOpen: /** 每个外部构建回调后重验同步关闭fence。 */ () => {
      if (stopping) {
        throw new CliError('backend_unavailable', 3)
      }
    },
    fail: /** 启动失败保留原错误；若原owner未确认释放则连同关闭入口交还。 */ async (error: unknown): Promise<never> => {
      try {
        await release()
      } catch (cleanupError) {
        throw new ProductionSourcesStartupError(error, Object.freeze({ release }), cleanupError)
      }
      throw error
    }
  }
}

/** Gateway原Luvus注册表和各中性session分组明确交付，目录选择仍委托原resolver。 */
export async function prepareMixedGateway(
  config: GatewayConfig,
  groups: readonly ProductionSourceGroup[],
  authority: ManagementSessionAuthority
): Promise<ProductionGatewayResources> {
  const owner = ownership()
  const prepared: ProductionGatewayResources[] = []
  try {
    for (const group of groups) {
      const resource = await group.source.gateway!(config, group.references, authority)
      owner.resources.push(resource)
      prepared.push(resource)
    }
    // 原生（Luvus）注册表最多一份；只有 Herdr 的 Gateway 可以没有它，此时每台设备各是一个中性会话组。
    const native = prepared.find(
      /** 选择原Luvus资源，不能把中性会话伪装成原生资源。 */ (resource) => resource.kind !== 'provider'
    )
    const hosts = prepared.filter(/** 保留中性provider的真实会话工厂。 */ (resource) => resource.kind === 'provider')
    if (native?.kind === 'mixed' || hosts.length !== prepared.length - (native ? 1 : 0) || prepared.length === 0) {
      throw new CliError('backend_unavailable', 3)
    }
    const hosted: GatewayHostedProviders[] = hosts.map(
      /** 保留完整 provider 条目；会话来源二选一：端口层登记或原工厂方法绑定。 */ (resource) => ({
        providers: resource.providers,
        ...(resource.ports ? { ports: resource.ports } : { session: resource.session!.bind(resource) })
      })
    )
    const routes = new Map<string, ProviderCatalogProvider | 'native'>()
    const names = new Set<string>()
    for (const resource of prepared) {
      for (const provider of resource.providers) {
        const name = provider.binding.machine_id + '/' + provider.binding.provider_id
        if (names.has(name)) {
          throw new CliError('invalid_config')
        }
        names.add(name)
        const catalog = resource.catalog
        if (catalog?.kind === 'mixed') {
          throw new CliError('invalid_config')
        }
        if (resource.kind === 'provider' && !catalog) {
          throw new CliError('backend_unavailable', 3)
        }
        routes.set(boundedJson(provider.target), catalog ?? 'native')
      }
    }
    const management = prepared.filter(
      /** 只允许唯一原管理来源，避免组合放宽权限。 */ (resource) => resource.management
    )
    if (management.length > 1) {
      throw new CliError('invalid_config')
    }
    let runtime: RuntimeCliGateway | undefined
    return {
      kind: 'mixed',
      providers: native?.providers ?? [],
      hosted,
      management: management[0]?.management,
      catalog: {
        kind: 'mixed',
        select: /** 精确目标只选一个原目录；Luvus 用自己的目录端口包装唯一已建立 runtime 的实际 epoch 目录。 */ (
          target
        ) => {
          owner.assertOpen()
          const route = routes.get(boundedJson(target))
          if (route === 'native') {
            const active = runtime
            if (!active?.catalog) {
              return undefined
            }
            return luvusCatalogProvider({
              store: active.store,
              provider: active.catalog
            })
          }
          return route
        }
      },
      started: /** 唯一宿主建立后绑定原目录，不从describe或CLI配置重建原生能力。 */ (active) => {
        owner.assertOpen()
        runtime = active
        for (const resource of prepared) {
          resource.started?.(active)
        }
        owner.assertOpen()
      },
      release: owner.release
    }
  } catch (error) {
    return owner.fail(error)
  }
}

/** Connector只把原builder交付给同一个中性transport，Herdr继续持有PR93原owner及其关闭语义。 */
export async function prepareMixedConnector(
  config: ConnectorConfig,
  groups: readonly ProductionSourceGroup[]
): Promise<ProductionConnectorResources> {
  const owner = ownership()
  const prepared: ProductionConnectorResources[] = []
  const unavailable: ProviderSessionGroup['providers'][number][] = []
  try {
    for (const group of groups) {
      try {
        const resource = await group.source.connector!(config, group.references)
        owner.resources.push(resource)
        prepared.push(resource)
      } catch (error) {
        if (error instanceof ProviderUnavailableError && group.kind === error.provider.binding.kind) {
          unavailable.push(error.provider)
        } else {
          throw error
        }
      }
    }
    const native = prepared.find(/** 选择原Luvus会话构建资源。 */ (resource) => resource.kind !== 'provider')
    const hosted = prepared.filter(/** 保留原中性Connector资源及其owner。 */ (resource) => resource.kind === 'provider')
    if (
      !native ||
      hosted.length !== prepared.length - 1 ||
      hosted.some(/** 缺真实路由覆盖不能从请求或readiness猜目标。 */ (resource) => !resource.providers?.length)
    ) {
      throw new CliError('backend_unavailable', 3)
    }
    const luvus = createLuvusConnectorSessions(native)
    owner.sessions.push(luvus)
    const replaceable = [native, ...hosted].filter(
      /* 只聚合会后台替换实例的来源。 */ (resource) => resource.session_replaced
    )
    return {
      kind: 'provider',
      provider_snapshot: native.provider_snapshot,
      release_timeout_ms: Math.min(
        5000,
        ...hosted.map(/** 组合只收紧原owner逻辑关闭预算。 */ (resource) => resource.release_timeout_ms ?? 5000)
      ),
      session: /** 每个真实welcome只建独立epoch，路由覆盖来自原owner实际配置。 */ (connection) => {
        owner.assertOpen()
        const parts: ProviderSessionGroup<ConnectorWireSession>[] = []
        let transferred = false
        try {
          parts.push(luvus.group(connection))
          owner.assertOpen()
          for (const resource of hosted) {
            const session = resource.session(connection)
            parts.push({ providers: resource.providers!, session })
            owner.assertOpen()
          }
          transferred = true
          return composeConnectorSessions(connection, parts, Date.now, unavailable)
        } catch (error) {
          if (!transferred) {
            for (const part of parts.reverse()) {
              try {
                closeSession(part.session)
              } catch {
                /* 原构建错误保留，但所有交付资源均尝试清理。 */
              }
            }
          }
          throw error
        }
      },
      release: owner.release,
      ...(replaceable.length > 0
        ? {
            /** 任一来源被后台替换都结束当前连接周期；混合连接器同样需要，否则 Herdr/Luvus 重建后旧 epoch 一直在线。 */
            session_replaced(listener: () => void): () => void {
              const unsubscribe = replaceable.map(
                /* 每个来源各自登记同一监听。 */ (resource) => resource.session_replaced!(listener)
              )
              return () => {
                for (const off of unsubscribe) {
                  off()
                }
              }
            }
          }
        : {})
    }
  } catch (error) {
    return owner.fail(error)
  }
}
