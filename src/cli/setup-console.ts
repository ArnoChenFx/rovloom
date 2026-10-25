// 原生准备只依赖结构化控制台：单码直连配对用静默实现（无问答、信息写 stderr），保留未来交互模式的位置。
import type { CliIo } from './run.js'

export type SetupConsole = {
  readonly io: CliIo
  /** 向操作者输出一行状态；静默实现固定写 stderr。 */
  show(text: string): void
  /** 预留的确认钩子；静默实现始终放行（单码直连配对自动批准）。 */
  confirm(text: string, signal?: AbortSignal): Promise<boolean>
  /** 静默实现不校验 TTY 所有权；网络请求路径不构造本接口。 */
  assertOwner(): void
}

// 单码直连配对的非交互控制台：不读 stdin、不提问，状态与提示只写 stderr。
export function silentConsole(io: CliIo): SetupConsole {
  return {
    io,
    show: (text) => {
      io.stderr.write(text)
    },
    confirm: async () => true,
    assertOwner: () => {}
  }
}
