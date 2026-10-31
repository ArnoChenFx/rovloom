/**
 * native.provider 缩小范围之后：Gateway 仍登记着 Connector 不再启动的来源，其余来源必须照常可用；
 * 没启动的来源的调用要在有限时间内收敛（不挂起），并且不影响留下的来源。
 * 不预设没启动的来源“应该”报什么——只记录实际表现，供复核者判断。
 * 用法：MCP_CONFIG=... APPEND_KINDS=luvus,herdr NARROW_KIND=luvus bun e2e/provider-narrow-session.mjs
 */
import assert from 'node:assert/strict'
import { connectMixed } from './mixed-client.mjs'

const registered = (process.env.APPEND_KINDS ?? '').split(',').filter(Boolean).sort()
const kept = process.env.NARROW_KIND
assert(kept && registered.includes(kept) && registered.length > 1, 'APPEND_KINDS and NARROW_KIND are required')
const { client, targets, tool, ok, invoke, call } = await connectMixed()
try {
  const machines = await ok('machines_list', {})
  assert.equal(machines.items.length, 1)
  const providers = await ok('providers_list', { machine_id: machines.items[0].machine_id })
  assert.deepEqual(
    providers.items.map((item) => item.kind).sort(),
    registered,
    'Gateway keeps the registered providers'
  )
  /** 留下的来源照常可用：每种 kind 一次只读。 */
  const read = async () => {
    if (kept === 'luvus') {
      const workspaces = await call('luvus', 'workspace.list', {})
      assert(Array.isArray(workspaces.workspaces ?? workspaces.items ?? []))
      return 'workspace.list'
    }
    if (kept === 'herdr') {
      assert.equal((await call('herdr', 'ping', {})).result.type, 'pong')
      return 'ping'
    }
    assert.match((await call('herdr-core', 'server.status', {})).core.id, /^[a-f0-9]{8,64}$/u)
    return 'server.status'
  }
  // 缩小范围后 Connector 可能先重连一次：持续观察 45 秒，记录留下的来源可用性的时间线（成功/失败各一次转折）。
  const timeline = []
  const began = Date.now()
  let last
  while (Date.now() - began < 45_000) {
    let state
    try {
      await read()
      state = 'ok'
    } catch (error) {
      state = 'fail:' + String(error.message).slice(0, 80)
    }
    if (state !== last) {
      timeline.push([Math.round((Date.now() - began) / 100) / 10, state])
      last = state
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  console.error('NARROW_TIMELINE ' + JSON.stringify(timeline))
  const before = await read()
  /** 没启动的来源：记录目录与一次调用的实际表现，且必须在有限时间内收敛。 */
  const stopped = {}
  for (const kind of registered.filter((candidate) => candidate !== kept)) {
    const target = targets.get(kind)
    const started = Date.now()
    const discovered = await tool('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
    const observation = { discover_error: discovered.isError }
    if (!discovered.isError) {
      const item = discovered.data.items.find((entry) => entry.available) ?? discovered.data.items[0]
      observation.available = discovered.data.items.filter((entry) => entry.available).length
      if (item) {
        try {
          const view = await invoke(
            target,
            item.contract_ref,
            { method: item.method, params: {} },
            500,
            Date.now() + 20_000
          )
          observation.call = view.state + (view.reason ? ':' + view.reason : '')
        } catch (error) {
          observation.call = 'tool_error:' + String(error.message).slice(0, 100)
        }
      }
    }
    observation.seconds = Math.round((Date.now() - started) / 100) / 10
    assert(observation.seconds < 60, `${kind} did not settle in time`)
    stopped[kind] = observation
  }
  // 访问过没启动的来源之后，留下的来源必须（在有限时间内）恢复可用；记录中间有没有断开。
  const recovery = []
  const resumed = Date.now()
  let after
  let previous
  while (Date.now() - resumed < 40_000) {
    let state
    try {
      after = await read()
      state = 'ok'
    } catch (error) {
      state = 'fail:' + String(error.message).slice(0, 60)
    }
    if (state !== previous) {
      recovery.push([Math.round((Date.now() - resumed) / 100) / 10, state])
      previous = state
    }
    if (state === 'ok' && recovery.length > 1) {
      break
    }
    if (state === 'ok' && Date.now() - resumed > 8000) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(previous, 'ok', 'kept provider did not recover: ' + JSON.stringify(recovery))
  console.log(JSON.stringify({ ok: true, kept, read: { before, after }, registered, stopped, recovery }))
} finally {
  await client.close()
}
