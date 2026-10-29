// 验证管理页新字段白名单及时间边界，旧 DTO 保持可读；样例不构成真实主机测量证据。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkManagementReadReply, checkPage } from '../../src/webui/validate.js'
import { fixtureDevice, fixtureSnapshot, fixtureTime } from './fixtures.js'
import { fixtureHostFields } from './host-fixture.js'

test('管理 DTO 同时接受旧 Connector 缺报和有来源/时间的新 host 块', () => {
  const args = { machine_id: 'fixture-a' }
  const legacy = fixtureDevice('fixture-a')
  assert.equal(checkManagementReadReply('devices_get', legacy, args).host, undefined)
  const current = { ...legacy, ...fixtureHostFields() }
  assert.deepEqual(checkManagementReadReply('devices_get', current, args).host, current.host)
  const route = { machineId: 'fixture-a', cursor: null, providerCursor: null }
  const snapshot = fixtureSnapshot(route)
  snapshot.value.device = current
  assert.deepEqual(checkPage(snapshot, route).value.device!.host, current.host)
})

test('主机字段拒绝网络/路径/秘密、伪造来源、重复 provider 与未来或倒序时间', () => {
  for (const scenario of ['secret', 'network', 'source', 'future', 'fraction', 'link', 'duplicate', 'cpu'] as const) {
    const current = { ...fixtureDevice('fixture-a'), ...fixtureHostFields() }
    const host = current.host!
    if (scenario === 'secret') {
      Object.assign(host, { env: 'PRIVATE_HOST_SECRET' })
    }
    if (scenario === 'network') {
      Object.assign(host.os, { address: 'PRIVATE_HOST_SECRET' })
    }
    if (scenario === 'source') {
      Object.assign(host, { source: 'live_shell' })
    }
    if (scenario === 'future') {
      Object.assign(host, { reported_at: fixtureTime + 1 })
    }
    if (scenario === 'fraction') {
      current.last_seen_at = fixtureTime - 0.5
    }
    if (scenario === 'link') {
      current.link_since = fixtureTime
    }
    if (scenario === 'duplicate') {
      Object.assign(host, { providers: [host.providers[0], host.providers[0]] })
    }
    if (scenario === 'cpu') {
      Object.assign(host, { cpus: -1 })
    }
    assert.throws(() => checkManagementReadReply('devices_get', current, { machine_id: 'fixture-a' }), {
      problem: 'invalid_response',
      message: 'invalid_response'
    })
  }
})

test('CPU 配额状态与数值一致，支持小数上界而不将 unknown 当成未限额', () => {
  for (const [cpu_quota, cpu_quota_status] of [
    [0.5, 'limited'],
    [0.0001, 'limited'],
    [0.5, 'partial'],
    [null, 'unknown'],
    [null, 'unlimited']
  ]) {
    const current = { ...fixtureDevice('fixture-a'), ...fixtureHostFields() }
    Object.assign(current.host!, { cpu_quota, cpu_quota_status })
    const actual = checkManagementReadReply('devices_get', current, { machine_id: 'fixture-a' })
    assert.equal(actual.host!.cpu_quota, cpu_quota)
    assert.equal(actual.host!.cpu_quota_status, cpu_quota_status)
  }
  for (const [cpu_quota, cpu_quota_status] of [
    [0.5, 'unlimited'],
    [null, 'limited'],
    [0.5, 'unknown'],
    [null, 'partial'],
    [0.5, undefined]
  ]) {
    const current = { ...fixtureDevice('fixture-a'), ...fixtureHostFields() }
    Object.assign(current.host!, { cpu_quota, cpu_quota_status })
    assert.throws(() => checkManagementReadReply('devices_get', current, { machine_id: 'fixture-a' }))
  }
})

test('管理 DTO 明确区分非 Linux 不支持和无法核实，拒绝平台或数值矛盾', () => {
  for (const family of ['linux', 'darwin', 'win32'] as const) {
    const current = { ...fixtureDevice('fixture-a'), ...fixtureHostFields() }
    Object.assign(current.host!, {
      os: { family, distribution: null, kernel: null },
      cpu_quota: null,
      cpu_quota_status: 'unknown'
    })
    const check = () => checkManagementReadReply('devices_get', current, { machine_id: 'fixture-a' })
    check()
    Object.assign(current.host!, { cpu_quota_status: 'unsupported' })
    if (family === 'linux') {
      assert.throws(check)
    } else {
      assert.equal(check().host!.cpu_quota_status, 'unsupported')
      Object.assign(current.host!, { cpu_quota_status: 'unlimited' })
      assert.throws(check)
    }
    Object.assign(current.host!, { cpu_quota: 0.5, cpu_quota_status: 'unsupported' })
    assert.throws(check)
  }
})
