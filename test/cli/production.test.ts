// 公开CLI与真实HTTP SDK/双库验证产品loader；身份、摘要、TLS均为自建合成fixture，不触及用户账户。
import { configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { CliError, configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { createProductionCliRuntime, productionOffer } from '../../src/cli/production.js'
import { negotiate, WIRE_MAJOR, WIRE_MINOR } from '../../src/wire/index.js'
import { createProductSources } from '../../src/cli/product-sources.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'
import { createManagementWriteClient } from '../../src/webui/write-client.js'
import { createDeviceManagementFlow } from '../../src/webui/write-flow.js'
import { createManagementHttpRead } from '../../src/webui/http-client.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { readRuntimeJson, runtimeReference } from '../../src/cli/runtime-files.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { FIXED_LUVUS_SCHEMA_SHA256, FIXED_LUVUS_SHA256 } from '../../src/connector/luvus/host/native-control.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/connector/luvus/host/native-source.js'
import { publishSchema, schemaReference } from '../../src/connector/schema-store.js'
import { SCHEMA_GC_GRACE } from '../../src/cli/gateway-schema-gc.js'
import { DatabaseSync } from 'node:sqlite'
import { startHttpFacade } from '../../src/mcp/http.js'
import type { ProviderCatalogSource } from '../../src/mcp/catalog.js'
import type { ProviderBinding, V2Target } from '../../src/wire/types.js'

const syntheticToken = 'SYNTHETIC_MCP_TOKEN_'.padEnd(48, 'x')
const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))

// 先从内核取得回环端口，再关闭本例预约listener，不访问外部端点。
async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  server.close()
  await once(server, 'close')
  return address.port
}

// 两个相互独立的私有配置层，默认入口只根据固定ref读取，不注入测试service或认证函数。
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-production-cli-'))
  const state = join(root, 'gateway')
  const refs = join(state, 'managed')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(refs, { mode: 0o700 })
  const port = await availablePort()
  let devicePort = await availablePort()
  while (devicePort === port) {
    devicePort = await availablePort()
  }
  const config = {
    ...configTemplate('gateway'),
    state_dir: state,
    mcp_port: port,
    device_port: devicePort,
    management_enabled: false
  } as GatewayConfig
  const url = `http://127.0.0.1:${port}/mcp`
  const source = {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource: url,
    local_policy: { revision: 'fixture_local', grants: [] },
    callers: [
      {
        principal: { id: 'fixture_caller', policy: { revision: 'fixture_caller_policy', grants: [] } },
        token_sha256: createHash('sha256').update(syntheticToken).digest('hex'),
        issued_at: Date.now() - 1000,
        expires_at: Date.now() + 60_000
      }
    ]
  }
  const auth = join(refs, config.authentication_ref + '.json')
  const path = join(root, 'gateway.json')
  writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
  writeFileSync(auth, JSON.stringify(source), { mode: 0o600 })
  const entries = new Map<string, unknown>()
  const providers = /* 程序管理的provider状态只由本例合成资源生成。 */ (values: Record<string, unknown>) => {
    entries.clear()
    for (const [reference, value] of Object.entries(values)) {
      entries.set(reference, value)
    }
    writeFileSync(
      join(refs, 'providers.json'),
      JSON.stringify({
        schema_version: 1,
        role: 'gateway',
        providers: [...entries].map(/* 每条保留原始来源值。 */ ([reference, value]) => ({ reference, value }))
      }),
      { mode: 0o600 }
    )
  }
  return { root, state, refs, config, url, source, auth, path, providers }
}

