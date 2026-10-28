// 导出可组合的角色宿主和可信请求接缝；唯一 CLI/HTTP/MCP 入口消费本模块。
export { createGatewayRuntime, createProviderGatewayRuntime } from './gateway.js'
export { createTrustedRequestScope } from './request-scope.js'
export { openGatewayState } from './state.js'
export { createConnectorRuntime, createLuvusConnectorSessions } from './connector.js'
export { createProviderConnectorRuntime, ConnectorHostStartupError } from './connector-host.js'
export type { ConnectorHostOptions, ConnectorHostShutdown, ConnectorReleaseStatus } from './connector-host.js'
export { createManagementSessionAuthority } from './management-session.js'
export type {
  ManagementSessionAuthority,
  ManagementSessionLease,
  ManagementSessionBootstrap,
  ManagementBootstrapOptions,
  CurrentManagementSession
} from './management-session.js'
export { initializeManagedLuvusRoot, openManagedLuvusRoot } from './native-root.js'
export type { ManagedLuvusRoot } from './native-root.js'
export { startManagedLuvus, MANAGED_LUVUS_REVISION, MANAGED_LUVUS_CLASSIFICATION } from './native-source.js'
export type { ControlledLuvusProcess, LocalOwnerLuvusInstance } from './native-source.js'
export { createLuvusOperationsProvider } from './luvus-operations-provider.js'
export { attachExistingLuvus } from './native-attach.js'
export type { AttachedLuvusInstance } from './native-attach.js'
export { createLuvusProductionSources, LuvusProductionStartupError } from './production-luvus.js'
export type { LuvusProductionOwnerConfig, LuvusProductionReference } from './production-luvus.js'
export type { LuvusProductionRemoteConfig } from './remote-luvus.js'
export {
  LUVUS_OPERATION_METHODS,
  luvusOperationDescriptor,
  luvusOperationValidation,
  validateLuvusOperationParams
} from './luvus-operations.js'
export {
  ConnectorAttemptBook,
  createConnectorAdmissionBackend,
  CONNECTOR_MAX_DEADLINE_MS
} from './connector-attempts.js'
export type {
  ConnectorAttemptBookOptions,
  ConnectorAdmissionOptions,
  ConnectorAdmissionSource,
  LuvusConnectorAdmissionSource
} from './connector-attempts.js'
export type { GatewayStateOptions } from './state.js'
export type * from './types.js'

export { createProviderResultAccess } from './results.js'
export type { ProviderResultAccessOptions, ProviderResultMetadata, ProviderResultPage } from './results.js'

export { composeGatewaySessions, composeConnectorSessions } from './provider-sessions.js'
export type { ProviderSessionGroup } from './provider-sessions.js'
