/*
 * 本入口导出 Luvus 的异步 Worker 契约编译，以及同步原生接口校验与调用授权内核。
 * 内核根据调用方提供的契约字节与可信来源上下文，校验能力、请求和响应，
 * 并签发仅在内存中有效的调用许可；这里不执行真实原生调用或身份认证。
 * integration 将原生证明接入 Wire 校验流程，wire 处理外层消息与生命周期约束；
 * 实际传输、认证和可信上下文解析由宿主提供，持久化事实由外层 Store/persistence 接缝承接。
 * 本入口不代表已具备 Herdr 的通用完整原生实现。
 */
export type * from './types.js'
export { DEFAULT_LIMITS, parseNativeJson } from './json.js'
export { compileBundle } from './bundle.js'
export { createNativeValidator } from './validator.js'
export { checkDispatch, checkResultBoundary, checkResultRetention } from './safety.js'
export { luvusMethod, LUVUS_TABLE_METHODS } from '../methods.js'