test('生产 Gateway 默认自动回收已观察七天的孤立 schema，并随宿主关闭释放维护任务', async () => {
  for (const missingRegistry of [false, true]) {
    const f = await fixture()
    let active: Awaited<ReturnType<NonNullable<ReturnType<typeof createProductionCliRuntime>['gateway']>>> | undefined
    try {
      const raw = Buffer.from('{"orphan":"failed-pairing"}')
      const path = schemaReference(f.state, createHash('sha256').update(raw).digest('hex'))
      publishSchema(path, raw)
      writeFileSync(
        runtimeReference(f.state, 'schema-gc'),
        JSON.stringify({
          version: 1,
          checked_at: Date.now(),
          candidates: [{ file: basename(path), unreferenced_at: Date.now() - SCHEMA_GC_GRACE - 1000 }]
        })
      )
      if (missingRegistry) {
        // 数据库仍有 provider、磁盘 registry 却缺失：不能把它误判成无引用孤儿。
        openGatewayState({ state_directory: f.state, changed() {} }).close()
        const seed = new DatabaseSync(join(f.state, 'gateway.db'))
        try {
          seed
            .prepare('INSERT INTO machines(machine_id,name,status) VALUES(?,?,?)')
            .run('synthetic', 'synthetic', 'pending')
          seed.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)').run('synthetic', 'luvus', 'luvus', 'missing', 1, 1)
        } finally {
          seed.close()
        }
      }
      active = await createProductionCliRuntime().gateway!(f.config)
      assert.equal(existsSync(path), missingRegistry)
      assert.equal(existsSync(join(f.state, 'gateway.db.lock')), true)
      await active.close()
      active = undefined
      assert.equal(existsSync(join(f.state, 'gateway.db.lock')), false)
    } finally {
      await active?.close()
      rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test(
  '生产混合Gateway保留真实Luvus远端pin与Herdr目录，标准loader核对全部引用且原始字节仍验pin',
  /** 设备/数据库种子是明确fixture；真实CLI/Worker/远端资源不需要本机native或合成成功会话。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await fixture()
    const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
    assert(schema.length > 16_384)
    const target: V2Target = {
      machine_id: 'fixture_remote_machine',
      provider_id: 'fixture_remote',
      profile: 'session',
      session: 'fixture_remote_session'
    }
    const binding: ProviderBinding = {
      machine_id: target.machine_id,
      provider_id: target.provider_id,
      kind: 'luvus',
      config_ref: 'fixture_remote',
      binding_revision: 1,
      enabled: true
    }
    const reference = {
      kind: 'luvus',
      authentication: 'remote_connector',
      binding,
      target,
      contract: {
        binary_version: '0.14.3',
        binary_sha256: FIXED_LUVUS_SHA256,
        schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
        adapter_revision: MANAGED_LUVUS_REVISION,
        classification_revision: MANAGED_LUVUS_CLASSIFICATION,
        schema_bundle: schema.toString('utf8')
      }
    }
    const herdrRoot = privateHerdrTestRoot('.mixed-production-schema-')
    const herdrTarget: V2Target = { ...target, provider_id: 'fixture_herdr' }
    const herdrBinding: ProviderBinding = {
      ...binding,
      provider_id: herdrTarget.provider_id,
      kind: 'herdr',
      config_ref: 'fixture_herdr'
    }
    const herdrSchema = join(herdrRoot, 'schema.json')
    const state = /** 同一个真实双库只在种子阶段或产品角色中独占打开。 */ () =>
      openGatewayState({
        state_directory: f.state,
        changed: /** 合成离线设备不存在活动通道。 */ () => {}
      })
    let active: Awaited<ReturnType<NonNullable<ReturnType<typeof createProductionCliRuntime>['gateway']>>> | undefined
    try {
      writeFileSync(herdrSchema, readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url)), {
        mode: 0o600
      })
      const herdrReference = {
        kind: 'herdr',
        config: {
          version: 1,
          target: herdrTarget,
          binding_revision: 1,
          config_ref: 'fixture_herdr',
          expected_source: fixedHerdrSource(),
          schema_ref: herdrSchema
        }
      }
      f.providers({ fixture_remote: reference, fixture_herdr: herdrReference })
      const grants = [target, herdrTarget].map(
        /** 两个完整目标分别授权，只读取目录，不授予native执行。 */ (selected) => ({
          target: selected,
          methods: [selected.provider_id === target.provider_id ? 'automation.list' : 'ping'],
          actions: ['read']
        })
      )
      f.source.local_policy.grants = grants as typeof f.source.local_policy.grants
      f.source.callers[0]!.principal.policy.grants = structuredClone(
        grants
      ) as (typeof f.source.callers)[0]['principal']['policy']['grants']
      writeFileSync(f.auth, JSON.stringify(f.source))
      state().close()
      const seed = new DatabaseSync(join(f.state, 'gateway.db'))
      try {
        seed
          .prepare('INSERT INTO machines(machine_id,name,status,credential_hash) VALUES(?,?,?,?)')
          .run(
            target.machine_id,
            'fixture_remote_machine',
            'offline',
            createHash('sha256').update('not_issued_remote_fixture').digest('hex')
          )
        seed
          .prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
          .run(binding.machine_id, binding.provider_id, binding.kind, binding.config_ref, binding.binding_revision, 1)
        seed
          .prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
          .run(
            herdrBinding.machine_id,
            herdrBinding.provider_id,
            herdrBinding.kind,
            herdrBinding.config_ref,
            herdrBinding.binding_revision,
            1
          )
      } finally {
        seed.close()
      }
      const runtime = createProductionCliRuntime(createProductSources())
      active = await runtime.gateway!(f.config)
      assert.equal(existsSync(join(f.root, 'control')), false)
      const context = { caller: { principal_id: 'fixture_caller' }, wait_signal: new AbortController().signal }
      const providers = await active.service.execute('providers_list', { machine_id: target.machine_id }, context)
      assert.deepEqual(
        providers.data.items
          .map(/** 只有同一Store已登记且当前可读的两个原provider。 */ (provider) => provider.provider_id)
          .sort(),
        [target.provider_id, herdrTarget.provider_id].sort()
      )
      assert.equal(
        (
          await active.service.execute(
            'runtime_describe',
            { target: herdrTarget, expected_binding_revision: 1, method: 'ping' },
            context
          )
        ).data.method,
        'ping'
      )
      await assert.rejects(
        active.service.execute(
          'runtime_describe',
          { target, expected_binding_revision: 1, method: 'automation.list' },
          context
        ),
        { code: 'backend_unavailable' }
      )
      await active.close()
      active = undefined
      state().close()
      for (const contract of [{ ...reference.contract, schema_bundle_ref: 'https://invalid.example/schema' }]) {
        f.providers({ fixture_remote: { ...reference, contract }, fixture_herdr: herdrReference })
        await assert.rejects(
          /** URL和双重声明在原资源打开前拒绝，不放宽小配置或路径门禁。 */ () => runtime.gateway!(f.config),
          { code: 'production_reference_invalid' }
        )
      }
      f.providers({
        fixture_remote: {
          ...reference,
          contract: { ...reference.contract, schema_bundle: '\ufeff' + schema.toString('utf8') }
        },
        fixture_herdr: herdrReference
      })
      await assert.rejects(
        /** 解码不能剥掉BOM后套用旧摘要，原始文件变化仍交原pin核验拒绝。 */ () => runtime.gateway!(f.config),
        { code: 'remote_luvus_pin_invalid' }
      )
      state().close()
    } finally {
      await active?.close()
      rmSync(f.root, { recursive: true, force: true })
      rmSync(herdrRoot, { recursive: true, force: true })
    }
  }
)

