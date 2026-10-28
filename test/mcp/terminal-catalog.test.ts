/** 原 Store/原生目录与合成 caller/观察值验证目录限制，不创建终端或执行命令。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StoreGatewayService, FacadeServiceError } from '../../src/mcp/index.js'
import { catalogFixture } from './catalog-fixture.js'
import { target, storeFixture } from './store-fixture.js'
import { authorizedCatalog } from '../../src/mcp/catalog.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { httpFixture } from './http-fixture.js'
import { terminalExecutionCatalog } from '../../src/connector/terminal-execution.js'

const methods = ['ping', 'pane.run', 'pane.read', 'agent.send', 'agent.prompt', 'workspace.new']

test(
  'actual Luvus discovery and describe follow local off/on/unknown state while retaining strict text variants',
  /** 读取授权沿用完整 Target 双端交集；观察值不增加执行分类或修改原生 schema。 */ async () => {
    const f = catalogFixture()
    let enabled: boolean | undefined = false
    const grants = [{ target, methods, actions: ['read' as const] }]
    f.setCaller({ id: 'alice' })
    f.setSource({ ...f.source(), supported_methods: grants[0]!.methods })
    const service = new StoreGatewayService({
      targets: f.targets,
      store: f.store,
      identities: f.identities,
      catalog: f.catalog,
      terminalExecutionState: /** 只注入本测试的受信同步观察源。 */ () => enabled
    })
    const context = { caller: { principal_id: 'alice' }, wait_signal: new AbortController().signal }
    const discover = /** 真实服务走既有分页/授权路径，不直接测试列表拼装。 */ (limit = 100) =>
      service.execute('runtime_discover', { target, expected_binding_revision: 1, limit }, context)
    const describe = /** 真实描述不能访问已隐藏方法。 */ (method: string) =>
      service.execute('runtime_describe', { target, expected_binding_revision: 1, method }, context)
    try {
      for (enabled of [false, undefined]) {
        const page = await discover()
        assert(!page.data.items.some(/** 关闭及未知均不能广告直接终端写入。 */ (row) => row.method === 'pane.run'))
        const prompt = (await describe('agent.prompt')).data
        assert.deepEqual(prompt.terminal_execution, {
          local_state: enabled === false ? 'disabled' : 'unknown',
          request_parameters_checked: true,
          requires_explicit_strict: true
        })
        assert.equal((await describe('workspace.new')).data.method, 'workspace.new')
        await assert.rejects(describe('pane.run'), new FacadeServiceError('not_found'))
      }
      enabled = true
      const page = await discover(1)
      assert(page.data.next_cursor)
      const run = (await describe('pane.run')).data
      assert.deepEqual(run.terminal_execution, { local_state: 'enabled' })
      assert.equal(run.schema_status, 'generic_params_only')
      assert.equal(run.classification_status, 'not_evaluated')
      enabled = false
      await assert.rejects(
        service.execute(
          'runtime_discover',
          {
            target,
            expected_binding_revision: 1,
            limit: 1,
            cursor: page.data.next_cursor
          },
          context
        ),
        new FacadeServiceError('invalid_cursor')
      )
    } finally {
      f.close()
    }
  }
)

test(
  'shared catalog classification preserves parameter-sensitive variants for both providers',
  /** 目录描述不代替最终请求检查；Herdr 与 Luvus 均复用已存在的分类判定。 */ () => {
    for (const kind of ['luvus', 'herdr'] as const) {
      const direct = kind === 'luvus' ? 'pane.run' : 'pane.send_text'
      assert.equal(terminalExecutionCatalog(kind, direct, false).visible, false)
      assert.equal(terminalExecutionCatalog(kind, direct, undefined).visible, false)
      assert.equal(terminalExecutionCatalog(kind, direct, true).visible, true)
      assert.equal(terminalExecutionCatalog(kind, 'agent.start', false).visible, true)
      assert.equal(terminalExecutionCatalog(kind, 'agent.start', false).details?.request_parameters_checked, true)
      assert.equal(terminalExecutionCatalog(kind, 'pane.read', false).details, undefined)
    }
  }
)

