/** 对照固定官方契约验证窗口/Agent 普通操作，合成参数测试不冒充真实 Agent 对话或本机 Owner。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import { createLuvusOperationsProvider } from '../../src/connector/luvus/operations-provider.js'
import type { LocalOwnerLuvusInstance } from '../../src/connector/luvus/host/native-source.js'
import {
  LUVUS_OPERATION_METHODS,
  luvusOperationDescriptor,
  luvusOperationValidation,
  validateLuvusOperationParams
} from '../../src/connector/luvus/operations.js'

const capabilities = JSON.parse(
  readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
).result
const schema = JSON.parse(
  readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
).request
const examples: Record<string, object> = {
  'session.snapshot': {},
  'wait.output': { pane: '1', match: 'unique_marker', timeout_s: 35 },
  'workspace.list': {},
  'workspace.get': { workspace_id: 'workspace_a' },
  'workspace.new': {},
  'workspace.open': { path: '/isolated/project', focus: false, if_revision: 10 },
  'workspace.focus': { workspace_id: 'workspace_a', if_revision: 10 },
  'workspace.rename': { workspace_id: 'workspace_a', name: 'project', if_revision: 10 },
  'workspace.close': { workspace_id: 'workspace_a', if_revision: 10 },
  'tab.list': {},
  'tab.get': { workspace_id: 'workspace_a', tab_id: 'tab_a' },
  'tab.new': {},
  'tab.focus': { tab_id: 'tab_a', if_revision: 10 },
  'tab.rename': { tab_id: 'tab_a', name: 'workspace', if_revision: 10 },
  'tab.close': { tab_id: 'tab_a', if_revision: 10 },
  'pane.list': { all_tabs: true },
  'pane.get': { pane: '1' },
  'pane.current': {},
  'pane.split': { pane: '1', direction: 'down' },
  'pane.focus': { pane: '1' },
  'pane.rename': { pane: '1', name: 'agent-window' },
  'pane.status': { pane: '1' },
  'pane.read': { pane: '1', lines: 100 },
  'pane.close': { pane: '1' },
  'pane.run': { pane: '1', command: 'printf rovloom-fixture' },
  'agent.list': {},
  'agent.get': { target: 'selected-agent' },
  'agent.explain': { target: 'selected-agent' },
  'agent.start': { name: 'selected-agent', kind: 'opencode', pane: '1' },
  'agent.prompt': {
    target: 'selected-agent',
    terminal_id: '1'.repeat(32),
    text: 'first turn',
    strict: true,
    wait: true,
    until: ['idle'],
    timeout_s: 30
  },
  'agent.send': { target: 'selected-agent', terminal_id: '1'.repeat(32), text: 'second turn', strict: true },
  'agent.keys': {
    target: 'selected-agent',
    keys: ['ctrl+c', 'Enter'],
    terminal_id: '1'.repeat(32),
    if_content_revision: 1
  },
  'agent.read': { target: 'selected-agent', lines: 100, source: 'recent' },
  'agent.sessions': {},
  'agent.resume': { session_id: 'native-session-id' },
  'agent.wait': { pane: '1', status: 'idle', timeout_s: 30 }
}

test('所有显式 pane 与 anchor 选择器统一接受正 u32 字符串，拒绝越界和非规范形式', () => {
  const cases = [
    ...[
      'pane.get',
      'pane.status',
      'pane.focus',
      'pane.close',
      'pane.rename',
      'pane.run',
      'pane.split',
      'pane.read',
      'agent.wait',
      'wait.output'
    ].map((method) => ({ method, params: examples[method]!, key: 'pane' })),
    { method: 'agent.start', params: { name: 'selected-agent', kind: 'opencode' }, key: 'pane' },
    { method: 'agent.start', params: { name: 'selected-agent', kind: 'opencode' }, key: 'anchor' }
  ]
  for (const { method, params, key } of cases) {
    for (const id of ['1', '4294967295']) {
      assert.doesNotThrow(() => validateLuvusOperationParams(method, { ...params, [key]: id }), method + ':' + key)
    }
    for (const id of ['4294967296', '9999999999', '10000000000', '0', '01', '-1', '1.0', 1]) {
      assert.throws(
        () => validateLuvusOperationParams(method, { ...params, [key]: id }),
        /luvus_operation_params_invalid/,
        method + ':' + key
      )
    }
  }
})

test('输出等待仅接受显式 pane 和有界字面标记，拒绝正则伪字段、错单位和越界值', () => {
  for (const timeout_s of [undefined, 0, 0.25, 3600]) {
    validateLuvusOperationParams('wait.output', {
      pane: '4294967295',
      match: '.*literal_汉字',
      ...(timeout_s === undefined ? {} : { timeout_s })
    })
  }
  for (const params of [
    {},
    { pane: '1' },
    { pane: '1', match: '' },
    { pane: '1', match: 'x'.repeat(4097) },
    { pane: '1', match: '汉'.repeat(1366) },
    { pane: '1', match: 'x\0y' },
    { pane: 1, match: 'x' },
    { pane: '0', match: 'x' },
    { pane: '4294967296', match: 'x' },
    { pane_id: '1', match: 'x' },
    { pane: '1', match: 'x', regex: true },
    { pane: '1', match: 'x', timeout_ms: 1000 },
    ...[-1, 3600.01, Infinity, NaN, '1', null].map((timeout_s) => ({ pane: '1', match: 'x', timeout_s }))
  ]) {
    assert.throws(() => validateLuvusOperationParams('wait.output', params), /luvus_operation_params_invalid/)
  }
})

test(
  'Luvus ordinary operation descriptors exactly match the official fixed live method contracts',
  /** 分类的 access/scope/idempotent 逐项取官方固定证据，不能从方法名称猜权限。 */ () => {
    assert(LUVUS_OPERATION_METHODS.length > 20)
    assert.deepEqual([...LUVUS_OPERATION_METHODS].sort(), Object.keys(examples).sort())
    for (const method of LUVUS_OPERATION_METHODS) {
      const expected = capabilities.method_contracts.find(
        /** 查找官方原生精确方法，不匹配前缀或通配符。 */ (entry: { method: string }) => entry.method === method
      )
      const descriptor = luvusOperationDescriptor(method)!
      assert.deepEqual(descriptor.native, expected)
      assert.equal(descriptor.effect, expected.access === 'read' ? 'read' : 'execute')
      const detailed = schema.allOf.some(
        /** 原 schema 是否实际有参数条件分支，generic 事实不能被分类掩盖。 */ (branch: any) => {
          const matcher = branch.if?.properties?.method
          return matcher?.const === method || matcher?.enum?.includes(method)
        }
      )
      assert.equal(descriptor.native_parameter_schema, detailed ? 'conditional_branch' : 'generic_params_only')
      assert.equal(luvusOperationValidation(method), detailed ? 'strict' : 'raw-contract')
      assert.doesNotThrow(
        /** 每个启用方法必须有一条明确可调用的参数样例。 */ () => validateLuvusOperationParams(method, examples[method])
      )
    }
  }
)

