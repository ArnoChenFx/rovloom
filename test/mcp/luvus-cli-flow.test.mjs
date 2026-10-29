// 正式HTTP SDK断言的服务明确为内存stub；不代表CLI/native、真实Agent状态或模型回复验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { httpFixture } from './http-fixture.ts'
import {
  LUVUS_OPERATION_METHODS,
  luvusOperationValidation,
  validateLuvusOperationParams
} from '../../src/connector/luvus/operations.ts'
import { LUVUS_FLOW_INTENT_MS, verifyLuvusMcpOperations } from '../../scripts/mcp/luvus-sdk-flow.mjs'
import { FacadeServiceError } from '../../src/mcp/types.ts'
import { createNativeMcpInvoker } from './native-conversation.ts'

const target = {
  machine_id: 'flow_fixture',
  provider_id: 'luvus_fixture',
  profile: 'session',
  session: 'transport_fixture'
}
const terminal = 'f'.repeat(32)
const contract = 'a'.repeat(64)

/** 仅替代GatewayService业务数据，仍经真实门面、参数schema、回环HTTP、官方SDK及结果分页。 */
function serviceFixture(mode, deliveryClock) {
  const records = new Map()
  const nativeRequests = []
  const cursors = []
  let workspaceName = 'fixture workspace'
  let agentStarted = false
  const agent = { name: 'cli-lab-opencode', agent: 'opencode', pane: '1', terminal_id: terminal, session: null }
  /** 合成原生投影仅覆盖流程契约，不运行任何程序，不把unknown或null补成成功状态。 */
  function native(method, params) {
    switch (method) {
      case 'session.snapshot':
        return { workspaces: [] }
      case 'pane.list':
        return { panes: [{ pane: '1', terminal_id: terminal }] }
      case 'pane.get':
        return { workspace_id: 'fixture_workspace_id', tab_id: 'fixture_tab_id', terminal_id: terminal }
      case 'workspace.get':
        return { workspace_id: 'fixture_workspace_id', name: workspaceName }
      case 'workspace.rename':
        workspaceName = params.name
        return { renamed: true }
      case 'tab.get':
        return { workspace_id: 'fixture_workspace_id', tab_id: 'fixture_tab_id' }
      case 'pane.status':
        return { status: 'unknown' }
      case 'pane.rename':
        return { renamed: true }
      case 'agent.start':
        agentStarted = true
        return { started: true }
      case 'agent.list':
        return { agents: agentStarted ? [agent] : [] }
      case 'agent.sessions':
        return { sessions: [] }
      case 'agent.get':
        return { ...agent, status: 'unknown', authority: 'unknown', state_source: 'unknown' }
      case 'agent.prompt':
        return { submitted: true }
      case 'agent.read':
        return {
          text: 'SYNTHETIC SDK FIXTURE OUTPUT; NO MODEL REPLY\n'.repeat(80),
          terminal_id: mode === 'terminal_drift' ? 'e'.repeat(32) : terminal,
          content_revision: 1
        }
      default:
        assert.fail('unexpected_fixture_native_method')
    }
  }
  /** 每个runtime_call只登记一次；后续查询只推进同一call，分页只读取原记录。 */
  async function execute(name, args, context) {
    assert.equal(context.caller.principal_id, 'isolated-caller')
    if (name === 'providers_get') {
      return { data: { ...target, kind: 'luvus', binding_revision: 1, enabled: true, readiness: 'ready' } }
    }
    if (name === 'runtime_discover') {
      const methods = LUVUS_OPERATION_METHODS.filter(
        /* 缺能力负例只改目录，不能靠后续伪造执行成功绕过。 */ (method) =>
          mode !== 'missing_prompt' || method !== 'agent.prompt'
      )
      const offset = args.cursor ? Number(args.cursor.slice('fixture-catalog-'.length)) : 0
      cursors.push(args.cursor)
      const end = Math.min(offset + Math.min(args.limit, 7), methods.length)
      return {
        data: {
          items: methods
            .slice(offset, end)
            .map(/* fixture目录沿用真实方法名与独立固定契约引用。 */ (method) => ({ method, contract_ref: contract })),
          ...(end < methods.length ? { next_cursor: 'fixture-catalog-' + end } : {})
        }
      }
    }
    if (name === 'runtime_describe') {
      return { data: { method: args.method, contract_ref: contract } }
    }
    if (name === 'runtime_call') {
      assert.deepEqual(args.target, target)
      assert.equal(args.expected_binding_revision, 1)
      assert.equal(args.contract_ref, contract)
      const { method, params } = args.native_request
      assert.equal(args.validation, luvusOperationValidation(method))
      validateLuvusOperationParams(method, params)
      nativeRequests.push(structuredClone(args.native_request))
      const id = 'fixture_call_' + nativeRequests.length
      const bytes = Buffer.from(JSON.stringify({ id, result: native(method, params) }))
      const result = {
        result_id: 'result_' + id,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        expires_at:
          mode === 'delivery_after_execution'
            ? Date.now() + 120_000
            : mode === 'expired_result'
              ? Date.now() - 1
              : args.deadline
      }
      const row = {
        bytes,
        result,
        polls: 0,
        call: {
          call_id: id,
          target,
          provider_kind: 'luvus',
          binding_revision: 1,
          contract_ref: null,
          state: 'created',
          delivery: 'pending',
          content_status: 'available'
        }
      }
      records.set(id, row)
      if (mode === 'delivery_after_execution') {
        row.call = { ...row.call, state: 'responded', contract_ref: contract, result }
        deliveryClock('responded')
      }
      return { data: row.call }
    }
    if (name === 'runtime_call_get') {
      assert.equal(args.wait_ms, 0)
      const row = records.get(args.call_id)
      assert(row)
      if (mode === 'wait_forbidden') {
        throw new FacadeServiceError('forbidden')
      }
      row.polls++
      return {
        data: {
          ...row.call,
          contract_ref: contract,
          ...(mode === 'binding_drift' ? { target: { ...target, session: 'other_fixture_session' } } : {}),
          state: row.polls === 1 ? 'connector_accepted' : 'responded',
          ...(mode === 'ref_regression' && row.polls > 1 ? { state: 'created', contract_ref: null } : {}),
          ...(row.polls > 1 && mode !== 'lost_context' ? { result: row.result } : {}),
          ...(mode === 'lost_context' && row.polls > 1
            ? { state: 'outcome_unknown', contract_ref: null, content_reason_code: 'unavailable' }
            : {})
        }
      }
    }
    if (name === 'runtime_result_read') {
      if (mode === 'delivery_after_execution') {
        // 仅推进本例合成时钟，避免将较短墙钟等待误用作SDK吞吐断言。
        deliveryClock('read')
      }
      const row = [...records.values()].find(
        /* 结果fixture仍固定属于原call，不从输入游标构造新业务结果。 */ (entry) =>
          entry.result.result_id === args.result_id
      )
      assert(row)
      const offset = args.cursor ? Number(args.cursor.slice('fixture-result-'.length)) : 0
      const end = Math.min(offset + (mode === 'delivery_after_execution' ? 32 : 512), row.bytes.length)
      let chunk = row.bytes.subarray(offset, end)
      if (mode === 'bad_digest' && offset === 0) {
        chunk = Buffer.concat([chunk, Buffer.from('!')])
      }
      return {
        data: {
          result_id: row.result.result_id,
          chunk: chunk.toString('base64'),
          encoding: 'base64',
          total_bytes: row.bytes.length,
          sha256: row.result.sha256,
          expires_at: row.result.expires_at,
          eof: end === row.bytes.length,
          ...(end < row.bytes.length ? { next_cursor: 'fixture-result-' + end } : {})
        }
      }
    }
    assert.fail('unexpected_fixture_tool')
  }
  return { service: { execute }, nativeRequests, records, cursors }
}

