/** 真实浏览器交互的隔离测试入口，仅注入展示投影，不模拟后端授权成功。 */
import { mountWebUi, ReadError, type PageRead, type TimedSnapshot, type PageView } from '../../src/webui/index.js'
import { fixtureReply, fixtureDevice } from './fixtures.js'
import { createManagementPageRead } from '../../src/webui/read.js'

type FixtureMode =
  | 'normal'
  | 'showcase'
  | 'hold'
  | '401'
  | '403'
  | '503'
  | 'degraded'
  | 'partial'
  | 'empty'
  | 'stale'
  | 'expired'
  | 'wrong_machine'
  | 'unverified'
  | 'heartbeat'
  | 'reconnecting'
  | 'pending'
  | 'stale_device'
  | 'stale_connection'
  | 'stale_auth'
  | 'stale_provider'
  | 'stale_runtime'
  | 'stale_children'
  | 'stale_permissions'
  | 'old_calls'
  | 'near_stale'

declare global {
  interface Window {
    webUiFixture: {
      mode: FixtureMode
      reads: number
      aborted: number
      pending: { resolve: (value: TimedSnapshot<PageView>) => void; snapshot: TimedSnapshot<PageView> }[]
      dispose: () => void
      release: () => void
      lastServerTime: number
    }
  }
}

const fixture = {
  mode: 'normal' as FixtureMode,
  reads: 0,
  aborted: 0,
  /** 最近一次交付投影的可信服务时点，供验收脚本按浏览器时区重新计算期望文本。 */
  lastServerTime: 0,
  pending: [] as { resolve: (value: TimedSnapshot<PageView>) => void; snapshot: TimedSnapshot<PageView> }[],
  /** 初始占位，挂载后替换为真实资源清理函数。 */
  dispose: () => {},
  /** 允许测试在导航或取消后交付旧投影。 */
  release: () => {
    for (const entry of fixture.pending.splice(0)) {
      entry.resolve(entry.snapshot)
    }
  }
}
window.webUiFixture = fixture

/** 根据显式测试模式读取 fixture；所有异常均为合成状态。 */
/** 复用与生产宿主相同的只读组合逻辑，替换的仅为共享 DTO 数据来源。 */
const baseRead = createManagementPageRead(
  /** 固定返回隔离 DTO，不连接真实管理端。 */
  async (name, args) => fixtureReply(name, args)
)

