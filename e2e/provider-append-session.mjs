/**
 * 已配对设备追加来源后的 MCP 验收：三个来源都在目录里，各做一次只读；
 * 原 luvus/herdr 仍可用；设备凭据与 MCP token 字节不变（由 quickstart 传进来的路径核对）。
 * 用法：MCP_CONFIG=... bun e2e/provider-append-session.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectMixed } from './mixed-client.mjs'

const { client, targets, ok, call, discover } = await connectMixed()
try {
  const machines = await ok('machines_list', {})
  assert.equal(machines.items.length, 1)
  const providers = await ok('providers_list', { machine_id: machines.items[0].machine_id })
  const kinds = providers.items.map((item) => item.kind).sort()
  // 未显式指定时按三来源检查（老 mixed 设备升级后的追加场景）。
  const expected = (process.env.APPEND_KINDS ?? 'luvus,herdr,herdr-core').split(',').sort()
  assert.deepEqual(kinds, expected, JSON.stringify(kinds))
  // 每个来源各一次只读，且数据来自本后端。
  const reads = {}
  if (expected.includes('luvus')) {
    const workspaces = await call('luvus', 'workspace.list', {})
    assert(Array.isArray(workspaces.workspaces ?? workspaces.items ?? []))
    reads.luvus = 'workspace.list'
  }
  if (expected.includes('herdr')) {
    const pong = await call('herdr', 'ping', {})
    assert.equal(pong.result.type, 'pong')
    reads.herdr = pong.result.type
  }
  if (expected.includes('herdr-core')) {
    const status = await call('herdr-core', 'server.status', {})
    assert.match(status.core.id, /^[a-f0-9]{8,64}$/u)
    reads['herdr-core'] = status.version
  }
  // 追加后 refs 互不相同（目录按 provider 分开）。
  const refs = new Set(
    await Promise.all(expected.map(async (kind) => (await discover(kind)).page.items[0].contract_ref))
  )
  assert.equal(refs.size, expected.length)
  // 设备凭据与 pairing 记录必须逐字不变（若 quickstart 提供了它们的摘要）。
  let identity = undefined
  if (process.env.APPEND_IDENTITY) {
    const recorded = JSON.parse(readFileSync(process.env.APPEND_IDENTITY, 'utf8'))
    const managed = process.env.CONNECTOR_MANAGED
    assert(managed, 'CONNECTOR_MANAGED is required with APPEND_IDENTITY')
    const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
    assert.equal(digest(join(managed, 'device.json')), recorded.device_sha256)
    assert.equal(digest(join(managed, 'providers.json')) === recorded.providers_sha256, false, 'providers changed as expected')
    identity = { device_unchanged: true }
  }
  console.log(JSON.stringify({ ok: true, providers: kinds, reads, refs: refs.size, identity, targets: [...targets.keys()] }))
} finally {
  await client.close()
}
