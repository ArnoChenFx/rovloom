// 异步编译入口只接受受信宿主的安装 schema，经 Bun Worker 生成后登记同步宿主契约。
import { SchemaCompiler } from './compiler-host.js'
import { createCompilerWorker } from './compiler-location.js'
import type { Check, CompiledContract, CompileOptions } from './types.js'

const compiler = new SchemaCompiler(createCompilerWorker)
process.once('exit', /* 角色正常退出时拒绝在途任务并请求回收自有 Worker。 */ () => compiler.close())

// 只改变编译阶段的异步接缝；成功后原 NativeValidator/权限句柄和 Wire 事务仍同步执行。
export function compileBundle(
  bytes: Uint8Array | string,
  options: CompileOptions,
  signal?: AbortSignal
): Promise<Check<CompiledContract>> {
  return compiler.compile(bytes, options, signal)
}