/** 每例都真实建立并关闭HTTP SDK会话；服务和认证仅用明确合成fixture。 */
async function isolated(mode, check) {
  const stub = serviceFixture(mode)
  const observations = []
  const fixture = httpFixture(stub.service)
  try {
    await fixture.client.connect(fixture.transport, { timeout: 5000 })
    const run = /* 与真实CLI脚本共享同一SDK流程和固定截止，不执行原生替身程序。 */ (
      minimum = false,
      opencode = !minimum
    ) =>
      verifyLuvusMcpOperations(fixture.client, {
        target,
        opencode,
        minimum,
        signal: new AbortController().signal,
        deadline: Date.now() + (minimum ? 1 : opencode ? 11 : 6) * LUVUS_FLOW_INTENT_MS,
        observe: /* 仅保存脱敏阶段投影，用于核对计数与期限；这里仍是明确服务stub。 */ (event) =>
          observations.push(event),
        progress: /* fixture不打印业务阶段或合成正文。 */ () => {}
      })
    await check(run, stub, observations)
  } finally {
    await fixture.close()
  }
}

test(
  '执行已在期限内完成时按原结果TTL读取，独立交付期限不重发原意图（服务stub）',
  /* 真实HTTP SDK与明确业务stub分离；默认5秒测试预算不变。 */ async () => {
    let clock = Date.now()
    const executionDeadline = clock + 30_000
    const stub = serviceFixture(
      'delivery_after_execution',
      /* 本例只推进驱动的私有逻辑时钟，不修改全局时间或产品时钟。 */ (stage) => {
        clock = stage === 'responded' ? executionDeadline - 1000 : executionDeadline + 1
      }
    )
    const fixture = httpFixture(stub.service)
    try {
      await fixture.client.connect(fixture.transport, { timeout: 5000 })
      const events = []
      const driver = createNativeMcpInvoker(
        fixture.client,
        new AbortController().signal,
        executionDeadline,
        /* 只记录脱敏阶段，用于证明进入独立交付而未续期原native请求。 */ (event) => events.push(event),
        { deliveryLimit: executionDeadline + 30_000, now: /* 私有测试时钟只服务于本例期限断言。 */ () => clock }
      )
      const reply = await driver.invoke({
        target,
        expected_binding_revision: 1,
        validation: 'strict',
        native_request: { method: 'pane.list', params: { all_tabs: true } }
      })
      assert(Array.isArray(reply.result.panes))
      assert(clock > executionDeadline)
      assert.equal(stub.nativeRequests.length, 1)
      assert(
        events.some(
          /* 结果读取使用交付阶段，原执行仍只有一次准入。 */ (event) =>
            event.stage === 'result' && event.budget_phase === 'delivery'
        )
      )
    } finally {
      await fixture.close()
    }
  }
)

