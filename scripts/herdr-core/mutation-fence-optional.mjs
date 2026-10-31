#!/usr/bin/env bun
/**
 * 指令 10 的变异检查：省略栅栏、给了就核对、解析出的地址、started 记账、预检与编码一致。
 * 每条变异都必须先让对应测试变红，恢复后变绿；变异用普通写回还原，不用 git checkout。
 * 用法：bun --no-env-file scripts/herdr-core/mutation-fence-optional.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url).pathname
const OPTIONAL = 'test/connector/herdr-core/fence-optional.test.ts'
const PREFLIGHT = 'test/connector/herdr-core/preflight.test.ts'

const mutations = [
  {
    name: '省略栅栏时仍然强制要求',
    file: 'src/connector/herdr-core/methods.ts',
    from: '  const coreId = params.core_id\n  const created = params.created_ms\n',
    to: "  const coreId = params.core_id\n  const created = params.created_ms\n  if (coreId === undefined || created === undefined) {\n    fail('herdr_core_terminal_fence_required')\n  }\n",
    test: [OPTIONAL, '-t', 'core_id / created_ms 各自可选'],
    expect: '(fail) core_id / created_ms 各自可选'
  },
  {
    name: '给了字段却跳过比较',
    file: 'src/connector/herdr-core/control.ts',
    from: '  if (fence.created_ms !== undefined && live.created_ms !== fence.created_ms) {',
    to: '  if (false as boolean) {',
    test: [OPTIONAL, '-t', 'core_id / created_ms 各自可选'],
    expect: '(fail) core_id / created_ms 各自可选'
  },
  {
    name: '写入用名字而不是解析出的地址',
    file: 'src/connector/herdr-core/runtime.ts',
    from: 'herdrCoreNativeParams(request.params, resolved)',
    to: 'herdrCoreNativeParams(request.params)',
    test: [OPTIONAL, '-t', '名字解析成地址'],
    expect: '(fail) 名字解析成地址'
  },
  {
    name: 'started 按名字删而不是解析出的地址',
    file: 'src/connector/herdr-core/runtime.ts',
    from: '        started.delete(resolved.terminal ?? String(request.params.terminal))',
    to: '        started.delete(String(request.params.terminal))',
    test: [OPTIONAL, '-t', 'kill/rm 用名字后按解析出的地址回收本机名额'],
    expect: '(fail) kill/rm 用名字后'
  },
  {
    name: '预检与编码规则不一致（只放宽预检的终端地址）',
    file: 'src/connector/herdr-core/preflight.ts',
    from: '  try {\n    reviewHerdrCoreParams(input.method, params)\n  } catch (error) {',
    to: '  try {\n    const relaxed = { ...params, terminal: typeof params.terminal === "string" && params.terminal.includes("/") ? "t1" : params.terminal }\n    reviewHerdrCoreParams(input.method, relaxed)\n  } catch (error) {',
    test: [PREFLIGHT, '-t', '预检与 Wire 编码的拒绝集合完全一致'],
    expect: '(fail) 预检与 Wire 编码'
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
console.log('变异检查通过：五条门禁被去掉时测试都变红，恢复后都变绿')
