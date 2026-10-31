/**
 * 真实 core 的智能体管理面：目录与说明、terminal.run（程序与模板两种形态）、多轮对话、
 * 读历史、core 明确拒绝的确定结局、blocked 拒绝、三元组栅栏、计划重启与 SIGKILL 后重新附着。
 * 用法：MCP_CONFIG=... HERDR_CORE_HC=... bun e2e/herdr-core-session.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { connect } from './herdr-core-client.mjs'

const env = process.env
for (const name of ['HERDR_CORE_HC', 'HERDR_CORE_BINARY', 'HERDR_CORE_SESSION', 'HERDR_CORE_RUNTIME']) {
  assert(env[name], `${name} is required`)
}
const mode = env.HERDR_CORE_MODE ?? 'attach'
const { client, target, tool, ok, invoke, readAll, call } = await connect()

/** hc 只对沙箱里的 core 生效：环境与 quickstart 启动 core 时一致，联网更新指向本机不可达端口。 */
const hcEnv = {
  HOME: env.HERDR_CORE_HOME ?? env.HOME,
  PATH: '/usr/bin:/bin',
  XDG_RUNTIME_DIR: env.HERDR_CORE_RUNTIME,
  ...(env.HERDR_CORE_STATE ? { XDG_STATE_HOME: env.HERDR_CORE_STATE } : {}),
  HC_SESSION: env.HERDR_CORE_SESSION,
  // managed 的套接字在私有运行目录里：显式给出，避免 hc 按 XDG 公式猜。
  ...(env.HERDR_CORE_SOCKET ? { HC_SOCKET: env.HERDR_CORE_SOCKET } : {}),
  SHELL: '/bin/sh',
  TERM: 'xterm-256color',
  LANG: 'C.UTF-8',
  HERDR_RELEASES_URL: 'http://127.0.0.1:9'
}
function hc(...args) {
  return execFileSync(env.HERDR_CORE_HC, [...args, '--json'], { env: hcEnv, encoding: 'utf8', timeout: 60_000 })
}

/** 确定未派发，并且带公开原因（不给原因时断言失败，避免原因码悄悄退化成裸 not_dispatched）。 */
async function refuses(view, reason, label) {
  assert.equal(view.state, 'not_dispatched', `${label}:${JSON.stringify(view)}`)
  if (reason !== undefined) {
    assert.equal(view.reason, reason, `${label}:${JSON.stringify(view)}`)
  }
}

async function until(description, action, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      return await action()
    } catch (error) {
      last = error
      await pause(250)
    }
  }
  throw new Error(`${description} timed out: ${last instanceof Error ? last.message : String(last)}`)
}

