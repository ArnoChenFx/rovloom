/** provider 中立的路径身份核验：逐层归属、权限与可写性；不绑定任何 provider 的端点命名规则。 */
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { windowsInspectPath } from '../platform/windows.js'
import { ProviderAdapterError } from './provider-error.js'

export type OwnedPathKind = 'directory' | 'binary' | 'socket'

/** 命名管道端点不是普通文件，Windows 下须由调用方给出自己的端点命名规则。 */
export type OwnedSocketName = (address: string) => boolean

/** 对路径链逐层检查归属与可写性；目录 ctime 的正常内容变化不改变其身份。 */
export function ownedPathStamp(path: string, kind: OwnedPathKind, socketName?: OwnedSocketName): string {
  if (process.platform === 'win32') {
    // Windows：命名管道端点以名称为身份；目录/二进制按属主 SID + DACL 逐级核验。
    if (kind === 'socket') {
      if (!socketName || !socketName(path)) {
        throw new ProviderAdapterError('owned_path_untrusted')
      }
      return path
    }
    try {
      return windowsInspectPath(path, kind)
    } catch {
      throw new ProviderAdapterError('owned_path_untrusted')
    }
  }
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    throw new ProviderAdapterError('owned_path_untrusted')
  }
  const paths = [path]
  while (paths[0] !== sep) {
    const parent = dirname(paths[0]!)
    if (parent === paths[0]) {
      throw new ProviderAdapterError('owned_path_untrusted')
    }
    paths.unshift(parent)
  }
  const rootOwner = lstatSync(sep, { bigint: true }).uid
  const uid = BigInt(process.geteuid!())
  const stamps: string[] = []
  for (const component of paths) {
    const info = lstatSync(component, { bigint: true })
    const last = component === path
    const mode = Number(info.mode & 0o777n)
    if (
      info.isSymbolicLink() ||
      (mode & 0o022) !== 0 ||
      (info.uid !== uid && info.uid !== 0n && info.uid !== rootOwner) ||
      (!last && !info.isDirectory()) ||
      (last && kind === 'directory' && (!info.isDirectory() || info.uid !== uid || mode !== 0o700)) ||
      (last && kind === 'socket' && (!info.isSocket() || info.uid !== uid || mode !== 0o600)) ||
      (last && kind === 'binary' && (!info.isFile() || (mode & 0o111) === 0 || (info.mode & 0o6000n) !== 0n))
    ) {
      throw new ProviderAdapterError('owned_path_untrusted')
    }
    stamps.push(
      [
        component,
        info.dev,
        info.ino,
        info.uid,
        info.gid,
        info.mode,
        last && kind !== 'directory' ? info.size : '',
        last && kind !== 'directory' ? info.ctimeNs : ''
      ].join(':')
    )
  }
  return stamps.join('\n')
}
