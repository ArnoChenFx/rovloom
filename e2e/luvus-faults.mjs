/** Luvus 故障验收的 MCP 侧步骤，由 quickstart.py 在各故障阶段之间分别调用。
 * 用法：MCP_CONFIG=<quickstart.py 写出的 mcp.json> bun e2e/luvus-faults.mjs <step> [参数]
 *   count                         打印当前 workspace 数
 *   submit-write <state文件> <pid>...   先读调用前计数，对给定 Luvus server 进程发 SIGSTOP，再提交一次有副作用的 workspace.new（不等待终态），
 *                                 把 call_id 与调用前计数写入文件
 *   check-unknown <state文件>     断言该调用为 outcome_unknown、没有被重发（计数最多比调用前多 1 且保持稳定），新调用仍可用
 *   revoke <gateway状态目录> <machine_id>   Gateway 已停止时经正式 Store 撤销设备
 *   check-revoked                 断言设备为 revoked 且调用被拒绝
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

const [step, ...rest] = process.argv.slice(2)
assert(process.env.MCP_CONFIG && step, 'MCP_CONFIG and a step are required')
const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const target = mcp.targets[0]

async function connect() {
  const client = new Client({ name: 'luvus-faults', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { authorization: `Bearer ${mcp.token}` } }
    })
  )
  return client
}
async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  return { isError: result.isError === true, data: result.structuredContent?.data, raw: result.structuredContent }
}
async function ok(client, name, args) {
  const result = await tool(client, name, args)
  assert.equal(result.isError, false, `${name}:${JSON.stringify(result.raw)}`)
  return result.data
}
/** Connector 刚重启时目录读取会失败，限时重试。 */
async function discover(client) {
  for (let attempt = 0; ; attempt++) {
    const result = await tool(client, 'runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
    if (!result.isError) {
      return Object.fromEntries(result.data.items.map((item) => [item.method, item.contract_ref]))
    }
    assert(attempt < 120, `runtime_discover:${JSON.stringify(result.raw)}`)
    await pause(500)
  }
}
const FINISHED = new Set(['responded', 'not_dispatched', 'outcome_unknown'])
async function settle(client, view, patience = 20_000) {
  const stop = Date.now() + patience
  while (!FINISHED.has(view.state) && Date.now() < stop) {
    view = await ok(client, 'runtime_call_get', { call_id: view.call_id, wait_ms: 200 })
  }
  return view
}
function submit(client, refs, method, params, extra = {}) {
  return ok(client, 'runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: refs[method],
    native_request: { method, params },
    deadline: Date.now() + 120_000,
    wait_ms: 300,
    ...extra
  })
}
async function readJson(client, view) {
  assert(view.result?.result_id, `result_missing:${JSON.stringify(view)}`)
  const page = await ok(client, 'runtime_result_read', { result_id: view.result.result_id, max_bytes: 16_384 })
  return JSON.parse(Buffer.from(page.chunk, 'base64').toString('utf8'))
}
async function count(client, refs) {
  const view = await settle(client, await submit(client, refs, 'workspace.list', {}))
  assert.equal(view.state, 'responded', JSON.stringify(view))
  const reply = await readJson(client, view)
  return (reply.result?.workspaces ?? reply.result?.items ?? []).length
}

// revoke 在 Gateway 停止时运行，不连 MCP。
const client = step === 'revoke' ? undefined : await connect()
try {
  if (step === 'count') {
    console.log(await count(client, await discover(client)))
  } else if (step === 'submit-write') {
    const refs = await discover(client)
    const before = await count(client, refs)
    // 暂停原生之后请求只会被接收、不会被应答：这正是“可能已执行”的未知结果。
    for (const pid of rest.slice(1)) {
      process.kill(Number(pid), 'SIGSTOP')
    }
    const view = await submit(client, refs, 'workspace.new', JSON.parse(process.env.LUVUS_WRITE ?? '{}'))
    assert(!FINISHED.has(view.state), `write finished before the fault: ${JSON.stringify(view)}`)
    writeFileSync(rest[0], JSON.stringify({ call_id: view.call_id, before, state: view.state }))
    console.log(JSON.stringify({ submitted: view.state, before }))
  } else if (step === 'check-unknown') {
    const saved = JSON.parse(readFileSync(rest[0], 'utf8'))
    const refs = await discover(client)
    // 旧调用在 Gateway 侧必须以“结果未知”收敛，不能被当成成功，也不能被自动重发。
    let view = await ok(client, 'runtime_call_get', { call_id: saved.call_id, wait_ms: 200 })
    view = await settle(client, view, 60_000)
    assert.equal(view.state, 'outcome_unknown', JSON.stringify(view))
    // 原生可能已经执行过一次（旧请求），但绝不能出现第二次：等待一段时间后计数稳定在 before 或 before+1。
    const first = await count(client, refs)
    assert(first === saved.before || first === saved.before + 1, `unexpected count ${first} (before ${saved.before})`)
    await pause(10_000)
    const second = await count(client, refs)
    assert.equal(second, first, 'workspace count kept changing: the request was resent')
    // 同一设备上的新调用不受影响。
    const created = await settle(
      client,
      await submit(client, refs, 'workspace.new', JSON.parse(process.env.LUVUS_WRITE ?? '{}'))
    )
    assert.equal(created.state, 'responded', JSON.stringify(created))
    assert.equal(await count(client, refs), second + 1)
    console.log(JSON.stringify({ ok: true, state: view.state, before: saved.before, after_unknown: second }))
  } else if (step === 'revoke') {
    const { openGatewayState } = await import('../src/runtime/state.ts')
    const state = openGatewayState({
      state_directory: rest[0],
      store: { management: () => ({ actor: 'e2e_admin', confirmation_id: randomUUID() }) },
      changed: () => {}
    })
    try {
      state.store.revoke(rest[1])
    } finally {
      state.close()
    }
    console.log(JSON.stringify({ revoked: rest[1] }))
  } else if (step === 'check-revoked') {
    const machine = await ok(client, 'machines_get', { machine_id: target.machine_id })
    assert.equal(machine.status, 'revoked', JSON.stringify(machine))
    const result = await tool(client, 'runtime_discover', { target, expected_binding_revision: 1, limit: 10 })
    assert.equal(result.isError, true, `revoked device must not be callable: ${JSON.stringify(result.data)}`)
    console.log(JSON.stringify({ ok: true, status: machine.status }))
  } else {
    throw new Error('unknown step: ' + step)
  }
} finally {
  await client?.close()
}