test(
  'Luvus workspace and tab selectors accept stable identities and explicit native numeric string positions',
  /** 原列表返回的位置字符串可显式使用；稳定 ID 保持原值，不被 guard 换算成位置。 */ () => {
    for (const method of ['workspace.get', 'workspace.focus', 'workspace.rename', 'workspace.close']) {
      for (const selected of [{ workspace_id: 'workspace_a' }, { workspace: 0 }, { workspace: '0' }]) {
        const params = {
          ...selected,
          ...(method === 'workspace.rename' ? { name: 'selected' } : {}),
          ...(method === 'workspace.get' ? {} : { if_revision: Number.MAX_SAFE_INTEGER })
        }
        const before = structuredClone(params)
        validateLuvusOperationParams(method, params)
        assert.deepEqual(params, before)
      }
    }
    for (const method of ['tab.get', 'tab.focus', 'tab.rename', 'tab.close']) {
      for (const selected of [{ tab_id: 'tab_a' }, { tab: 1 }, { tab: '1' }]) {
        validateLuvusOperationParams(method, {
          ...selected,
          ...(method === 'tab.rename' ? { name: '' } : {}),
          ...(method === 'tab.get' ? { workspace_id: 'workspace_a' } : { if_revision: 0 })
        })
      }
    }
    for (const params of [
      {},
      { workspace_id: 'workspace_a' },
      { workspace: '0', tab_id: 'tab_a' },
      { workspace_id: 'workspace_a', tab: '1' }
    ]) {
      validateLuvusOperationParams('tab.get', params)
    }
    validateLuvusOperationParams('workspace.get', {})
    validateLuvusOperationParams('workspace.open', { path: '/isolated/project', focus: false, if_revision: 0 })
    for (const method of ['workspace.new', 'tab.new']) {
      validateLuvusOperationParams(method, { if_revision: 0 })
    }
  }
)

