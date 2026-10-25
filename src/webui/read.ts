/** 只消费共享管理读取操作；不接受浏览器 AdminContext，不实现后台授权或管理变更。 */
import type { ManagementArguments, ManagementReply, ManagementStatus, DeviceSnapshot } from '../mcp/management.js'
import { ReadError } from './reader.js'
import type { PageRead } from './page.js'
import type { PageView } from './view.js'

export type ManagementReadOperation =
  | 'status'
  | 'devices_list'
  | 'devices_get'
  | 'providers_list'
  | 'providers_get'
  | 'permissions_get'
  | 'calls_list'

/** 由共享受保护管理传输提供；真正 AdminContext 只能在服务端中间件注入。 */
export type ManagementReadTransport = <K extends ManagementReadOperation>(
  operation: K,
  args: ManagementArguments[K],
  signal: AbortSignal
) => Promise<ManagementReply[K]>

/** 同一页的全局模式、策略、恢复代次与 history fence 必须一致。 */
function statusFence(status: ManagementStatus): string {
  return JSON.stringify([
    status.mode,
    status.recovery_generation,
    status.policy_revision,
    status.history?.history_epoch ?? null,
    status.history?.accept_new_until ?? null
  ])
}

/** 详情读取前后核对设备 revision、认证与 connection epoch，不将新旧观测混合。 */
function deviceFence(device: DeviceSnapshot): string {
  return JSON.stringify([
    device.machine_id,
    device.resource_revision,
    device.persisted_state,
    device.connection.verification === 'verified'
      ? [device.connection.value.state, device.connection.value.connection_epoch_ref]
      : device.connection.reason_code,
    device.authentication.verification === 'verified'
      ? device.authentication.value.state
      : device.authentication.reason_code
  ])
}

/** Provider/权限部分失败只允许固定可公开分类，401 等全局失败必须清空整页。 */
function partialProblem(error: unknown): 'forbidden' | 'unavailable' {
  if (error instanceof ReadError && (error.problem === 'forbidden' || error.problem === 'not_found')) {
    return 'forbidden'
  }
  if (!(error instanceof ReadError) || error.problem === 'unavailable') {
    return 'unavailable'
  }
  throw error
}

/** 将共享 DTO 组合成一致页面；每次 execute 的认证/资源授权仍由既有服务重新执行。 */
export function createManagementPageRead(transport: ManagementReadTransport): PageRead {
  return /* 串行有界读取，不缓存授权、不续 history scope，也不调用任何写操作。 */ async (route, signal) => {
    /** 取消后不得继续调用下一项管理读取。 */
    async function execute<K extends ManagementReadOperation>(
      name: K,
      args: ManagementArguments[K]
    ): Promise<ManagementReply[K]> {
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      return transport(name, args, signal)
    }
    const before = await execute('status', {})
    const page: PageView = {
      status: before,
      devices: { items: [] },
      device: null,
      providers: { items: [] },
      permissions: null,
      providersProblem: null,
      calls: null,
      callsProblem: null
    }
    if (route.machineId === null) {
      page.devices = await execute('devices_list', {
        limit: 50,
        ...(route.cursor === null ? {} : { cursor: route.cursor })
      })
      if (route.section === 'calls') {
        // 调用窗口与设备列表同属全局范围；部分失败只标记该区块，不清空整页。
        try {
          page.calls = await execute('calls_list', {
            limit: 50,
            ...(route.callsCursor ? { cursor: route.callsCursor } : {})
          })
        } catch (error) {
          page.callsProblem = partialProblem(error)
        }
      }
    } else {
      const target = { machine_id: route.machineId }
      const device = await execute('devices_get', target)
      page.device = device
      try {
        page.providers = await execute('providers_list', {
          ...target,
          limit: 50,
          ...(route.providerCursor === null ? {} : { cursor: route.providerCursor })
        })
      } catch (error) {
        page.providersProblem = partialProblem(error)
      }
      try {
        page.permissions = await execute('permissions_get', target)
      } catch (error) {
        partialProblem(error)
      }
      const currentDevice = await execute('devices_get', target)
      if (deviceFence(device) !== deviceFence(currentDevice)) {
        throw new ReadError('conflict')
      }
      page.device = currentDevice
    }
    const after = await execute('status', {})
    if (statusFence(before) !== statusFence(after) || after.server_time < before.server_time) {
      throw new ReadError('conflict')
    }
    if (
      page.permissions &&
      (page.permissions.recovery_generation !== after.recovery_generation ||
        page.permissions.policy_revision !== after.policy_revision)
    ) {
      throw new ReadError('conflict')
    }
    // 调用窗口的采样时点必须落在同一次读取的状态 fence 内，不能与新的全局状态混拼。
    if (page.calls && (page.calls.observed_at < before.observed_at || page.calls.observed_at > after.observed_at)) {
      throw new ReadError('conflict')
    }
    page.status = after
    // 共享状态没有管理员会话期限；权限 TTL/history 截止均不能被冒充为登录期限。
    return {
      value: page,
      serverTime: after.server_time,
      observedAt: Math.min(before.observed_at, after.observed_at),
      sessionExpiresAt: null
    }
  }
}
