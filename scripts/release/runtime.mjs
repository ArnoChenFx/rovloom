/** 选择验收产物的执行方式：原生执行，或用一次性 Alpine 容器运行 musl 产物。 */
import { alpineRuntime } from './alpine.mjs'

/** 原生执行只做参数透传；除 musl 目标外，验收一律在本机原生运行。 */
export const nativeRuntime = Object.freeze({
  kind: 'native',
  wrap: /** 不改变可执行文件、参数、cwd 或环境。 */ (file, args, options) => ({ file, args, ...options })
})

/** 通过环境变量选择容器验收，供 package.mjs 为 musl 目标显式开启。 */
export function smokeRuntime(env = process.env, options = {}) {
  if (env.ROVLOOM_MUSL_ALPINE !== '1') {
    return nativeRuntime
  }
  return Object.assign(alpineRuntime(options), { kind: 'alpine' })
}
