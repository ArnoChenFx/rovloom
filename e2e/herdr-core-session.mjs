/**
 * 经已部署 Gateway 的 MCP 对真实 herdr-core 走一遍控制档：目录里看到 8 个控制方法、
 * 向 e2e 终端 send 并读回、blocked 终端上 send/keys/interrupt 全部被拒、三元组不符被拒、
 * kill/rm 只作用于 e2e 自己建的终端，以及计划重启与 SIGKILL 后重新附着。
 * 用法：MCP_CONFIG=... HERDR_CORE_HC=... bun e2e/herdr-core-session.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { connect } from './herdr-core-client.mjs'

const env = process.env
for (const name of ['HERDR_CORE_HC', 'HERDR_CORE_BINARY', 'HERDR_CORE_SESSION', 'HERDR_CORE_RUNTIME']) {
  assert(env[name], `${name} is required`)
}
const { client, target, ok, invoke, readAll, call } = await connect()

/** hc 只对沙箱里的 core 生效：环境与 quickstart 启动 core 时一致，联网更新指向本机不可达端口。 */
const hcEnv = {
  HOME: env.HERDR_CORE_HOME ?? env.HOME,
  PATH: '/usr/bin:/bin',
  XDG_RUNTIME_DIR: env.HERDR_CORE_RUNTIME,
  ...(env.HERDR_CORE_STATE ? { XDG_STATE_HOME: env.HERDR_CORE_STATE } : {}),
  HC_SESSION: env.HERDR_CORE_SESSION,
  SHELL: '/bin/sh',
  TERM: 'xterm-256color',
  LANG: 'C.UTF-8',
  HERDR_RELEASES_URL: 'http://127.0.0.1:9'
}
function hc(...args) {
  return execFileSync(env.HERDR_CORE_HC, [...args, '--json'], { env: hcEnv, encoding: 'utf8', timeout: 60_000 })
}

/** 控制档拒绝是确定未派发；不把 outcome_unknown 当成拒绝。 */
async function refuses(view, reason) {
  assert.equal(view.state, 'not_dispatched', `${reason}:${JSON.stringify(view)}`)
}

