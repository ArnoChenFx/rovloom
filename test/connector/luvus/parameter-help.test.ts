// 用实际原生 schema 与既有审核校验器验证提示；错误诊断只投影固定字段，不带用户值。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compiled } from '../../native-contract/helpers.js'
import { createLuvusRequestPreflight, NativeRequestPreflightError } from '../../../src/connector/luvus/preflight.js'
import { validateLuvusOperationParams } from '../../../src/connector/luvus/operations.js'
import {
  luvusParameterHelp,
  publicLuvusParameterDiagnostic,
  type LuvusParameterDiagnostic
} from '../../../src/connector/luvus/parameter-help.js'

test('描述示例同时通过原 schema 和 Rovloom 审核子集，独立副本不能改变以后返回的提示', () => {
  const preflight = createLuvusRequestPreflight(compiled)
  for (const method of ['agent.start', 'agent.wait', 'agent.prompt', 'pane.run', 'wait.output']) {
    const guide = luvusParameterHelp(method)!
    for (const params of guide.examples as Record<string, unknown>[]) {
      validateLuvusOperationParams(method, params)
      preflight({ id: 'native_example', method, params })
    }
    ;(guide.required as string[]).push('user-secret')
    assert(!JSON.stringify(luvusParameterHelp(method)).includes('user-secret'))
  }
  assert.equal(luvusParameterHelp('unknown.method'), undefined)
})

test('常见选择器、wait 依赖与 generic 必填字段在登记前得到固定路径，秘密和未知字段不回显', () => {
  const preflight = createLuvusRequestPreflight(compiled)
  const secret = 'PRIVATE_PROMPT_COMMAND_TOKEN'
  for (const [method, params, path, rule] of [
    ['agent.start', { name: secret, kind: 'pi' }, '/params/name', 'pattern'],
    ['agent.start', { name: 'worker', kind: secret }, '/params/kind', 'pattern'],
    ['agent.start', { kind: 'pi' }, '/params/name', 'required'],
    ['agent.start', { name: 'worker' }, '/params/kind', 'required'],
    ['agent.start', { name: 'worker', kind: 'pi', pane: '2', anchor: '3' }, '/params/pane', 'one_of'],
    ['agent.wait', { target: secret, until: 'idle' }, '/params/pane', 'required'],
    ['agent.prompt', { target: 'agent', text: secret, until: ['idle'] }, '/params/wait', 'required_true'],
    ['pane.run', { pane: '2', [secret]: secret }, '/params/command', 'required'],
    ['wait.output', { pane: '2', [secret]: secret }, '/params/match', 'required'],
    ['wait.output', { pane: '2', match: secret, timeout_s: -1 }, '/params/timeout_s', 'range'],
    ['agent.wait', { pane: '2', status: 'idle', timeout_s: -1 }, '/params/timeout_s', 'range']
  ] as const) {
    assert.throws(
      () => preflight({ id: 'native_invalid', method, params }),
      (error) => {
        assert(error instanceof NativeRequestPreflightError)
        const detail = publicLuvusParameterDiagnostic(error.parameterDiagnostic!)!
        assert(detail.issues.some((issue) => issue.path === path && issue.rule === rule))
        assert(!JSON.stringify(detail).includes(secret))
        return true
      }
    )
  }
})

test('未知字段和非法枚举的真实 preflight 拒绝提供根路径诊断，不泄露键名或值', () => {
  const preflight = createLuvusRequestPreflight(compiled)
  const secret = 'PRIVATE_UNKNOWN_FIELD_OR_ENUM'
  for (const [method, params] of [
    ['agent.start', { name: 'worker', kind: 'pi', [secret]: secret }],
    ['pane.run', { pane: '2', command: 'x', [secret]: secret }],
    ['agent.wait', { pane: '2', status: secret }]
  ] as const) {
    assert.throws(
      () => preflight({ id: 'native_invalid', method, params }),
      (error) => {
        assert(error instanceof NativeRequestPreflightError)
        const detail = publicLuvusParameterDiagnostic(error.parameterDiagnostic!)!
        assert.deepEqual(detail.issues, [{ path: '/params', rule: 'invalid_value' }])
        assert.deepEqual(detail.parameter_help, luvusParameterHelp(method))
        assert(!JSON.stringify(detail).includes(secret))
        return true
      }
    )
  }
})

test('MCP 诊断投影拒绝伪造字段路径、规则和额外错误正文', () => {
  const value = {
    method: 'agent.wait',
    issues: [
      { path: '/params/secret-value', rule: 'required', text: 'private' },
      { path: '/params/pane', rule: 'private-error' },
      { path: '/params/pane', rule: 'required', text: 'private' }
    ]
  } as unknown as LuvusParameterDiagnostic
  const detail = publicLuvusParameterDiagnostic(value)!
  assert.deepEqual(detail.issues, [{ path: '/params/pane', rule: 'required' }])
  assert(!JSON.stringify(detail).includes('private'))
})
