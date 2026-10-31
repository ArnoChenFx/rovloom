#!/usr/bin/env bun
/**
 * 指令 11 的变异检查：描述上限与常量一致、parameter_help 带上限、预检与编码的 timeout 上限一致。
 * 每条变异都必须先让对应测试变红，恢复后变绿；变异用普通写回还原，不用 git checkout。
 * 用法：bun --no-env-file scripts/herdr-core/mutation-limits.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url).pathname
const LIMITS = 'test/connector/herdr-core/limits.test.ts'

const mutations = [
  {
    name: '描述里的 maximum 与复核常量不一致',
    file: 'src/connector/herdr-core/overlay.ts',
    from: '      schema.maximum = limit.max',
    to: '      schema.maximum = limit.max + 1',
    test: [LIMITS, '-t', '五个 timeout 的说明与 schema 上限都来自复核常量'],
    expect: '(fail) 五个 timeout 的说明与 schema 上限都来自复核常量'
  },
  {
    name: 'parameter_help 里去掉上限句子与数值',
    file: 'src/connector/herdr-core/overlay.ts',
    from: '  const limits = HERDR_CORE_LIMITS[method]\n  if (limits) {',
    to: '  const limits = undefined as (typeof HERDR_CORE_LIMITS)[string] | undefined\n  if (limits) {',
    test: [LIMITS, '-t', '超限被拒时 parameter_help 能读到上限'],
    expect: '(fail) 超限被拒时 parameter_help 能读到上限'
  },
  {
    name: '只放宽预检的 timeout 上限（编码不跟）',
    file: 'src/connector/herdr-core/preflight.ts',
    from: '    reviewHerdrCoreParams(input.method, params)',
    to: '    reviewHerdrCoreParams(input.method, typeof params.timeout === "number" && params.timeout > 60 ? { ...params, timeout: 60 } : params)',
    test: ['test/connector/herdr-core/preflight.test.ts', '-t', '预检与 Wire 编码的拒绝集合完全一致'],
    expect: '(fail) 预检与 Wire 编码的拒绝集合完全一致'
  }
]

/** 运行单个测试文件；返回状态与输出，由调用方判断红/绿。 */
function run(args) {
  const result = spawnSync('bun', ['--no-env-file', 'test', ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

let failed = 0
for (const mutation of mutations) {
  const path = ROOT + mutation.file
  const original = readFileSync(path, 'utf8')
  if (!original.includes(mutation.from)) {
    console.error(`SKIP ${mutation.name}: 变异锚点不存在（源码已变化）`)
    failed += 1
    continue
  }
  try {
    writeFileSync(path, original.replace(mutation.from, mutation.to))
    const red = run(mutation.test)
    const caught = red.status !== 0 && red.output.includes(mutation.expect)
    console.log(`${caught ? 'RED  ' : 'MISS '} ${mutation.name} → ${caught ? '测试按预期失败' : '测试仍然通过'}`)
    if (!caught) {
      failed += 1
      if (process.env.MUTATION_DEBUG) {
        console.error(red.output.slice(-800))
      }
    }
  } finally {
    // 普通写回还原：不删文件、不用 git checkout，保留工作区其它改动。
    writeFileSync(path, original)
  }
  const green = run(mutation.test)
  console.log(
    `${green.status === 0 ? 'GREEN' : 'BROKEN'} ${mutation.name} → 恢复后${green.status === 0 ? '通过' : '仍未通过'}`
  )
  if (green.status !== 0) {
    failed += 1
  }
}
if (failed) {
  console.error(`变异检查失败：${failed} 项`)
  process.exit(1)
}
console.log('变异检查通过：三条门禁被去掉时测试都变红，恢复后都变绿')
