#!/usr/bin/env bun
/**
 * 变异检查：把三条安全门禁逐条去掉，对应的测试必须变红，再恢复原文件。
 * 用法：bun --no-env-file scripts/herdr-core/mutation-check.mjs
 * 退出码非 0 表示某个变异没有被测试抓到（门禁实际上没有被测试覆盖）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url).pathname
const TEST = 'test/connector/herdr-core/control.test.ts'
const PROVIDER = 'test/connector/herdr-core/provider.test.ts'

const mutations = [
  {
    name: 'blocked 判定',
    file: 'src/connector/herdr-core/control.ts',
    from: "  if (blocked(live.status)) {\n    fail('herdr_core_terminal_blocked')\n  }",
    to: "  if (blocked(live.status) && false) {\n    fail('herdr_core_terminal_blocked')\n  }",
    test: [TEST, '-t', 'blocked 由 rovloom 自己判断'],
    expect: 'herdr_core_terminal_blocked'
  },
  {
    name: '终端三元组核对',
    file: 'src/connector/herdr-core/control.ts',
    from: "  if (live.address !== fence.address || live.created_ms !== fence.created_ms) {\n    fail('herdr_core_terminal_identity_mismatch')\n  }",
    to: "  if (live.address !== fence.address) {\n    fail('herdr_core_terminal_identity_mismatch')\n  }",
    test: [TEST, '-t', 'created_ms 与 core.id 不一致'],
    expect: 'herdr_core_terminal_identity_mismatch'
  },
  {
    name: '本机开关（Connector 最终写入前）',
    file: 'src/connector/herdr-core/runtime.ts',
    from: "      assertTerminalExecutionAllowed(\n        'herdr-core',\n        { method: request.method, params: request.params },\n        options.terminalExecution ? options.terminalExecution() : false\n      )",
    to: '      void assertTerminalExecutionAllowed',
    test: [TEST, '-t', '本机开关关闭时控制档在原生写入前拒绝'],
    expect: 'terminal_execution_disabled'
  },
  {
    name: '本机开关（Gateway 登记前）',
    file: 'src/connector/herdr-core/provider.ts',
    from: "            if (requiresTerminalExecution('herdr-core', method, object(candidate.params ?? {})) && !terminalEnabled()) {\n              fail('terminal_execution_disabled')\n            }",
    to: '            void requiresTerminalExecution',
    test: [PROVIDER, '-t', '资源工厂登记五个端口'],
    expect: 'terminal_execution_disabled'
  }
]

/** 运行单个测试文件；返回 stdout+stderr，由调用方判断红/绿。 */
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
    if (process.env.MUTATION_DEBUG) {
      console.error(JSON.stringify({ status: red.status, tail: red.output.slice(-300) }))
    }
    // 测试变红的判据是它自己被报告为失败；错误码可能只出现在断言详情里。
    const caught = red.status !== 0 && red.output.includes('(fail) ' + mutation.test.at(-1))
    console.log(
      `${caught ? 'RED  ' : 'MISS '} ${mutation.name} → ${caught ? '测试按预期失败（' + mutation.test.at(-1) + '）' : '测试仍然通过'}`
    )
    if (!caught) {
      failed += 1
    }
  } finally {
    writeFileSync(path, original)
  }
  const green = run(mutation.test)
  const restored = green.status === 0
  console.log(`${restored ? 'GREEN' : 'BROKEN'} ${mutation.name} → 恢复后${restored ? '通过' : '仍未通过'}`)
  if (!restored) {
    failed += 1
  }
}
if (failed) {
  console.error(`变异检查失败：${failed} 项`)
  process.exit(1)
}
console.log('变异检查通过：四条门禁被去掉时测试都变红，恢复后都变绿')