test(
  'real MCP SDK receives the current terminal restriction without gaining a dispatch backend',
  /** SDK/HTTP/目录均为真实模块，身份和本地开关明确为合成 fixture，原生执行后端缺失。 */ async () => {
    const f = catalogFixture()
    let enabled = false
    const grants = [{ target, methods: ['pane.run', 'pane.read'], actions: ['read' as const] }]
    f.setCaller({ id: 'alice' })
    f.setSource({ ...f.source(), supported_methods: grants[0]!.methods })
    const service = new StoreGatewayService({
      targets: f.targets,
      store: f.store,
      identities: f.identities,
      catalog: f.catalog,
      terminalExecutionState: /** 本测试仅模拟本机观察，不签发派发许可。 */ () => enabled
    })
    const session = httpFixture(service, {
      authentication: { authenticate: /** HTTP 受信身份是测试主体，不从参数注入。 */ () => ({ principal_id: 'alice' }) }
    })
    try {
      await session.client.connect(session.transport, { timeout: 5000 })
      const request = {
        name: 'runtime_describe',
        arguments: { target, expected_binding_revision: 1, method: 'pane.run' }
      }
      const off = await session.client.callTool(request, CallToolResultSchema, { timeout: 5000 })
      assert.equal(off.isError, true)
      assert.deepEqual(off.structuredContent, { gateway_error: { code: 'not_found' } })
      enabled = true
      const on = await session.client.callTool(request, CallToolResultSchema, { timeout: 5000 })
      assert.equal(on.isError, undefined)
      const result = on.structuredContent as { data: { terminal_execution: object; contract_ref: string } }
      assert.deepEqual(result.data.terminal_execution, { local_state: 'enabled' })
      const dispatch = await session.client.callTool(
        {
          name: 'runtime_call',
          arguments: {
            target,
            expected_binding_revision: 1,
            contract_ref: result.data.contract_ref,
            native_request: { method: 'pane.run', params: { pane: '1', command: 'printf fixture' } },
            deadline: 1_020_000
          }
        },
        CallToolResultSchema,
        { timeout: 5000 }
      )
      assert.deepEqual(dispatch.structuredContent, { gateway_error: { code: 'backend_unavailable' } })
    } finally {
      await session.close()
      f.close()
    }
  }
)

test(
  'Herdr neutral catalog keeps original native descriptions and rejects observation drift',
  /** 合成 Herdr 目录只验证既有中性投影，不冒充已启动 Herdr 或实际输入回包。 */ () => {
    const f = storeFixture(
      'active',
      /** writer 关闭时设定本例原 Herdr 绑定。 */ (db) => {
        db.prepare('UPDATE providers SET kind=? WHERE machine_id=? AND provider_id=?').run(
          'herdr',
          target.machine_id,
          target.provider_id
        )
      }
    )
    let enabled: boolean | undefined
    const entries = [{ method: 'pane.send_text' }, { method: 'pane.read' }, { method: 'agent.start' }]
    f.setCaller({ id: 'alice' })

    const schema = { type: 'object', properties: { text: { type: 'string' } } }
    const source = {
      target,
      local_provider: f.store.provider(target.machine_id, target.provider_id)!,
      contract_ref: 'a'.repeat(64),
      capability_revision: 'herdr_fixture',
      expires_at: f.store.clock() + 30_000,
      methods: entries,
      describe: /** 原描述作为本例不变事实，不按开关修改参数 schema。 */ (method: string) => ({
        method,
        params_schema: schema
      })
    }
    const read = /** 每次都走真实中性目录授权和来源复验。 */ () =>
      authorizedCatalog({
        store: f.store,
        principal: f.current(),
        currentPrincipal: f.current,
        target,
        expected_binding_revision: 1,
        provider: { kind: 'provider', resolve: /** 只交付本例固定合成来源。 */ () => source },
        terminalExecutionState: /** 原本地同步观察值供目录使用。 */ () => enabled
      })
    try {
      for (enabled of [undefined, false]) {
        const catalog = read()
        assert(!catalog.methods.some(/** 关闭/未知均隐藏直接输入。 */ (row) => row.method === 'pane.send_text'))
        assert.equal(catalog.describe('agent.start').method, 'agent.start')
      }
      enabled = true
      const catalog = read()
      assert.deepEqual(catalog.describe('pane.send_text').params_schema, schema)
      assert.deepEqual(catalog.describe('pane.send_text').terminal_execution, { local_state: 'enabled' })
      enabled = false
      assert.throws(
        /** 旧目录视图不能越过同 epoch 的本地状态变化。 */ () => catalog.describe('pane.send_text'),
        new FacadeServiceError('contract_unavailable')
      )
    } finally {
      f.close()
    }
  }
)
