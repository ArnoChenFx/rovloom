/**
 * herdr-core 控制档的执行端栅栏：在真正写入前用同一条连接读一次 `terminal.get`，
 * 核对终端三元组 `(core.id, created_ms, address)`，并自己判断 blocked。
 *
 * 为什么不能信 core 的闸门：spike 3f 实测只有 `send` 在 blocked 时拒绝，`keys`、`interrupt`、
 * `force` 都照常送达。所以 blocked 必须由 rovloom 判断，判定失败一律 fail-closed。
 *
 * 残余风险（未消除，只写清楚）：判定与写入之间终端状态仍可能变化。`send` 还有 core 自己的
 * blocked 闸门兜底；`keys`/`interrupt` 没有原生闸门，程序在这段窗口里转成 blocked 时输入仍会送达。
 * 二者之间没有 await 以外的等待，也不跨连接、不跨实例。
 */
import type { JsonObject } from '../../wire/types.js'
import { fail } from '../../wire/index.js'
import type { HerdrCoreClient } from './client.js'
import { herdrCoreInput, HERDR_CORE_FENCE_PARAMS } from './methods.js'
import type { HerdrCoreContract } from './schema.js'

/** 单次终端状态读取的本地期限：它只是执行前检查，不等待原生工作。 */
export const HERDR_CORE_FENCE_TIMEOUT_MS = 5000

/**
 * 调用方认定的终端事实；`terminal` 必须是裸本地地址，名字与 `machine/tN` 都不接受。
 * `core_id` 来自 `server.status` 的 `core.id`，`created_ms` 来自同一终端的读取结果。
 */
export type HerdrCoreTerminalFence = Readonly<{ core_id: string; created_ms: number; address: string }>

/** 只取栅栏字段；调用方参数里其余字段原样交给原生请求。 */
export function herdrCoreFence(params: Readonly<Record<string, unknown>>): HerdrCoreTerminalFence {
  const core_id = params.core_id
  const created_ms = params.created_ms
  const address = params.terminal
  if (typeof core_id !== 'string' || typeof created_ms !== 'number' || typeof address !== 'string') {
    fail('herdr_core_terminal_fence_required')
  }
  return Object.freeze({ core_id, created_ms, address })
}

/** 控制档请求里除栅栏字段外还有哪些原生参数；执行端只用它们发请求。 */
export function herdrCoreControlNativeParams(params: Readonly<Record<string, unknown>>): JsonObject {
  const native: JsonObject = {}
  for (const [key, value] of Object.entries(params)) {
    if (!HERDR_CORE_FENCE_PARAMS.includes(key)) {
      native[key] = value
    }
  }
  return native
}

/**
 * 程序自己的状态字（OSC 7501）。`null` 表示它从未上报：这类程序不可能进入 blocked
 * （core 的闸门也只认上报过的状态），所以不把「不上报」当成未知。
 * 形状不符、读不到、终端已结束都按未知处理并拒绝。
 */
function blocked(status: unknown): boolean {
  if (status === null || status === undefined) {
    return false
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    fail('herdr_core_terminal_unavailable')
  }
  const state = (status as JsonObject).state
  if (typeof state !== 'string') {
    fail('herdr_core_terminal_unavailable')
  }
  return state === 'blocked'
}

/**
 * 执行前核对：先看这条连接自己的 `core.id`，再读实时终端事实。
 * 地址、`created_ms` 或 `core.id` 任一不符即拒绝，绝不把输入送给同地址的另一个终端。
 * 只有真正送输入的方法（send/keys/interrupt）才做 blocked 判定；`put` 只写文件，
 * `kill`/`rm`/`keep`/`label` 改的是终端记录，blocked 时也必须可用（否则没法收拾现场）。
 */
export async function assertHerdrCoreTerminal(options: {
  client: HerdrCoreClient
  contract: HerdrCoreContract
  method: string
  params: Readonly<Record<string, unknown>>
  /** 剩余期限；检查本身也不得超过这个预算。 */
  timeout_ms: number
}): Promise<void> {
  const fence = herdrCoreFence(options.params)
  const budget = Math.min(options.timeout_ms, HERDR_CORE_FENCE_TIMEOUT_MS)
  if (budget < 1) {
    fail('herdr_core_timeout')
  }
  // 连接与调用方认定的实例必须一致：core.id 变了就是另一个实例，旧三元组一律作废。
  if (options.client.hello.core.id !== fence.core_id) {
    fail('herdr_core_terminal_identity_mismatch')
  }
  let live: JsonObject
  try {
    live = options.contract.validateResult(
      'terminal.get',
      await options.client.request('terminal.get', { terminal: fence.address }, budget)
    )
  } catch {
    // 读不到终端事实就不能判断 blocked；固定码，不把原生错误文本带出去。
    fail('herdr_core_terminal_unavailable')
  }
  if (live.address !== fence.address || live.created_ms !== fence.created_ms) {
    fail('herdr_core_terminal_identity_mismatch')
  }
  // 送输入或写文件要求终端仍在运行；kill/rm/keep/label 改的是记录，
  // 必须能对已结束的终端使用（rm 就是用来删除已结束终端的）。
  if (herdrCoreInput(options.method) || options.method === 'terminal.put') {
    if (live.state !== 'live') {
      fail('herdr_core_terminal_unavailable')
    }
  }
  if (!herdrCoreInput(options.method)) {
    return
  }
  if (blocked(live.status)) {
    fail('herdr_core_terminal_blocked')
  }
}
