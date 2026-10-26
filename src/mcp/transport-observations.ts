/** 将真实Gateway观测投影到已授权管理读模型；不查询设备、不解析管理员身份、不提供管理写入。 */
import type { DeviceSnapshot, ManagementStatus, Observed } from './management.js'
import type { GatewayTransportObservationSource, GatewayTransportSnapshot } from '../transport/observation.js'

export type ManagementObservationFence = Readonly<
  Pick<ManagementStatus, 'mode' | 'server_time' | 'recovery_generation' | 'stale_after_ms'>
>
type UnknownReason = Extract<Observed<never>, { verification: 'unverified' }>['reason_code']
type TransportDevice = GatewayTransportSnapshot['devices'][number]
export interface ManagementTransportProjection {
  readonly transport: ManagementStatus['components']['transport']
  /** 只接收共享服务已经授权、读取的单台设备；没有匹配观测时保持未知。 */
  device(device: DeviceSnapshot): DeviceSnapshot
  /** 当前可信传输证据下的设备连接；无证据时保持未知，不从持久状态推断。 */
  link(machine_id: string): 'connected' | 'unverified'
  /** 指定 provider 在给定绑定 revision 下的派发就绪；revision 不符或无证据时保持未知。 */
  providerReady(
    machine_id: string,
    provider_id: string,
    binding_revision: number
  ): 'ready' | 'unavailable' | 'unverified'
}

/** 可信宿主逐次取样；异常只成为不可用，调用方随后采集同一Store的时间/代次与模式fence。 */
export function sampleManagementTransport(
  source: GatewayTransportObservationSource | undefined
): GatewayTransportSnapshot | null {
  try {
    return source?.snapshot() ?? null
  } catch {
    return null
  }
}

/** 只接受同一服务时钟中的安全毫秒数，不用浏览器或墙钟补造时间。 */
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 每层观测分别保留原时间；较新全局取样不能续期旧连接或认证。 */
function current(value: unknown, fence: ManagementObservationFence): value is number {
  return timestamp(value) && value <= fence.server_time && fence.server_time - value < fence.stale_after_ms
}

/** 未知原因仅限固定公共码，不从异常正文或持久online状态推断offline。 */
function unknown(reason_code: UnknownReason): { verification: 'unverified'; reason_code: UnknownReason } {
  return {
    verification: 'unverified',
    reason_code: ['backend_unavailable', 'not_recorded', 'stale'].includes(reason_code)
      ? reason_code
      : 'backend_unavailable'
  }
}

/** 克隆可公开连接字段；安全epoch引用不能变成原始连接fence或执行许可。 */
function connection(
  value: TransportDevice['connection'],
  fence: ManagementObservationFence
): DeviceSnapshot['connection'] {
  if (value.verification !== 'verified') {
    return unknown(value.reason_code)
  }
  if (!current(value.observed_at, fence) || value.source !== 'gateway_transport') {
    return unknown('stale')
  }
  const link = value.value
  if (
    link.state !== 'online' ||
    typeof link.connection_epoch_ref !== 'string' ||
    !link.connection_epoch_ref.length ||
    link.connection_epoch_ref.length > 1024 ||
    (link.last_heartbeat_at !== null &&
      (!timestamp(link.last_heartbeat_at) || link.last_heartbeat_at > value.observed_at))
  ) {
    return unknown('not_recorded')
  }
  return {
    verification: 'verified',
    observed_at: value.observed_at,
    source: 'gateway_transport',
    value: {
      state: 'online',
      connection_epoch_ref: link.connection_epoch_ref,
      last_heartbeat_at: link.last_heartbeat_at
    }
  }
}

/** 认证与连接独立核验，缺失或过期的认证不因连接online而升级。 */
function authentication(
  value: TransportDevice['authentication'],
  fence: ManagementObservationFence
): DeviceSnapshot['authentication'] {
  if (value.verification !== 'verified') {
    return unknown(value.reason_code)
  }
  if (!current(value.observed_at, fence) || value.source !== 'gateway_transport') {
    return unknown('stale')
  }
  if (value.value.state !== 'authenticated' || value.value.last_failure !== null) {
    return unknown('not_recorded')
  }
  return {
    verification: 'verified',
    observed_at: value.observed_at,
    source: 'gateway_transport',
    value: { state: 'authenticated', last_failure: null }
  }
}

/**
 * 平台是"最近一次上报"的历史观测：已核实就原样复制，未记录就保持未记录。
 * 它不因连接或认证过期而降级，也不会被升级成当前在线事实。
 */
function platform(value: DeviceSnapshot['platform']): DeviceSnapshot['platform'] {
  if (value.verification !== 'verified' || value.source !== 'store') {
    return unknown('not_recorded')
  }
  const platform = value.value
  const distribution = platform.distribution
  if (
    !['linux', 'darwin', 'win32'].includes(platform.os) ||
    !['x64', 'arm64'].includes(platform.arch) ||
    (distribution !== null &&
      (typeof distribution.id !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(distribution.id) ||
        (distribution.version_id !== null &&
          (typeof distribution.version_id !== 'string' ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/u.test(distribution.version_id)))))
  ) {
    return unknown('not_recorded')
  }
  return {
    verification: 'verified',
    observed_at: value.observed_at,
    source: 'store',
    value: {
      os: platform.os,
      arch: platform.arch,
      distribution: distribution === null ? null : { id: distribution.id, version_id: distribution.version_id ?? null }
    }
  }
}

