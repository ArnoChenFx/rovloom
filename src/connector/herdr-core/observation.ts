/**
 * herdr-core 的观察档调用：先按本仓库规则复核参数，再用审核 schema 校验请求与结果，
 * 最后附上终端标识三元组。这里不发送输入、不改终端记录、不订阅事件。
 */
import { boundedJson, object, parseJson } from '../../wire/index.js'
import type { JsonObject } from '../../wire/types.js'
import type { HerdrCoreClient } from './client.js'
import { herdrCoreTerminalIdentity, type HerdrCoreTerminalIdentity } from './identity.js'
import { HERDR_CORE_MAX_REQUEST_BYTES, HERDR_CORE_WAIT_MAX_SECONDS, reviewHerdrCoreParams } from './methods.js'
import { compileHerdrCoreContract, type HerdrCoreContract } from './schema.js'

export type HerdrCoreObservationCall = Readonly<{
  method: string
  params: JsonObject
  result: JsonObject
  /** 单终端结果（如 terminal.get）的三元组；没有终端事实的方法不补造。 */
  terminal?: HerdrCoreTerminalIdentity
  /** 列表结果的逐终端三元组；server.status 这类方法没有。 */
  terminals?: readonly HerdrCoreTerminalIdentity[]
}>

export type HerdrCoreObservation = Readonly<{
  contract: HerdrCoreContract
  call(method: string, params?: JsonObject): Promise<HerdrCoreObservationCall>
}>

/** 请求超时给 wait 的检查间隔留余量；超时只结束本地等待，不宣称原生停止。 */
function requestTimeout(method: string, params: JsonObject): number {
  const timeout = method === 'terminal.wait' && typeof params.timeout === 'number' ? params.timeout : 0
  return Math.min(Math.max(timeout * 1000 + 5000, 5000), HERDR_CORE_WAIT_MAX_SECONDS * 1000 + 5000)
}

/**
 * 用同一条已握手连接建立观察面。contract 必须来自本次 core 的 `rpc.discover`，
 * 不能沿用仓库里历史版本的 schema。
 */
export function createHerdrCoreObservation(options: {
  client: HerdrCoreClient
  contract: HerdrCoreContract
}): HerdrCoreObservation {
  const { client, contract } = options
  /** 结果里的 address/created_ms 只在两者同时出现时构成终端事实。 */
  function terminalOf(result: JsonObject): HerdrCoreTerminalIdentity | undefined {
    return result.address === undefined && result.created_ms === undefined
      ? undefined
      : herdrCoreTerminalIdentity(client.hello.core.id, result)
  }
  /** 列表结果逐项建立三元组；任何一项不合格都不返回部分列表。 */
  function terminalsOf(result: JsonObject): readonly HerdrCoreTerminalIdentity[] | undefined {
    if (!Array.isArray(result.terminals)) {
      return undefined
    }
    return Object.freeze(
      result.terminals.map(
        /** 每一项都必须同时带地址与创建时间。 */ (entry) =>
          herdrCoreTerminalIdentity(client.hello.core.id, object(entry))
      )
    )
  }
  return Object.freeze({
    contract,
    call: /** 复核顺序固定：本仓库规则 → 审核参数 schema → 原生请求 → 审核结果 schema。 */ async (
      method: string,
      params: JsonObject = {}
    ) => {
      const value = object(parseJson(boundedJson(params, HERDR_CORE_MAX_REQUEST_BYTES)))
      reviewHerdrCoreParams(method, value)
      const checked = contract.validateParams(method, value)
      const result = contract.validateResult(
        method,
        await client.request(method, checked, requestTimeout(method, checked))
      )
      const terminal = terminalOf(result)
      const terminals = terminalsOf(result)
      return Object.freeze({
        method,
        params: checked,
        result,
        ...(terminal ? { terminal } : {}),
        ...(terminals ? { terminals } : {})
      })
    }
  })
}

/**
 * 通过 `rpc.discover` 取本次实例的 OpenRPC 文档并编译。文档只来自这条已核对的连接，
 * 不接受调用方传入的 schema，也不回退到仓库 fixture。
 */
export async function loadHerdrCoreContract(client: HerdrCoreClient): Promise<HerdrCoreContract> {
  const result = await client.request('rpc.discover', {}, 10_000)
  return compileHerdrCoreContract(boundedJson(result, 1024 * 1024))
}
