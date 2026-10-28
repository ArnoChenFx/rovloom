/** 隔离验收单文件内的 Luvus / Herdr 编译 Worker（含未知 schema、坏输入）、standalone 和 helper 路径。 */
import assert from 'node:assert/strict'
import { buildStandalone } from './build.mjs'
import { smokeStandalone } from './smoke.mjs'

const output = await buildStandalone({
  entrypoint: 'test/release/native-probe.mjs',
  workers: ['src/connector/luvus/contract/compiler-worker.ts', 'src/connector/herdr/compiler-herdr-worker.ts'],
  probe: 'native-contract'
})
const [result] = await smokeStandalone(output.binary, [{ args: [], code: 0, stderr: /^$/u }])
assert.deepEqual(JSON.parse(result.stdout), {
  scope: 'native-contract-probe',
  documents: 29,
  errorDataPreserved: true,
  unknownSchemaWorker: { documents: 9, malformedRejected: true, unknownKeywordRejected: true, helpersValidated: true },
  herdr: {
    version: '0.9.5',
    originalRoots: true,
    compiledBrand: true,
    unknownSchemaWorker: true
  }
})
console.log(JSON.stringify({ scope: 'native-contract-probe', isolatedRuntime: 'pass', sha256: output.manifest.sha256 }))
