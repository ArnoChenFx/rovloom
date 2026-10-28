/** 验证固定 Herdr Worker 随 Bun 模块及 standalone 嵌入，产物不依赖源码 Worker 路径。 */
import { phaseTiming } from '../../support/phase-timing.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const api = fileURLToPath(new URL('../../../src/connector/herdr/compiler-api.ts', import.meta.url))
const plugin = fileURLToPath(new URL('../../../scripts/connector/worker-plugin.mjs', import.meta.url))
const raw = readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url))

for (const standalone of [false, true]) {
  test(
    `固定 Herdr Worker 内嵌 ${standalone ? 'standalone' : 'Bun 模块'}`,
    /** 在隔离目录执行真实产物，不从源码 Worker 补包。 */ async () => {
      const directory = mkdtempSync(join(tmpdir(), 'rovloom-herdr-compiler-'))
      try {
        const entry = join(directory, 'entry.ts')
        const fixture = join(directory, 'schema.json')
        const output = join(
          directory,
          standalone ? `herdr-compiler${process.platform === 'win32' ? '.exe' : ''}` : 'bundle.js'
        )
        writeFileSync(fixture, raw)
        writeFileSync(
          entry,
          `
        // 验证本次固定打包产物中的 Herdr Worker。
        import { readFileSync } from 'node:fs';
        import { compileHerdrSchemas, isCompiledHerdrSchemas } from ${JSON.stringify(api)};
        const schemas = await compileHerdrSchemas(readFileSync(${JSON.stringify(fixture)}));
        console.log(JSON.stringify({
          brand: isCompiledHerdrSchemas(schemas),
          request: schemas.request({id:'packaged',method:'ping',params:{}}),
          response: schemas.response({id:'packaged',result:{type:'pong',version:'0.9.5',protocol:22}})
        }));
      `
        )
        const build = await phaseTiming('herdr.package.build.' + (standalone ? 'standalone' : 'module'), () =>
          spawnSync(
            process.execPath,
            [
              '--no-env-file',
              '-e',
              `
        import {compilerWorkerPlugin} from ${JSON.stringify(plugin)};
        const result = await Bun.build({
          entrypoints:[${JSON.stringify(entry)}], target:'bun', format:'esm', packages:'bundle', minify:true,
          plugins:[await compilerWorkerPlugin()],
          ${standalone ? `compile:{outfile:${JSON.stringify(output)}}` : `outdir:${JSON.stringify(directory)},naming:{entry:'bundle.js'}`}
        });
        if (!result.success) throw new AggregateError(result.logs, 'Herdr compiler packaging failed');
      `
            ],
            { cwd: directory, encoding: 'utf8', timeout: 30_000 }
          )
        )
        assert.ifError(build.error)
        assert.equal(build.status, 0, build.stderr)
        rmSync(entry)
        const run = await phaseTiming('herdr.package.run.' + (standalone ? 'standalone' : 'module'), () =>
          spawnSync(standalone ? output : process.execPath, standalone ? [] : ['--no-env-file', output], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 10_000
          })
        )
        assert.ifError(run.error)
        assert.equal(run.status, 0, run.stderr)
        assert.deepEqual(JSON.parse(run.stdout), { brand: true, request: true, response: true })
        assert.equal(run.stderr, '')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
}