/** 调整隔离测试情景，不实现或绕过后台管理员授权。 */
const read: PageRead = async (route, signal) => {
  fixture.reads++
  signal.addEventListener(
    'abort',
    /** 统计页面是否清理读取资源。 */
    () => {
      fixture.aborted++
    },
    { once: true }
  )
  if (fixture.mode === '401') {
    throw new ReadError('unauthenticated')
  }
  if (fixture.mode === '403') {
    throw new ReadError('forbidden')
  }
  if (fixture.mode === '503') {
    throw new Error('fixture-secret-never-render-this')
  }
  const result = await baseRead(route, signal)
  fixture.lastServerTime = result.serverTime
  if (fixture.mode === 'showcase') {
    const samples = ['studio-workstation', 'macbook-pro', 'home-server', 'build-runner'].map((name, index) => {
      const device = fixtureDevice('fixture-a')
      device.machine_id = `demo-device-${index + 1}`
      device.name = name
      device.labels = index < 2 ? ['development', 'workspace'] : index === 2 ? ['home', 'server'] : ['build']
      if (index === 2 && device.connection.verification === 'verified') {
        device.persisted_state = 'offline'
        device.connection.value.state = 'offline'
        device.connection.value.last_heartbeat_at = result.serverTime - 180_000
      }
      if (index === 3) {
        device.persisted_state = 'pending'
        device.connection = { verification: 'unverified', reason_code: 'not_recorded' }
        device.authentication = { verification: 'unverified', reason_code: 'not_recorded' }
      }
      // 四种平台形态各出现一次，供窄屏与双语文案验收真实排版：
      // Linux+发行版、Linux 无发行版（os-release 读不到）、macOS、从未上报。
      device.platform =
        index === 0
          ? { os: 'linux', arch: 'x64', distribution: { id: 'ubuntu', version_id: '24.04' } }
          : index === 1
            ? { os: 'linux', arch: 'arm64', distribution: null }
            : index === 2
              ? { os: 'darwin', arch: 'arm64', distribution: null }
              : null
      return device
    })
    if (route.machineId) {
      result.value.device = samples.find((device) => device.machine_id === route.machineId) ?? samples[0]!
      for (const provider of result.value.providers.items) {
        provider.machine_id = result.value.device.machine_id
      }
    } else {
      result.value.devices = { items: samples }
    }
  }
  if (fixture.mode === 'hold') {
    return new Promise(
      /** 故意不响应取消，检验迟到保护。 */
      (resolve) => {
        fixture.pending.push({ resolve, snapshot: result })
      }
    )
  }
  if (fixture.mode === 'degraded') {
    result.value.status.mode = 'storage_degraded'
  }
  if (fixture.mode === 'partial') {
    result.value.providersProblem = 'unavailable'
    result.value.providers = { items: [] }
  }
  if (fixture.mode === 'empty') {
    result.value.devices = { items: [] }
  }
  if (fixture.mode === 'stale') {
    result.observedAt -= 20_000
  }
  if (fixture.mode === 'expired') {
    result.sessionExpiresAt = result.serverTime
  }
  if (fixture.mode === 'wrong_machine' && result.value.device) {
    result.value.device.machine_id = 'fixture-wrong-machine'
  }
  if (fixture.mode === 'unverified') {
    for (const device of [...result.value.devices.items, ...(result.value.device ? [result.value.device] : [])]) {
      device.connection = { verification: 'unverified', reason_code: 'backend_unavailable' }
      device.authentication = { verification: 'unverified', reason_code: 'not_recorded' }
    }
  }
  if (fixture.mode === 'pending') {
    for (const device of [...result.value.devices.items, ...(result.value.device ? [result.value.device] : [])]) {
      device.persisted_state = 'pending'
    }
  }
  if (fixture.mode === 'heartbeat' && result.value.device) {
    result.value.device.connection = {
      verification: 'verified',
      source: 'gateway_transport',
      observed_at: result.serverTime,
      value: { state: 'offline', connection_epoch_ref: null, last_heartbeat_at: result.serverTime - 60_000 }
    }
    result.value.device.authentication = {
      verification: 'verified',
      source: 'gateway_transport',
      observed_at: result.serverTime,
      value: {
        state: 'expired',
        last_failure: { reason_code: 'heartbeat_timeout', occurred_at: result.serverTime - 1000 }
      }
    }
  }
  if (fixture.mode === 'reconnecting' && result.value.device?.connection.verification === 'verified') {
    result.value.device.connection.value.state = 'reconnecting'
    result.value.device.authentication = { verification: 'unverified', reason_code: 'not_recorded' }
  }
  if (fixture.mode.startsWith('stale_') || fixture.mode === 'near_stale') {
    const observedAt = result.serverTime - (fixture.mode === 'near_stale' ? 14_500 : 60_000)
    const all = fixture.mode === 'stale_children' || fixture.mode === 'near_stale'
    for (const device of [...result.value.devices.items, ...(result.value.device ? [result.value.device] : [])]) {
      if (all || fixture.mode === 'stale_device') {
        device.observed_at = observedAt
      }
      if ((all || fixture.mode === 'stale_connection') && device.connection.verification === 'verified') {
        device.connection.observed_at = observedAt
      }
      if ((all || fixture.mode === 'stale_auth') && device.authentication.verification === 'verified') {
        device.authentication.observed_at = observedAt
      }
    }
    for (const provider of result.value.providers.items) {
      if (all || fixture.mode === 'stale_provider') {
        provider.observed_at = observedAt
      }
      if ((all || fixture.mode === 'stale_runtime') && provider.runtime.verification === 'verified') {
        provider.runtime.observed_at = observedAt
      }
    }
  }
  if (fixture.mode === 'stale_permissions' && result.value.permissions) {
    result.value.permissions.observed_at = result.serverTime - 60_000
  }
  if (fixture.mode === 'old_calls' && result.value.calls) {
    // 复现用户报告的病态累加：调用记录创建于 3,665 秒前，应收敛显示为“1 小时前”。
    const linked = result.serverTime - 3_665 * 1_000
    for (const call of result.value.calls.items) {
      call.created_at = linked
      call.deadline = linked + 30_000
    }
    // 采样窗口的首末时点必须仍落在同一窗口内，否则共享校验会拒收整页投影。
    result.value.calls.window.first_at = linked
    result.value.calls.window.last_at = linked
  }
  return result
}

const root = document.getElementById('rovloom-management')
if (root) {
  fixture.dispose = mountWebUi(root, read)
  const notice = document.createElement('p')
  notice.textContent =
    '隔离测试 fixture / Synthetic fixture: 以下展示不代表真实管理后端、管理员授权或设备链路完成。No production management backend, administrator authorization or device link is verified.'
  notice.setAttribute('role', 'note')
  document.body.prepend(notice)
}
