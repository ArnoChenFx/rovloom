// 正式SDK窗口/Agent流程与角色启动解耦；这里不生成native成功值、schema artifact或模型回复。
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { luvusOperationValidation } from '../../src/connector/luvus/operations.ts'
import { createNativeMcpInvoker } from '../../test/mcp/native-conversation.ts'

// 每个独立用户动作沿用原30秒期限；总流程按已知动作数封顶，轮询与结果分页不能刷新原意图。
export const LUVUS_FLOW_INTENT_MS = 30_000
export const LUVUS_FLOW_CALL_LIMIT = Object.freeze({ minimum: 1, window: 6, agent: 11 })
// 目录检查与显式临时raw批准共用本轮精确方法集合，不能按整个provider目录自动扩大范围。
export const LUVUS_FLOW_METHODS = Object.freeze({
  minimum: Object.freeze(['pane.list']),
  window: Object.freeze(['pane.list', 'pane.get', 'workspace.get', 'tab.get', 'agent.list', 'agent.sessions']),
  agent: Object.freeze([
    'pane.list',
    'pane.get',
    'workspace.get',
    'tab.get',
    'agent.start',
    'agent.list',
    'agent.sessions',
    'agent.get',
    'agent.prompt',
    'agent.read'
  ])
})

/** 使用现有runtime工具完成明确选中对象的单次输入和读取，未知状态/null session保持原生差异。 */
export async function verifyLuvusMcpOperations(
  client,
  { target, opencode, minimum = false, signal, deadline, progress, observe }
) {
  assert(!(minimum && opencode), 'minimum_native_excludes_agent_input')
  const checks = []
  const calls = []
  const callLimit = minimum
    ? LUVUS_FLOW_CALL_LIMIT.minimum
    : opencode
      ? LUVUS_FLOW_CALL_LIMIT.agent
      : LUVUS_FLOW_CALL_LIMIT.window
  let agentInputOutput
  const shared = createNativeMcpInvoker(client, signal, Math.min(deadline, Date.now() + LUVUS_FLOW_INTENT_MS), observe)
  const provider = await shared.tool('providers_get', {
    machine_id: target.machine_id,
    provider_id: target.provider_id
  })
  assert.equal(provider.machine_id, target.machine_id)
  assert.equal(provider.provider_id, target.provider_id)
  assert.equal(provider.kind, 'luvus')
  assert.equal(provider.binding_revision, 1)
  assert.equal(provider.enabled, true)
  const methods = new Set()
  const cursors = new Set()
  let cursor
  do {
    const page = await shared.tool('runtime_discover', {
      target,
      expected_binding_revision: 1,
      limit: 20,
      ...(cursor ? { cursor } : {})
    })
    assert(Array.isArray(page.items))
    for (const item of page.items) {
      assert.equal(typeof item.method, 'string')
      assert(!methods.has(item.method))
      methods.add(item.method)
    }
    cursor = page.next_cursor
    if (cursor) {
      assert.equal(typeof cursor, 'string')
      assert(!cursors.has(cursor))
      cursors.add(cursor)
    }
  } while (cursor)
  const requiredMethods = minimum
    ? LUVUS_FLOW_METHODS.minimum
    : opencode
      ? LUVUS_FLOW_METHODS.agent
      : LUVUS_FLOW_METHODS.window
  for (const method of requiredMethods) {
    assert(methods.has(method), 'required_native_method_unavailable')
  }
  checks.push('current_provider_binding_and_paginated_native_catalog')
  const rpc = /* 每个明确意图只提交一次，原生请求/结果全部经正式HTTP SDK。 */ async (method, params) => {
    assert(calls.length < callLimit, 'native_flow_call_limit')
    progress(method)
    const intentIndex = calls.length + 1
    const active = createNativeMcpInvoker(
      client,
      signal,
      Math.min(deadline, Date.now() + LUVUS_FLOW_INTENT_MS),
      /* 诊断中的序号属于此独立意图，不输出原call_id或参数。 */ (event) =>
        observe?.({ ...event, intent_index: intentIndex }),
      { deliveryLimit: deadline }
    )
    try {
      return await active.invoke({
        target,
        expected_binding_revision: 1,
        validation: luvusOperationValidation(method),
        native_request: { method, params }
      })
    } finally {
      calls.push(...active.calls)
    }
  }
  if (minimum) {
    const panes = await rpc('pane.list', { all_tabs: true })
    assert(Array.isArray(panes.result.panes))
    checks.push('real_describe_single_call_and_verified_result_read')
    return {
      checks,
      verification_scope: 'native_rpc_minimum',
      native_calls: calls.length,
      agent_state_exercised: false,
      model_requests: 0,
      conversation_verified: false
    }
  }
  const panes = await rpc('pane.list', { all_tabs: true })
  assert(Array.isArray(panes.result.panes) && panes.result.panes.length > 0)
  const pane = String(panes.result.panes[0].pane)
  const selected = await rpc('pane.get', { pane })
  assert.equal(typeof selected.result.workspace_id, 'string')
  assert.equal(typeof selected.result.tab_id, 'string')
  const window = { workspace_id: selected.result.workspace_id, tab_id: selected.result.tab_id }
  const workspace = await rpc('workspace.get', { workspace_id: window.workspace_id })
  assert.equal(workspace.result.workspace_id, window.workspace_id)
  const tab = await rpc('tab.get', window)
  assert.equal(tab.result.tab_id, window.tab_id)
  assert.equal(tab.result.workspace_id, window.workspace_id)
  checks.push('real_selected_window_stable_workspace_tab_and_pane')
  if (opencode) {
    await rpc('agent.start', {
      name: 'cli-lab-opencode',
      kind: 'opencode',
      pane,
      args: ['--model', 'opencode/big-pickle', '--agent', 'build'],
      timeout_s: 5
    })
    checks.push('real_opencode_start_once')
  }
  const agents = await rpc('agent.list', {})
  assert(Array.isArray(agents.result.agents))
  await rpc('agent.sessions', {})
  checks.push('real_agent_and_session_discovery')
  if (opencode) {
    const agent = agents.result.agents.find(
      /* 只选本轮明确启动的原pane/名称，不把最近Agent作为目标。 */ (row) =>
        row.name === 'cli-lab-opencode' && String(row.pane) === pane
    )
    assert(agent && agent.agent === 'opencode' && /^[a-f0-9]{32}$/.test(agent.terminal_id))
    const state = await rpc('agent.get', { target: agent.name })
    assert(
      ['status', 'authority', 'state_source'].every(
        /* unknown等原生状态也必须保留真实字段，不能从进程存活推断idle。 */ (key) => Object.hasOwn(state.result, key)
      )
    )
    const submitted = await rpc('agent.prompt', {
      target: agent.name,
      terminal_id: agent.terminal_id,
      text: `Return exactly ROVLOOM_CLI_${randomBytes(8).toString('hex')}. Do not run commands or access files.`,
      strict: true
    })
    assert.equal(submitted.result.submitted, true)
    const output = await rpc('agent.read', { target: agent.name, lines: 40, source: 'recent' })
    assert.equal(typeof output.result.text, 'string')
    assert(output.result.text.length > 0)
    assert.equal(output.result.terminal_id, agent.terminal_id)
    const after = await rpc('agent.list', {})
    const same = after.result.agents.find(
      /* 输入和读取均保持原Agent、pane、terminal；session有值时才核对，null不会被补造。 */ (row) =>
        row.name === agent.name && row.pane === agent.pane && row.terminal_id === agent.terminal_id
    )
    assert(same)
    if (agent.session !== null && agent.session !== undefined) {
      assert.equal(same.session, agent.session)
    }
    agentInputOutput = {
      input_submitted_once: true,
      output_bytes: Buffer.byteLength(output.result.text),
      terminal_identity_verified: true,
      native_session_known: typeof same.session === 'string',
      native_state: ['idle', 'working', 'blocked', 'done', 'unknown'].includes(state.result.status)
        ? state.result.status
        : 'unknown',
      state_fields_observed: true,
      model_blocker: /Tunnel connection failed: 403 Forbidden/.test(output.result.text) ? 'tunnel_403' : undefined,
      model_reply_verified: false
    }
    checks.push('real_agent_native_state_single_input_and_output_same_terminal')
  }
  return {
    checks,
    verification_scope: agentInputOutput ? 'selected_window_and_agent_input_output' : 'selected_window_read_only',
    native_calls: calls.length,
    agent_count: agents.result.agents.length,
    agent_state_exercised: !!agentInputOutput,
    agent_input_output: agentInputOutput,
    conversation_verified: false
  }
}
