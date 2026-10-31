/**
 * 宿主级能力的真实 core 验收：machine.exec（argv/line/退出码/stdin/超时）、file.* 往返与
 * edit 的「全成或全不成」、doc.* 的 CAS、server.restart（重新附着）、server.stop（attach：
 * 不可用直到手动拉起；managed：下一次调用重新拉起）、terminal.run 的 parent 编排、
 * 开关关闭时全部被拒。
 * 用法：MCP_CONFIG=... HERDR_CORE_* bun e2e/herdr-core-host.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { connect } from './herdr-core-client.mjs'

const env = process.env
for (const name of ['HERDR_CORE_HC', 'HERDR_CORE_BINARY', 'HERDR_CORE_SESSION', 'HERDR_CORE_RUNTIME']) {
  assert(env[name], `${name} is required`)
}
const mode = env.HERDR_CORE_MODE ?? 'attach'
const { client, target, ok, invoke, readAll } = await connect()
const hcEnv = {
  HOME: env.HERDR_CORE_HOME ?? env.HOME,
  PATH: '/usr/bin:/bin',
  XDG_RUNTIME_DIR: env.HERDR_CORE_RUNTIME,
  ...(env.HERDR_CORE_STATE ? { XDG_STATE_HOME: env.HERDR_CORE_STATE } : {}),
  HC_SESSION: env.HERDR_CORE_SESSION,
  SHELL: '/bin/sh',
  TERM: 'xterm-256color',
  LANG: 'C.UTF-8',
  HERDR_RELEASES_URL: 'http://127.0.0.1:9',
  ...(env.HERDR_CORE_SOCKET ? { HC_SOCKET: env.HERDR_CORE_SOCKET } : {})
}
function hc(...args) {
  return execFileSync(env.HERDR_CORE_HC, [...args, '--json'], { env: hcEnv, encoding: 'utf8', timeout: 60_000 })
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
async function refuses(view, reason, label) {
  assert.equal(view.state, 'not_dispatched', `${label}:${JSON.stringify(view)}`)
  if (reason !== undefined) {
    assert.equal(view.reason, reason, `${label}:${JSON.stringify(view)}`)
  }
}
const text = (base64) => Buffer.from(String(base64 ?? ''), 'base64').toString('utf8')
const statusView = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
const refOf = (method) => {
  const found = statusView.items.find((item) => item.method === method)
  assert(found, `${method} missing`)
  return found.contract_ref
}
const read = async (method, params = {}) => {
  const view = await invoke(refOf(method), { method, params })
  assert.equal(view.state, 'responded', `${method}:${JSON.stringify(view)}`)
  return readAll(view)
}
const status = await read('server.status')
const coreId = status.core.id
const work = env.HERDR_CORE_WORK
assert(work, 'HERDR_CORE_WORK is required')
const scratch = join(work, 'host-ops')
mkdirSync(scratch, { recursive: true, mode: 0o700 })

try {
  const discovered = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  const entry = (method) => {
    const found = discovered.items.find((item) => item.method === method)
    assert(found, `${method} missing: ${JSON.stringify(discovered.items.map((item) => item.method))}`)
    return found
  }
  // 目录里能看到 8 个宿主级方法与 parent 声明；blocked_methods 说明永远不开放的部分。
  for (const method of [
    'machine.exec',
    'file.read',
    'file.write',
    'file.edit',
    'doc.get',
    'doc.set',
    'server.restart',
    'server.stop'
  ]) {
    assert.equal(entry(method).available, true, method)
  }
  // 档位表保持诚实：doc.get 仍是有条件档（读取类），其余新增的是宿主级。
  assert.equal(entry('doc.get').tier, 'conditional')
  for (const method of [
    'machine.exec',
    'file.read',
    'file.write',
    'file.edit',
    'doc.set',
    'server.restart',
    'server.stop'
  ]) {
    assert.equal(entry(method).tier, 'host', method)
  }
  const described = await ok('runtime_describe', { target, expected_binding_revision: 1, method: 'machine.exec' })
  assert.equal(described.blocked_methods['machine.list'], 'bypasses_per_device_token_scope')
  assert.deepEqual([...described.params_schema.required], ['timeout'])
  const runDescribed = await ok('runtime_describe', { target, expected_binding_revision: 1, method: 'terminal.run' })
  assert.ok(runDescribed.params_schema.properties.parent_created_ms)
  assert.equal(Object.hasOwn(runDescribed.params_schema.properties, 'die_with_parent'), false)
  // runtime_call 的 wait_ms 上限是 5000；更长的等待靠后面的轮询。
  // invoke 的第三个参数是绝对 deadline、第四个才是 wait_ms；这里只调 wait_ms。
  const invoked = async (method, params, wait = 500) =>
    invoke(entry(method).contract_ref, { method, params }, undefined, Math.min(wait, 5000))
  /** 参数不合法的调用：MCP 参数拒绝或确定未派发都算被拒（固定码由单测覆盖）。 */
  const refused = async (method, params) => {
    try {
      const view = await invoked(method, params)
      assert.notEqual(view.state, 'responded', `${method}:${JSON.stringify(view)}`)
    } catch {
      /* MCP 参数校验拒绝 */
    }
  }
  const done = async (method, params, wait = 500) => {
    const view = await invoked(method, params, wait)
    assert.equal(view.state, 'responded', `${method}:${JSON.stringify(view)}`)
    return readAll(view)
  }

  // ---- machine.exec ----
  const argvRun = await done('machine.exec', { argv: ['/bin/echo', 'héllo argv'], timeout: 10 })
  assert.equal(argvRun.code, 0, JSON.stringify(argvRun))
  assert.equal(text(argvRun.stdout), 'héllo argv\n')
  assert.equal(argvRun.truncated, false)
  const lineRun = await done('machine.exec', { line: 'printf line; exit 3', timeout: 10 })
  assert.equal(lineRun.code, 3)
  assert.equal(text(lineRun.stdout), 'line')
  // 显式 env 与 cwd。
  const envRun = await done('machine.exec', {
    argv: ['/bin/sh', '-c', 'printf "%s:%s" "$MARK" "$PWD"'],
    env: { MARK: 'from-env' },
    cwd: scratch,
    timeout: 10
  })
  assert.equal(text(envRun.stdout), `from-env:${realpathSync(scratch)}`)
  // stdin：input 是 base64。
  const stdinRun = await done('machine.exec', {
    argv: ['/bin/cat'],
    input: Buffer.from('piped-through-stdin').toString('base64'),
    timeout: 10
  })
  assert.equal(text(stdinRun.stdout), 'piped-through-stdin')
  // 超时：timed_out 原样透传，不当作成功。
  const timeoutRun = await done('machine.exec', { argv: ['/bin/sleep', '5'], timeout: 1 }, 6000)
  assert.equal(timeoutRun.timed_out, true, JSON.stringify(timeoutRun))
  // 参数与体积：argv 与 line 不能同时给；timeout 必填；on 拒绝。
  for (const params of [
    { argv: ['/bin/true'], line: 'true', timeout: 5 },
    { argv: ['/bin/true'] },
    { argv: ['/bin/true'], timeout: 5, on: 'box' },
    { argv: ['/bin/true'], timeout: 5, cwd: 'relative' }
  ]) {
    await refused('machine.exec', params)
  }

  // ---- file.* 往返（只在自己的 0700 目录） ----
  const filePath = join(scratch, 'notes.txt')
  const written = await done('file.write', { path: filePath, data: Buffer.from('alpha\nbeta\n').toString('base64') })
  assert.equal(written.bytes, 11)
  const firstRead = await done('file.read', { path: filePath })
  assert.equal(firstRead.text, 'alpha\nbeta\n')
  assert.equal(firstRead.lines, 2)
  const edited = await done('file.edit', { path: filePath, edits: [{ old: 'beta', new: 'gamma' }] })
  assert.equal(edited.path, filePath)
  assert.equal(readFileSync(filePath, 'utf8'), 'alpha\ngamma\n')
  // old 不唯一：整体失败，文件不变。
  writeFileSync(filePath, 'dup\ndup\n')
  await refused('file.edit', { path: filePath, edits: [{ old: 'dup', new: 'x' }] })
  assert.equal(readFileSync(filePath, 'utf8'), 'dup\ndup\n')
  // 相对路径与 cwd 拒绝。
  await refused('file.read', { path: 'notes.txt' })
  await refused('file.read', { path: filePath, cwd: scratch })

  // ---- doc.* 的 CAS ----
  const docName = 'host-ops-doc'
  const before = await done('doc.get', { name: docName })
  const version = Number(before.version)
  const set = await done('doc.set', { name: docName, value: { rounds: version + 1 }, version })
  assert(Number(set.version) > version)
  const after = await done('doc.get', { name: docName })
  assert.deepEqual(after.value, { rounds: version + 1 })
  // 版本不符：core 明确拒绝（看类别）。
  const stale = await invoked('doc.set', { name: docName, value: { rounds: 99 }, version })
  assert.equal(stale.state, 'not_dispatched', JSON.stringify(stale))
  assert.equal(typeof stale.reason, 'string')
  assert.deepEqual((await done('doc.get', { name: docName })).value, { rounds: version + 1 })

  // ---- terminal.run parent 编排 ----
  const parent = await done('terminal.run', { name: 'p-host', line: 'sleep 3600' })
  const parentAddress = parent.address
  const child = (name) =>
    done('terminal.run', {
      name,
      line: 'sleep 1',
      parent: parentAddress,
      parent_created_ms: parent.created_ms,
      no_notify: true,
      ...(name === 'c-outlive' ? { outlive_parent: true } : {})
    })
  const childA = await child('c-a')
  const childB = await child('c-b')
  assert.equal(childA.parent, parentAddress)
  // 两个子都结束后，等父的 children:all 返回。
  const waited = await done('terminal.wait', { terminal: parentAddress, children: 'all', timeout: 30 }, 30_000)
  assert.equal(waited.ended, true, JSON.stringify(waited))
  assert.deepEqual(
    (waited.children ?? []).map((entry) => entry.terminal).sort(),
    [childA.address, childB.address].sort()
  )
  // 父 created_ms 不符：确定未派发，不会挂到同地址的另一个终端。
  await refuses(
    await invoked('terminal.run', {
      line: 'true',
      parent: parentAddress,
      parent_created_ms: parent.created_ms + 1
    }),
    'fence_mismatch',
    'parent fence'
  )
  // 杀父：默认子随父结束（0.1.13 起），outlive_parent 的子留下。
  const outlive = await child('c-outlive')
  const parentChild = await child('c-die')
  await done('terminal.kill', { terminal: parentAddress, core_id: coreId, created_ms: parent.created_ms })
  await until('parent child finished', async () => {
    const view = await read('terminal.get', { terminal: parentChild.address })
    assert.equal(view.state, 'finished', JSON.stringify(view.state))
  })
  const survivor = await read('terminal.get', { terminal: outlive.address })
  assert.equal(survivor.state, 'live', 'outlive_parent child must survive the parent')
  await done('terminal.kill', { terminal: outlive.address, core_id: coreId, created_ms: outlive.created_ms })

  // core_id 栅栏：错的 id 不转发（放在重启之前，避免此刻 provider 尚未重新就绪）。
  await refuses(await invoked('server.restart', { core_id: 'f'.repeat(16) }), 'fence_mismatch', 'core fence')

  // ---- server.restart：在途结局 + 重新附着 ----
  const list = await read('terminal.list')
  const target1 = list.terminals.find((terminal) => terminal.name === 'e2e') ?? list.terminals[0]
  const restartView = await invoked('server.restart', { core_id: coreId }, 500)
  assert(['responded', 'outcome_unknown', 'not_dispatched'].includes(restartView.state), JSON.stringify(restartView))
  const afterRestart = await until('read after server.restart', () =>
    read('terminal.get', { terminal: target1.address })
  )
  assert.equal(afterRestart.created_ms, target1.created_ms)
  const statusAfter = await until('status after server.restart', () => read('server.status'))
  assert.equal(statusAfter.core.id, coreId, 'planned restart keeps core.id')

  // ---- server.stop：attach 不可用直到手动拉起；managed 下一次调用重新拉起 ----
  const stopView = await invoked('server.stop', { core_id: coreId }, 500)
  assert(['responded', 'outcome_unknown', 'not_dispatched'].includes(stopView.state), JSON.stringify(stopView))
  const restartState = stopView.state
  if (mode === 'managed') {
    // managed：下一次调用会重新拉起 core（所以这次调用本身可能直接成功，也可能先失败再成功）。
    const back = await until('managed restart after stop', () => read('server.status'), 60_000)
    assert.equal(back.core.id, coreId, 'managed restart keeps core.id')
  } else {
    // attach：stop 之后 provider 不可用——门面拒绝（unavailable）或确定未派发，直到有人把 core 拉起来。
    try {
      const down = await invoked('server.status', {}, 500)
      assert.notEqual(down.state, 'responded', JSON.stringify(down))
    } catch (error) {
      assert.match(String(error), /unavailable|not_dispatched/u)
    }
    // attach：provider 不可用，直到手动把 core 拉起来。
    hc('server', 'start')
    const back = await until('manual restart after stop', () => read('server.status'), 60_000)
    assert.equal(typeof back.core.id, 'string')
  }

  console.log(
    JSON.stringify({
      ok: true,
      mode,
      methods: discovered.items.length,
      exec: { argv: argvRun.code, line: lineRun.code, stdin: text(stdinRun.stdout), timed_out: timeoutRun.timed_out },
      file: { write: written.bytes, read: firstRead.lines, edit: 'gamma', edit_conflict: 'rejected' },
      doc: { version: Number(set.version), cas: 'rejected' },
      parent: { children: 2, wait_ended: waited.ended, outlive_survived: true, fence: 'fence_mismatch' },
      restart: { state: restartState, core_id_stable: true },
      stop: { state: restartState, recovered: true }
    })
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
  await client.close()
}
