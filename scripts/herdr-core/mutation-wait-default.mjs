#!/usr/bin/env bun
/**
 * 指令 12 的变异检查：terminal.wait 省略 timeout 的默认值。
 * 每条变异都必须先让对应测试变红，恢复后变绿；变异用普通写回还原，不用 git checkout。
 * 用法：bun --no-env-file scripts/herdr-core/mutation-wait-default.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url).pathname
const WAIT = 'test/connector/herdr-core/wait-default.test.ts'

const OMIT_TEST = [WAIT, '-t', 'terminal.wait 省略 timeout 时补成 60']
const PERIOD_TEST = [WAIT, '-t', '补值后的本地期限是本地上限']
const ONLY_WAIT_TEST = [WAIT, '-t', '补值只针对 terminal.wait']

const mutations = [
  {
    name: '不补值',
    file: 'src/connector/herdr-core/provider.ts',
    from: "            request.method === 'terminal.wait' &&",
    to: '            false &&',
    test: OMIT_TEST,
    expect: '(fail) terminal.wait 省略 timeout 时补成 60'
  },
  {
    name: '补成 59',
    file: 'src/connector/herdr-core/provider.ts',
    from: 'params: Object.freeze({ ...params, timeout: HERDR_CORE_WAIT_MAX_SECONDS })',
    to: 'params: Object.freeze({ ...params, timeout: HERDR_CORE_WAIT_MAX_SECONDS - 1 })',
    test: OMIT_TEST,
    expect: '(fail) terminal.wait 省略 timeout 时补成 60'
  },
  {
    name: '补成 61',
    file: 'src/connector/herdr-core/provider.ts',
    from: 'params: Object.freeze({ ...params, timeout: HERDR_CORE_WAIT_MAX_SECONDS })',
    to: 'params: Object.freeze({ ...params, timeout: HERDR_CORE_WAIT_MAX_SECONDS + 1 })',
    test: OMIT_TEST,
    expect: '(fail) terminal.wait 省略 timeout 时补成 60'
  },
  {
    name: '对显式值也覆盖',
    file: 'src/connector/herdr-core/provider.ts',
    from: "            !Object.hasOwn(params, 'timeout')",
    to: '            true',
    test: OMIT_TEST,
    expect: '(fail) terminal.wait 省略 timeout 时补成 60'
  },
  {
    name: '对 terminal.send 也补',
    file: 'src/connector/herdr-core/provider.ts',
    from: "            request.method === 'terminal.wait' &&",
    to: "            (request.method === 'terminal.wait' || request.method === 'terminal.send') &&",
    test: ONLY_WAIT_TEST,
    expect: '(fail) 补值只针对 terminal.wait'
  },
  {
    name: '对 null 也补',
    file: 'src/connector/herdr-core/provider.ts',
    from: "!Object.hasOwn(params, 'timeout')",
    to: "(!Object.hasOwn(params, 'timeout') || params.timeout === null)",
    test: OMIT_TEST,
    expect: '(fail) terminal.wait 省略 timeout 时补成 60'
  },
  {
    name: '本地期限兜底改回 0',
    file: 'src/connector/herdr-core/methods.ts',
    from: 'seconds(params.timeout, HERDR_CORE_WAIT_MAX_SECONDS) * 1000',
    to: 'seconds(params.timeout, 0) * 1000',
    test: PERIOD_TEST,
    expect: '(fail) 补值后的本地期限是本地上限'
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
console.log('变异检查通过：七条变异都让测试变红，恢复后都变绿')