test(
  '已见契约后原上下文失效返回unknown即停止，不能把缺失旧许可当成新结果（服务stub）',
  /* 明确合成元数据终态，不能用测试stub证明真实断线执行结果。 */ async () => {
    await isolated(
      'lost_context',
      /* 已登记输入不因unknown或缺失正文再次准入。 */ async (run, stub, observations) => {
        await assert.rejects(run, { message: 'native_flow_call_failed' })
        assert.equal(stub.nativeRequests.length, 1)
        assert(
          observations.some(
            /* 原因只能是固定公共码，不带原异常或旧连接信息。 */ (event) =>
              event.state === 'outcome_unknown' && event.content_reason === 'unavailable'
          )
        )
      }
    )
  }
)

test(
  '原结果TTL已到期时拒绝读取，不能用新的交付等待复活结果（服务stub）',
  /* 未过期业务截止不能替代原句柄期限。 */ async () => {
    await isolated(
      'expired_result',
      /* 到期结果应在发送读取前被拒绝，原生意图仍仅一次。 */ async (run, stub) => {
        await assert.rejects(run, { message: 'native_flow_deadline' })
        assert.equal(stub.nativeRequests.length, 1)
      }
    )
  }
)

test(
  '六次只读SDK流程不报告Agent输入输出或模型成功（服务stub）',
  /** 业务为明确stub，实际HTTP SDK验证默认窗口模式没有start/prompt和错误范围标记。 */ async () => {
    await isolated(
      'normal',
      /** 六个读取必须保持精确方法集合且不产生任何输入意图。 */ async (run, stub) => {
        const result = await run(false, false)
        assert.equal(result.verification_scope, 'selected_window_read_only')
        assert.equal(result.native_calls, 6)
        assert.equal(result.agent_state_exercised, false)
        assert.equal(result.agent_input_output, undefined)
        assert.equal(result.conversation_verified, false)
        assert.deepEqual(
          stub.nativeRequests.map(/** 只比较固定方法名，不输出业务参数。 */ (row) => row.method),
          ['pane.list', 'pane.get', 'workspace.get', 'tab.get', 'agent.list', 'agent.sessions']
        )
      }
    )
  }
)

