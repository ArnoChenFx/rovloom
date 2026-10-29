// 已审核子集的执行校验、runtime_describe 与拒绝诊断同源：接受即无诊断，拒绝即给出可定位的固定路径与规则。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compiled } from './contract/helpers.js'
import { NativeRequestPreflightError } from '../../../src/connector/preflight.js'
import { createLuvusRequestPreflight } from '../../../src/connector/luvus/preflight.js'
import {
  luvusParameterDiagnostic,
  luvusParameterHelp,
  publicLuvusParameterDiagnostic
} from '../../../src/connector/luvus/parameter-help.js'
import { luvusReviewedParams } from '../../../src/connector/luvus/reviewed-params.js'
import { LUVUS_OPERATION_METHODS, validateLuvusOperationParams } from '../../../src/connector/luvus/operations.js'

// 每个已审核普通方法的一份合法参数；任何字段规则变化都会让下面的基线断言先失败。
const BASE: Record<string, Record<string, unknown>> = {
  'session.snapshot': {},
  'workspace.list': {},
  'tab.list': {},
  'pane.current': {},
  'agent.list': {},
  'agent.sessions': {},
  'workspace.new': {},
  'tab.new': {},
  'workspace.open': { path: '/work/a' },
  'workspace.get': { workspace_id: 'wB' },
  'workspace.focus': { workspace: '0' },
  'workspace.close': { workspace_id: 'wB' },
  'workspace.rename': { workspace: '1', name: 'alpha' },
  'tab.get': { workspace_id: 'wB', tab: '1' },
  'tab.focus': { tab_id: 't1' },
  'tab.close': { tab: '2' },
  'tab.rename': { tab_id: 't1', name: 'alpha' },
  'pane.list': { all_tabs: true },
  'pane.get': { pane: '2' },
  'pane.status': { pane: '2' },
  'pane.focus': { pane: '2' },
  'pane.close': { pane: '2' },
  'pane.rename': { pane: '2', name: 'alpha' },
  'pane.run': { pane: '2', command: 'printf hello' },
  'wait.output': { pane: '2', match: 'marker', timeout_s: 35 },
  'pane.split': { pane: '2', direction: 'right' },
  'agent.get': { target: 'selected-agent' },
  'agent.explain': { target: 'selected-agent' },
  'agent.read': { target: 'selected-agent', lines: 10, source: 'recent' },
  'pane.read': { pane: '2', lines: 10 },
  'agent.resume': { session_id: 's1' },
  'agent.start': { name: 'worker', kind: 'pi', direction: 'auto', timeout_s: 30, args: ['--x'] },
  'agent.prompt': {
    target: 'selected-agent',
    text: 'Hello',
    strict: true,
    wait: true,
    until: ['idle'],
    timeout_s: 120
  },
  'agent.send': { target: 'selected-agent', text: 'Hello' },
  'agent.keys': { target: 'selected-agent', keys: ['enter'] },
  'agent.wait': { pane: '2', statuses: ['idle'], timeout_s: 35 }
}

type Issue = { path: string; rule: string }
type Schema = { required: string[]; properties: Record<string, Record<string, unknown>> }

/** 执行校验是否接受；拒绝时的诊断由同一请求的 luvusParameterDiagnostic 给出。 */
function accepted(method: string, params: unknown): boolean {
  try {
    validateLuvusOperationParams(method, params)
    return true
  } catch {
    return false
  }
}

function diagnosticOf(method: string, params: unknown) {
  return luvusParameterDiagnostic({ id: 'native_probe', method, params })
}

function issuesOf(method: string, params: unknown): readonly Issue[] {
  return diagnosticOf(method, params)?.issues ?? []
}

test('每个已审核方法都有与执行校验一致的合法基线，且 describe 与提示共用同一份必填和字段列表', () => {
  assert.deepEqual(
    [...LUVUS_OPERATION_METHODS].sort(),
    Object.keys(BASE).sort(),
    '普通方法清单与已审核基线必须一一对应'
  )
  for (const method of LUVUS_OPERATION_METHODS) {
    const params = BASE[method]!
    assert(accepted(method, params), method + ' 的合法基线必须通过执行校验')
    const schema = luvusReviewedParams(method) as unknown as Schema
    const help = luvusParameterHelp(method) as { required: string[]; optional: string[] }
    assert.deepEqual(help.required, schema.required, method + ' 的必填字段需与 describe 一致')
    assert.deepEqual(
      [...help.required, ...help.optional].sort(),
      Object.keys(schema.properties).sort(),
      method + ' 的提示字段需覆盖 describe 声明的全部字段'
    )
  }
})

