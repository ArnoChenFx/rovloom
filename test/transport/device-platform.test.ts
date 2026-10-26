/**
 * 设备平台：Connector 采集真实平台、Wire 上报、Gateway 落库，管理面按 Observed 惯例投影。
 * 老 Gateway 协商不到能力时不得收到该帧；离线后保留旧值但展示为历史观测。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probePlatform, parseOsRelease, supportedArch, supportedOs } from '../../src/platform/device.js'
import { fixture, rawConnect, until } from '../transport/helpers.js'
import { checkManagementReadReply } from '../../src/webui/validate.js'
import { createManagementTransportProjection } from '../../src/mcp/transport-observations.js'
import type { DeviceSnapshot } from '../../src/mcp/management.js'
import { negotiate, WIRE_MINOR } from '../../src/wire/index.js'

test('平台采集只取真实 os/arch 与 Linux 发行版，未知架构或非 Linux 不编造发行版', () => {
  const linux = probePlatform({ platform: 'linux', arch: 'x64' })
  assert.equal(linux?.os, 'linux')
  assert.equal(linux?.arch, 'x64')
  // 本机是 Linux 时必须有发行版标识；非 Linux 的 darwin/win32 明确缺省。
  const darwin = probePlatform({ platform: 'darwin', arch: 'arm64' })
  assert.deepEqual(darwin, { os: 'darwin', arch: 'arm64', distribution: null })
  const windows = probePlatform({ platform: 'win32', arch: 'x64' })
  assert.deepEqual(windows, { os: 'win32', arch: 'x64', distribution: null })
  // 不在允许集合内的运行时平台或架构不产生平台声明。
  assert.equal(probePlatform({ platform: 'freebsd', arch: 'x64' }), undefined)
  assert.equal(probePlatform({ platform: 'linux', arch: 'ia32' }), undefined)
  assert.equal(supportedOs('linux'), true)
  assert.equal(supportedOs('freebsd'), false)
  assert.equal(supportedArch('arm64'), true)
  assert.equal(supportedArch('mips'), false)
  if (process.platform === 'linux') {
    assert.equal(linux?.distribution !== null, true)
    assert.match(linux!.distribution!.id, /^[a-z0-9][a-z0-9._-]*$/u)
  }
})

test('os-release 解析只取 ID 与 VERSION_ID，容忍引号、注释与重复键', () => {
  assert.deepEqual(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\n'), { id: 'ubuntu', version_id: '24.04' })
  assert.deepEqual(parseOsRelease("ID='debian'\nVERSION_ID='12'\n"), { id: 'debian', version_id: '12' })
  // 行内注释只在未加引号时被剥离。
  assert.deepEqual(parseOsRelease('ID=alpine # minimal\nVERSION_ID=3.19\n'), { id: 'alpine', version_id: '3.19' })
  // 缺失 VERSION_ID 时明确为空，不借用 PRETTY_NAME 或其它字段。
  assert.deepEqual(parseOsRelease('ID=arch\nPRETTY_NAME="Arch Linux"\n'), { id: 'arch', version_id: null })
  // 缺少 ID、非法字符或过长内容一律不产生发行版标识。
  assert.equal(parseOsRelease('VERSION_ID=1\n'), null)
  assert.equal(parseOsRelease('ID=Ubuntu Linux\n'), null)
  assert.equal(parseOsRelease('ID=../etc/passwd\n'), null)
  assert.equal(parseOsRelease('ID=' + 'a'.repeat(64) + '\n'), null)
  // 重复键以最后一次为准。
  assert.deepEqual(parseOsRelease('ID=one\nID=two\nVERSION_ID=1\n'), { id: 'two', version_id: '1' })
})

test('WIRE_MINOR 提升到 1，device_platform 只在双方都广告时协商出来', () => {
  assert.equal(WIRE_MINOR, 1)
  const withCapability = { major: 2, minor: 1, capabilities: ['rpc', 'device_platform'], required: ['rpc'] }
  const oldGateway = { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] }
  assert.deepEqual(negotiate(withCapability, withCapability), {
    major: 2,
    minor: 1,
    capabilities: ['device_platform', 'rpc']
  })
  // 老 Gateway 只广告 2.0：协商结果既没有该能力，minor 也退回 0。
  const negotiated = negotiate(withCapability, oldGateway)
  assert.equal(negotiated.minor, 0)
  assert.deepEqual(negotiated.capabilities, ['rpc'])
  // 单方广告也不构成能力。
  assert.deepEqual(negotiate({ ...withCapability, capabilities: ['rpc'] }, withCapability).capabilities, ['rpc'])
})

test(
  '真实 Connector 在 welcome 后上报一次平台，Gateway 落库并在管理面按历史观测投影',
  { timeout: 20_000 },
  async () => {
    // Gateway 与 Connector 必须都广告该能力；协商按双方交集，单方广告不成立。
    const f = fixture({
      offer: { major: 2, minor: 1, capabilities: ['rpc', 'device_platform'], required: ['rpc'] }
    })
    try {
      const a = f.pair('mock_platform_a')
      const client = f.connector(/** 只交付本次 fixture 凭据。 */ () => a.credential, {
        offer: { major: 2, minor: 1, capabilities: ['rpc', 'device_platform'], required: ['rpc'] },
        platform: () => ({ os: 'linux', arch: 'x64', distribution: { id: 'ubuntu', version_id: '24.04' } })
      })
      await until(
        /** 等真实 welcome 与随后的平台帧都被 Gateway 处理。 */
        () => f.store.devicePlatform(a.machine_id) !== null
      )
      assert.deepEqual(f.store.devicePlatform(a.machine_id), {
        os: 'linux',
        arch: 'x64',
        distribution: { id: 'ubuntu', version_id: '24.04' }
      })
      // 平台写入不推进 resource_revision，也不改变在线状态。
      const machine = f.store.machine(a.machine_id)
      assert.equal(machine.status, 'online')
      // 管理面投影把账本里的上报原样交付，并标注为 store 来源的历史观测。
      const device: DeviceSnapshot = {
        machine_id: a.machine_id,
        name: machine.name,
        labels: null,
        resource_revision: null,
        persisted_state: 'online',
        observed_at: f.now,
        connection: { verification: 'unverified', reason_code: 'backend_unavailable' },
        authentication: { verification: 'unverified', reason_code: 'backend_unavailable' },
        platform: {
          verification: 'verified',
          observed_at: f.now,
          source: 'store',
          value: f.store.devicePlatform(a.machine_id)!
        }
      }
      const projected = createManagementTransportProjection(null, {
        mode: 'active',
        server_time: f.now,
        recovery_generation: f.store.generation(),
        stale_after_ms: 15000
      }).device(device)
      const checked = checkManagementReadReply('devices_get', projected, { machine_id: a.machine_id })
      assert.equal(checked.platform.verification, 'verified')
      assert(checked.platform.verification === 'verified')
      assert.deepEqual(checked.platform.value, {
        os: 'linux',
        arch: 'x64',
        distribution: { id: 'ubuntu', version_id: '24.04' }
      })
      assert.equal(JSON.stringify(checked).includes('/etc/os-release'), false)
      // 只上报一次：连接继续处理后续心跳帧，平台值不被重复写入改变。
      const epoch = client.status().connection_epoch
      assert.equal(typeof epoch, 'string')
      await until(
        /** 至少经过一次心跳周期，且连接仍是同一 epoch。 */ () =>
          client.status().phase === 'ready' && client.status().connection_epoch === epoch
      )
      assert.deepEqual(f.store.devicePlatform(a.machine_id), {
        os: 'linux',
        arch: 'x64',
        distribution: { id: 'ubuntu', version_id: '24.04' }
      })
    } finally {
      f.stop()
    }
  }
)

