/** 只使用系统 API 与固定标记文件，不启动 shell 或读取用户环境。未知项明确缺省。 */
import { existsSync } from 'node:fs'
import { cpus as visibleCpus, release, totalmem } from 'node:os'
import type { HostProfileReport } from '../wire/types.js'
import { probePlatform } from './device.js'
import { probeCpuQuota } from './cpu-quota.js'

export function probeHostProfile(agentVersion: string): HostProfileReport | undefined {
  const platform = probePlatform()
  if (!platform) {
    return undefined
  }
  let cpus: number | null = null
  let memory: number | null = null
  let kernel: string | null = null
  let container: HostProfileReport['container'] = 'unknown'
  try {
    // 系统可见逻辑 CPU 数量；不将亲和性或 cgroup 配额折算为核数。
    const count = visibleCpus().length
    if (Number.isSafeInteger(count) && count > 0 && count <= 262144) {
      cpus = count
    }
  } catch {
    /* 系统未提供时不猜测。 */
  }
  try {
    const bytes = totalmem()
    if (Number.isSafeInteger(bytes) && bytes > 0) {
      memory = bytes
    }
  } catch {
    /* 系统未提供时不猜测。 */
  }
  try {
    const value = release()
    if (/^[a-zA-Z0-9][a-zA-Z0-9._+~-]{0,127}$/.test(value)) {
      kernel = value
    }
  } catch {
    /* 系统未提供时不猜测。 */
  }
  if (platform.os === 'linux') {
    // 没有已知标记不能证明未容器化，因此保留 unknown，不把缺少标记当成 none。
    if (existsSync('/run/.containerenv')) {
      container = 'podman'
    } else if (existsSync('/.dockerenv')) {
      container = 'docker'
    }
  }
  return Object.freeze({
    os: Object.freeze({
      family: platform.os,
      distribution: platform.distribution
        ? [platform.distribution.id, platform.distribution.version_id].filter(Boolean).join('-')
        : null,
      kernel
    }),
    arch: platform.arch === 'x64' ? 'x86_64' : 'aarch64',
    cpus,
    ...probeCpuQuota(platform.os),
    memory_bytes: memory,
    container,
    agent_version: agentVersion,
    providers: Object.freeze([])
  })
}
