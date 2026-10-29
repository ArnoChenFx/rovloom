/** 用一次性 Alpine 容器运行 musl 产物：先装 libstdc++，再以隔离环境执行真实命令。 */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

/** 固定镜像与包；不接受环境提供的镜像名、仓库或额外包。
 *  su-exec 只用来把真实命令降回宿主 uid/gid：装包必须以容器 root 运行，
 *  而产品写出的状态目录归当前用户，属主才能与直接执行一致。
 */
export const ALPINE_IMAGE = 'alpine:3.20'
export const ALPINE_PACKAGES = Object.freeze(['libstdc++', 'su-exec'])

/**
 * 构建容器运行时。容器与宿主共享 uid/gid 与网络命名空间：产物仍归当前用户，
 * Gateway 绑定的 127.0.0.1 端口对宿主驱动可见。挂载集合只来自显式 roots、
 * 可执行文件目录、cwd 和绝对路径环境变量，不挂载宿主根目录。
 */
export function alpineRuntime(options = {}) {
  const docker = options.docker ?? 'docker'
  const image = options.image ?? ALPINE_IMAGE
  const packages = options.packages ?? ALPINE_PACKAGES
  const roots = options.roots ?? []
  const uid = options.uid ?? process.getuid?.() ?? 0
  const gid = options.gid ?? process.getgid?.() ?? 0
  const exists = options.exists ?? existsSync
  const runDocker = options.runDocker ?? spawnSync
  // 镜像必须是 `名称[:tag]` 形式（不含 shell 元字符）；包名只允许发行包名字符。
  if (!/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u.test(image)) {
    throw new Error('invalid_alpine_runtime')
  }
  for (const value of packages) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9+._-]*$/u.test(value)) {
      throw new Error('invalid_alpine_runtime')
    }
  }

  /** 同一路径在容器内保持绝对路径，产品配置与状态目录无需改写。 */
  function mounts(executable, args, cwd, env) {
    const candidates = [...roots, dirname(executable), cwd]
    // 绝对路径 argv（例如 --config /abs/config.json）所在目录也必须可见。
    for (const value of args) {
      if (typeof value === 'string' && value.startsWith('/')) {
        candidates.push(dirname(value))
      }
    }
    for (const value of Object.values(env)) {
      if (typeof value === 'string' && value.startsWith('/')) {
        candidates.push(value)
      }
    }
    const directories = []
    for (const path of candidates) {
      if (!exists(path) || directories.some((directory) => path === directory || path.startsWith(directory + '/'))) {
        continue
      }
      // 新目录取代已被它覆盖的旧挂载，避免同一路径出现两份绑定。
      for (let index = directories.length - 1; index >= 0; index--) {
        if (directories[index].startsWith(path + '/')) {
          directories.splice(index, 1)
        }
      }
      directories.push(path)
    }
    return directories.sort()
  }

  return {
    image,
    packages,
    /** 只替换进程启动方式；argv、环境与 cwd 语义与直接执行一致。 */
    wrap(executable, args, { cwd, env }) {
      const pairs = Object.entries(env)
        .filter(
          /** undefined 不是容器环境的一部分；空字符串（例如空 PATH）仍需保留。 */ ([, value]) => value !== undefined
        )
        .map(/** 每个变量作为独立 argv，避免任何 shell 引号解析。 */ ([key, value]) => `${key}=${value}`)
      const directories = mounts(executable, args, cwd, env)
      const name = `rovloom-smoke-${randomUUID()}`
      const command = [
        'create',
        '--name',
        name,
        '--interactive',
        // 产品在容器内绑定 127.0.0.1；共享宿主网络命名空间后驱动进程才能访问这些端口。
        '--network',
        'host',
        '--workdir',
        cwd,
        ...directories.flatMap(/** 绝对路径原样挂载。 */ (directory) => ['-v', `${directory}:${directory}`]),
        image,
        'sh',
        '-c',
        // 装包必须以容器 root 运行（apk 数据库不可写即 99），装完再用 su-exec 降回宿主 uid/gid，
        // 使产物写出的文件仍归当前用户，行为与直接执行一致。
        `apk add --no-cache ${packages.join(' ')} >/dev/null && exec su-exec ${uid}:${gid} env -i "$@"`,
        'rovloom-alpine',
        ...pairs,
        executable,
        ...args
      ]
      // docker CLI 自身需要宿主 PATH；产品环境由上面的 env -i 单独注入。
      let containerId
      let attempted = false
      let removed = false
      // 只有 create 交付确认 ID 后才有可删除的自有容器；未确认时不把「没有容器」误报成删除失败。
      let created = false
      const invoke = (args, timeout) =>
        runDocker(docker, args, {
          cwd,
          env: process.env,
          encoding: 'utf8',
          timeout,
          maxBuffer: 1_048_576,
          windowsHide: true
        })
      return {
        file: docker,
        args: [],
        cwd,
        env: process.env,
        prepare(timeout = 15_000) {
          if (attempted) {
            throw new Error('alpine_launch_already_prepared')
          }
          attempted = true
          const result = invoke(command, timeout)
          const id = typeof result.stdout === 'string' ? result.stdout.trim() : ''
          if (result.status !== 0 || !/^[a-f0-9]{64}$/u.test(id)) {
            // Docker 明确失败（镜像拉不到、名字冲突）说明容器没建，保留原始诊断即可；
            // 但 spawn 失败或超时意味着 create 可能已经建好，只能按随机名尽力删除。
            if (result.error) {
              const cleaned = invoke(['rm', '--force', name], 5_000)
              if (cleaned.error || cleaned.status !== 0) {
                throw Object.assign(new Error('alpine_create_unconfirmed'), { code: 'smoke_cleanup_unknown' })
              }
            }
            throw new Error('alpine_create_failed')
          }
          containerId = id
          created = true
          // create 已确认容器身份，start 不再创建容器；杀死附着客户端不会与创建发生竞争。
          this.args = ['start', '--attach', '--interactive', containerId]
        },
        stop(signal) {
          if (!containerId || !['SIGTERM', 'SIGKILL'].includes(signal)) {
            throw new Error('invalid_alpine_signal')
          }
          const result = invoke(['kill', '--signal', signal, containerId], 5_000)
          if (result.error || result.status !== 0) {
            throw new Error('alpine_signal_failed')
          }
        },
        cleanup() {
          if (!attempted || removed) {
            return
          }
          if (!created) {
            // create 未确认：没有自有容器需要删除，prepare 已判定容器状态或按随机名清理过。
            removed = true
            return
          }
          // 不使用 --rm：即使进程自然退出，容器也保留到本所有者确认删除，rm 成功即为 daemon 的删除确认。
          const result = invoke(['rm', '--force', containerId], 5_000)
          if (result.error || result.status !== 0) {
            throw Object.assign(new Error('alpine_cleanup_unconfirmed'), { code: 'smoke_cleanup_unknown' })
          }
          removed = true
        }
      }
    }
  }
}
