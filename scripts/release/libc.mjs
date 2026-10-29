/** 只读运行时报告与固定加载器路径判断 Linux 所用 libc；不探测用户目录、配置或外部命令。 */
import { existsSync } from 'node:fs'

const MUSL_LOADERS = Object.freeze({
  x64: ['/lib/ld-musl-x86_64.so.1', '/usr/lib/ld-musl-x86_64.so.1'],
  arm64: ['/lib/ld-musl-aarch64.so.1', '/usr/lib/ld-musl-aarch64.so.1']
})

/**
 * 返回 linux 的 'glibc' 或 'musl'，非 linux 返回 null。
 * glibc 由运行时报告证明；musl 由官方加载器文件证明，两者都不成立时拒绝，不按默认值放行。
 */
export function runtimeLibc(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') {
    return null
  }
  const report = options.report ?? process.report?.getReport?.()?.header
  if (report?.glibcVersionRuntime) {
    return 'glibc'
  }
  const arch = options.arch ?? process.arch
  const loaders = MUSL_LOADERS[arch]
  if (!loaders) {
    throw new Error('unsupported_release_libc')
  }
  const exists = options.exists ?? existsSync
  if (loaders.some(/** 加载器是 musl 运行时唯一可核验的证据。 */ (path) => exists(path))) {
    return 'musl'
  }
  throw new Error('unsupported_release_libc')
}