test(
  '最小SDK验收只提交一次pane.list并读取原结果，明确排除窗口/Agent和模型成功（服务stub）',
  /* 范围标记和单次意图通过实际SDK验证，业务回复仍是明确stub。 */ async () => {
    await isolated(
      'normal',
      /* SDK业务回复为明确stub，仅验证最小范围与单次调用。 */ async (run, stub) => {
        const result = await run(true)
        assert.equal(result.verification_scope, 'native_rpc_minimum')
        assert.deepEqual(
          stub.nativeRequests.map(/* 只比较已登记方法，不投影业务内容。 */ (row) => row.method),
          ['pane.list']
        )
        assert.equal(result.native_calls, 1)
        assert.equal(result.agent_state_exercised, false)
        assert.equal(result.model_requests, 0)
        assert.equal(result.conversation_verified, false)
        assert(result.checks.includes('real_describe_single_call_and_verified_result_read'))
      }
    )
  }
)

test(
  '正式SDK流程保留分页/原call轮询/稳定ID/单次输入，unknown与null不变成模型成功（服务stub）',
  /* 本例只有协议fixture，不能代表真实native成功。 */ async () => {
    await isolated(
      'normal',
      /* 只验证SDK契约和编排，不宣称真实native验收。 */ async (run, stub, observations) => {
        const result = await run()
        assert(stub.cursors.length > 1)
        assert([...stub.records.values()].every(/* 所有调用都读取原call直到响应。 */ (row) => row.polls === 2))
        assert.equal(
          stub.nativeRequests.filter(/* 业务输入只提交一次。 */ (row) => row.method === 'agent.prompt').length,
          1
        )
        assert.equal(
          stub.nativeRequests.find(
            /** 关闭终端时文本调用由原caller显式选择严格原生门禁。 */ (row) => row.method === 'agent.prompt'
          ).params.strict,
          true
        )
        const selected = stub.nativeRequests.find(
          /* 窗口读取使用实际选择后的稳定ID，不以位置或猜测revision替代。 */ (row) => row.method === 'workspace.get'
        )
        assert.deepEqual(selected.params, { workspace_id: 'fixture_workspace_id' })
        assert.equal(result.native_calls, 11)
        assert.equal(result.verification_scope, 'selected_window_and_agent_input_output')
        assert.equal(result.agent_input_output.native_state, 'unknown')
        assert.equal(result.agent_input_output.native_session_known, false)
        assert.equal(result.agent_input_output.model_reply_verified, false)
        assert.equal(result.conversation_verified, false)
        const deadlines = [...stub.records.values()].map(
          /* 每个真正准入记录保留最初的绝对截止。 */ (row) => row.result.expires_at
        )
        assert.equal(new Set(deadlines).size, 11)
        assert(
          observations.every(
            /* 每个新意图最多30秒，后续查询不能延长原期限。 */ (event) => event.remaining_ms <= LUVUS_FLOW_INTENT_MS
          )
        )
        const trace = JSON.stringify(observations)
        assert(
          !trace.includes('fixture_call_') &&
            !trace.includes('fixture_workspace_id') &&
            !trace.includes('SYNTHETIC SDK FIXTURE OUTPUT')
        )
      }
    )
  }
)

