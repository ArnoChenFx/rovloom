/** 合成官方工作流数据验证现有 codec/Wire 接缝；不运行原生程序或宣称真实 Agent 对话完成。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHerdrCodec, createHerdrReadonlyAdapter } from '../../../src/connector/herdr/readonly.js'
import {} from '../../../src/connector/herdr/wire.js'
import type { JsonObject } from '../../../src/wire/types.js'
import { backendFixture, schemas, source } from './helpers.js'

const workspace = {
  workspace_id: 'owned-workspace',
  number: 1,
  label: 'synthetic',
  focused: true,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: 'owned-tab',
  agent_status: 'unknown'
}
const tab = {
  tab_id: 'owned-tab',
  workspace_id: 'owned-workspace',
  number: 1,
  label: 'synthetic',
  focused: true,
  pane_count: 1,
  agent_status: 'unknown'
}
const pane = {
  pane_id: 'owned-pane',
  terminal_id: 'owned-terminal',
  workspace_id: 'owned-workspace',
  tab_id: 'owned-tab',
  focused: true,
  agent_status: 'unknown',
  revision: 7
}
const agent = {
  ...pane,
  name: 'owned-agent',
  agent: 'opencode',
  interactive_ready: false,
  launch_pending: true,
  agent_session: { source: 'herdr:opencode', agent: 'opencode', kind: 'id', value: 'synthetic-session' }
}
const read = {
  pane_id: pane.pane_id,
  workspace_id: pane.workspace_id,
  tab_id: pane.tab_id,
  source: 'visible',
  format: 'text',
  text: 'synthetic terminal output',
  revision: 7,
  truncated: false
}

const cases: { method: string; params: JsonObject; result: JsonObject }[] = [
  { method: 'workspace.list', params: {}, result: { type: 'workspace_list', workspaces: [workspace] } },
  {
    method: 'workspace.get',
    params: { workspace_id: workspace.workspace_id },
    result: { type: 'workspace_info', workspace }
  },
  {
    method: 'workspace.create',
    params: { label: 'owned', focus: false },
    result: { type: 'workspace_created', workspace, tab, root_pane: pane }
  },
  {
    method: 'workspace.rename',
    params: { workspace_id: workspace.workspace_id, label: 'renamed' },
    result: { type: 'workspace_info', workspace }
  },
  { method: 'tab.list', params: { workspace_id: workspace.workspace_id }, result: { type: 'tab_list', tabs: [tab] } },
  {
    method: 'tab.create',
    params: { workspace_id: workspace.workspace_id, label: 'owned' },
    result: { type: 'tab_created', tab, root_pane: pane }
  },
  { method: 'tab.focus', params: { tab_id: tab.tab_id }, result: { type: 'tab_info', tab } },
  { method: 'pane.list', params: {}, result: { type: 'pane_list', panes: [pane] } },
  { method: 'pane.get', params: { pane_id: pane.pane_id }, result: { type: 'pane_info', pane } },
  {
    method: 'pane.read',
    params: { pane_id: pane.pane_id, source: 'visible', format: 'text' },
    result: { type: 'pane_read', read }
  },
  {
    method: 'pane.split',
    params: { target_pane_id: pane.pane_id, direction: 'right' },
    result: { type: 'pane_info', pane }
  },
  { method: 'pane.input.set', params: { pane_id: pane.pane_id, right_click: 'pane' }, result: { type: 'ok' } },
  {
    method: 'pane.send_input',
    params: { pane_id: pane.pane_id, text: 'owned input', keys: ['Enter'] },
    result: { type: 'ok' }
  },
  { method: 'pane.close', params: { pane_id: pane.pane_id }, result: { type: 'ok' } },
  { method: 'agent.list', params: {}, result: { type: 'agent_list', agents: [agent] } },
  { method: 'agent.get', params: { target: 'owned-agent' }, result: { type: 'agent_info', agent } },
  { method: 'agent.read', params: { target: 'owned-agent', source: 'visible' }, result: { type: 'pane_read', read } },
  {
    method: 'agent.start',
    params: { name: 'owned-agent', kind: 'opencode', pane_id: pane.pane_id, args: ['--synthetic'] },
    result: { type: 'agent_started', agent, argv: ['opencode', '--synthetic'] }
  },
  {
    method: 'agent.prompt',
    params: { target: 'owned-agent', text: 'synthetic prompt' },
    result: { type: 'agent_prompted', agent: { ...agent, agent_status: 'working' } }
  },
  {
    method: 'agent.wait',
    params: { target: 'owned-agent', until: ['blocked'], timeout_ms: 1000 },
    result: { type: 'agent_info', agent: { ...agent, agent_status: 'blocked' } }
  }
]

for (const entry of cases) {
  test(
    `official ${entry.method} request and result retain native values through the existing permit`,
    /** 逐族覆盖官方参数与成功类型；完整 schema 通过也不能接受其它方法的 Pong 或错 ID。 */ () => {
      const state = backendFixture()
      state.record.method = entry.method
      state.record.native_request = { method: entry.method, params: entry.params }
      const request = { ...state.record.native_request, id: state.binding.native_request_id }
      const response = { id: request.id, result: entry.result }
      const bytes = Buffer.from(JSON.stringify(response) + '\n')
      const codec = createHerdrCodec(source, schemas)
      const core = createHerdrReadonlyAdapter(state.backend)
      try {
        assert.deepEqual(JSON.parse(Buffer.from(codec.encode(request)).toString()), request)
        assert.deepEqual(codec.decode(bytes, request), response)
        const context = core.resolve(state.identity)
        assert.throws(
          /** 未派发状态不从合法 native success 补造许可。 */ () => core.decodeResponse(bytes, context),
          /dispatch_permit_unavailable/
        )
        core.encodeRequest(request, context)
        assert.deepEqual(core.decodeResponse(bytes, context), response)
        assert.throws(
          /** 完整 success 根合法的其它方法结果仍须被逐方法规则拒绝。 */ () =>
            core.decodeResponse(
              Buffer.from(
                JSON.stringify({ id: request.id, result: { type: 'pong', version: '0.9.5', protocol: 22 } }) + '\n'
              ),
              context
            ),
          /herdr_native_response_invalid/
        )
        assert.throws(
          /** 正确类型不能跨原 native request ID 关联。 */ () =>
            core.decodeResponse(Buffer.from(JSON.stringify({ ...response, id: 'different' }) + '\n'), context),
          /herdr_native_response_invalid/
        )
        const error = { id: request.id, error: { code: 'synthetic_native_error', message: 'synthetic failure' } }
        assert.deepEqual(core.decodeResponse(Buffer.from(JSON.stringify(error) + '\n'), context), error)
        state.emit({ kind: 'content', machine_id: state.binding.machine_id, call_id: state.binding.call_id })
        state.backend.attempt = /** 回收后模拟原生参数与 prompt 正文已不可恢复。 */ () => undefined
        assert.equal(core.stats().executions, 0)
        assert.equal(core.stats().responses, 1)
        assert.deepEqual(core.decodeResponse(bytes, context), response)
        assert.throws(/** 回收后的有效结果不能复活交付权限。 */ () => core.checkResult(context), /content_unavailable/)
      } finally {
        core.close()
      }
    }
  )
}
