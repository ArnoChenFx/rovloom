// 启动时当前目录已被删除（终端停在被删目录里）：Bun 构造标准输入终端流会取 cwd 并抛 ENOENT，连 --version 也崩。
import { homedir } from 'node:os'

export type WorkingDirectoryProbe = {
  readonly cwd: () => string
  readonly chdir: (path: string) => void
  readonly home: () => string
}

/** 'present' 当前目录可用；'reset' 已切到家目录；'unavailable' 当前目录不可用且家目录也切不过去（保持原状）。 */
export type WorkingDirectoryState = 'present' | 'reset' | 'unavailable'

const REAL: WorkingDirectoryProbe = { cwd: () => process.cwd(), chdir: (path) => process.chdir(path), home: homedir }

/**
 * 当前目录取不到时切到家目录，让后续按绝对路径或配置目录工作的命令照常运行。
 * 只在 cwd 确实不可用时才动；不读取、不创建、不改写任何文件。
 */
export function recoverWorkingDirectory(probe: WorkingDirectoryProbe = REAL): WorkingDirectoryState {
  try {
    probe.cwd()
    return 'present'
  } catch {
    // 当前目录已不存在，继续尝试家目录。
  }
  try {
    probe.chdir(probe.home())
    return 'reset'
  } catch {
    return 'unavailable'
  }
}