/** 只保留既有Store来源的pending/revoked证明，不把持久登记字段另造认证事实。 */
function storedAuthentication(
  device: DeviceSnapshot,
  fence: ManagementObservationFence
): DeviceSnapshot['authentication'] {
  const auth = device.authentication
  if (
    auth.verification === 'verified' &&
    auth.source === 'store' &&
    auth.value.state === device.persisted_state &&
    current(auth.observed_at, fence)
  ) {
    return {
      verification: 'verified',
      observed_at: auth.observed_at,
      source: 'store',
      value: { state: auth.value.state, last_failure: null }
    }
  }
  return unknown('not_recorded')
}

/** 按当前Store fence准备一次投影；不缓存跨请求观测，不枚举或扩大服务已授权的返回集合。 */
export function createManagementTransportProjection(
  sample: GatewayTransportSnapshot | null,
  fence: ManagementObservationFence
): ManagementTransportProjection {
  const devices = new Map<string, TransportDevice>()
  let transport: ManagementStatus['components']['transport'] = 'unavailable'
  let reason: UnknownReason = 'backend_unavailable'
  try {
    if (fence.mode !== 'active' || !timestamp(fence.server_time) || fence.stale_after_ms !== 15000) {
      sample = null
    } else if (sample !== null) {
      if (sample.recovery_generation !== fence.recovery_generation || !current(sample.observed_at, fence)) {
        transport = 'unverified'
        reason = 'stale'
      } else if (sample.transport.verification !== 'verified') {
        transport = 'unverified'
        reason = sample.transport.reason_code
      } else if (!current(sample.transport.observed_at, fence) || sample.transport.source !== 'gateway_transport') {
        transport = 'unverified'
        reason = 'stale'
      } else if (sample.transport.value === 'unavailable') {
        transport = 'unavailable'
      } else if (sample.transport.value === 'available') {
        for (const item of sample.devices) {
          if (devices.has(item.machine_id)) {
            throw new Error('duplicate_transport_observation')
          }
          devices.set(item.machine_id, item)
        }
        transport = 'available'
        reason = 'not_recorded'
      }
    }
  } catch {
    devices.clear()
    transport = 'unverified'
    reason = 'backend_unavailable'
  }
  return Object.freeze({
    transport,
    /** 白名单复制已授权设备元数据，不把其它设备/provider、原始epoch或秘密带入回复。 */
    device: (device: DeviceSnapshot): DeviceSnapshot => {
      let link: DeviceSnapshot['connection'] = unknown(reason)
      let auth: DeviceSnapshot['authentication'] = unknown(reason)
      if (device.persisted_state === 'pending' || device.persisted_state === 'revoked') {
        auth = storedAuthentication(device, fence)
        link = unknown('not_recorded')
      } else if (transport === 'available') {
        const observed = devices.get(device.machine_id)
        if (observed) {
          try {
            link = connection(observed.connection, fence)
            auth = authentication(observed.authentication, fence)
          } catch {
            link = unknown('backend_unavailable')
            auth = unknown('backend_unavailable')
          }
        }
      }
      return {
        machine_id: device.machine_id,
        name: device.name,
        labels: device.labels === null ? null : [...device.labels],
        resource_revision: device.resource_revision,
        persisted_state: device.persisted_state,
        observed_at: device.observed_at,
        connection: link,
        authentication: auth,
        // 平台是账本里的历史上报，不来自本次传输取样，因此不随连接失效而降级。
        platform: platform(device.platform)
      }
    },
    /** 只把已核实的在线连接投影为 connected；其余一律 unverified，不推测 offline。 */
    link: (machine_id: string): 'connected' | 'unverified' => {
      if (transport !== 'available') {
        return 'unverified'
      }
      const observed = devices.get(machine_id)
      if (!observed) {
        return 'unverified'
      }
      try {
        return connection(observed.connection, fence).verification === 'verified' ? 'connected' : 'unverified'
      } catch {
        return 'unverified'
      }
    },
    /** 绑定 revision 必须与观测一致，否则旧观测不能为新绑定背书；无证据时保持 unverified。 */
    providerReady: (
      machine_id: string,
      provider_id: string,
      binding_revision: number
    ): 'ready' | 'unavailable' | 'unverified' => {
      if (transport !== 'available') {
        return 'unverified'
      }
      const observed = devices.get(machine_id)
      if (!observed) {
        return 'unverified'
      }
      try {
        const provider = observed.providers.find(
          /* 只认同一 provider 且同一 binding revision 的当前观测。 */ (entry) =>
            entry.provider_id === provider_id && entry.binding_revision === binding_revision
        )
        if (!provider || provider.dispatch_ready.verification !== 'verified') {
          return 'unverified'
        }
        if (
          !current(provider.dispatch_ready.observed_at, fence) ||
          provider.dispatch_ready.source !== 'gateway_transport'
        ) {
          return 'unverified'
        }
        return provider.dispatch_ready.value ? 'ready' : 'unavailable'
      } catch {
        return 'unverified'
      }
    }
  })
}
