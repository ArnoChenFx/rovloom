/** 管理 UI 展示层入口；宿主须接入共享受保护管理读取，此模块不提供管理员身份。 */
export { mountWebUi, unavailableRead, type PageRead } from './page.js'
export { ReadError, createSnapshotReader, type ReadClock, type TimedSnapshot } from './reader.js'
export { parseRoute, routeHref, type PageRoute, type PageView } from './view.js'
export { createManagementPageRead, type ManagementReadTransport, type ManagementReadOperation } from './read.js'
export { createManagementHttpRead, type ManagementFetch } from './http-client.js'
export { createManagementPageCsrf } from './bootstrap.js'

export { createManagementWriteClient, type ManagementWriteClientOptions } from './write-client.js'
export {
  ManagementClientError,
  type ManagementWriteTransport,
  type ManagementClientOperation,
  type DeviceManagementIntent
} from './write-contract.js'
export { createDeviceManagementFlow, type DeviceManagementState, type ManagementOperationKey } from './write-flow.js'
