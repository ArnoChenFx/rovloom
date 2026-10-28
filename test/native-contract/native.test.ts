// 覆盖原生契约主路径、P0 离线重放、参数覆盖状态及 JSON 安全边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDispatch,
  checkResultBoundary,
  LUVUS_TABLE_METHODS,
  parseNativeJson
} from '../../src/connector/luvus/contract/index.js'
import { auth, clone, json, raw, register, rejects, request, sourceFor, unwrap, validator, view } from './helpers.js'

test(
  '原生完整 schema 保留 144 generic 与 79 条件分支的独立状态',
  /* 遍历通用参数方法，确认严格派发拒绝缺口且完整 raw 授权仍保留覆盖状态。 */ () => {
    const session = view()
    const host = view('host')
    assert.equal(session.methods.length, 197)
    assert.equal(host.methods.length, 17)
    assert.equal(
      session.methods.filter(
        /* 筛选没有方法专用参数分支的描述，核对总数。 */ (m) => m.schema_status === 'generic_params_only'
      ).length,
      144
    )
    let listed = 0
    for (const entry of session.methods.filter(
      /* 枚举仅有通用参数约束的方法以逐一验证两种执行模式。 */ (m) => m.schema_status === 'generic_params_only'
    )) {
      const checked = request(session, {
        id: 'all-generic',
        method: entry.method,
        params: { unannounced: ['synthetic'] }
      })
      assert.equal(checked.validation, 'generic')
      if (!LUVUS_TABLE_METHODS.includes(entry.method)) {
        // 表外方法不能靠 raw 获得许可。
        rejects(checkDispatch(checked, auth(checked)), 'method_not_listed')
        rejects(checkDispatch(checked, raw(checked)), 'method_not_listed')
        continue
      }
      // 表内方法在严格路径仍仅因参数缺口拒绝；显式 raw 保留 generic 覆盖状态。
      rejects(checkDispatch(checked, auth(checked)), 'parameter_schema_incomplete')
      const allowed = unwrap(checkDispatch(checked, raw(checked)))
      assert.equal(allowed.validation, 'generic')
      assert.equal(allowed.mode, 'raw_contract')
      listed++
    }
    assert(listed > 0)
  }
)

test(
  '原生 P0 全量 LF 请求/响应/事件离线重放，不制造认证或原生新运行',
  /* 离线重放 P0 请求、响应与事件，核对接受数量和预期拒绝边界。 */ () => {
    const transcript = json('transcript.json') as any[]
    const requests = new Map<string, any>()
    const sources = new Map<string, any>()
    const controls = new Set<string>()
    let accepted = 0
    let responses = 0
    let invalid = 0
    const generation = json('session-capabilities.json').result.server_generation
    const sessionCaps = json('session-capabilities.json')
    const sessionSource = sourceFor({
      ...view().binding,
      target: { machine_id: 'm1', profile: 'session', session: 'p0-issue3' },
      server_generation: generation
    })
    const actualView = unwrap(validator.bindCapabilities(sessionCaps, sessionSource))
    const host = view('host')
    // 将发送记录校验为请求或控制候选，并保存响应关联及可信来源。
    function sent(input: any) {
      if (
        input.action ||
        ['events.subscribe', 'terminal.backend.observe', 'terminal.backend.control'].includes(input.method)
      ) {
        // 流方法及其控制帧不属于 RPC 路径，只作为采集证据保留。
        controls.add(input.id)
        return
      }
      const from = actualView.methods.some(
        /* 判断 session 能力是否广告了当前发送的方法。 */ (m) => m.method === input.method
      )
        ? actualView
        : host.methods.some(/* 判断 host 能力是否广告了当前发送的方法。 */ (m) => m.method === input.method)
          ? host
          : actualView
      const checked = validator.checkRequest(from, input)
      if (input.id === 'proxy-unknown-method') {
        rejects(checked, 'native_request_invalid')
        requests.set(input.id, input)
        invalid++
      } else {
        requests.set(input.id, register(unwrap(checked), from))
        sources.set(input.id, sourceFor(from.binding))
        accepted++
      }
    }
    // 按原请求校验响应；流事件不再有校验入口，直接跳过。
    function received(input: any) {
      if (input.event) {
        return
      }
      if (controls.has(input.id)) {
        return
      }
      const original = requests.get(input.id)
      assert(original, '每个原生 response 必须有原始请求证据')
      if (original?.kind === 'request' || original?.kind === 'permit') {
        const checked = unwrap(validator.checkResponse(original, input, sources.get(input.id)))
        assert.deepEqual(checked.response, input)
      } else {
        assert.deepEqual(
          unwrap(validator.checkResponseShape(input, original?.action ? 'terminal' : 'general')).response,
          input
        )
      }
      responses++
    }
    for (const row of transcript) {
      if (row.kind === 'send') {
        sent(JSON.parse(row.wire))
      }
      if (row.kind === 'receive') {
        received(JSON.parse(row.wire))
      }
      if (row.kind === 'process' && row.argv.slice(-2).join(' ') === 'uhp proxy') {
        if (row.label !== 'proxy-malformed-json') {
          sent(JSON.parse(row.stdin.split('\n')[0]))
        }
        if (row.stdout) {
          received(JSON.parse(row.stdout))
        }
      }
    }
    assert.equal(accepted, 20)
    assert.equal(responses, 18)
    assert.equal(invalid, 1)
  }
)