try {
  const machines = await ok('machines_list', {})
  assert.equal(machines.items.length, 1)
  const providers = await ok('providers_list', { machine_id: target.machine_id })
  assert.equal(providers.items[0].kind, 'herdr-core')
  const discovered = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  const entry = (method) => {
    const found = discovered.items.find((item) => item.method === method)
    assert(found, `${method} missing: ${JSON.stringify(discovered.items.map((item) => item.method))}`)
    return found
  }
  const methods = discovered.items.map((item) => item.method).sort()
  // 开关打开时目录里有 6 个读取 + 8 个控制档 + terminal.run + 8 个宿主级 + 长轮询共 24 个；事件订阅与 machine.* 不在其中（见 blocked_methods）。
  assert.deepEqual(methods, [
    'doc.get',
    'doc.set',
    'file.edit',
    'file.read',
    'file.write',
    'machine.exec',
    'server.restart',
    'server.status',
    'server.stop',
    'templates.list',
    'terminal.events',
    'terminal.get',
    'terminal.interrupt',
    'terminal.keep',
    'terminal.keys',
    'terminal.kill',
    'terminal.label',
    'terminal.list',
    'terminal.put',
    'terminal.read',
    'terminal.rm',
    'terminal.run',
    'terminal.send',
    'terminal.wait'
  ])
  for (const method of methods) {
    assert.equal(entry(method).available, true, `${method} should be available with the switch on`)
  }
  // core 自己的说明与 rovloom 的使用说明随 describe 交付，$ref 已展开，被拒绝的参数不出现。
  const runDescription = await ok('runtime_describe', { target, expected_binding_revision: 1, method: 'terminal.run' })
  assert.match(String(runDescription.description), /Start a program in a new terminal/u)
  assert.match(String(runDescription.params_schema.properties.argv.description), /template name and its task/u)
  assert.deepEqual(runDescription.blocked_params, [
    'caller',
    'calls_you',
    'core',
    'on',
    'die_with_parent',
    'children_of'
  ])
  assert.equal(Object.hasOwn(runDescription.params_schema.properties, 'caller'), false)
  // 交互要点：core 侧事实 + 档位/等待/快照/rm 与 hidden_finished 的说明。
  assert.equal((runDescription.guide ?? []).length, 14)
  assert.ok(runDescription.guide.some((line) => line.includes('allow_terminal_execution') && line.includes('tier')))
  assert.ok(runDescription.guide.some((line) => line.includes('runtime_call_get')))
  assert.ok(runDescription.guide.some((line) => line.includes('hidden_finished')))
  // 栅栏字段可选、终端可用名字：说明与实际行为一致。
  assert.ok(runDescription.guide.some((line) => line.includes('core_id') && line.includes('optional')))
  const sendDescription = await ok('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.send'
  })
  assert.deepEqual(sendDescription.params_schema.properties.if.anyOf[0].enum, ['idle', 'working'])
  // 控制档的 terminal 收裸地址或名字，但 `machine/t7` 一律拒绝：说明按实际规则写。
  assert.match(String(sendDescription.params_schema.properties.terminal.description), /t7/u)
  assert.match(String(sendDescription.params_schema.properties.terminal.description), /name/u)
  assert.match(String(sendDescription.params_schema.properties.core_id.description), /Optional/u)
  assert.equal(sendDescription.params_schema.required.includes('core_id'), false)
  assert.equal(sendDescription.params_schema.required.includes('created_ms'), false)
  assert.ok(
    sendDescription.usage.some((line) => line.includes('runtime_call_get')),
    'send usage must point at runtime_call_get'
  )
  const waitDescription = await ok('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.wait'
  })
  assert.ok(waitDescription.usage.some((line) => line.includes('runtime_call_get')))

  const status = await call(entry('server.status').contract_ref, 'server.status', {})
  assert.match(env.HERDR_CORE_EXPECT_VERSION ?? '', /^\d+\.\d+\.\d+$/u)
  assert.equal(status.version, env.HERDR_CORE_EXPECT_VERSION)
  const coreId = status.core.id

  // ---- 省略 params 等同 {}：同一个方法、同一个结果 ----
  const withoutParams = await invoke(entry('server.status').contract_ref, { method: 'server.status' })
  assert.equal(withoutParams.state, 'responded', JSON.stringify(withoutParams))
  const withoutParamsResult = await readAll(withoutParams)
  // 除运行时长外逐字段相同：省略参数没有被当成另一种请求。
  assert.deepEqual({ ...withoutParamsResult, uptime_ms: 0 }, { ...status, uptime_ms: 0 })
  assert.equal(withoutParamsResult.pid, status.pid)

  // ---- 参数预检：登记前就拒绝，带固定路径与规则，且不产生调用记录 ----
  const refusals = [
    // `machine/t7` 走 core 自己的机器表，绕开设备令牌范围：预检就拒绝。
    ['machine route', { method: 'terminal.kill', params: { terminal: 'machine/t1' } }, '/terminal'],
    [
      'null created_ms',
      { method: 'terminal.kill', params: { terminal: 't1', core_id: coreId, created_ms: null } },
      '/created_ms'
    ],
    ['missing text', { method: 'terminal.send', params: { terminal: 't1' } }, '/text'],
    ['server.stop without core_id', { method: 'server.stop', params: {} }, '/core_id']
  ]
  for (const [label, native_request, path] of refusals) {
    const refused = await tool('runtime_call', {
      target,
      expected_binding_revision: 1,
      contract_ref: entry(native_request.method).contract_ref,
      native_request,
      deadline: Date.now() + 30_000,
      wait_ms: 1000
    })
    assert.equal(refused.isError, true, `${label}:${JSON.stringify(refused.raw)}`)
    const error = refused.raw?.gateway_error
    assert.equal(error?.code, 'native_request_invalid', `${label}:${JSON.stringify(refused.raw)}`)
    assert.equal(error?.outcome, 'not_dispatched', `${label}:${JSON.stringify(refused.raw)}`)
    assert.ok(
      (error?.details?.issues ?? []).some((issue) => issue.path === path),
      `${label} issues:${JSON.stringify(error?.details?.issues)}`
    )
    // 被拒的调用没有调用记录：错误里没有 call_id，也没有可读的账本条目。
    assert.equal(error?.call_id, undefined, label)
    assert.equal(refused.data?.call_id, undefined, label)
  }
  // 同一个调用参数修好后可以正常提交，说明预检拒绝没有留下占位记录。
  const retried = await invoke(entry('terminal.list').contract_ref, { method: 'terminal.list', params: {} })
  assert.equal(retried.state, 'responded', JSON.stringify(retried))

  // ---- managed：先确认 Connector 重启前启动的终端还在 ----
  if (mode === 'managed') {
    const listed = await call(entry('terminal.list').contract_ref, 'terminal.list', {})
    const survivor = listed.terminals.find((terminal) => terminal.name === 'survivor')
    assert(
      survivor,
      `survivor terminal missing after connector restart: ${JSON.stringify(listed.terminals.map((t) => t.name))}`
    )
    const read = await call(entry('terminal.read').contract_ref, 'terminal.read', {
      terminal: survivor.address,
      lines: 0
    })
    assert(read.text.includes('survivor'), JSON.stringify(read.text.slice(0, 200)))
  }

  // ---- 长轮询：能发现、能读、状态变化能在事件里看到 ----
  const eventsDescription = await ok('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.events'
  })
  assert.equal(eventsDescription.tier, 'observe')
  assert.ok(eventsDescription.params_schema.properties.after_seq)
  assert.ok(Array.isArray(eventsDescription.usage))
  /** 轮询到出现满足条件的事件为止；返回最后一条结果。 */
  const pollEvents = async (after, predicate, rounds = 20, timeout = 2000, extra = {}) => {
    let cursor = after
    let last
    for (let index = 0; index < rounds; index++) {
      const view = await invoke(entry('terminal.events').contract_ref, {
        method: 'terminal.events',
        params: { after_seq: cursor, limit: 64, timeout_ms: timeout, ...extra }
      })
      assert.equal(view.state, 'responded', JSON.stringify(view))
      last = await readAll(view)
      assert(Array.isArray(last.events) && Array.isArray(last.terminals))
      assert(typeof last.next_after_seq === 'number')
      cursor = last.next_after_seq
      if (predicate(last)) {
        return { poll: last, after: cursor }
      }
    }
    assert.fail(`no matching event: ${JSON.stringify(last?.events?.slice(-5))}`)
  }

  // ---- 程序形态：line 启动 cat，send 后读回 ----
  const cat = await invoke(entry('terminal.run').contract_ref, {
    method: 'terminal.run',
    params: { name: 'cat-e2e', line: 'printf "rovloom-e2e\\n"; exec cat' }
  })
  assert.equal(cat.state, 'responded', JSON.stringify(cat))
  const catResult = await readAll(cat)
  assert.equal(typeof catResult.created_ms, 'number')
  const marker = `rovloom-e2e-${Date.now()}`
  const sent = await invoke(entry('terminal.send').contract_ref, {
    method: 'terminal.send',
    params: {
      terminal: catResult.address,
      core_id: coreId,
      created_ms: catResult.created_ms,
      text: `echo ${marker}\n`
    }
  })
  assert.equal(sent.state, 'responded', JSON.stringify(sent))
  const echoed = await until('terminal.read sees the sent text', async () => {
    const read = await call(entry('terminal.read').contract_ref, 'terminal.read', {
      terminal: catResult.address,
      lines: 0
    })
    assert(read.text.includes(marker), `marker missing: ${JSON.stringify(read.text.slice(-200))}`)
    return read
  })
  const killedCat = await invoke(entry('terminal.kill').contract_ref, {
    method: 'terminal.kill',
    params: { terminal: catResult.address, core_id: coreId, created_ms: catResult.created_ms }
  })
  assert.equal(killedCat.state, 'responded')
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { terminal: catResult.address, core_id: coreId, created_ms: catResult.created_ms, text: 'x' }
    }),
    'terminal_unavailable',
    'send to a finished terminal'
  )
  const removedCat = await invoke(entry('terminal.rm').contract_ref, {
    method: 'terminal.rm',
    params: { terminal: catResult.address, core_id: coreId, created_ms: catResult.created_ms }
  })
  assert.equal(removedCat.state, 'responded')

  // ---- reason 在同一次返回里：`runtime_call` 的 wait_ms 决定它等多久 ----
  const finishedRequest = {
    method: 'terminal.send',
    params: { terminal: catResult.address, text: 'x' }
  }
  const quick = await tool('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry('terminal.send').contract_ref,
    native_request: finishedRequest,
    deadline: Date.now() + 30_000,
    wait_ms: 500
  })
  assert.equal(quick.isError, false, JSON.stringify(quick.raw))
  // 给 wait_ms 时，确定拒绝（已结束/已删除的终端）在首个返回里就是终局 + reason。
  assert.equal(quick.data.state, 'not_dispatched', JSON.stringify(quick.data))
  assert.equal(quick.data.reason, 'terminal_unavailable', JSON.stringify(quick.data))
  // 省略 wait_ms：首个返回允许是 dispatching 或已终局；终局后 reason 一定能经 runtime_call_get 取到。
  const slow = await tool('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry('terminal.send').contract_ref,
    native_request: finishedRequest,
    deadline: Date.now() + 30_000
  })
  assert.equal(slow.isError, false, JSON.stringify(slow.raw))
  let slowView = slow.data
  for (
    let index = 0;
    index < 100 && !['responded', 'not_dispatched', 'outcome_unknown'].includes(slowView.state);
    index++
  ) {
    await pause(50)
    slowView = await ok('runtime_call_get', { call_id: slow.data.call_id, wait_ms: 100 })
  }
  assert.equal(slowView.state, 'not_dispatched', JSON.stringify(slowView))
  assert.equal(slowView.reason, 'terminal_unavailable', JSON.stringify(slowView))

  // ---- timeout 超限：诊断与 describe 都能读到 rovloom 的上限（60 秒）----
  const overTimeout = await tool('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry('terminal.send').contract_ref,
    native_request: {
      method: 'terminal.send',
      params: { terminal: 'e2e', text: 'x', wait: true, timeout: 120 }
    },
    deadline: Date.now() + 30_000,
    wait_ms: 500
  })
  assert.equal(overTimeout.isError, true, JSON.stringify(overTimeout.raw))
  const timeoutError = overTimeout.raw?.gateway_error
  assert.equal(timeoutError?.code, 'native_request_invalid', JSON.stringify(overTimeout.raw))
  assert.ok(
    (timeoutError?.details?.issues ?? []).some((issue) => issue.path === '/timeout' && issue.rule === 'range'),
    JSON.stringify(timeoutError?.details?.issues)
  )
  assert.equal(timeoutError?.details?.parameter_help?.limits?.timeout?.max, 60, JSON.stringify(timeoutError?.details))
  assert.ok(
    (timeoutError?.details?.parameter_help?.rules ?? []).some((line) => line.includes('at most 60')),
    JSON.stringify(timeoutError?.details?.parameter_help?.rules)
  )
  const sendSchema = await ok('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.send'
  })
  assert.equal(sendSchema.params_schema.properties.timeout.maximum, 60)
  assert.match(String(sendSchema.params_schema.properties.timeout.description), /at most 60/u)
  assert.doesNotMatch(String(sendSchema.params_schema.properties.timeout.description), /180|600/u)

  // ---- 栅栏字段可省略、终端可以用名字（用户 2026-10-31 拍板）----
  const named = await invoke(entry('terminal.run').contract_ref, {
    method: 'terminal.run',
    params: { name: 'fence-omit', line: 'exec cat' }
  })
  assert.equal(named.state, 'responded', JSON.stringify(named))
  const namedResult = await readAll(named)
  const markerOmit = `rovloom-omit-${Date.now()}`
  // 省略 core_id 与 created_ms、用名字：成功。
  const omitted = await invoke(entry('terminal.send').contract_ref, {
    method: 'terminal.send',
    params: { terminal: 'fence-omit', text: `echo ${markerOmit}\n` }
  })
  assert.equal(omitted.state, 'responded', JSON.stringify(omitted))
  await until('read sees the named send', async () => {
    const read = await call(entry('terminal.read').contract_ref, 'terminal.read', {
      terminal: 'fence-omit',
      lines: 0
    })
    assert(read.text.includes(markerOmit), `marker missing: ${JSON.stringify(read.text.slice(-200))}`)
    return read
  })
  // 只给 core_id、只给 created_ms 也都可以。
  const onlyCore = await invoke(entry('terminal.send').contract_ref, {
    method: 'terminal.send',
    params: { terminal: 'fence-omit', core_id: coreId, text: `echo only-core-${markerOmit}\n` }
  })
  assert.equal(onlyCore.state, 'responded', JSON.stringify(onlyCore))
  const onlyCreated = await invoke(entry('terminal.keys').contract_ref, {
    method: 'terminal.keys',
    params: { terminal: 'fence-omit', created_ms: namedResult.created_ms, keys: ['enter'] }
  })
  assert.equal(onlyCreated.state, 'responded', JSON.stringify(onlyCreated))
  // 给了错的 created_ms 仍然拒绝，原因是 fence_mismatch（读完之后、写入之前）。
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { terminal: 'fence-omit', created_ms: namedResult.created_ms + 1, text: 'x' }
    }),
    'fence_mismatch',
    'send with a wrong created_ms'
  )
  // 名字不存在：确定未派发，原因是 terminal_unavailable。
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { terminal: 'no-such-terminal', text: 'x' }
    }),
    'terminal_unavailable',
    'send to an unknown name'
  )
  // 用名字 kill / rm：执行端解析成地址后写入，并回收本机名额。
  const killedNamed = await invoke(entry('terminal.kill').contract_ref, {
    method: 'terminal.kill',
    params: { terminal: 'fence-omit' }
  })
  assert.equal(killedNamed.state, 'responded', JSON.stringify(killedNamed))
  const removedNamed = await invoke(entry('terminal.rm').contract_ref, {
    method: 'terminal.rm',
    params: { terminal: 'fence-omit' }
  })
  assert.equal(removedNamed.state, 'responded', JSON.stringify(removedNamed))

  // ---- 模板形态 + 假智能体：多轮对话、读历史、core 明确拒绝 ----
  const templateDir = env.HERDR_CORE_MANAGED_CONFIG
    ? `${env.HERDR_CORE_MANAGED_CONFIG}/herdr-core/templates`
    : `${env.HERDR_CORE_HOME}/.config/herdr-core/templates`
  execFileSync('mkdir', ['-p', '-m', '700', templateDir])
  writeFileSync(
    `${templateDir}/fake.md`,
    [
      '---',
      'description: 假智能体，用于 e2e 多轮对话',
      `command: python3 -I ${env.HERDR_CORE_FAKEAGENT} ${env.HERDR_CORE_FAKEAGENT_LOG}`,
      '---',
      'You are a fake agent used by the rovloom e2e.'
    ].join('\n') + '\n',
    { mode: 0o600 }
  )
  const templates = await call(entry('templates.list').contract_ref, 'templates.list', {})
  assert(
    templates.templates.some((template) => template.name === 'fake'),
    JSON.stringify(templates)
  )

  const agent = await invoke(entry('terminal.run').contract_ref, {
    method: 'terminal.run',
    params: { argv: ['fake', 'first task'], template: true, name: 'fake-agent', no_parent: true, no_notify: true }
  })
  assert.equal(agent.state, 'responded', JSON.stringify(agent))
  const agentResult = await readAll(agent)
  // 模板形态：第一条消息在智能体就绪后送进去。
  assert.equal(agentResult.first_message?.sent, true, JSON.stringify(agentResult.first_message))
  assert.equal(agentResult.parent, null, 'root terminal has no parent')
  const agentFence = { terminal: agentResult.address, core_id: coreId, created_ms: agentResult.created_ms }
  // 第一轮结束后状态是 done（不是 idle）。
  const firstTurn = await until('first turn finishes', async () => {
    const read = await call(entry('terminal.get').contract_ref, 'terminal.get', { terminal: agentResult.address })
    assert.equal(read.status?.state, 'done', JSON.stringify(read.status))
    return read
  })
  // 模板正文与任务各算一行，所以第一轮之后 turn 至少是 1；后面按增量核对。
  assert(firstTurn.turn >= 1, JSON.stringify(firstTurn))

  // 先建立长轮询的水位（订阅快照），再看这一轮的状态变化能不能在事件里看到。
  const baseline = (await pollEvents(0, () => true, 1)).after
  // 第二轮：send wait=true 一次完成「发送并等这一轮结束」。
  const second = await invoke(entry('terminal.send').contract_ref, {
    method: 'terminal.send',
    params: { ...agentFence, text: 'second task', wait: true, timeout: 30 }
  })
  assert.equal(second.state, 'responded', JSON.stringify(second))
  const secondResult = await readAll(second)
  assert.equal(secondResult.wait.reason, 'status', JSON.stringify(secondResult.wait))
  // 结果里的 turn 是文本送入时的轮次，wait.turn 是那一轮结束后的轮次。
  assert.equal(secondResult.turn, firstTurn.turn, JSON.stringify(secondResult))
  assert.equal(secondResult.wait.turn, firstTurn.turn + 1, JSON.stringify(secondResult.wait))
  // 状态从 working→done 在事件里可见（data.status.state，core 的 status 事件带 records/reported/status）。
  const seen = await pollEvents(baseline, (poll) =>
    poll.events.some((event) => event.terminal === agentResult.address && event.fact === 'status')
  )
  assert(
    seen.poll.events.some((event) => ['working', 'done', 'blocked'].includes(String(event.data?.status?.state))),
    JSON.stringify(seen.poll.events.slice(-5))
  )
  // 按 address 过滤：别的终端的事件不进来。
  const filtered = await pollEvents(seen.after, (poll) => poll.terminals.length === 1, 2, 200, {
    address: agentResult.address
  })
  assert.deepEqual(
    filtered.poll.terminals.map((terminal) => terminal.address),
    [agentResult.address]
  )
  // 读历史：lines>0，原样透传 how/complete。
  const history = await call(entry('terminal.read').contract_ref, 'terminal.read', {
    terminal: agentResult.address,
    lines: 200
  })
  assert(history.text.includes('working on: second task'), JSON.stringify(history.text.slice(-300)))
  assert.equal(typeof history.how, 'string')
  assert.equal(typeof history.complete, 'boolean')

  // D1：状态是 done 时 send 带 if:"idle" 被 core 明确拒绝 → 确定未派发，带 core 的类别。
  const mismatch = await invoke(entry('terminal.send').contract_ref, {
    method: 'terminal.send',
    params: { ...agentFence, text: 'should not be typed', if: 'idle' }
  })
  await refuses(mismatch, 'status_mismatch', 'if:idle while done')
  const afterMismatch = await call(entry('terminal.get').contract_ref, 'terminal.get', {
    terminal: agentResult.address
  })
  assert.equal(afterMismatch.turn, secondResult.wait.turn, 'rejected send must not advance the turn')

  // ---- terminal.run wait=true：带显式 timeout，返回 output 与 wait 结果 ----
  const waitedRun = await invoke(entry('terminal.run').contract_ref, {
    method: 'terminal.run',
    params: { line: 'echo run-wait-done', wait: true, timeout: 20, name: 'run-wait' }
  })
  assert.equal(waitedRun.state, 'responded', JSON.stringify(waitedRun))
  const waitedResult = await readAll(waitedRun)
  assert.equal(waitedResult.wait?.ended, true, JSON.stringify(waitedResult.wait))
  assert.match(String(waitedResult.output ?? ''), /run-wait-done/)
  // 结束后清理这个终端（已结束的终端用 rm，仍然走三元组栅栏）。
  const cleanedRun = await invoke(entry('terminal.rm').contract_ref, {
    method: 'terminal.rm',
    params: {
      terminal: waitedResult.address,
      core_id: coreId,
      created_ms: waitedResult.created_ms
    }
  })
  assert.equal(cleanedRun.state, 'responded', JSON.stringify(cleanedRun))

  // ---- terminal.put：往沙箱终端旁放一个文件并读回 ----
  const put = await invoke(entry('terminal.put').contract_ref, {
    method: 'terminal.put',
    params: { ...agentFence, name: 'rovloom-e2e.txt', data: Buffer.from('put-from-rovloom').toString('base64') }
  })
  assert.equal(put.state, 'responded', JSON.stringify(put))
  const putResult = await readAll(put)
  assert.equal(readFileSync(String(putResult.path), 'utf8'), 'put-from-rovloom')
  assert.equal(putResult.bytes, 16)

  // ---- blocked：send/keys/interrupt 都被 rovloom 拒绝，程序日志只有 ready ----
  // 用独立的日志：attach 模式下 quickstart 自己也起了一个 blocked 终端。
  const blockedLog = `${env.HERDR_CORE_BLOCKED_LOG ?? env.HERDR_CORE_FAKEAGENT_LOG + '.blocked'}.e2e`
  const blocked = await invoke(entry('terminal.run').contract_ref, {
    method: 'terminal.run',
    params: {
      name: 'blocked-e2e',
      line: `python3 -I ${env.HERDR_CORE_BLOCKED} ${blockedLog}`
    }
  })
  assert.equal(blocked.state, 'responded', JSON.stringify(blocked))
  const blockedResult = await readAll(blocked)
  const blockedFence = { terminal: blockedResult.address, core_id: coreId, created_ms: blockedResult.created_ms }
  await until('blocked terminal reports blocked', async () => {
    const read = await call(entry('terminal.get').contract_ref, 'terminal.get', { terminal: blockedResult.address })
    assert.equal(read.status?.state, 'blocked', JSON.stringify(read.status))
  })
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { ...blockedFence, text: 'y' }
    }),
    'blocked',
    'blocked send'
  )
  await refuses(
    await invoke(entry('terminal.keys').contract_ref, {
      method: 'terminal.keys',
      params: { ...blockedFence, keys: ['y'] }
    }),
    'blocked',
    'blocked keys'
  )
  await refuses(
    await invoke(entry('terminal.interrupt').contract_ref, { method: 'terminal.interrupt', params: blockedFence }),
    'blocked',
    'blocked interrupt'
  )
  if (existsSync(blockedLog)) {
    assert.equal(readFileSync(blockedLog, 'utf8').trim(), 'ready', 'blocked program received input')
  }
  const interrupted = await invoke(entry('terminal.interrupt').contract_ref, {
    method: 'terminal.interrupt',
    params: agentFence
  })
  assert.equal(interrupted.state, 'responded', JSON.stringify(interrupted))
  const killedAgent = await invoke(entry('terminal.kill').contract_ref, {
    method: 'terminal.kill',
    params: agentFence
  })
  assert.equal(killedAgent.state, 'responded', JSON.stringify(killedAgent))
  const removedAgent = await invoke(entry('terminal.rm').contract_ref, {
    method: 'terminal.rm',
    params: agentFence
  })
  assert.equal(removedAgent.state, 'responded', JSON.stringify(removedAgent))

  // ---- 三元组栅栏与不存在的地址 ----
  const survivorTerminal =
    mode === 'managed'
      ? (await call(entry('terminal.list').contract_ref, 'terminal.list', {})).terminals.find(
          (t) => t.name === 'survivor'
        )
      : (await call(entry('terminal.list').contract_ref, 'terminal.list', {})).terminals.find((t) => t.name === 'e2e')
  assert(survivorTerminal, 'e2e terminal missing')
  const e2e = survivorTerminal
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { terminal: e2e.address, core_id: coreId, created_ms: e2e.created_ms + 1, text: 'x' }
    }),
    'fence_mismatch',
    'created_ms mismatch'
  )
  await refuses(
    await invoke(entry('terminal.kill').contract_ref, {
      method: 'terminal.kill',
      params: { terminal: 't999', core_id: coreId, created_ms: e2e.created_ms }
    }),
    'terminal_unavailable',
    'unknown address'
  )

  // ---- 计划重启后水位重建 ----
  const beforeRestart = (await pollEvents(0, () => true, 1)).after
  hc('server', 'restart')
  const rebuilt = await until('events rebuilt after restart', async () => {
    const view = await invoke(entry('terminal.events').contract_ref, {
      method: 'terminal.events',
      params: { after_seq: beforeRestart + 100, limit: 16, timeout_ms: 500 }
    })
    assert.equal(view.state, 'responded', JSON.stringify(view))
    const poll = await readAll(view)
    assert.equal(poll.rebuilt, true, JSON.stringify(poll))
    return poll
  })
  assert.equal(rebuilt.rebuilt, true)

  // ---- 计划重启与 SIGKILL：重新附着后继续读，在途调用确定结局 ----
  hc('server', 'restart')
  await until('read after server restart', () =>
    call(entry('terminal.read').contract_ref, 'terminal.read', { terminal: e2e.address, lines: 0 })
  )
  const afterRestart = await until('status after server restart', () =>
    call(entry('server.status').contract_ref, 'server.status', {})
  )
  assert.equal(afterRestart.core.id, coreId, 'planned restart keeps core.id')
  const pid = afterRestart.pid
  assert.equal(realpathSync(`/proc/${pid}/exe`), realpathSync(env.HERDR_CORE_BINARY), 'kill only the sandbox core')
  const inflight = await ok('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry('terminal.wait').contract_ref,
    native_request: { method: 'terminal.wait', params: { terminal: e2e.address, timeout: 20 } },
    deadline: Date.now() + 60_000,
    wait_ms: 0
  })
  await pause(300)
  process.kill(pid, 'SIGKILL')
  let inflightView = inflight
  const finished = new Set(['responded', 'not_dispatched', 'outcome_unknown'])
  for (let i = 0; i < 300 && !finished.has(inflightView.state); i++) {
    inflightView = await ok('runtime_call_get', { call_id: inflight.call_id, wait_ms: 100 })
  }
  assert.equal(inflightView.state, 'outcome_unknown', JSON.stringify(inflightView))
  await until('read after SIGKILL', () =>
    call(entry('terminal.read').contract_ref, 'terminal.read', { terminal: e2e.address, lines: 0 })
  )
  const afterKill = await call(entry('server.status').contract_ref, 'server.status', {})
  assert.equal(afterKill.core.id, coreId, 'holder restart keeps core.id')

  console.log(
    JSON.stringify({
      ok: true,
      mode,
      switch: 'on',
      methods: methods.length,
      guide: (runDescription.guide ?? []).length,
      run: { program: 'line', template: true, first_message: agentResult.first_message },
      turns: { first: firstTurn.turn, second: secondResult.turn, wait_reason: secondResult.wait.reason },
      read_history: { how: history.how, complete: history.complete, bytes: history.text.length },
      native_rejection: { if_idle_while_done: mismatch.reason },
      blocked: { send: 'blocked', keys: 'blocked', interrupt: 'blocked', killed: true, removed: true },
      fence: { created_ms: 'fence_mismatch', unknown_address: 'terminal_unavailable' },
      restart: { planned: true, sigkill: true, inflight: inflightView.state, core_id_stable: true },
      events: { status_seen: true, filtered_by_address: true, rebuilt_after_restart: true },
      run_wait: { ended: waitedResult.wait.ended, output: String(waitedResult.output ?? '').trim() },
      put: { path: putResult.path, bytes: putResult.bytes },
      cat_read_bytes: echoed.text.length
    })
  )
} finally {
  await client.close()
}
