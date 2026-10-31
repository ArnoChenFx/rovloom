/**
 * D4：量一次经 Connector 的调用在提交与收敛上各花多久，先量再决定。
 * 用法：MCP_CONFIG=... bun e2e/herdr-core-latency.mjs（METHODS=server.status,terminal.read）
 * 只做只读调用；每项 10 次，输出每次的提交毫秒数与收敛毫秒数。
 */
import assert from 'node:assert/strict'
import { connect } from './herdr-core-client.mjs'

const { client, target, ok } = await connect()
const rounds = Number(process.env.ROUNDS ?? 10)
const methods = (process.env.METHODS ?? 'server.status').split(',')

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1)
  }
}

try {
  const discovered = await ok('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  const entry = (method) => discovered.items.find((item) => item.method === method)
  const baseline = []
  for (let index = 0; index < rounds; index++) {
    const started = performance.now()
    await ok('machines_list', {})
    baseline.push(Math.round(performance.now() - started))
  }
  /** 一次预热调用，避免把首次建连/编译算进每次延迟；同时取回控制档需要的三元组。 */
  const warmup = process.env.WARMUP_METHOD ?? 'terminal.list'
  const listed = await ok('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: entry(warmup).contract_ref,
    native_request: { method: warmup, params: {} },
    deadline: Date.now() + 30_000,
    wait_ms: 5000
  })
  assert.equal(listed.state, 'responded', JSON.stringify(listed))
  let address = 't1'
  let createdMs = 0
  let coreId = ''
  if (warmup === 'terminal.list') {
    const page = await ok('runtime_result_read', { result_id: listed.result.result_id, max_bytes: 16_384 })
    const text = page.text ?? Buffer.from(page.chunk, 'base64').toString('utf8')
    const terminals = JSON.parse(text).terminals
    address = terminals[0].address
    createdMs = terminals[0].created_ms
    const status = await ok('runtime_call', {
      target,
      expected_binding_revision: 1,
      contract_ref: entry('server.status').contract_ref,
      native_request: { method: 'server.status', params: {} },
      deadline: Date.now() + 30_000,
      wait_ms: 5000
    })
    const statusPage = await ok('runtime_result_read', { result_id: status.result.result_id, max_bytes: 16_384 })
    coreId = JSON.parse(statusPage.text ?? Buffer.from(statusPage.chunk, 'base64').toString('utf8')).core.id
  }
  const report = { provider: target.provider_id, rounds, baseline_machines_list: summary(baseline), methods: {} }
  for (const method of methods) {
    const params =
      method === 'terminal.read'
        ? { terminal: address, lines: 0 }
        : method === 'terminal.send'
          ? { terminal: address, core_id: coreId, created_ms: createdMs, text: 'echo latency\n' }
          : {}
    const submit = []
    const settle = []
    for (let index = 0; index < rounds; index++) {
      const started = performance.now()
      const view = await ok('runtime_call', {
        target,
        expected_binding_revision: 1,
        contract_ref: entry(method).contract_ref,
        native_request: { method, params },
        deadline: Date.now() + 30_000,
        wait_ms: 0
      })
      submit.push(Math.round(performance.now() - started))
      let current = view
      const finished = new Set(['responded', 'not_dispatched', 'outcome_unknown'])
      for (let poll = 0; poll < 300 && !finished.has(current.state); poll++) {
        current = await ok('runtime_call_get', { call_id: view.call_id, wait_ms: 0 })
        if (!finished.has(current.state)) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      assert(finished.has(current.state), `${method} did not settle: ${JSON.stringify(current)}`)
      settle.push(Math.round(performance.now() - started))
    }
    report.methods[method] = { submit: summary(submit), settle: summary(settle) }
  }
  console.log(JSON.stringify({ ok: true, ...report }))
} finally {
  await client.close()
}
