import type { V2Target } from '../wire/types.js'
// 将CLI生命周期接到已验证transport；状态、身份及原生适配器均由受信宿主显式交付，不补造默认权限。
import { AsyncLocalStorage } from 'node:async_hooks'
import { Router, type Principal } from '../router.js'
import type { Store } from '../store.js'
import type { TrustedAttempt } from '../wire/backend.js'
import {
  createConnector,
  createGateway,
  type GatewayOptions,
  type NativeConnectorOptions,
  type WireConnectorOptions,
  type OriginalReadResolver
} from '../transport/index.js'
import { StoreGatewayService, resolveGatewayPrincipal } from '../mcp/store-service.js'
import { FacadeServiceError, type CallerIdentity, type GatewayService } from '../mcp/types.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import type { GatewayIdentitySource } from '../mcp/management.js'
import type { GatewayCatalog } from '../mcp/catalog.js'
import type { ConnectorConfig, GatewayConfig } from './config.js'
import type { CliRuntime } from './run.js'

export type GatewayTransportPorts = Readonly<{
  store: Store
  router: Router
  transport: ReturnType<typeof createGateway>
  targets?(): readonly V2Target[]
  // 与transport派发共享当前请求的受保护caller作用域，逐次重读身份；作用域外和关闭后拒绝。
  principal(): Principal
  // 只读取当前caller所属且仍有原文的实际Store尝试，不生成原生许可或另一份请求缓存。
  originalAttempt(callId: string, attemptId: string): TrustedAttempt | undefined
  // 直接复用当前transport的活原请求resolver；逐次核对同一caller作用域，不缓存Wire或重建permit。
  resolveOriginalRead: OriginalReadResolver
}>
export type GatewayTransportResources = {
  store: Store
  identities: GatewayIdentitySource
  targets?(): readonly V2Target[]
  authentication: HttpAuthenticationProvider
  catalog?: GatewayCatalog
  transport: Omit<GatewayOptions, 'store' | 'router' | 'principal'>
  // 可选原生服务工厂复用同一Store/Router/transport；省略时仅开放既有Store查询与清理。
  service?(ports: GatewayTransportPorts): GatewayService
  // 接收资源所有权后必须释放Store、身份库及宿主会话；由CLI组合保证恰好调用一次。
  close(): Promise<void>
}
export type ConnectorTransportResources = {
  transport: Omit<NativeConnectorOptions, 'url'> | Omit<WireConnectorOptions, 'url'>
  // 仅释放本次受信宿主持有的资源；关闭连接不证明原生动作停止或回滚。
  close(): Promise<void>
}
export type TransportCliHost = {
  // 有界打开受保护状态及已验证设备身份桥，原始秘密只能由宿主专用输入读取。
  gateway?(config: GatewayConfig): Promise<GatewayTransportResources>
  // 按非秘密配置引用解析既有设备凭据和native适配器，不执行配对或签发。
  connector?(config: ConnectorConfig): Promise<ConnectorTransportResources>
}

// 复用真实transport管理listener/socket；缺失角色宿主仍由runCli明确报告backend_unavailable。
export function createTransportCliRuntime(host: TransportCliHost): CliRuntime {
  const runtime: CliRuntime = {}
  if (host.gateway) {
    runtime.gateway = /* 一次启动只组合一个Store/Router；失败和正常关闭都先停网络再释放持久资源。 */ async (config) => {
      const owned = await host.gateway!(config)
      const scope = new AsyncLocalStorage<CallerIdentity>()
      let transport: ReturnType<typeof createGateway> | undefined
      let closing: Promise<void> | undefined
      const close = /* 共享同一关闭Promise，确保并发关闭不重复释放宿主资源。 */ (): Promise<void> => {
        closing ??= Promise.resolve().then(
          /* 先保存Promise再开始清理，宿主同步重入也只能取得同一次关闭。 */ async () => {
            try {
              transport?.stop()
            } finally {
              scope.disable()
              await owned.close()
            }
          }
        )
        return closing
      }
      try {
        const router = new Router(owned.store)
        const principal = /* 为派发、结果读取及原请求索引提供同一当前身份，禁止全局最近caller。 */ (): Principal => {
          if (closing) {
            throw new FacadeServiceError('unavailable')
          }
          const caller = scope.getStore()
          if (!caller) {
            throw new FacadeServiceError('unauthenticated')
          }
          return resolveGatewayPrincipal(owned.identities, caller)
        }
        transport = createGateway({
          ...owned.transport,
          store: owned.store,
          router,
          principal
        })
        const service = owned.service
          ? owned.service({
              store: owned.store,
              router,
              transport,
              principal,
              resolveOriginalRead: transport.resolveOriginalRead,
              originalAttempt: /* 原请求仅供可信结果接线核对原绑定；归属和当前read政策仍先经Router。 */ (
                callId,
                attemptId
              ) => {
                const call = router.get(principal(), callId)
                return call.attempt_id === attemptId ? owned.store.attempt(callId, attemptId) : undefined
              }
            })
          : new StoreGatewayService({ ...owned, router, targets: owned.targets ?? (() => []) })
        return {
          authentication: owned.authentication,
          service: {
            execute: /* 关闭开始即拒绝新操作；仅复制facade受信caller，不从业务参数提取身份。 */ (
              name,
              args,
              context
            ) => {
              if (closing) {
                return Promise.reject(new FacadeServiceError('unavailable'))
              }
              return scope.run(
                Object.freeze({ principal_id: context.caller.principal_id }),
                /* 仅延续已建立的宿主作用域；服务仍须逐操作执行完整授权与native内容门禁。 */ () =>
                  service.execute(name, args, context)
              )
            }
          },
          close
        }
      } catch (error) {
        await close()
        throw error
      }
    }
  }
  if (host.connector) {
    runtime.connector = /* 固定追加现有transport端点；URL只含配置origin，凭据保持在专用宿主回调中。 */ async (
      config
    ) => {
      const owned = await host.connector!(config)
      let transport: ReturnType<typeof createConnector> | undefined
      let finish!: () => void
      const closed = new Promise<void>(
        /* 本地生命周期终止后唤醒runCli，重连不视为角色退出。 */ (resolve) => {
          finish = resolve
        }
      )
      let closing: Promise<void> | undefined
      const close = /* 停止真实重连/timer/socket后释放宿主资源；保留可能已送达调用的持久事实。 */ (): Promise<void> => {
        closing ??= Promise.resolve().then(
          /* 先保存Promise再开始清理，失败仍解除等待且不回显原文。 */ async () => {
            try {
              transport?.stop()
            } finally {
              try {
                await owned.close()
              } finally {
                finish()
              }
            }
          }
        )
        return closing
      }
      try {
        transport = createConnector({ ...owned.transport, url: new URL('/connector', config.gateway_url).href })
        return { closed, close }
      } catch (error) {
        await close()
        throw error
      }
    }
  }
  return runtime
}
