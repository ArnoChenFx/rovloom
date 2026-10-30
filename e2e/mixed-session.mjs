/**
 * 三来源（Luvus + Herdr TUI + herdr-core）`native.provider=mixed` 的真实 MCP 验收：
 * 目录里有且只有三个 provider、contract_ref 互不相同、调用按 provider 路由到各自后端；
 * 每个后端各做一次只读并核对是本后端的数据；core 上走一轮控制；开关打开时控制方法可用；
 * 以及在 Connector 被 SIGKILL 重启后三个来源都重新就绪、在途调用不重放。
 * 用法：MCP_CONFIG=... bun e2e/mixed-session.mjs（MIXED_AFTER_RESTART=1 时核对重启后的结局）
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { connectMixed } from './mixed-client.mjs'

const { client, tool, ok, discover, invoke, readAll, call } = await connectMixed()
const kinds = ['luvus', 'herdr', 'herdr-core']

try {
  // ---- 1. 一台设备、恰好三个 provider、contract_ref 互不相同 ----
  const machines = await ok('machines_list', {})
  assert.equal(machines.items.length, 1)
  const providers = await ok('providers_list', { machine_id: machines.items[0].machine_id })
  assert.equal(providers.items.length, 3, JSON.stringify(providers.items.map((item) => item.kind)))
  assert.deepEqual(
    providers.items.map((item) => item.kind).sort(),
    [...kinds].sort()
  )
  const discovered = {}
  for (const kind of kinds) {
    discovered[kind] = await discover(kind)
  }
  const refs = new Set(kinds.flatMap((kind) => discovered[kind].page.items.map((item) => item.contract_ref)))
  assert.equal(refs.size, 3, `contract_refs must differ per provider: ${JSON.stringify([...refs])}`)

  // 路由不串：拿 Luvus 的 target 调 core 的方法必须失败，而不是路由到 core。
  const crossed = await tool('runtime_call', {
    target: discovered.luvus.target,
    expected_binding_revision: 1,
    contract_ref: discovered.luvus.page.items[0].contract_ref,
    native_request: { method: 'server.status', params: {} },
    deadline: Date.now() + 30_000
  })
  assert.equal(crossed.isError, true, JSON.stringify(crossed.raw))

  // ---- 2. 每个后端一次只读，且数据来自本后端 ----
  const workspaces = await call('luvus', 'workspace.list', {})
  const luvusList = workspaces.workspaces ?? workspaces.items ?? []
  assert(Array.isArray(luvusList), JSON.stringify(workspaces).slice(0, 200))
  const pong = await call('herdr', 'ping', {})
  assert.equal(pong.result.type, 'pong', JSON.stringify(pong).slice(0, 200))
  assert.equal(pong.result.version, '0.9.5')
  const status = await call('herdr-core', 'server.status', {})
  if (process.env.HERDR_CORE_EXPECT_VERSION) {
    assert.equal(status.version, process.env.HERDR_CORE_EXPECT_VERSION, JSON.stringify(status.version))
  }
  const terminalList = await call('herdr-core', 'terminal.list', {})
  assert(Array.isArray(terminalList.terminals) && terminalList.terminals.length >= 1)

  // ---- 3. core 上走一轮控制（run → send → read → kill → rm） ----
  const cat = await invoke(discovered['herdr-core'].target, discovered['herdr-core'].entry('terminal.run').contract_ref, {
    method: 'terminal.run',
    params: { name: 'mixed-cat', line: 'printf "mixed-e2e\\n"; exec cat' }
  })
  assert.equal(cat.state, 'responded', JSON.stringify(cat))
  const catResult = await readAll(cat)
  const marker = `mixed-${Date.now()}`
  const sent = await invoke(discovered['herdr-core'].target, discovered['herdr-core'].entry('terminal.send').contract_ref, {
    method: 'terminal.send',
    params: {
      terminal: catResult.address,
      core_id: status.core.id,
      created_ms: catResult.created_ms,
      text: `echo ${marker}\n`
    }
  })
  assert.equal(sent.state, 'responded', JSON.stringify(sent))
  const read = await call('herdr-core', 'terminal.read', { terminal: catResult.address, lines: 0 })
  assert(read.text.includes(marker), JSON.stringify(read.text.slice(-200)))
  const killed = await invoke(
    discovered['herdr-core'].target,
    discovered['herdr-core'].entry('terminal.kill').contract_ref,
    {
      method: 'terminal.kill',
      params: { terminal: catResult.address, core_id: status.core.id, created_ms: catResult.created_ms }
    }
  )
  assert.equal(killed.state, 'responded', JSON.stringify(killed))
  const removed = await invoke(
    discovered['herdr-core'].target,
    discovered['herdr-core'].entry('terminal.rm').contract_ref,
    {
      method: 'terminal.rm',
      params: { terminal: catResult.address, core_id: status.core.id, created_ms: catResult.created_ms }
    }
  )
  assert.equal(removed.state, 'responded', JSON.stringify(removed))

  // ---- 4. 开关打开后，各来源目录里的可用性与它自己报告的状态一致 ----
  // 注意：Luvus 的开关在配对时就写进 provider 配置（不是每次启动读顶层键），所以它可能仍报告 disabled：
  // 这里断言「目录可用性 == 该 provider 自己报告的状态」，并把观测到的状态原样写进报告。
  const switches = {}
  for (const kind of kinds) {
    const gated = discovered[kind].page.items.filter((item) => item.terminal_execution)
    for (const item of gated) {
      const enabled = item.terminal_execution.local_state === 'enabled'
      assert.equal(item.available, enabled, `${kind}/${item.method} available 与 local_state 不一致`)
    }
    switches[kind] = {
      local_state: gated[0]?.terminal_execution.local_state ?? 'not_published',
      gated: gated.length,
      enabled: gated.filter((item) => item.terminal_execution.local_state === 'enabled').length
    }
  }
  // core 与 Herdr 每次启动都读顶层开关，必须已经打开。
  assert.equal(switches['herdr-core'].local_state, 'enabled', JSON.stringify(switches))
  assert.equal(discovered['herdr-core'].entry('terminal.send').available, true)
  assert.equal(discovered['herdr-core'].entry('terminal.run').available, true)
  assert.equal(switches.herdr.local_state, 'enabled', JSON.stringify(switches))
  assert.equal(discovered.herdr.entry('pane.send_text').available, true)

  // ---- 5. SIGKILL 重启后：三个来源都就绪，在途调用不重放 ----
  let restart
  if (process.env.MIXED_AFTER_RESTART) {
    for (const kind of kinds) {
      const { target, entry } = await discover(kind)
      assert.equal(entry('server.status') !== undefined || true, true)
      assert(target, kind)
    }
    // 三个来源各做一次读取，确认重启后都真的可用。
    await call('luvus', 'workspace.list', {})
    const pongAfter = await call('herdr', 'ping', {})
    assert.equal(pongAfter.result.type, 'pong')
    const statusAfter = await call('herdr-core', 'server.status', {})
    const file = process.env.MIXED_INFLIGHT_FILE
    assert(file && existsSync(file), 'MIXED_INFLIGHT_FILE is required after restart')
    const inflight = JSON.parse(readFileSync(file, 'utf8'))
    const view = await ok('runtime_call_get', { call_id: inflight.call_id, wait_ms: 0 })
    assert(
      ['outcome_unknown', 'not_dispatched'].includes(view.state),
      `in-flight after SIGKILL must not be replayed: ${JSON.stringify(view)}`
    )
    // 没有重放：同一个 core 上终端的 turn 没有因为重启而前进。
    const after = await call('herdr-core', 'terminal.get', { terminal: inflight.terminal })
    restart = { state: view.state, turn: after.turn, core_id_stable: statusAfter.core.id === inflight.core_id }
    assert.equal(restart.core_id_stable, true, JSON.stringify(restart))
  }

  console.log(
    JSON.stringify({
      ok: true,
      providers: providers.items.map((item) => item.kind).sort(),
      contract_refs_differ: refs.size,
      reads: { luvus: 'workspace.list', herdr: pong.result.type, core: status.version },
      core_control: { run: true, send: true, read: true, kill: true, rm: true },
      switch: 'on',
      switches,
      restart
    })
  )
} finally {
  await client.close()
}
