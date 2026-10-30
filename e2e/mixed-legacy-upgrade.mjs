/**
 * 老设备升级后的检查：配置仍是 `native.provider: "mixed"`（0.10 之前的含义 = Luvus + Herdr），
 * 配对记录只有两条。Connector 必须正常就绪、两个来源都能调用、目录里没有 herdr-core。
 * 用法：MCP_CONFIG=... bun e2e/mixed-legacy-upgrade.mjs
 */
import assert from 'node:assert/strict'
import { connectMixed } from './mixed-client.mjs'

const { client, ok, call, discover } = await connectMixed()
try {
  const machines = await ok('machines_list', {})
  assert.equal(machines.items.length, 1)
  const providers = await ok('providers_list', { machine_id: machines.items[0].machine_id })
  const kinds = providers.items.map((item) => item.kind).sort()
  assert.deepEqual(kinds, ['herdr', 'luvus'], `legacy mixed must stay Luvus + Herdr: ${JSON.stringify(kinds)}`)
  // 两个来源都真的可用。
  const workspaces = await call('luvus', 'workspace.list', {})
  assert(Array.isArray(workspaces.workspaces ?? workspaces.items ?? []))
  const pong = await call('herdr', 'ping', {})
  assert.equal(pong.result.type, 'pong')
  // 没有 herdr-core 的目录或目标。
  await assert.rejects(discover('herdr-core'), /target herdr-core missing/u)
  console.log(JSON.stringify({ ok: true, legacy: true, providers: kinds, herdr_version: pong.result.version }))
} finally {
  await client.close()
}