test(
  'UTF-8/重复键/整数精度/深度及无行为对象边界',
  /* 覆盖解析的编码、重复键、精度与资源边界，并验证校验不会读取行为属性。 */ () => {
    assert.deepEqual(unwrap(parseNativeJson('{"__proto__":{"safe":true}}')), JSON.parse('{"__proto__":{"safe":true}}'))
    rejects(parseNativeJson('{"id":"a","id":"b"}'), 'duplicate_json_key')
    rejects(parseNativeJson(new Uint8Array([0xff])), 'invalid_utf8')
    rejects(parseNativeJson('{"sequence":9007199254740993}'), 'json_number_precision')
    rejects(parseNativeJson('"\\ud800"'), 'invalid_json')
    rejects(parseNativeJson('['.repeat(65) + '0' + ']'.repeat(65)), 'object_limit')
    const input: any = { id: 'no-getter', method: 'ping', params: {} }
    Object.defineProperty(input.params, 'trap', {
      enumerable: true,
      // 一旦访问测试属性即抛错，用于证明快照不会执行 getter。
      get() {
        throw Error('执行了 getter')
      }
    })
    rejects(validator.checkRequest(view(), input), 'invalid_json')
    const array: any[] = []
    Object.defineProperty(array, 'hidden', { value: true })
    rejects(validator.checkRequest(view(), { id: 'hidden', method: 'ping', params: { array } }), 'invalid_json')
  }
)

test(
  '许可/上下文不能通过 JSON 复制，普通 error.data 原样保存且结果重授权',
  /* 验证 JSON 复制无法伪造许可，错误数据保持原样且结果读取须重新授权。 */ () => {
    const v = view()
    const checked = request(v, {
      id: 'prompt',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    })
    rejects(checkDispatch(clone(checked), auth(checked)), 'invalid_request_handle')
    const permit = unwrap(checkDispatch(checked, auth(checked)))
    const error = {
      id: 'prompt',
      error: {
        code: 'synthetic_extension',
        message: 'synthetic',
        data: { a: [{ keep: true }] },
        extension: true
      }
    }
    assert.deepEqual(unwrap(validator.checkResponse(permit, error, sourceFor(checked.binding))).response, error)
    const resultContext = {
      principal_id: 'synthetic',
      content_status: 'available' as const
    }
    unwrap(checkResultBoundary(permit, resultContext))
    rejects(checkResultBoundary(permit, { ...resultContext, content_status: 'discarded' }), 'content_unavailable')
    rejects(checkResultBoundary(permit, { ...resultContext, principal_id: 'other' }), 'forbidden')
    rejects(validator.checkResponse(clone(permit), error, sourceFor(checked.binding)), 'invalid_permit_handle')
  }
)
