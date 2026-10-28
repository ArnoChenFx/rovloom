// 集中导出HTTP MCP门面与服务契约；不创建身份、存储或原生执行后端。
export { createMcpFacade } from './facade.js'
export type { DiagnosticCode, FacadeOptions } from './facade.js'
export { createHttpFacade, startHttpFacade, HTTP_BODY_BYTES } from './http.js'
export type { HttpAuthenticationProvider, HttpFacadeOptions, RunningHttp } from './http.js'
export {
  MCP_REVISION,
  PRODUCT_VERSION,
  MAX_MCP_BYTES,
  MAX_RESULT_BYTES,
  MAX_WAIT_MS,
  toolDefinition,
  toolNames,
  parseToolArguments
} from './schema.js'
export { FacadeServiceError } from './types.js'
export type {
  CallerIdentity,
  McpContextProvider,
  ServiceContext,
  ServiceReply,
  ServiceErrorCode,
  GatewayService,
  ToolArguments,
  ToolName,
  ReplyData,
  CallView,
  MachineView,
  MachineDetailsView,
  ProviderView,
  ProviderMetadata,
  McpProviderView,
  Page
} from './types.js'

export { StoreGatewayService } from './store-service.js'
export type { StoreGatewayOptions } from './store-service.js'
export type * from './management.js'
export { authorizedCatalog, selectCatalogProvider } from './catalog.js'
export type {
  GatewayCatalog,
  CompositeGatewayCatalogProvider,
  ProviderCatalogProvider,
  ProviderCatalogSource,
  AuthorizedCatalogOptions
} from './catalog.js'
export { luvusCatalogProvider } from '../connector/luvus/catalog-provider.js'
export type { GatewayCatalogProvider, GatewayCatalogSource } from '../connector/luvus/catalog-provider.js'
export { RuntimeGatewayService } from './runtime-service.js'
export type { RuntimeGateway, RuntimeGatewayPort, RuntimeGatewayServiceOptions } from './runtime-service.js'
