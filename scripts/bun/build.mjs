/** 构建 Bun 模块与内置管理页静态资源，清除旧输出；不启动 Gateway/Connector 或注入测试数据。 */
import { rmSync } from 'node:fs'
import { toolchain } from './toolchain.mjs'
import { compilerWorkerPlugin } from '../connector/worker-plugin.mjs'
import { buildWebui } from './webui.mjs'
import { resolve } from 'node:path'
import { loadManagementAssets } from '../../src/admin/assets.ts'
import { managementPlugin } from '../release/build.mjs'

toolchain()
rmSync(new URL('../../dist/', import.meta.url), { recursive: true, force: true })
const browserFiles = await buildWebui('dist/webui')
const webui = resolve('dist/webui')
const result = await Bun.build({
  entrypoints: [
    'src/contracts.ts',
    'src/store.ts',
    'src/router.ts',
    'src/protocol.ts',
    'src/connector/luvus/contract/index.ts',
    'src/wire/index.ts',
    'src/connector/luvus/wire.ts',
    'src/wire/persistence.ts',
    'src/connector/luvus/persistence.ts',
    'src/connector/luvus/host/gateway-runtime.ts',
    'src/connector/luvus/host/connector-runtime.ts',
    'src/transport/index.ts',
    'src/runtime/state.ts',
    'src/runtime/gateway.ts',
    'src/runtime/connector-host.ts',
    'src/runtime/connector-attempts.ts',
    'src/runtime/results.ts',
    'src/connector/luvus/index.ts',
    'src/connector/herdr/readonly.ts',
    'src/connector/herdr/compiler-api.ts',
    'src/connector/herdr/installation.ts',
    'src/connector/herdr/runtime.ts',
    'src/connector/herdr/discovery.ts',
    'src/connector/herdr/provider.ts',
    'src/webui/index.ts',
    'src/admin/index.ts',
    'src/mcp/index.ts',
    'src/cli/index.ts',
    'src/cli/main.ts',
    'src/service/index.ts'
  ],
  outdir: 'dist/src',
  root: 'src',
  target: 'bun',
  format: 'esm',
  packages: 'external',
  splitting: true,
  sourcemap: 'external',
  plugins: [await compilerWorkerPlugin(), managementPlugin(webui, loadManagementAssets(webui), { inline: true })]
})
if (!result.success) {
  throw new AggregateError(result.logs, 'Bun build failed')
}
console.log(
  `Built ${result.outputs.length} Bun ESM files/maps and ${browserFiles} browser files/maps; MCP/CLI and management listener require explicit host services and trusted identity/session adapters`
)
