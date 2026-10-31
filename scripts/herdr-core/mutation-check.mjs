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
    name: 'core 明确拒绝不再标成未知',
    file: 'src/connector/herdr-core/runtime.ts',
    from: '      if (error instanceof HerdrCoreRpcError && HERDR_CORE_NATIVE_REJECTION_KINDS.includes(error.kind)) {',
    to: '      if (false as boolean) {',
    test: ['test/connector/herdr-core/native-error.test.ts', '-t', 'core 明确拒绝的类别是确定未派发'],
    expect: 'not_dispatched'
  },
  {
    name: '模板名核对',
    file: 'src/connector/herdr-core/runtime.ts',
    from: '        await assertHerdrCoreTemplate({',
    to: '        void assertHerdrCoreTemplate({',
    test: ['test/connector/herdr-core/run.test.ts', '-t', '模板声明与真实模板不符时在写入前拒绝'],
    expect: 'herdr_core_template'
  },
  {
    name: 'caller/parent/on 拒绝',
    file: 'src/connector/herdr-core/methods.ts',
    from: "    if (HERDR_CORE_BLOCKED_PARAMS.includes(key)) {\n      fail('herdr_core_param_blocked')\n    }",
    to: "    if (HERDR_CORE_BLOCKED_PARAMS.includes(key) && false) {\n      fail('herdr_core_param_blocked')\n    }",
    test: ['test/connector/herdr-core/run.test.ts', '-t', 'parent/caller/on 一律拒绝'],
    expect: 'herdr_core_param_blocked'
  },
  {
    name: '本机容量上限',
    file: 'src/connector/herdr-core/runtime.ts',
    from: "          if (started.size >= capacity) {\n            fail('herdr_core_run_capacity')\n          }",
    to: "          if (false as boolean) {\n            fail('herdr_core_run_capacity')\n          }",
    test: ['test/connector/herdr-core/run.test.ts', '-t', '本机容量上限'],
    expect: 'herdr_core_run_capacity'
  },
  {
    name: '读历史受开关约束',
    file: 'src/connector/terminal-execution.ts',
    from: "  if (kind === 'herdr-core' && method === 'terminal.read') {\n    return typeof params.lines === 'number' && params.lines > 0\n  }",
    to: "  if (kind === 'herdr-core' && method === 'terminal.read' && false) {\n    return typeof params.lines === 'number' && params.lines > 0\n  }",
    test: ['test/connector/terminal-execution.test.ts', '-t', 'herdr-core 关闭开关时仍列出控制档但标成不可用'],
    expect: 'lines'
  },
  {
    name: '长轮询水位归零重建',
    file: 'src/connector/herdr-core/feed.ts',
    from: '    if (after > watermark) {',
    to: '    if (false as boolean) {',
    test: ['test/connector/herdr-core/events-poll.test.ts', '-t', '水位比当前大'],
    expect: 'rebuilt'
  },
  {
    name: '长轮询截断标记',
    file: 'src/connector/herdr-core/feed.ts',
    from: '      return { rebuilt: false, truncated: true, dropped: floor - after, from: floor }',
    to: '      return { rebuilt: false, truncated: false, dropped: 0, from: floor }',
    test: ['test/connector/herdr-core/events-poll.test.ts', '-t', '缓冲溢出'],
    expect: 'truncated'
  },
  {
    name: '长轮询：追平的调用方不被告知截断',
    file: 'src/connector/herdr-core/feed.ts',
    from: '    return { rebuilt: false, truncated: false, dropped: 0, from: after }\n  }\n',
    to: '    return { rebuilt: false, truncated: after > 0 && floor > 0, dropped: floor, from: after }\n  }\n',
    test: ['test/connector/herdr-core/events-poll-state.test.ts', '-t', '截断只对确实错过事件的调用方成立'],
    expect: 'truncated'
  },
  {
    name: '长轮询：订阅单飞',
    file: 'src/connector/herdr-core/feed.ts',
    from: '    if (subscribing) {\n      return subscribing\n    }\n',
    to: '',
    test: ['test/connector/herdr-core/events-poll-state.test.ts', '-t', '并发的首次轮询共用同一次订阅'],
    expect: 'subscribes'
  },
  {
    name: '长轮询：一条事件唤醒全部等待者',
    file: 'src/connector/herdr-core/feed.ts',
    from: '    for (const done of waiters) {\n      done()\n    }',
    to: '    ;[...waiters].at(-1)?.()',
    test: ['test/connector/herdr-core/events-poll-state.test.ts', '-t', '并发等待的调用方全部被同一条事件唤醒'],
    expect: 'wake'
  },
  {
    name: '长轮询：水位取读快照之前',
    file: 'src/connector/herdr-core/feed.ts',
    from: 'const nextAfter = matching.length > selected.length ? selected.at(-1)!.seq : horizon',
    to: 'const nextAfter = matching.length > selected.length ? selected.at(-1)!.seq : Math.max(view.from, watermark)',
    test: ['test/connector/herdr-core/events-poll-state.test.ts', '-t', '读快照期间到达的事件不会被'],
    expect: 'horizon'
  },
  {
    name: 'core 同帧多行通知逐行解析',
    file: 'src/connector/herdr-core/client.ts',
    from: '    for (const line of frameLines(payload)) {\n      const message = object(parseJson(line, HERDR_CORE_MAX_FRAME_BYTES))',
    to: '    for (const line of [payload]) {\n      const message = object(parseJson(line, HERDR_CORE_MAX_FRAME_BYTES))',
    test: ['test/connector/herdr-core/events.test.ts', '-t', 'core 把紧挨着的通知合并进同一帧时逐行交付'],
    expect: 'invalid_frame_json'
  },
  {
    name: 'managed 套接字就绪要真实连接探测',
    file: 'src/connector/herdr-core/managed.ts',
    from: 'function socketConnectable(socket: string, timeoutMs = 500): Promise<boolean> {',
    to: 'function socketConnectable(socket: string, timeoutMs = 500): Promise<boolean> {\n  try {\n    return Promise.resolve(lstatSync(socket).isSocket())\n  } catch {\n    return Promise.resolve(false)\n  }\n}\nfunction unusedProbe(socket: string, timeoutMs = 500): Promise<boolean> {',
    test: ['test/connector/herdr-core/managed.test.ts', '-t', '残留的陈旧套接字文件不算就绪'],
    expect: 'stale'
  },
  {
    name: '宿主级开关（Connector 最终写入前）',
    file: 'src/connector/herdr-core/runtime.ts',
    from: "      assertTerminalExecutionAllowed(\n        'herdr-core',",
    to: "      void assertTerminalExecutionAllowed && (\n        'herdr-core',",
    test: ['test/connector/herdr-core/host.test.ts', '-t', '开关关闭时宿主级方法'],
    expect: 'terminal_execution_disabled'
  },
  {
    name: '绝对路径检查',
    file: 'src/connector/herdr-core/methods.ts',
    from: "  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\0') || Buffer.byteLength(value) > 4096) {",
    to: "  if (typeof value !== 'string' || value.includes('\\0') || Buffer.byteLength(value) > 4096) {",
    test: ['test/connector/herdr-core/host.test.ts', '-t', '宿主级方法的参数逐项收紧'],
    expect: 'file.read'
  },
  {
    name: 'server.* 的 core_id 栅栏',
    file: 'src/connector/herdr-core/control.ts',
    from: '  if (client.hello.core.id !== coreId) {',
    to: '  if (false as boolean) {',
    test: ['test/connector/herdr-core/host.test.ts', '-t', 'server.* 的 core_id 栅栏'],
    expect: 'core_id'
  },
  {
    name: 'parent 栅栏',
    file: 'src/connector/herdr-core/control.ts',
    from: '  if (live.address !== parent || live.created_ms !== created) {',
    to: '  if (live.address !== parent) {',
    test: ['test/connector/herdr-core/host.test.ts', '-t', 'terminal.run 的 parent 栅栏'],
    expect: 'parent'
  },
  {
    name: 'managed 不走 hc',
    file: 'src/connector/herdr-core/managed.ts',
    from: "  const child = launch(binary, ['serve'], {",
    to: "  const child = launch(binary, ['server', 'start'], {",
    test: ['test/connector/herdr-core/managed.test.ts', '-t', 'managed 直接 exec'],
    expect: 'serve'
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
