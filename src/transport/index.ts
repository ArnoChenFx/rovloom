// 集中导出可组合的 transport、持久身份与专用交付接口，不提供默认授权或第二套 CLI。
export { createGateway } from './gateway.js'
export type { GatewayOptions, OriginalRead, OriginalReadResolver } from './gateway.js'
export type { TransportObserved, GatewayTransportSnapshot, GatewayTransportObservationSource } from './observation.js'
export { createConnector } from './connector.js'
export type {
  ConnectorOptions,
  NativeConnectorOptions,
  WireConnectorOptions,
  ConnectorWireSession,
  WireExecutionResult
} from './connector.js'
export type { IdentityHost, DeviceCredential } from './identity.js'
export type { DispatchRefusalLedger } from './dispatch-refusal.js'
export { PairingAdmin } from './pairing.js'
export type { ManagementHost, ManagementAction } from './pairing.js'
export { loadCredential, saveCredential, createFileCredentialSink } from './credentials.js'
export type { Session, Connection, Readiness, Adapter, CloseEvent } from './common.js'
export { boundedDisconnect, remoteDisconnect } from './disconnect.js'
export type { DisconnectObservation, DisconnectReason } from './disconnect.js'
export { createPairingDelivery } from './custody.js'
export type {
  PairingBackend,
  DeliveryLedger,
  CredentialSink,
  PairingRequest,
  CredentialDeliveryContext,
  CredentialDeliveryAck
} from './custody.js'
export { ChannelRegistry } from './channel-host.js'
export type { ChannelHost, SocketChannel } from './channel-host.js'
export { createDeviceLifecycle } from './lifecycle.js'
export type { DeviceLifecycleWiring } from './lifecycle.js'
