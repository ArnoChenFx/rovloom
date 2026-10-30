/** 长轮询测试的公共夹具：真实 0.1.14 契约 + 带标签的终端事实。 */
import { readFileSync } from 'node:fs'
import { compileHerdrCoreContract } from '../../../src/connector/herdr-core/schema.js'

export const OPENRPC = readFileSync(new URL('../../fixtures/herdr-core/openrpc-0.1.14.json', import.meta.url))
export const CONTRACT = compileHerdrCoreContract(OPENRPC)

/** 假 core 的终端事实；labels 由测试覆盖。 */
export function fakeTerminalForEvents() {
  return { labels: { role: 'review' } }
}
