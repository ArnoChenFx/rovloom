// 从受维护的本地模块启动 Bun Worker；构建时将同一入口内嵌为受控 Blob 资源。
import type { CompilerPort } from './compiler-protocol.js'

// 源码入口只使用固定文件，不接受 caller 的路径、代码或 Worker 选项。
export function createCompilerWorker(): CompilerPort {
  const RuntimeWorker = Worker as unknown as new (url: string, options: { smol: boolean }) => CompilerPort
  return new RuntimeWorker(new URL('./compiler-worker.ts', import.meta.url).href, { smol: true })
}
