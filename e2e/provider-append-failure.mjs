/**
 * 追加失败非致命：本机准备/连接失败时只打印固定码，已配对来源照常启动、读取可用。
 * 用法：MCP_CONFIG=... APPEND_KINDS=luvus,herdr bun e2e/provider-append-failure.mjs
 */
import assert from 'node:assert/strict'
import { connectMixed } from './mixed-client.mjs'

const { client, ok, call } = await connectMixed()
try {
  const machines = await ok('machines_list', {})
  const providers = await ok('providers_list', { machine_id: machines.items[0].machine_id })
  // 只应有原本配对过的来源（quickstart 用 luvus 配对，追加失败后仍只有它）。
  assert.deepEqual(
    providers.items.map((item) => item.kind).sort(),
    [process.env.PAIRED_KIND ?? 'luvus']
  )
  const workspaces = await call('luvus', 'workspace.list', {})
  assert(Array.isArray(workspaces.workspaces ?? workspaces.items ?? []))
  console.log(JSON.stringify({ ok: true, providers: providers.items.map((item) => item.kind), read: 'workspace.list' }))
} finally {
  await client.close()
}
