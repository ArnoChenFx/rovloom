#!/usr/bin/env bun
/**
 * 本次改动的变异检查：预检、省略参数规范化、编码阶段兜底原因、裸地址规则。
 * 每条变异都对应一个必须先变红、恢复后变绿的测试；变异用普通写回还原，不用 git checkout。
 * 用法：bun --no-env-file scripts/herdr-core/mutation-preflight.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url).pathname
const PREFLIGHT = 'test/connector/herdr-core/preflight.test.ts'

const mutations = [
  {
    name: '预检跳过审核 schema（只做逐方法复核）',
    file: 'src/connector/herdr-core/preflight.ts',
    from: '  if (HERDR_CORE_SYNTHETIC_METHODS.includes(input.method)) {\n    return\n  }',
    to: '  if (true as boolean) {\n    return\n  }',
    test: [PREFLIGHT, '-t', '预检与 Wire 编码的拒绝集合完全一致'],
    expect: '(fail) 预检与 Wire 编码'
  },
  {
    name: '预检不再指出被屏蔽的参数名',
    file: 'src/connector/herdr-core/preflight.ts',
    from: "      return [{ path: key === undefined ? '/params' : '/' + key, rule: 'invalid_value' }]",
    to: "      void key\n      return [{ path: '/params', rule: 'invalid_value' }]",
    test: [PREFLIGHT, '-t', '拒绝的情形在登记前给出固定路径与规则'],
    expect: '(fail) 拒绝的情形在登记前给出固定路径与规则'
  },
  {
    name: '省略 params 不再规范化',
    file: 'src/connector/herdr-core/provider.ts',
    from: '          return request.params === undefined ? Object.freeze({ ...request, params: {} }) : request',
    to: '          return request',
    test: [PREFLIGHT, '-t', '省略 params 等同空对象'],
    expect: '(fail) 省略 params 等同空对象'
  },
  {
    name: '编码阶段的兜底原因被删',
    file: 'src/transport/gateway.ts',
    from: '        return options.store.gatewayDispatchRefusal(callId)',
    to: '        return undefined',
    test: ['test/transport/dispatch-refusal.test.ts', '-t', 'Gateway raw 编码拒绝未写 socket'],
    expect: '(fail) Gateway raw 编码拒绝未写 socket'
  },
  {
    name: '终端标识的拒绝规则被改成 invalid_value',
    file: 'src/connector/herdr-core/preflight.ts',
    from: "      return [{ path: terminalField(params), rule: 'pattern' }]",
    to: "      return [{ path: terminalField(params), rule: 'invalid_value' }]",
    test: [PREFLIGHT, '-t', '拒绝的情形在登记前给出固定路径与规则'],
    expect: '(fail) 拒绝的情形在登记前给出固定路径与规则'
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
