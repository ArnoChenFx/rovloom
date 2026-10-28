// 为唯一产品入口组合正常系统服务；检查当前产物与配置格式，不修改权限或自动提权。
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { createNativeServiceBackend } from '../service/native.js'
import { ServiceManager } from '../service/manager.js'
import { ServiceError, type ServiceBackend, type ServiceRole, type ServiceSpec } from '../service/types.js'
import { manifest, serviceControlId } from '../service/spec.js'
import { requestStopPipe, windowsStopPipe } from '../service/windows-control.js'
import { parseJson } from '../json/bounds.js'
import { parseConfig } from './config.js'
import { resolveRoleConfigPath } from './config-path.js'
import type { CliServiceHost } from './run.js'

export type ProductServiceEnvironment = Readonly<{
  platform: string
  arch: string
  executable: string
  standalone: boolean
}>

// Bun 编译入口位于只读虚拟文件系统；源码入口及解释器不能登记为产品服务。
export function productServiceEnvironment(): ProductServiceEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    executable: realpathSync(process.execPath),
    standalone: !!process.versions.bun && /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/u.test(process.argv[1] ?? '')
  }
}

// 本机 native Connector 的服务支持范围：Linux x64、Windows x64 与 macOS（x64 / arm64，LaunchDaemon 以所选用户运行；均有真实 e2e）；其它平台/架构明确拒绝。
function connectorServiceSupported(platform: string, arch: string): boolean {
  return platform === 'darwin'
    ? arch === 'x64' || arch === 'arm64'
    : arch === 'x64' && (platform === 'linux' || platform === 'win32')
}

// 不先执行安装目标；先证明它是本次正在执行的单文件，并保留现有角色平台限制。
export function assertServiceProduct(spec: ServiceSpec, environment: ProductServiceEnvironment): void {
  if (!environment.standalone) {
    throw new ServiceError('backend_unavailable')
  }
  if (spec.platform !== environment.platform || spec.executable !== environment.executable) {
    throw new ServiceError('unsafe_installation')
  }
  // Gateway服务支持三个平台；本机native Connector限Linux x64、Windows x64与macOS。
  if (
    !['linux', 'darwin', 'win32'].includes(environment.platform) ||
    (spec.role === 'connector' && !connectorServiceSupported(environment.platform, environment.arch))
  ) {
    throw new ServiceError('backend_unavailable')
  }
}

// 已有配置只做普通文件/JSON/角色检查；缺失配置留给角色正常首次启动生成，不核对UID/mode/ACL或状态目录。
export async function verifyProductServiceRuntime(
  spec: ServiceSpec,
  environment: ProductServiceEnvironment
): Promise<void> {
  assertServiceProduct(spec, environment)
  if (!statSync(spec.directory).isDirectory()) {
    throw new ServiceError('invalid_arguments')
  }
  let fd: number
  try {
    fd = openSync(spec.config, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  const bytes = Buffer.alloc(16385)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 16384) {
      throw new ServiceError('invalid_arguments')
    }
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) {
        break
      }
      length += count
    }
    const parsed = parseJson(bytes.subarray(0, length), {
      object_bytes: 16384,
      object_depth: 16,
      object_nodes: 4096
    })
    if (length > 16384 || !parsed.ok) {
      throw new ServiceError('invalid_arguments')
    }
    let role: string
    try {
      role = parseConfig(parsed.value).role
    } catch {
      throw new ServiceError('invalid_arguments')
    }
    if (role !== spec.role) {
      throw new ServiceError('invalid_arguments')
    }
  } finally {
    bytes.fill(0)
    closeSync(fd)
  }
}

// 将既有原生后端绑定当前产品及正常停止路径；受信端口便于隔离复现跨两次查询的状态竞态。
export function productServiceBackend(
  native: ServiceBackend,
  environment: ProductServiceEnvironment,
  stopDelivery: (path: string) => Promise<void> = requestStopPipe
): ServiceBackend {
  return {
    ...native,
    // 运行中Windows角色先正常释放资源；排队和启动竞态明确失败，不向Scheduler请求可能强停的取消。
    async stop(spec: ServiceSpec, forRestart?: boolean): Promise<'graceful_request' | void> {
      if (environment.platform === 'win32') {
        assertServiceProduct(spec, environment)
        const current = await native.inspect(spec.role)
        if (!current || manifest(current.spec) !== manifest(spec)) {
          throw new ServiceError('service_conflict')
        }
        if (current.state === 'running') {
          await stopDelivery(windowsStopPipe(spec.role, spec.executable, spec.config, serviceControlId(spec)))
          return 'graceful_request'
        }
      }
      await native.stop(spec, forRestart)
    },
    // 当前不能运行角色的平台在接触系统控制目录、权限或注册之前明确拒绝。
    async authorize(role?: ServiceRole) {
      if (
        !['linux', 'darwin', 'win32'].includes(environment.platform) ||
        !environment.standalone ||
        (role === 'connector' && !connectorServiceSupported(environment.platform, environment.arch))
      ) {
        throw new ServiceError('backend_unavailable')
      }
      await native.authorize()
    }
  }
}

// 构造无副作用；仅 service 动作会 authorize/lock，help/version 也不会触碰系统设施。
export function createProductServiceHost(): CliServiceHost {
  const environment = productServiceEnvironment()
  const native = createNativeServiceBackend({
    platform: environment.platform,
    verifyRuntime: /* 安装和每次启动均验证当前精确产物，不能接管另一安装。 */ async (spec) =>
      verifyProductServiceRuntime(spec, environment)
  })
  const backend = productServiceBackend(native, environment)
  return {
    platform: environment.platform,
    executable: environment.executable,
    manager: new ServiceManager(backend),
    resolveDefaultConfig: /* 与前台共用当前用户的唯一角色文件；安装后只使用保存的绝对路径。 */ (role) =>
      resolveRoleConfigPath(role)
  }
}