test('pane.read 缺必填、类型错、lines 0 与 1001 在登记前带出与 describe 一致的字段诊断', () => {
  const preflight = createLuvusRequestPreflight(compiled)
  for (const [params, issues] of [
    [{ lines: 5 }, [{ path: '/params/pane', rule: 'required' }]],
    [{ pane: '1', lines: 'abc' }, [{ path: '/params/lines', rule: 'invalid_value' }]],
    [{ pane: '1', lines: 0 }, [{ path: '/params/lines', rule: 'range' }]],
    [{ pane: '1', lines: 1001 }, [{ path: '/params/lines', rule: 'range' }]]
  ] as const) {
    assert.throws(
      () => preflight({ id: 'native_invalid', method: 'pane.read', params }),
      (error: unknown) => {
        assert(error instanceof NativeRequestPreflightError)
        assert.deepEqual(error.parameterDiagnostic!.issues, issues)
        assert.deepEqual(error.parameterDiagnostic!.parameter_help, luvusParameterHelp('pane.read'))
        return true
      }
    )
  }
  assert.deepEqual(luvusParameterHelp('pane.read')!.required, ['pane'])
  // lines 边界 1 与 1000 合法，与 describe 的 minimum/maximum 一致。
  for (const lines of [1, 1000]) {
    validateLuvusOperationParams('pane.read', { pane: '1', lines })
  }
})

test('workspace.close 缺少稳定 ID 或位置选择器时给出选择器诊断，且 pane.list 未知字段给出根路径诊断', () => {
  const preflight = createLuvusRequestPreflight(compiled)
  assert.throws(
    () => preflight({ id: 'native_invalid', method: 'workspace.close', params: {} }),
    (error: unknown) => {
      assert(error instanceof NativeRequestPreflightError)
      // workspace 与 workspace_id 二选一：分支必填不逐个报告，由对象级 one_of 表达。
      assert.deepEqual(error.parameterDiagnostic!.issues, [{ path: '/params', rule: 'one_of' }])
      return true
    }
  )
  assert.throws(
    () => preflight({ id: 'native_invalid', method: 'pane.list', params: { lines: 5 } }),
    (error: unknown) => {
      assert(error instanceof NativeRequestPreflightError)
      assert.deepEqual(error.parameterDiagnostic!.issues, [{ path: '/params', rule: 'invalid_value' }])
      return true
    }
  )
})

test('执行校验接受即无诊断；拒绝即至少有一条固定诊断；describe 的必填、枚举与范围都能在诊断中找到', () => {
  for (const method of LUVUS_OPERATION_METHODS) {
    const base = BASE[method]!
    const schema = luvusReviewedParams(method) as unknown as Schema
    const probes: [string, Record<string, unknown>, Issue | undefined][] = [
      ['未知字段', { ...base, unexpected_field_xyz: 1 }, { path: '/params', rule: 'invalid_value' }]
    ]
    for (const [name, property] of Object.entries(schema.properties)) {
      if (schema.required.includes(name)) {
        const { [name]: _removed, ...rest } = base
        probes.push(['缺少 ' + name, rest, { path: '/params/' + name, rule: 'required' }])
      }
      const values = (property.enum ?? (property.items as { enum?: unknown[] } | undefined)?.enum) as
        | unknown[]
        | undefined
      if (Array.isArray(values)) {
        probes.push(['枚举外取值 ' + name, { ...base, [name]: 'NOT_A_VALUE' }, undefined])
      }
      if (typeof property.maximum === 'number' && property.type !== 'string') {
        probes.push([
          '超上界 ' + name,
          { ...base, [name]: property.maximum + 1 },
          { path: '/params/' + name, rule: 'range' }
        ])
      }
      if (typeof property.minimum === 'number' && property.type !== 'string') {
        probes.push([
          '低于下界 ' + name,
          { ...base, [name]: property.minimum - 1 },
          { path: '/params/' + name, rule: 'range' }
        ])
      }
    }
    for (const [label, params, expected] of probes) {
      const ok = accepted(method, params)
      const issues = issuesOf(method, params)
      assert.equal(ok, issues.length === 0, method + ' ' + label + '：接受与诊断必须一致')
      if (!ok) {
        const detail = publicLuvusParameterDiagnostic(diagnosticOf(method, params)!)!
        assert(detail.issues.length > 0, method + ' ' + label + '：拒绝必须有公开诊断')
        if (expected) {
          assert(
            issues.some((issue) => issue.path === expected.path && issue.rule === expected.rule),
            method + ' ' + label + '：应包含 ' + JSON.stringify(expected)
          )
        }
      }
    }
  }
})