test(
  'Luvus stable selectors preserve discovered identities and revisions after preceding rows close',
  /** 此处验证维护参数投影，不复制原生 resolver；实际命中及 revision_conflict 另由隔离官方实例核验。 */ () => {
    const workspaces = [
      { workspace: '0', workspace_id: 'workspace_before' },
      { workspace: '1', workspace_id: 'workspace_a' }
    ]
    const tabs = [
      { tab: '1', tab_id: 'tab_before' },
      { tab: '2', tab_id: 'tab_a' }
    ]
    const selectedWorkspace = { workspace_id: workspaces[1]!.workspace_id, name: 'selected A', if_revision: 40 }
    const selectedTab = { tab_id: tabs[1]!.tab_id, name: 'selected A', if_revision: 40 }
    workspaces.shift()
    tabs.shift()
    workspaces[0]!.workspace = '0'
    tabs[0]!.tab = '1'
    for (const [method, params] of [
      ['workspace.rename', selectedWorkspace],
      ['tab.rename', selectedTab]
    ] as const) {
      const before = structuredClone(params)
      validateLuvusOperationParams(method, params)
      assert.deepEqual(params, before)
    }
    assert.equal(selectedWorkspace.workspace_id, workspaces[0]!.workspace_id)
    assert.equal(selectedTab.tab_id, tabs[0]!.tab_id)
    assert.equal(selectedWorkspace.if_revision, 40)
    assert.equal(selectedTab.if_revision, 40)
    assert.throws(
      /** tab 写入不能静默忽略 workspace_id 并误操作当前 workspace 的同位置对象。 */ () =>
        validateLuvusOperationParams('tab.rename', { ...selectedTab, workspace_id: 'other_workspace' }),
      /luvus_operation_params_invalid/
    )
  }
)

test(
  'Luvus snapshot display coordinates project through the stable pane identity rather than a workspace offset',
  /** snapshot 的两层 index 为一基；用 pane_id 获取稳定 workspace/tab ID，不能把 index 原样当零基 workspace。 */ () => {
    const snapshot = { event_sequence: 40, workspaces: [{ index: 2, tabs: [{ index: 1, panes: [{ pane_id: '7' }] }] }] }
    const paneRequest = { pane: String(snapshot.workspaces[0]!.tabs[0]!.panes[0]!.pane_id) }
    validateLuvusOperationParams('pane.get', paneRequest)
    const paneResult = {
      pane: '7',
      workspace: '1',
      workspace_id: 'workspace_a',
      tab: '1',
      tab_id: 'tab_a',
      revision: 41
    }
    const workspaceRequest = { workspace_id: paneResult.workspace_id, name: 'A', if_revision: paneResult.revision }
    const tabRequest = { workspace_id: paneResult.workspace_id, tab_id: paneResult.tab_id }
    validateLuvusOperationParams('workspace.rename', workspaceRequest)
    validateLuvusOperationParams('tab.get', tabRequest)
    assert.equal('workspace' in workspaceRequest, false)
    assert.equal('workspace' in tabRequest, false)
    assert.deepEqual(paneRequest, { pane: '7' })
  }
)

