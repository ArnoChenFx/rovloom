import type { V2Target } from '../wire/types.js'
// 为受信宿主组合实际Store Gateway；身份和本地政策必须显式注入，不从argv、配置或OS名称推导权限。
import { join } from 'node:path'
import { Store, type StoreOptions } from '../store.js'
import { StoreGatewayService, type GatewayIdentitySource, type GatewayCatalogProvider } from '../mcp/index.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import type { CliRuntime } from './run.js'

export type StoreCliHost = {
  authentication: HttpAuthenticationProvider
  identities: GatewayIdentitySource
  targets?(): readonly V2Target[]
  catalog?: GatewayCatalogProvider
  storeOptions?: Omit<StoreOptions, 'management' | 'fault'>
}

// 仅在显式启动Gateway时打开受保护状态库，宿主关闭释放唯一writer；Connector仍缺真实transport。
export function createStoreCliRuntime(host: StoreCliHost): CliRuntime {
  return {
    gateway: /* 使用现有Store路径/权限/单writer检查；配置不会加载模块、执行命令或提供身份。 */ async (config) => {
      const store = new Store(join(config.state_dir, 'gateway.db'), Date.now, host.storeOptions)
      try {
        return {
          service: new StoreGatewayService({
            store,
            identities: host.identities,
            targets: host.targets ?? (() => []),
            catalog: host.catalog
          }),
          authentication: host.authentication,
          close: /* 只释放当前宿主持有的数据库和timer，不重试或取消原生工作。 */ async () => store.close()
        }
      } catch (error) {
        store.close()
        throw error
      }
    }
  }
}