test('老 Gateway 只广告 2.0 时不收到平台帧，握手与业务调用完全照常', { timeout: 20_000 }, async () => {
  // Gateway 使用升级前的默认 offer（minor 0，无该能力），Connector 仍然广告新能力。
  const f = fixture()
  try {
    const a = f.pair('mock_platform_legacy')
    const client = f.connector(/** 只交付本次 fixture 凭据。 */ () => a.credential, {
      offer: { major: 2, minor: 1, capabilities: ['rpc', 'device_platform'], required: ['rpc'] },
      platform: () => ({ os: 'linux', arch: 'x64', distribution: { id: 'ubuntu', version_id: '24.04' } })
    })
    await until(/** 老 Gateway 仍完成真实认证与 ready。 */ () => client.status().phase === 'ready')
    // 协商结果退回 minor 0，Connector 因此完全不发该帧。
    assert.equal(
      f.encoded.some((frame) => frame.includes('device_platform')),
      false
    )
    assert.equal(f.store.devicePlatform(a.machine_id), null)
    // 业务调用不受影响：旧协议路径照常派发并提交响应。
    const call = f.call(a.target)
    f.gateway.dispatch(call.call_id)
    await until(
      /** 等待真实 Store 的响应事务完成。 */ () => f.router.get(f.principal, call.call_id).state === 'responded'
    )
  } finally {
    f.stop()
  }
})

test('未协商该能力时手工发送平台帧被 codec 拒绝，库内不留下任何平台', { timeout: 20_000 }, async () => {
  const f = fixture()
  try {
    const a = f.pair('mock_platform_unnegotiated')
    const raw = rawConnect(f.gateway.url, a.credential)
    try {
      await until(/** 等待真实 welcome 与 epoch。 */ () => !!raw.epoch)
      raw.ws.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'device_platform',
          message_id: 'unnegotiated_platform',
          machine_id: a.machine_id,
          recovery_generation: a.credential.recovery_generation,
          connection_epoch: raw.epoch,
          payload: { os: 'linux', arch: 'x64', distribution: { id: 'ubuntu', version_id: '24.04' } }
        })
      )
      await until(/** 未协商能力的帧必须关闭该 socket。 */ () => raw.ws.readyState === WebSocket.CLOSED)
      assert.equal(f.store.devicePlatform(a.machine_id), null)
    } finally {
      raw.ws.close()
    }
  } finally {
    f.stop()
  }
})
