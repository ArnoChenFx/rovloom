/** Linux cgroup CPU 带宽配额；只读当前进程所属层级，保留小数核，不从 cpus 猜测。 */
import { posix } from 'node:path'
import { readPrivateBytes } from '../storage/files.js'
import type { HostProfileReport } from '../wire/types.js'

type ReadControl = (path: string, maximum: number) => string | undefined

function readControl(path: string, maximum: number): string | undefined {
  try {
    return readPrivateBytes(path, maximum).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** -1/max 表示该层未限额；无效值不得被当成无限配额。 */
export function parseCpuQuota(quota: string, period: string): number | null {
  const denominator = Number(period)
  if (!/^[1-9][0-9]*$/.test(period) || !Number.isSafeInteger(denominator)) {
    throw new Error('cpu_quota_invalid')
  }
  if (quota === 'max' || quota === '-1') {
    return null
  }
  const numerator = Number(quota)
  const cores = numerator / denominator
  if (
    !/^[1-9][0-9]*$/.test(quota) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isFinite(cores) ||
    cores <= 0 ||
    cores > 262144
  ) {
    throw new Error('cpu_quota_invalid')
  }
  return cores
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

type QuotaObservation = Required<Pick<HostProfileReport, 'cpu_quota' | 'cpu_quota_status'>>

/** 读取可见祖先上限；未知不能解释成未限额，未走完的链保留已读上界并标为 partial。 */
export function probeCpuQuota(platform: string = process.platform, read: ReadControl = readControl): QuotaObservation {
  let result: number | null = null
  let observed = false
  let complete = true
  const report = (): QuotaObservation => ({
    cpu_quota: result,
    cpu_quota_status:
      result !== null ? (complete ? 'limited' : 'partial') : complete && observed ? 'unlimited' : 'unknown'
  })
  if (platform !== 'linux') {
    return { cpu_quota: null, cpu_quota_status: 'unsupported' }
  }
  try {
    const memberships = read('/proc/self/cgroup', 65_536)
    const mounts = read('/proc/self/mountinfo', 1_048_576)
    if (memberships === undefined || mounts === undefined) {
      return report()
    }
    for (const row of memberships.trim().split('\n')) {
      const member = /^[^:]+:([^:]*):(\/.*)$/.exec(row)
      if (!member) {
        continue
      }
      const controllers = member[1]!
      const unified = controllers === ''
      if (!unified && !controllers.split(',').includes('cpu')) {
        continue
      }
      for (const mount of mounts.trim().split('\n')) {
        const [left, right] = mount.split(' - ')
        const info = left?.split(' ')
        const system = right?.split(' ')
        if (
          !info ||
          !system ||
          (unified ? system[0] !== 'cgroup2' : system[0] !== 'cgroup' || !system[2]?.split(',').includes('cpu'))
        ) {
          continue
        }
        const root = unescapeMount(info[3] ?? '')
        const point = unescapeMount(info[4] ?? '')
        const current = member[2]!
        if (!posix.isAbsolute(root) || !posix.isAbsolute(point) || posix.normalize(current) !== current) {
          continue
        }
        const relative = posix.relative(root, current)
        if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
          continue
        }
        let directory = posix.join(point, relative)
        for (let depth = 0; depth < 128; depth++) {
          let quota: number | null = null
          if (unified) {
            const raw = read(posix.join(directory, 'cpu.max'), 1024)
            if (raw !== undefined) {
              const parts = raw.trim().split(/\s+/)
              if (parts.length !== 2) {
                throw new Error('cpu_quota_invalid')
              }
              quota = parseCpuQuota(parts[0]!, parts[1]!)
              observed = true
            }
          } else {
            const raw = read(posix.join(directory, 'cpu.cfs_quota_us'), 1024)
            const period = read(posix.join(directory, 'cpu.cfs_period_us'), 1024)
            if ((raw === undefined) !== (period === undefined)) {
              throw new Error('cpu_quota_invalid')
            }
            if (raw !== undefined && period !== undefined) {
              quota = parseCpuQuota(raw.trim(), period.trim())
              observed = true
            }
          }
          if (quota !== null) {
            result = result === null ? quota : Math.min(result, quota)
          }
          if (directory === point) {
            break
          }
          const parent = posix.dirname(directory)
          if (parent === directory || depth === 127) {
            complete = false
            break
          }
          directory = parent
        }
      }
    }
  } catch {
    complete = false
  }
  return report()
}
