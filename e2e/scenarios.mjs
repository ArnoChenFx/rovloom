/** 端到端场景；每个场景独占一套新状态并返回可记录的证据，断言失败即场景失败。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { ok, tool, until } from './harness.mjs'

const METHODS = ['ping', 'session.snapshot', 'workspace.create', 'pane.send_text']

/** 用session.snapshot计数workspace；这是区分“执行0次/1次/2次”的原生旁证。 */
async function workspaces(stack, client) {
  const view = await stack.invoke(client, { method: 'session.snapshot', params: {} })
  assert.equal(view.state, 'responded', `e2e_snapshot:${JSON.stringify(view)}`)
  return (await stack.readResult(client, view)).result.snapshot.workspaces.length
}

/** 启动三件套并等到真实ping通过。 */
async function boot(stack) {
  await stack.startGateway()
  stack.startConnector()
  const client = await stack.connect()
  await stack.waitReady(client)
  return client
}

export const scenarios = [
  {
    name: 'full-chain-herdr',
    methods: METHODS,
    /** discover → describe → call → get → result_read，另有一次有副作用的写与读回。 */
    async run(stack) {
      const client = await boot(stack)
      const machines = await ok(client, 'machines_list', {})
      assert.equal(machines.items.length, 1)
      const providers = await ok(client, 'providers_list', { machine_id: stack.target.machine_id })
      assert.equal(providers.items[0].kind, 'herdr')
      const discovered = await ok(client, 'runtime_discover', {
        target: stack.target,
        expected_binding_revision: 1,
        limit: 100
      })
      const names = discovered.items.map((item) => item.method).sort()
      for (const method of ['ping', 'session.snapshot', 'workspace.create', 'pane.list']) {
        assert(names.includes(method), `exposed method missing: ${method}`)
      }
      assert(!names.includes('pane.send_text'), 'terminal write must be hidden')
      const described = await ok(client, 'runtime_describe', {
        target: stack.target,
        expected_binding_revision: 1,
        method: 'ping'
      })
      assert.equal(described.method, 'ping')
      const pong = await stack.invoke(client, { method: 'ping', params: {} })
      assert.equal(pong.state, 'responded')
      const page = await ok(client, 'runtime_result_read', { result_id: pong.result.result_id, max_bytes: 16_384 })
      const bytes = Buffer.from(page.chunk, 'base64')
      assert.equal(createHash('sha256').update(bytes).digest('hex'), page.sha256)
      const reply = JSON.parse(bytes.toString('utf8'))
      assert.equal(reply.result.type, 'pong')
      assert.equal(reply.result.version, '0.9.5')
      const before = await workspaces(stack, client)
      const created = await stack.invoke(client, { method: 'workspace.create', params: {} })
      assert.equal(created.state, 'responded')
      assert.equal(await workspaces(stack, client), before + 1)
      return { herdr: reply.result.version, methods: names, workspaces_after_create: before + 1 }
    }
  },
  {
    name: 'idempotent-retry',
    methods: METHODS,
    /** 同key同意图合并为一次执行；同key不同意图被拒；无key不去重。 */
    async run(stack) {
      const client = await boot(stack)
      const before = await workspaces(stack, client)
      const request = {
        target: stack.target,
        expected_binding_revision: 1,
        contract_ref: stack.f.contractRef,
        native_request: { method: 'workspace.create', params: {} },
        deadline: Date.now() + 120_000,
        wait_ms: 500,
        client_request_key: 'e2e-retry-1'
      }
      const first = await ok(client, 'runtime_call', request)
      const second = await ok(client, 'runtime_call', request)
      assert.equal(second.call_id, first.call_id, 'same key and intent must return the same call')
      await until(
        'first_settled',
        async () => (await ok(client, 'runtime_call_get', { call_id: first.call_id })).state !== 'dispatching'
      )
      assert.equal(await workspaces(stack, client), before + 1, 'retry must not execute twice')
      const conflict = await tool(client, 'runtime_call', {
        ...request,
        native_request: { method: 'workspace.create', params: { label: 'other' } }
      })
      assert.equal(conflict.isError, true)
      assert.equal(conflict.raw.gateway_error.code, 'conflict')
      const a = await stack.invoke(client, { method: 'ping', params: {} })
      const b = await stack.invoke(client, { method: 'ping', params: {} })
      assert.notEqual(a.call_id, b.call_id, 'calls without a key are never merged')
      return { merged_call_id: first.call_id, conflict: conflict.raw.gateway_error.code, workspaces: before + 1 }
    }
  },
  {
    name: 'terminal-switch',
    methods: METHODS,
    /** 开关关闭：写终端被拒但连接与只读调用不受影响；改配置重启后同一调用被放行。 */
    async run(stack) {
      const client = await boot(stack)
      await stack.invoke(client, { method: 'workspace.create', params: {} })
      const send = { method: 'pane.send_text', params: { pane_id: 'w1:p1', text: 'e2e' } }
      const denied = await stack.invoke(client, send)
      assert.equal(denied.state, 'not_dispatched', `e2e_terminal_off:${JSON.stringify(denied)}`)
      assert.equal((await stack.invoke(client, { method: 'ping', params: {} })).state, 'responded')
      await stack.connector.stop()
      const path = stack.f.connectorConfigPath
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), allow_terminal_execution: true }))
      stack.startConnector()
      await stack.waitReady(client)
      const snapshot = await stack.invoke(client, { method: 'session.snapshot', params: {} })
      let pane = (await stack.readResult(client, snapshot)).result.snapshot.panes[0]?.pane_id
      if (!pane) {
        await stack.invoke(client, { method: 'workspace.create', params: {} })
        const next = await stack.invoke(client, { method: 'session.snapshot', params: {} })
        pane = (await stack.readResult(client, next)).result.snapshot.panes[0]?.pane_id
      }
      assert(pane, 'e2e_pane_missing')
      const allowed = await stack.invoke(client, { ...send, params: { ...send.params, pane_id: pane } })
      assert.equal(allowed.state, 'responded')
      const written = await stack.readResult(client, allowed)
      assert.equal(written.error, undefined, `e2e_native_error:${JSON.stringify(written)}`)
      const names = (
        await ok(client, 'runtime_discover', { target: stack.target, expected_binding_revision: 1, limit: 100 })
      ).items.map((i) => i.method)
      assert(names.includes('pane.send_text'), 'catalog shows the method once the switch is on')
      return { switch_off: denied.state, switch_on: allowed.state, native_reply: written.result?.type }
    }
  },
  {
    name: 'connector-restart',
    methods: ['ping'],
    /** Connector正常重启：离线时立即失败而非挂起，重启后恢复并回收旧native。 */
    async run(stack) {
      const client = await boot(stack)
      const oldNative = stack.natives()
      assert.equal(oldNative.length, 1)
      await stack.connector.stop()
      assert.equal(stack.connector.exit.code, 0)
      for (const child of oldNative) {
        assert.equal(stack.alive(child), false, 'native child must be reaped on graceful stop')
      }
      const started = Date.now()
      const offline = await stack.invoke(client, { method: 'ping', params: {} })
      const elapsed = Date.now() - started
      assert.equal(offline.submit_error?.gateway_error?.code, 'unavailable')
      assert(elapsed < 2000, `offline call must fail fast: ${elapsed}ms`)
      stack.startConnector()
      const recovered = await stack.waitReady(client)
      assert.equal(recovered.state, 'responded')
      assert.equal(stack.natives().length, 1)
      return { offline_error: 'unavailable', offline_ms: elapsed, recovered: true }
    }
  },
  {
    name: 'connector-crash',
    methods: ['ping'],
    /** kill -9：孤儿native仍监听时重启fail-closed；native也消失（等同掉电）后重启自动清理遗留并恢复。 */
    async run(stack) {
      const client = await boot(stack)
      const natives = stack.natives()
      await stack.connector.kill()
      const offline = await stack.invoke(client, { method: 'ping', params: {} })
      assert.equal(offline.submit_error?.gateway_error?.code, 'unavailable')
      stack.startConnector()
      const refused = await stack.connector.closed
      assert.equal(refused.code, 3, 'a live orphan native must keep the restart fail-closed')
      assert(existsSync(stack.f.ownerPath), 'the owner record must survive a refused restart')
      for (const child of natives) {
        assert.equal(stack.alive(child), true, 'a refused restart must not touch the orphan')
        process.kill(child.pid, 'SIGKILL') // 模拟整机掉电：native也不存在
      }
      await pause(300)
      stack.startConnector()
      const recovered = await stack.waitReady(client, { tries: 60 })
      assert.equal(recovered.state, 'responded')
      assert.match(stack.connector.output.stderr, /herdr_crash_residue_cleared/)
      return {
        gateway_view: 'unavailable',
        restart_with_live_orphan: 'refused_fail_closed',
        restart_after_orphan_gone: 'auto_recovered'
      }
    }
  },
  {
    name: 'attach-existing',
    methods: METHODS,
    attach: true,
    /** 用户已在运行 Herdr：Connector 附着它而不是再起一个；Connector 退出不影响用户的实例。 */
    async run(stack) {
      const userPid = await stack.startUserHerdr()
      const client = await boot(stack)
      const processes = stack.herdrProcesses()
      assert.equal(processes.length, 1, 'attaching must not start a second herdr')
      assert.equal(processes[0].pid, userPid)
      const before = await workspaces(stack, client)
      const created = await stack.invoke(client, { method: 'workspace.create', params: {} })
      assert.equal(created.state, 'responded')
      assert.equal(await workspaces(stack, client), before + 1)
      await stack.connector.stop()
      assert.equal(stack.herdrProcesses().length, 1, 'the user instance must survive the connector')
      assert.equal(stack.herdrProcesses()[0].pid, userPid)
      return { attached_pid: userPid, herdr_processes: 1, survived_connector_stop: true }
    }
  },
  {
    name: 'attach-create-persist',
    methods: METHODS,
    attach: true,
    /** 没有现成实例：Connector 自建一个并放手；Connector 退出后它继续运行，重启后重新附着到同一个。 */
    async run(stack) {
      assert.equal(stack.herdrProcesses().length, 0)
      const client = await boot(stack)
      const created = stack.herdrProcesses()
      assert.equal(created.length, 1)
      await workspaces(stack, client)
      await stack.invoke(client, { method: 'workspace.create', params: {} })
      await stack.connector.stop()
      assert.equal(stack.herdrProcesses().length, 1, 'the created instance must outlive the connector')
      assert.equal(stack.herdrProcesses()[0].pid, created[0].pid)
      stack.startConnector()
      await stack.waitReady(client)
      assert.equal(stack.herdrProcesses().length, 1, 'restart must re-attach, not create another')
      assert.equal(stack.herdrProcesses()[0].pid, created[0].pid)
      // 持久会话里之前创建的 workspace 还在：证明复用的是同一个实例而不是新的。
      assert.equal(await workspaces(stack, client), 1)
      return { pid: created[0].pid, reused_after_restart: true, workspaces_kept: 1 }
    }
  },
  {
    name: 'attach-recover',
    methods: METHODS,
    attach: true,
    /** 附着的实例被杀：Connector 自己重新附着或重建（无需重启），之后调用恢复；Connector 进程不退出。 */
    async run(stack) {
      const client = await boot(stack)
      const [first] = stack.herdrProcesses()
      process.kill(first.pid, 'SIGKILL')
      const recovered = await stack.waitReady(client, { tries: 200 })
      assert.equal(recovered.state, 'responded')
      assert(stack.connector.alive, 'the connector must keep running')
      const now = stack.herdrProcesses()
      assert.equal(now.length, 1)
      assert.notEqual(now[0].pid, first.pid, 'a new instance must have been started')
      return { old_pid: first.pid, new_pid: now[0].pid, connector_alive: true }
    }
  },
  {
    name: 'device-revoke',
    methods: ['ping'],
    /** 管理员撤销设备后：旧凭据的Connector无法再连接，MCP侧调用不可达，且不再出现在可用设备里。 */
    async run(stack) {
      const client = await boot(stack)
      await client.close()
      await stack.connector.stop()
      await stack.gateway.stop()
      await stack.revokeOffline()
      await stack.startGateway()
      const reconnect = stack.startConnector()
      await pause(4000)
      const next = await stack.connect()
      const machine = await tool(next, 'machines_get', { machine_id: stack.target.machine_id })
      const call = await stack.invoke(next, { method: 'ping', params: {} })
      assert.equal(call.state === 'responded', false, 'a revoked device must never serve calls')
      return {
        machine: machine.isError ? machine.raw : machine.data?.status,
        call: call.submit_error ?? call.state,
        connector: reconnect.alive ? 'retrying' : `exited:${reconnect.exit.code}`
      }
    }
  },
  {
    name: 'unknown-outcome',
    methods: METHODS,
    /** 已写入native后断线：结果为outcome_unknown，Connector重启也不自动重发（native只执行一次）。 */
    async run(stack) {
      const client = await boot(stack)
      const before = await workspaces(stack, client)
      const [native] = stack.natives()
      process.kill(native.pid, 'SIGSTOP') // native收到请求但不应答
      const pending = await stack.invoke(
        client,
        { method: 'workspace.create', params: {} },
        { wait_ms: 200 },
        { settle: false }
      )
      assert.notEqual(pending.state, 'responded')
      await pause(500)
      await stack.connector.kill() // 请求可能已到达native：Gateway只能看到断线
      const settled = await until(
        'unknown',
        async () => {
          const view = await tool(client, 'runtime_call_get', { call_id: pending.call_id, wait_ms: 200 })
          return view.data?.state === 'outcome_unknown' || view.data?.state === 'not_dispatched' ? view.data : undefined
        },
        { tries: 50, interval: 200 }
      )
      process.kill(native.pid, 'SIGCONT') // native随后真的执行了这次请求
      await pause(500)
      process.kill(native.pid, 'SIGKILL')
      await pause(300)
      stack.startConnector()
      await stack.waitReady(client, { tries: 60 })
      const after = await tool(client, 'runtime_call_get', { call_id: pending.call_id })
      assert.equal(after.data.state, settled.state, 'a reconnect must not rewrite or resend an unknown outcome')
      const count = await workspaces(stack, client)
      assert.equal(count, before, 'the new native must never receive the possibly-executed request')
      return {
        state_after_disconnect: settled.state,
        state_after_restart: after.data.state,
        workspaces_before: before,
        workspaces_after_restart: count,
        resent_to_new_native: count > before
      }
    }
  }
]