/** 有界轮询：core 重启后要等 holder 拉起新 core，不无限等。 */
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
  const entry = (method) => discovered.items.find((item) => item.method === method)
  const methods = discovered.items.map((item) => item.method).sort()
  // 开关打开时目录里有 5 个读取 + 8 个控制档；宿主级方法与事件订阅仍不可见。
  assert.deepEqual(methods, [
    'server.status',
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
    'terminal.send',
    'terminal.wait'
  ])
  assert.equal(entry('terminal.send').tier, 'control')
  const described = await ok('runtime_describe', {
    target,
    expected_binding_revision: 1,
    method: 'terminal.send'
  })
  assert.equal(described.tier, 'control')
  assert.deepEqual([...described.params_schema.required].sort(), ['core_id', 'created_ms', 'terminal', 'text'])

  const status = await call(entry('server.status').contract_ref, 'server.status', {})
  assert.equal(status.version, '0.1.14')
  assert.equal(typeof status.pid, 'number')
  const coreId = status.core.id
  assert.match(coreId, /^[a-f0-9]{8,64}$/u)

  /** 终端清单里按名字取本轮自己的两个终端；名字来自 quickstart 的 hc run --name。 */
  const terminals = await call(entry('terminal.list').contract_ref, 'terminal.list', {})
  const named = (name) => {
    const found = terminals.terminals.find((terminal) => terminal.name === name)
    assert(found, `terminal ${name} missing: ${JSON.stringify(terminals.terminals.map((t) => [t.name, t.address]))}`)
    return found
  }
  const e2e = named(env.HERDR_CORE_TERMINAL_NAME ?? 'e2e')
  const blockedTerminal = named(env.HERDR_CORE_BLOCKED_NAME ?? 'blocked')

  // ---- 控制档：send 文字并用 terminal.read(lines=0) 读回 ----
  const marker = `rovloom-e2e-${Date.now()}`
  const sent = await invoke(entry('terminal.send').contract_ref, {
    method: 'terminal.send',
    params: { terminal: e2e.address, core_id: coreId, created_ms: e2e.created_ms, text: `echo ${marker}\n` }
  })
  assert.equal(sent.state, 'responded', JSON.stringify(sent))
  const sentResult = await readAll(sent)
  assert.equal(typeof sentResult.turn, 'number')
  const echoed = await until('terminal.read sees the sent text', async () => {
    const read = await call(entry('terminal.read').contract_ref, 'terminal.read', {
      terminal: e2e.address,
      lines: 0
    })
    assert(read.text.includes(marker), `marker missing: ${JSON.stringify(read.text.slice(-400))}`)
    return read
  })

  // ---- 三元组栅栏：created_ms 不符即拒绝，输入不会送给同地址的另一个终端 ----
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: {
        terminal: e2e.address,
        core_id: coreId,
        created_ms: e2e.created_ms + 1,
        text: `echo ${marker}-wrong\n`
      }
    }),
    'created_ms mismatch'
  )
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { terminal: e2e.address, core_id: 'f'.repeat(16), created_ms: e2e.created_ms, text: 'x' }
    }),
    'core_id mismatch'
  )
  // 名字与远端路由都不是输入目标：参数复核在派发前拒绝，结果是确定未派发。
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { terminal: 'e2e', core_id: coreId, created_ms: e2e.created_ms, text: 'x' }
    }),
    'named target'
  )
  await refuses(
    await invoke(entry('terminal.send').contract_ref, {
      method: 'terminal.send',
      params: { terminal: 'm1/t1', core_id: coreId, created_ms: e2e.created_ms, text: 'x' }
    }),
    'remote target'
  )

  // ---- blocked：core 只在 send 上拦，keys/interrupt 照常送达，所以必须由 rovloom 拒绝 ----
  const blockedNow = await call(entry('terminal.get').contract_ref, 'terminal.get', {
    terminal: blockedTerminal.address
  })
  assert.equal(blockedNow.status?.state, 'blocked', JSON.stringify(blockedNow.status))
  for (const [method, params] of [
    ['terminal.send', { text: 'y\n' }],
    ['terminal.keys', { keys: ['y', 'enter'] }],
    ['terminal.interrupt', {}]
  ]) {
    await refuses(
      await invoke(entry(method).contract_ref, {
        method,
        params: {
          terminal: blockedTerminal.address,
          core_id: coreId,
          created_ms: blockedTerminal.created_ms,
          ...params
        }
      }),
      `blocked ${method}`
    )
  }
  // 输入确实没有送到程序：blocked 程序只写过 ready。
  if (env.HERDR_CORE_BLOCKED_LOG && existsSync(env.HERDR_CORE_BLOCKED_LOG)) {
    const log = readFileSync(env.HERDR_CORE_BLOCKED_LOG, 'utf8')
    assert.equal(log.trim(), 'ready', `blocked program received input: ${JSON.stringify(log.slice(0, 200))}`)
  }
  // blocked 时仍能收拾现场：kill 与 rm 只作用于本轮自己建的终端。
  const killed = await invoke(entry('terminal.kill').contract_ref, {
    method: 'terminal.kill',
    params: { terminal: blockedTerminal.address, core_id: coreId, created_ms: blockedTerminal.created_ms }
  })
  assert.equal(killed.state, 'responded', JSON.stringify(killed))
  const removed = await invoke(entry('terminal.rm').contract_ref, {
    method: 'terminal.rm',
    params: { terminal: blockedTerminal.address, core_id: coreId, created_ms: blockedTerminal.created_ms }
  })
  assert.equal(removed.state, 'responded', JSON.stringify(removed))
  // 不存在的地址：三元组核对读不到终端事实，确定未派发。
  await refuses(
    await invoke(entry('terminal.kill').contract_ref, {
      method: 'terminal.kill',
      params: { terminal: 't999', core_id: coreId, created_ms: e2e.created_ms }
    }),
    'unknown address'
  )

  // ---- 计划重启：连接关闭后重新附着，core.id 不变，旧终端仍可读 ----
  hc('server', 'restart')
  const afterRestart = await until('read after server restart', () =>
    call(entry('terminal.read').contract_ref, 'terminal.read', { terminal: e2e.address, lines: 0 })
  )
  assert.equal(typeof afterRestart.text, 'string')
  const statusAfterRestart = await until('status after server restart', () =>
    call(entry('server.status').contract_ref, 'server.status', {})
  )
  assert.equal(statusAfterRestart.core.id, coreId, 'planned restart keeps core.id')

  // ---- SIGKILL core：在途调用确定是 outcome_unknown，holder 拉起新 core 后能继续读 ----
  const pid = statusAfterRestart.pid
  assert.equal(realpathSync(`/proc/${pid}/exe`), realpathSync(env.HERDR_CORE_BINARY), 'kill only the sandbox core')
  // 长等读取正在执行时杀掉 core：这条调用已写出，结局只能是未知。
  const inflight = await ok('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry('terminal.wait').contract_ref,
    native_request: {
      method: 'terminal.wait',
      params: { terminal: e2e.address, timeout: 20 }
    },
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
  assert.equal(inflightView.state, 'outcome_unknown', `in-flight after SIGKILL: ${JSON.stringify(inflightView)}`)
  // holder 默认 3 秒后自己拉起新 core；重新附着后继续读，core.id 与终端都还在。
  const afterKill = await until('read after SIGKILL', () =>
    call(entry('terminal.read').contract_ref, 'terminal.read', { terminal: e2e.address, lines: 0 })
  )
  assert.equal(typeof afterKill.text, 'string')
  const statusAfterKill = await call(entry('server.status').contract_ref, 'server.status', {})
  assert.equal(statusAfterKill.core.id, coreId, 'holder restart keeps core.id')
  const stillListed = await call(entry('terminal.list').contract_ref, 'terminal.list', {})
  assert(
    stillListed.terminals.some(
      (terminal) => terminal.address === e2e.address && terminal.created_ms === e2e.created_ms
    ),
    'terminal record survives the core restart'
  )

  console.log(
    JSON.stringify({
      ok: true,
      switch: 'on',
      methods,
      core_id: coreId,
      e2e: {
        address: e2e.address,
        created_ms: e2e.created_ms,
        sent_turn: sentResult.turn,
        read_bytes: echoed.text.length
      },
      blocked: {
        address: blockedTerminal.address,
        refused: ['send', 'keys', 'interrupt'],
        killed: true,
        removed: true
      },
      fence: {
        created_ms_mismatch: 'not_dispatched',
        core_id_mismatch: 'not_dispatched',
        named_target: 'not_dispatched',
        remote_target: 'not_dispatched'
      },
      restart: { planned: true, sigkill: true, inflight: inflightView.state, core_id_stable: true }
    })
  )
} finally {
  await client.close()
}