test(
  '生产CLI在同一双库交付页面CSRF，真实读写服务完成合成设备确认改名并响应源撤权',
  { timeout: 30_000 },
  /** 会话来源为显式测试stub，业务使用实际产品工厂/HTTP/Store；没有真实账户、原生调用或设备凭据签发。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await fixture()
    let active: Awaited<ReturnType<NonNullable<ReturnType<typeof createProductionCliRuntime>['gateway']>>> | undefined
    let client: ReturnType<typeof createManagementWriteClient> | undefined
    let managementOrigin = ''
    let enabled = true
    const machine = 'fixture_page_machine'
    const sessionRef = 'fixture_existing_page_session'
    const issued = Date.now()
    const sources = createProductSources()
    try {
      const initial = openGatewayState({
        state_directory: f.state,
        changed: /** 没有运行中的设备连接。 */ () => {}
      })
      initial.close()
      const seed = new DatabaseSync(join(f.state, 'gateway.db'))
      try {
        seed
          .prepare('INSERT INTO machines(machine_id,name,status,credential_hash) VALUES(?,?,?,?)')
          .run(
            machine,
            'before_fixture',
            'offline',
            createHash('sha256').update('not_issued_fixture_page').digest('hex')
          )
      } finally {
        seed.close()
      }
      sources.administrator = /** 合成原后端只认可既有caller/session，并逐次检查撤权；不是生产登录实现。 */ function (
        caller,
        ref
      ) {
        assert.equal(this, sources)
        return enabled && caller.principal_id === 'fixture_caller' && ref === sessionRef
          ? {
              principal_id: caller.principal_id,
              session_ref: sessionRef,
              assurance: 'administrator',
              policy_revision: 'fixture_page_policy',
              grants: [
                { action: 'devices_read', machine_id: machine },
                { action: 'devices_rename', machine_id: machine }
              ]
            }
          : null
      }
      sources.management = {
        port: 0,
        http: { assets: new Map([['/', new TextEncoder().encode('<html><head></head><body>fixture</body></html>')]]) },
        /** 仅测试stub用标记模拟原受保护请求；不交付生产认证协议，也不据loopback默认选管理员。 */
        async resolveLease(request, signal) {
          assert.equal(this, sources.management)
          return !signal.aborted && enabled && request.headers.get('x-fixture-protected-request') === 'synthetic-only'
            ? {
                caller: { principal_id: 'fixture_caller' },
                management_session_ref: sessionRef,
                issued_at: issued,
                expires_at: issued + 60_000
              }
            : null
        },
        /** 只接收实际URL，不包含cookie、CSRF或其他身份材料。 */
        listening(url) {
          assert.equal(this, sources.management)
          managementOrigin = url.replace(/\/$/, '')
        }
      }
      active = await createProductionCliRuntime(sources).gateway!(f.config)
      const plain = await fetch(managementOrigin)
      assert.equal(plain.headers.get('set-cookie'), null)
      assert(!(await plain.text()).includes('rovloom-management-bootstrap'))
      const page = await fetch(managementOrigin, { headers: { 'x-fixture-protected-request': 'synthetic-only' } })
      assert.equal(page.status, 200)
      const body = await page.text()
      const cookie = /^rovloom_management=[\w-]{43}/.exec(page.headers.get('set-cookie')!)![0]!
      const csrf = /content="([\w-]{43})"/.exec(body)![1]!
      const fetcher = /** Bun显式模拟浏览器附带同源cookie/Origin，服务与确认逻辑全部保持真实。 */ (
        path: string,
        init: RequestInit
      ) => {
        const headers = new Headers(init.headers)
        headers.set('cookie', cookie)
        headers.set('origin', managementOrigin)
        return fetch(managementOrigin + path, { ...init, headers })
      }
      const read = createManagementHttpRead(fetcher)
      const before = await read('devices_get', { machine_id: machine }, new AbortController().signal)
      assert.equal(before.name, 'before_fixture')
      client = createManagementWriteClient({
        csrf: /** 测试从真实HTML取回原值，页面DOM消费另由bootstrap测试覆盖。 */ async () => csrf,
        fetcher
      })
      const flow = createDeviceManagementFlow({ transport: client })
      try {
        assert.equal(
          (await flow.prepare({ action: 'device_rename', machine_id: machine, name: 'after_fixture' })).phase,
          'awaiting_confirmation'
        )
        assert.equal((await flow.confirm()).phase, 'committed')
        assert.equal(
          (await read('devices_get', { machine_id: machine }, new AbortController().signal)).name,
          'after_fixture'
        )
        enabled = false
        await assert.rejects(client.execute('history_open', {}, new AbortController().signal), /unauthenticated/)
      } finally {
        flow.dispose()
      }
      client.close()
      await active.close()
      active = undefined
      const verify = new DatabaseSync(join(f.state, 'gateway.db'), { readOnly: true })
      try {
        assert.equal(
          (verify.prepare('SELECT name FROM machines WHERE machine_id=?').get(machine) as { name: string }).name,
          'after_fixture'
        )
      } finally {
        verify.close()
      }
      assert(!body.includes(cookie) && !body.includes(sessionRef) && !body.includes('fixture_caller'))
    } finally {
      client?.close()
      await active?.close()
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  '生产loader接中性Gateway与Herdr目录，不要求Luvus来源且保留分页、失效和实际writer释放',
  { timeout: 30_000 },
  /* Herdr binding、目录和身份均为明确元数据fixture；没有原生会话，不计真实窗口/Agent验收。 */ async () => {
    if (process.platform !== 'linux') {
      assert.throws(/* 非Linux读取仍使用现行拒绝。 */ () => readRuntimeJson('/unused'), CliError)
      return
    }
    const f = await fixture()
    let active: Awaited<ReturnType<NonNullable<ReturnType<typeof createProductionCliRuntime>['gateway']>>> | undefined
    let http: ReturnType<typeof startHttpFacade> | undefined
    let client: Client | undefined
    let released = 0
    let sessionCalls = 0
    const target: V2Target = {
      machine_id: 'fixture_machine',
      provider_id: 'fixture_herdr',
      profile: 'session',
      session: 'fixture_session'
    }
    const binding: ProviderBinding = {
      machine_id: target.machine_id,
      provider_id: target.provider_id,
      kind: 'herdr',
      config_ref: 'fixture_herdr',
      binding_revision: 1,
      enabled: true
    }
    const state = /* 初始化/重开同一真实双库，测试种子只在全部writer关闭时写入。 */ () =>
      openGatewayState({
        state_directory: f.state,
        changed: /* 没有设备连接需要通知。 */ () => {}
      })
    let source: ProviderCatalogSource = {
      target,
      local_provider: binding,
      contract_ref: 'b'.repeat(64),
      capability_revision: 'fixture_catalog_1',
      expires_at: Date.now() + 30_000,
      methods: [{ method: 'pane.read' }, { method: 'agent.state' }, { method: 'agent.prompt' }],
      describe: /* 合成目录只验证接线，不伪称这是官方schema或原生成功回复。 */ (method) => ({
        method,
        inputSchema: { type: 'object' }
      })
    }
    try {
      const grants = [{ target, methods: ['pane.read', 'agent.state'], actions: ['read'] }]
      writeFileSync(
        f.auth,
        JSON.stringify({
          ...f.source,
          local_policy: { ...f.source.local_policy, grants },
          callers: f.source.callers.map(
            /* 当前文件caller复用原摘要和租期，只配置本例精确目标。 */ (caller) => ({
              ...caller,
              principal: { ...caller.principal, policy: { ...caller.principal.policy, grants } }
            })
          )
        })
      )
      f.providers({ fixture_herdr: { kind: 'herdr' } })
      state().close()
      const seed = new DatabaseSync(join(f.state, 'gateway.db'))
      try {
        seed
          .prepare('INSERT INTO machines(machine_id,name,status,credential_hash) VALUES(?,?,?,?)')
          .run(
            target.machine_id,
            'fixture_machine',
            'offline',
            createHash('sha256').update('not_issued_fixture').digest('hex')
          )
        seed
          .prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
          .run(binding.machine_id, binding.provider_id, binding.kind, binding.config_ref, 1, 1)
      } finally {
        seed.close()
      }
      const runtime = createProductionCliRuntime({
        gateway: /* 真实loader接中性factory；这个fixture不提供任何原生执行成功替身。 */ async (_config, references) => {
          assert.deepEqual(references, [{ reference: 'fixture_herdr', value: { kind: 'herdr' } }])
          return {
            kind: 'provider',
            providers: [
              {
                binding,
                target,
                admit() {
                  throw new Error('unused_native_admission_fixture')
                },
                retainEvidence(plan) {
                  return plan
                },
                ready: /* 无原生实例不能报告ready。 */ () => false
              }
            ],
            session: /* 本例没有设备连接；意外调用必须失败，不能产生成功native stub。 */ () => {
              sessionCalls++
              throw new Error('unused_native_session_fixture')
            },
            catalog: { kind: 'provider', resolve: /* 只返回明确的合成目录，运行时不反序列化来源。 */ () => source },
            release: /* 资源释放由唯一Gateway工厂委托，不能多次回收。 */ async () => {
              released++
            }
          }
        }
      })
      active = await runtime.gateway!(f.config)
      http = startHttpFacade({
        service: active.service,
        authentication: active.authentication,
        port: f.config.mcp_port
      })
      client = new Client({ name: 'neutral_loader_fixture', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(http.url), {
          requestInit: { headers: { authorization: `Bearer ${syntheticToken}` } }
        }),
        { timeout: 5000 }
      )
      const provider = await client.callTool(
        { name: 'providers_get', arguments: { machine_id: target.machine_id, provider_id: target.provider_id } },
        CallToolResultSchema
      )
      assert.equal(
        (CallToolResultSchema.parse(provider).structuredContent!.data as Record<string, unknown>).kind,
        'herdr'
      )
      const args = { target, expected_binding_revision: 1 }
      const first = await client.callTool(
        { name: 'runtime_discover', arguments: { ...args, limit: 1 } },
        CallToolResultSchema
      )
      assert.equal(first.isError, undefined)
      const page = CallToolResultSchema.parse(first).structuredContent!.data as {
        items: { method: string }[]
        next_cursor: string
      }
      assert.deepEqual(
        page.items.map(/* 只展示当前双端read允许的原生方法。 */ (item) => item.method),
        ['pane.read']
      )
      assert(page.next_cursor)
      const description = await client.callTool(
        { name: 'runtime_describe', arguments: { ...args, method: 'pane.read' } },
        CallToolResultSchema
      )
      assert.equal(description.isError, undefined)
      assert.equal(
        (CallToolResultSchema.parse(description).structuredContent!.data as Record<string, unknown>).contract_ref,
        source.contract_ref
      )
      source = { ...source, capability_revision: 'fixture_catalog_2' }
      const stale = await client.callTool(
        { name: 'runtime_discover', arguments: { ...args, limit: 1, cursor: page.next_cursor } },
        CallToolResultSchema
      )
      assert.deepEqual(stale.structuredContent, { gateway_error: { code: 'invalid_cursor' } })
      source = { ...source, expires_at: Date.now() - 1 }
      const expired = await client.callTool(
        { name: 'runtime_describe', arguments: { ...args, method: 'pane.read' } },
        CallToolResultSchema
      )
      assert.deepEqual(expired.structuredContent, { gateway_error: { code: 'contract_unavailable' } })
      assert.equal(sessionCalls, 0)
      await client.close()
      await http.close()
      await active.close()
      await active.close()
      assert.equal(released, 1)
      state().close()
    } finally {
      await client?.close()
      await http?.close()
      await active?.close()
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  '公开CLI从受保护文件建立真实Gateway HTTP，EOF持续运行、摘要认证撤销及SIGTERM释放双库',
  { timeout: 30_000 },
  /* 只测试空provider角色的真实查询与生命周期，不把SDK/双库成功称为native调用成功。 */ async () => {
    const f = await fixture()
    const child = spawn(process.execPath, ['--no-env-file', main, 'gateway', '--config', f.path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' }
    })
    let output = ''
    let errors = ''
    child.stdout.on(
      'data',
      /* 有界观察公开进程输出，凭据不通过该通道交付。 */ (chunk) => {
        output = (output + String(chunk)).slice(0, 65_536)
      }
    )
    child.stderr.on(
      'data',
      /* 失败时只检查固定诊断及秘密缺失，不转发原始子进程内容。 */ (chunk) => {
        errors = (errors + String(chunk)).slice(0, 65_536)
      }
    )
    const exited = once(child, 'exit')
    const transport = new StreamableHTTPClientTransport(new URL(f.url), {
      requestInit: { headers: { authorization: `Bearer ${syntheticToken}` } }
    })
    const client = new Client({ name: 'production-loader-fixture', version: '1' })
    try {
      child.stdin.end()
      const until = performance.now() + 5000
      while (true) {
        assert.equal(child.exitCode, null, 'fixture_cli_exited_before_listener')
        let response: Response
        try {
          response = await fetch(f.url, { signal: AbortSignal.timeout(300) })
        } catch {
          assert(
            performance.now() < until,
            existsSync(join(f.state, 'gateway.db'))
              ? 'fixture_cli_start_timeout_after_state'
              : 'fixture_cli_start_timeout_before_state'
          )
          await new Promise(
            /* 只等待实际listener可用，不改变产品或SDK请求预算。 */ (resolve) => setTimeout(resolve, 10)
          )
          continue
        }
        await response.body?.cancel()
        assert.equal(response.status, 401)
        break
      }
      await client.connect(transport, { timeout: 5000 })
      const reply = await client.callTool({ name: 'machines_list', arguments: {} }, CallToolResultSchema, {
        timeout: 5000
      })
      assert.equal(reply.isError, undefined)
      assert.deepEqual(reply.structuredContent, { data: { items: [] } })
      assert(existsSync(join(f.state, 'gateway.db')))
      assert.deepEqual(await client.ping({ timeout: 5000 }), {})
      assert.equal(child.exitCode, null)
      writeFileSync(f.auth, JSON.stringify({ ...f.source, callers: [] }))
      await assert.rejects(client.ping({ timeout: 5000 }))
      assert.equal((await fetch(f.url, { headers: { authorization: `Bearer ${syntheticToken}` } })).status, 401)
      // 注册表热读：恢复原内容后，同一令牌无需重启即可再次认证。
      writeFileSync(f.auth, JSON.stringify(f.source))
      assert.notEqual((await fetch(f.url, { headers: { authorization: `Bearer ${syntheticToken}` } })).status, 401)
      await client.close()
      child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      let ended: unknown
      try {
        ended = await Promise.race([
          exited,
          new Promise(
            /* 只对本例拥有的子进程设置原有5秒清理预算，超时即失败。 */ (_resolve, reject) => {
              timer = setTimeout(
                /* 本例清理超时明确失败，不遗留延迟拒绝。 */ () => reject(new Error('fixture_cli_close_timeout')),
                5000
              )
            }
          )
        ])
      } finally {
        clearTimeout(timer)
      }
      assert.deepEqual(ended, [0, null])
      assert.equal(output, '')
      assert(!errors.includes(syntheticToken))
      const reopened = openGatewayState({
        state_directory: f.state,
        changed: /* 本例没有任何身份变更。 */ () => {}
      })
      reopened.close()
    } finally {
      await client.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      await exited
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  '只读caller源沿用普通文件和链接，仍拒绝过期、错误资源及额外身份字段',
  /* 直接验证正式读取/authentication代码，全部摘要来自本例合成token。 */ async () => {
    const f = await fixture()
    try {
      const source = openCallerSource(f.auth, f.url)
      const request = new Request(f.url, { headers: { authorization: `Bearer ${syntheticToken}` } })
      const signal = new AbortController().signal
      assert.deepEqual(source.authentication.authenticate(request, signal), { principal_id: 'fixture_caller' })
      assert.equal(source.identities.administrator({ principal_id: 'fixture_caller' }, 'forged'), null)
      assert.equal(source.authentication.authenticate(new Request(f.url + '?secret=synthetic'), signal), null)
      assert.throws(/* 资源不匹配不能挂载身份来源。 */ () => openCallerSource(f.auth, f.url + '/other'))
      writeFileSync(f.auth, JSON.stringify({ ...f.source, source_verified: true }))
      assert.throws(/* 普通配置不得声明来源已验证。 */ () => openCallerSource(f.auth, f.url))
      assert.equal(source.authentication.authenticate(request, signal), null)
      writeFileSync(
        f.auth,
        JSON.stringify({ ...f.source, callers: [{ ...f.source.callers[0], expires_at: 1, issued_at: 0 }] })
      )
      const expired = openCallerSource(f.auth, f.url)
      assert.equal(expired.authentication.authenticate(request, signal), null)
      assert.equal(expired.identities.principal({ principal_id: 'fixture_caller' }), null)
      chmodSync(f.auth, 0o644)
      assert.doesNotThrow(/* 普通读取权限不赋予有效网络身份。 */ () => readRuntimeJson(f.auth))
      assert.equal(expired.authentication.authenticate(request, signal), null)
      chmodSync(f.auth, 0o600)
      const alias = join(f.refs, 'alias.json')
      linkSync(f.auth, alias)
      assert.deepEqual(readRuntimeJson(alias), readRuntimeJson(f.auth))
      unlinkSync(alias)
      symlinkSync(f.auth, alias)
      assert.deepEqual(readRuntimeJson(alias), readRuntimeJson(f.auth))
      assert.equal(existsSync(join(f.state, 'gateway.db')), false)
      source.close()
      expired.close()
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  'caller源按canonical默认HTTP端口匹配，并在IO结束及交付前复验原截止和时钟回拨',
  /* 不绑定80端口；真实Request规范化及同步可控时钟只用于验证本地认证边界。 */ async () => {
    const f = await fixture()
    const realNow = Date.now
    try {
      const resource = new URL('http://127.0.0.1:80/mcp').href
      writeFileSync(f.auth, JSON.stringify({ ...f.source, resource }))
      const source = openCallerSource(f.auth, resource)
      const request = new Request('http://127.0.0.1:80/mcp', { headers: { authorization: `Bearer ${syntheticToken}` } })
      assert.deepEqual(source.authentication.authenticate(request, new AbortController().signal), {
        principal_id: 'fixture_caller'
      })
      const expiration = f.source.callers[0]!.expires_at
      const times = [expiration - 1, expiration - 1, expiration]
      Date.now = /* 文件读取后仍未到期，但摘要比较结束时恰好过期，必须拒绝。 */ () => times.shift() ?? expiration
      assert.equal(source.authentication.authenticate(request, new AbortController().signal), null)
      Date.now = realNow
      const rolledBack = openCallerSource(f.auth, resource)
      const before = realNow()
      const clock = [before, before - 1]
      Date.now = /* 模拟同一次实际文件复读前后的时间回退，不修改产品限时。 */ () => clock.shift() ?? before
      assert.equal(rolledBack.authentication.authenticate(request, new AbortController().signal), null)
      Date.now = realNow
      assert.equal(rolledBack.authentication.authenticate(request, new AbortController().signal), null)
      source.close()
      rolledBack.close()
      Date.now = realNow
      const running = await createProductionCliRuntime(createProductSources()).gateway!({ ...f.config, mcp_port: 80 })
      try {
        assert.deepEqual(await running.authentication.authenticate(request, new AbortController().signal), {
          principal_id: 'fixture_caller'
        })
      } finally {
        await running.close()
      }
    } finally {
      Date.now = realNow
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  '固定runtime ref拒绝非字符串、路径及URL，不以JavaScript隐式转换选择真实文件',
  /* JSON的number/boolean/null/数组/对象均不得进入受信resolver。 */ () => {
    for (const value of [123, true, null, ['native'], {}, '../native', 'https://example.invalid', '']) {
      assert.throws(/* 不以隐式字符串转换通过引用校验。 */ () => runtimeReference('/unused', value))
    }
  }
)

test(
  'runtime描述非法ref和resolver缺项均在打开双库前拒绝，管理员回调后仍复核caller来源',
  /* resolver仅交付故意不合法的negative fixture，不创建可执行provider或真实管理身份。 */ async () => {
    const f = await fixture()
    try {
      for (const value of [
        { reference: 123, value: {} },
        { reference: '../outside', value: {} }
      ]) {
        writeFileSync(
          join(f.refs, 'providers.json'),
          JSON.stringify({ schema_version: 1, role: 'gateway', providers: [value] }),
          { mode: 0o600 }
        )
        await assert.rejects(createProductionCliRuntime().gateway!(f.config), { code: 'invalid_config' })
        assert.equal(existsSync(join(f.state, 'gateway.db')), false)
      }
      f.providers({ a: {}, b: {} })
      let released = 0
      const runtime = createProductionCliRuntime({
        gateway: /* 相同ref的两个残缺对象不得借总数相等进入实际Gateway工厂。 */ async () => ({
          providers: [{ binding: { config_ref: 'a' } }, { binding: { config_ref: 'a' } }] as never,
          release: /* 验证校验失败仍释放这一次测试资源。 */ async () => {
            released++
          }
        })
      })
      await assert.rejects(runtime.gateway!(f.config))
      assert.equal(released, 1)
      assert.equal(existsSync(join(f.state, 'gateway.db')), false)
      const missing = createProductionCliRuntime({
        gateway: /* 模拟不合法JS宿主遗漏真实资源，不能退成空provider成功。 */ async () => undefined as never
      })
      await assert.rejects(missing.gateway!(f.config))
      assert.equal(existsSync(join(f.state, 'gateway.db')), false)
      const caller = openCallerSource(
        f.auth,
        f.url,
        /* 外部管理来源同步撤去caller时，旧admin不能越过最后fence。 */ (identity, sessionRef) => {
          writeFileSync(f.auth, JSON.stringify({ ...f.source, callers: [] }))
          return {
            principal_id: identity.principal_id,
            session_ref: sessionRef,
            assurance: 'administrator',
            policy_revision: 'fixture',
            grants: []
          }
        }
      )
      assert.equal(caller.identities.administrator({ principal_id: 'fixture_caller' }, 'fixture_admin'), null)
      caller.close()
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  '公开main静态调用真实Luvus factory，缺既有root时失败且不创建writer或启动native',
  /* 使用完整无秘密引用到测试自有缺失路径；不是实际窗口/Agent成功验收。 */ async () => {
    if (process.platform !== 'linux') {
      assert.throws(/* 私有runtime仍保留平台拒绝。 */ () => readRuntimeJson('/unused'), CliError)
      return
    }
    const f = await fixture()
    try {
      f.providers({
        local_luvus: {
          kind: 'luvus',
          authentication: 'local_owner',
          native: {
            mode: 'attach',
            root_record: join(f.root, 'missing-root.json'),
            expected_root_id: 'fixture_root',
            expected_root_revision: 1
          },
          principal_id: 'fixture_caller',
          policies: { caller: f.source.callers[0]!.principal.policy, local: f.source.local_policy },
          storage_mode: 'open'
        }
      })
      const result = spawnSync(process.execPath, ['--no-env-file', main, 'gateway', '--config', f.path], {
        env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
        timeout: 5000,
        encoding: 'utf8'
      })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, 'runtime_failed\n')
      assert.equal(existsSync(join(f.state, 'gateway.db')), false)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  '公开CLI缺原生文件或Connector引用时明确不可用，不打开writer',
  /* 不提供测试session/native成功替身，缺资源时保留真实非零退出。 */ async () => {
    const f = await fixture()
    try {
      f.providers({ native: { kind: 'luvus' } })
      for (const role of ['gateway', 'connector'] as const) {
        const path = join(f.root, role + '.json')
        if (role === 'connector') {
          writeFileSync(path, JSON.stringify(configDocument({ ...configTemplate(role), state_dir: f.state })), {
            mode: 0o600
          })
        }
        const result = spawnSync(process.execPath, ['--no-env-file', main, role, '--config', path], {
          env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
          timeout: 5000,
          encoding: 'utf8'
        })
        assert.equal(result.status, role === 'gateway' ? 1 : 2)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, role === 'gateway' ? /^runtime_failed\n$/ : /^configuration_required\n/)
        assert.equal(existsSync(join(f.state, 'gateway.db')), false)
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test('生产 offer 的 minor 跟随 WIRE_MINOR，双端协商后能拿到 device_platform', () => {
  const gateway = productionOffer()
  const connector = productionOffer()
  // 生产 offer 必须与当前实现支持的 minor 一致，不能写死旧值。
  assert.equal(gateway.minor, WIRE_MINOR)
  assert.equal(connector.minor, WIRE_MINOR)
  assert.equal(gateway.major, WIRE_MAJOR)
  // 两端都来自生产 offer，协商结果必须包含平台能力，否则真实部署永远拿不到平台。
  const negotiated = negotiate(gateway, connector)
  assert.equal(negotiated.minor, WIRE_MINOR)
  assert.equal(negotiated.capabilities.includes('device_platform'), true)
  // 与只广告 2.0 的老 Gateway 协商仍退回 0，且不带该能力（向后兼容不受影响）。
  const legacy = negotiate(gateway, { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] })
  assert.equal(legacy.minor, 0)
  assert.equal(legacy.capabilities.includes('device_platform'), false)
})