test(
  'Luvus topology rejects ambiguous selectors, read revisions and native ignored fields',
  /** 字段逐方法核官方分发；不通过接受原生会忽略的参数伪装跨 workspace 写入或 cwd 创建。 */ () => {
    const malformed: [string, object][] = [
      ['workspace.get', { workspace: 0, workspace_id: 'workspace_a' }],
      ['workspace.get', { workspace_id: '' }],
      ['workspace.get', { workspace_id: null }],
      ['workspace.get', { workspace: '1.5' }],
      ['workspace.get', { workspace: '-1' }],
      ['workspace.get', { workspace_id: 'workspace_a', if_revision: 1 }],
      ['workspace.list', { if_revision: 1 }],
      ['workspace.new', { cwd: '/ignored' }],
      ['workspace.open', { path: '/isolated', focus: 'false' }],
      ['tab.get', { workspace: '0', workspace_id: 'workspace_a', tab_id: 'tab_a' }],
      ['tab.get', { tab: '1', tab_id: 'tab_a' }],
      ['tab.get', { tab: '0' }],
      ['tab.get', { tab_id: 'tab_a', if_revision: 1 }],
      ['tab.list', { workspace_id: 'workspace_a' }],
      ['tab.new', { workspace_id: 'workspace_a' }],
      ['tab.focus', { tab_id: 'tab_a', workspace_id: 'workspace_a' }],
      ['tab.rename', { tab_id: 'tab_a', workspace: '0', name: 'A' }],
      ['tab.close', { tab_id: '' }]
    ]
    for (const method of [
      'workspace.focus',
      'workspace.rename',
      'workspace.close',
      'tab.focus',
      'tab.rename',
      'tab.close'
    ]) {
      const selected = method.startsWith('workspace.') ? { workspace_id: 'workspace_a' } : { tab_id: 'tab_a' }
      const name = method.endsWith('.rename') ? { name: 'A' } : {}
      malformed.push([method, name])
      for (const if_revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
        malformed.push([method, { ...selected, ...name, if_revision }])
      }
    }
    for (const [method, params] of malformed) {
      assert.throws(
        /** 每种错形都在派发前拒绝，不通过自动 focus 或重放修补。 */ () => validateLuvusOperationParams(method, params),
        /luvus_operation_params_invalid/
      )
    }
  }
)

test(
  'Luvus Agent prompt, output and keys preserve explicit target and terminal identity across turns',
  /** 此测试只验证参数边界，真实模型两轮回复须由隔离 lab 另行实际执行。 */ () => {
    const target = 'selected-agent'
    const terminal = '1'.repeat(32)
    for (const text of ['remember this context', 'continue the previous turn']) {
      const params = {
        target,
        terminal_id: terminal,
        text,
        strict: true,
        wait: true,
        until: ['idle', 'done'],
        timeout_s: 60
      }
      validateLuvusOperationParams('agent.prompt', params)
      assert.equal(params.target, target)
      assert.equal(params.terminal_id, terminal)
      validateLuvusOperationParams('agent.read', { target, lines: 100, source: 'recent' })
    }
    validateLuvusOperationParams('agent.keys', { target, keys: ['esc'] })
    validateLuvusOperationParams('agent.wait', { pane: '1', statuses: ['idle', 'done'], timeout_s: 30 })
  }
)

