/** 固定真实产品入口；Worker 路径须随原生契约工厂接线更新，不自动搜集或复制其它服务。 */
export const product = {
  entrypoint: 'src/cli/main.ts',
  workers: ['src/connector/luvus/contract/compiler-worker.ts', 'src/connector/herdr/compiler-herdr-worker.ts'],
  assets: [],
  // Gateway切片保留独立验收；完整门禁另含同产物Connector和真实原生ping。
  gatewaySmoke: 'scripts/release/gateway-smoke.mjs',
  // 六目标须真实验收Gateway；只有Linux x64接通同产物原生Owner，任何失败均拒绝收据。
  releaseSmoke: 'scripts/release/product-smoke.mjs'
}
