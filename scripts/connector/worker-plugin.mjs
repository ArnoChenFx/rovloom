// 将两种固定编译 Worker 内嵌进 Bun 产物，避免打包后定位器引用源码或外部入口。
import { fileURLToPath } from 'node:url'

const entries = [
  {
    path: '../../src/connector/luvus/contract/compiler-worker.ts',
    filter: /[/\\]connector[/\\]luvus[/\\]contract[/\\]compiler-location\.ts$/,
    factory: 'createCompilerWorker'
  },
  {
    path: '../../src/connector/herdr/compiler-herdr-worker.ts',
    filter: /[/\\]connector[/\\]herdr[/\\]compiler-location\.ts$/,
    factory: 'createHerdrCompilerWorker'
  }
]

// 对同源的固定 Worker 独立打包；生成物入口不接受运行时 caller 的代码、路径或选项。
async function embeddedWorker(entry) {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entry.path, import.meta.url))],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    minify: true,
    write: false
  })
  if (!built.success || built.outputs.length !== 1) {
    throw new AggregateError(built.logs, 'Schema Worker build failed')
  }
  const workerSource = await built.outputs[0].text()
  return `
    // 内嵌代码来自本次构建的固定 Worker 入口；Blob URL 只由本 Worker 生命周期持有。
    export function ${entry.factory}() {
      const url = URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], {type: 'text/javascript'}))
      try {
        const worker = new Worker(url, {smol: true})
        // 退出或失败后释放资源定位符，避免在 open 时提前撤销仍在加载的脚本。
        const release = () => URL.revokeObjectURL(url)
        worker.addEventListener('error', release, {once: true})
        worker.addEventListener('close', release, {once: true})
        return worker
      } catch (error) { URL.revokeObjectURL(url); throw error }
    }
  `
}

// 保留原 Luvus 构建插件接口，并仅对两个受维护的固定定位模块提供同源内嵌代码。
export async function compilerWorkerPlugin() {
  const contents = await Promise.all(entries.map(/* 分别生成两个固定入口的 Worker 代码。 */ embeddedWorker))
  return {
    name: 'rovloom-schema-worker',
    // 其余模块保持原构建行为；两个工厂保留各自协议和原始 schema 语义。
    setup(build) {
      for (const [index, entry] of entries.entries()) {
        build.onLoad(
          { filter: entry.filter },
          /* 将当前固定定位器替换为本次构建的对应 Worker。 */ () => ({ contents: contents[index], loader: 'js' })
        )
      }
    }
  }
}