for (const [method, params] of [
  ['workspace.focus', { workspace: -1 }],
  ['tab.focus', { tab: 0 }],
  ['pane.focus', { pane: 'other' }],
  ['pane.list', { all_tabs: 'true' }],
  ['pane.read', { pane: '1', source: 'recent' }],
  ['pane.split', { pane: '1', direction: 'left' }],
  ['agent.start', { name: 'x', kind: 'opencode', pane: '1', anchor: '2' }],
  ['agent.start', { name: 'x', kind: 'unreviewed kind' }],
  ['agent.prompt', { target: 'x', text: 'hello', until: ['idle'] }],
  ['agent.prompt', { target: 'x', text: 'hello', wait: true, until: ['finished'] }],
  ['agent.prompt', { target: 'x', text: 'hello', terminal_id: 'changed' }],
  ['agent.send', { target: 'x', text: 'hello', wait: true }],
  ['agent.keys', { target: 'x', keys: ['ctrl+c'], terminal_id: '1'.repeat(32) }],
  ['agent.keys', { target: 'x', keys: ['\u001b'] }],
  ['agent.keys', { target: 'x', keys: ['run arbitrary command'] }],
  ['agent.wait', { pane: '1', status: 'idle', statuses: ['done'] }],
  ['agent.read', { target: 'x', lines: 1001 }],
  ['agent.get', { target: 'x', auth: 'caller-token' }]
] as const) {
  test(
    `Luvus ordinary operation ${method} rejects malformed ${Object.keys(params).join(',')} params`,
    /** 错形参数不得被 Owner 模式或 generic 原 schema 的宽松外壳吞掉。 */ () => {
      assert.throws(
        /** 错误只返回固定码，不泄露 prompt、路径或输出。 */ () => validateLuvusOperationParams(method, params),
        /** 检查安全错误类型和公开固定消息。 */ (error: unknown) =>
          error instanceof LuvusAdapterError &&
          error.code === 'luvus_operation_params_invalid' &&
          error.message === error.code
      )
    }
  )
}

test(
  'Luvus ordinary operation surface excludes token, admin and integration state fabrication',
  /** 普通操作不借 Owner 模式加入 token 或伪造 Agent 上报。 */ () => {
    for (const method of [
      'uhp.token.create',
      'server.stop',
      'config.patch',
      'pane.send_input',
      'agent.report',
      'agent.release'
    ]) {
      assert.equal(luvusOperationDescriptor(method), undefined)
      assert.throws(
        /** 未审方法没有模式推导，不自动进入 raw。 */ () => luvusOperationValidation(method),
        /luvus_operation_unreviewed/
      )
      assert.throws(
        /** 空参数也不能把未知方法变成允许操作。 */ () => validateLuvusOperationParams(method, {}),
        /luvus_operation_unreviewed/
      )
    }
  }
)

test(
  'Luvus operation params do not invoke getters and a forged local Owner cannot establish a provider',
  /** 对参数与来源分别验证真实边界，ready 回调或同形 JSON 均不是 Owner 证据。 */ () => {
    let invoked = false
    const params = Object.defineProperty({}, 'target', {
      enumerable: true,
      /** 记录访问器是否执行，参数边界必须先拒绝。 */ get() {
        invoked = true
        return 'selected-agent'
      }
    })
    assert.throws(
      /** 不通过调用 getter 获取参数。 */ () => validateLuvusOperationParams('agent.get', params),
      /luvus_operation_params_invalid/
    )
    const owner = {
      ready: /** 假来源不能借回调自证。 */ () => {
        invoked = true
        return true
      }
    } as unknown as LocalOwnerLuvusInstance
    assert.throws(
      /** 工厂在读取任何伪造来源字段前核实际交付句柄。 */ () => createLuvusOperationsProvider(owner),
      /local_owner_unavailable/
    )
    assert.equal(invoked, false)
  }
)

test(
  'pane.run preserves explicit PTY input and rejects implicit targets and unsupported execution fields',
  /** 原生只收 pane/command 并回复输入确认；此处不执行命令，也不伪造退出状态。 */ () => {
    const params = { pane: '7', command: 'printf "fixture\\n"' }
    const before = structuredClone(params)
    validateLuvusOperationParams('pane.run', params)
    assert.deepEqual(params, before)
    assert.equal(luvusOperationValidation('pane.run'), 'raw-contract')
    for (const input of [
      { command: 'printf fixture' },
      { pane: '0', command: 'printf fixture' },
      { pane: '7', command: '' },
      { pane: '7', command: 'x'.repeat(65_537) },
      { ...params, cwd: '/ignored' },
      { ...params, env: { SYNTHETIC_SECRET: 'not-forwarded' } },
      { ...params, args: ['ignored'] },
      { ...params, timeout_s: 1 }
    ]) {
      assert.throws(
        /** 只接受核对过的真实字段，不替调用者扩展 shell 环境或生成执行框架。 */ () =>
          validateLuvusOperationParams('pane.run', input),
        /luvus_operation_params_invalid/
      )
    }
  }
)