test(
  '真实SDK等待查询被撤权后停止，不重发原native意图；诊断只保留固定工具和公共码（服务stub）',
  /* 不用延长测试超时模拟长任务；由实际门面返回确定的授权拒绝。 */ async () => {
    await isolated(
      'wait_forbidden',
      /* 原始准入仅一次，后续变更或Agent输入都不得继续。 */ async (run, stub, observations) => {
        await assert.rejects(run, {
          message: 'native_flow_mcp_rejected',
          tool: 'runtime_call_get',
          serviceCode: 'forbidden'
        })
        assert.equal(stub.nativeRequests.length, 1)
        assert(
          observations.some(
            /* 拒绝必须定位到实际等待工具，不能误记为原生成功。 */ (event) =>
              event.stage === 'service_error' && event.tool === 'runtime_call_get'
          )
        )
      }
    )
  }
)

test(
  '正式SDK拒绝结果摘要变化，不继续发送Agent输入（服务stub）',
  /* 损坏回复不能继续业务流程。 */ async () => {
    await isolated(
      'bad_digest',
      /* 损坏结果不能在后续流程被当作正常回复。 */ async (run, stub) => {
        await assert.rejects(run, { message: 'native_flow_result_digest' })
        assert.equal(stub.nativeRequests.length, 1)
      }
    )
  }
)

test(
  '正式SDK发现terminal漂移就失败，已提交输入不重发（服务stub）',
  /* 身份漂移不触发输入重试。 */ async () => {
    await isolated(
      'terminal_drift',
      /* 原native terminal身份与读取结果必须相等。 */ async (run, stub) => {
        await assert.rejects(run, { code: 'ERR_ASSERTION' })
        assert.equal(
          stub.nativeRequests.filter(/* 身份失败后不得再次发送同一prompt。 */ (row) => row.method === 'agent.prompt')
            .length,
          1
        )
      }
    )
  }
)

test(
  '正式SDK目录缺少prompt能力时在native动作前拒绝（服务stub）',
  /* 缺能力先拒绝，不能用fixture执行掩盖。 */ async () => {
    await isolated(
      'missing_prompt',
      /* 目录不能用后续stub成功掩盖真实缺能力。 */ async (run, stub) => {
        await assert.rejects(run, { message: 'required_native_method_unavailable' })
        assert.equal(stub.nativeRequests.length, 0)
      }
    )
  }
)

test(
  '正式SDK拒绝同call_id的完整Target漂移，不发送后续输入（服务stub）',
  /* 原call_id不能使其它目标的回复变成已选会话结果。 */ async () => {
    await isolated(
      'binding_drift',
      /* 当前完整绑定变化立即失败，不自动重发动作。 */ async (run, stub) => {
        await assert.rejects(run, { message: 'native_flow_call_binding' })
        assert.equal(stub.nativeRequests.length, 1)
      }
    )
  }
)

test(
  '正式SDK允许created未派发时null契约，已见真实契约后拒绝退回null（服务stub）',
  /* 正常null到原契约的过渡已由正例覆盖；倒退不能靠同call_id继续。 */ async () => {
    await isolated(
      'ref_regression',
      /* 元数据倒退仍不重发原动作。 */ async (run, stub) => {
        await assert.rejects(run, { message: 'native_flow_call_binding' })
        assert.equal(stub.nativeRequests.length, 1)
      }
    )
  }
)
