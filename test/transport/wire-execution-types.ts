// 在完整严格类型检查中固定 Wire/原生执行互斥及真实 adapter、读取 port 的公开类型边界；不执行原生工作。
import type { LuvusRpcAdapter } from '../../src/connector/luvus/index.js'
import type { JsonObject } from '../../src/wire/types.js'
import type {
  ConnectorOptions,
  ConnectorWireSession,
  NativeConnectorOptions,
  WireConnectorOptions,
  Session,
  OriginalRead
} from '../../src/transport/index.js'

/** 只供编译器检查正反契约，运行时不调用此函数或其中的执行回调。 */
export function connectorTypeChecks(
  base: Omit<WireConnectorOptions, 'session'>,
  wireSession: ConnectorWireSession,
  plainSession: Session,
  rpc: LuvusRpcAdapter,
  original: OriginalRead
) {
  const mixedValue = {
    ...base,
    /** 该类型负例返回带 Wire hook 的会话。 */
    session: () => wireSession,
    /** 该类型负例同时试图声明原生 JSON 注入。 */
    nativeInput: (input: JsonObject) => input,
    /** 该类型负例同时试图声明原生 JSON 执行。 */
    execute: async () => ({})
  }
  const validNative: NativeConnectorOptions = {
    ...mixedValue,
    /** 有效的旧式执行模式只能返回无 Wire hook 的会话。 */
    session: () => plainSession
  }
  const validWire: WireConnectorOptions = {
    ...base,
    /** 有效 Wire 模式必须提供逐会话 hook。 */
    session: () => wireSession
  }
  const noHook = {
    ...base,
    /** 该类型负例缺少专用 Wire 执行 hook。 */
    session: () => plainSession
  }
  // @ts-expect-error Wire hook 与原生注入/执行不能共存。
  const mixed: ConnectorOptions = mixedValue
  // @ts-expect-error 原生模式的会话不能偷偷携带 Wire hook。
  const mixedNative: NativeConnectorOptions = mixedValue
  // @ts-expect-error Wire 模式不能只提供普通会话。
  const missingHook: WireConnectorOptions = noHook
  const legacyBudget: WireConnectorOptions['limits'] = {
    // @ts-expect-error Wire 的完整原生预算归实际 adapter 配置，不能使用旧式注入预算。
    native_bytes: 100
  }
  /** 实际 LuvusRpcAdapter.dispatch 的返回值直接满足 hook，无需剥字段或另造协议。 */
  const executeWire: ConnectorWireSession['executeWire'] = (raw, signal) => rpc.dispatch(raw, signal)
  /** 结果层只取得当前原 Wire 的受保护保留检查，不取得私有 permit。 */
  const retention: (nativeFrame: JsonObject) => void = (nativeFrame) =>
    original.wire.checkResultRetention(original.binding, nativeFrame)
  // @ts-expect-error 保留检查必须带精确原生响应，不能只提供 binding。
  original.wire.checkResultRetention(original.binding)
  // @ts-expect-error 读取 port 不提供 Wire 私有 context。
  const context = original.wire.context
  // @ts-expect-error 读取 port 不提供原生 validator 或 permit。
  const validator = original.wire.validator
  return {
    validNative,
    validWire,
    mixed,
    mixedNative,
    missingHook,
    legacyBudget,
    executeWire,
    retention,
    context,
    validator
  }
}
