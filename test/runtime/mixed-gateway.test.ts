// 复用既有runtime fixture的真实双库、认证连接与Luvus原派发；Herdr只使用真实Gateway pin/目录工厂。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeFixture } from './helpers.js'
import { createHerdrGatewayResources } from '../../src/connector/herdr/provider.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import type { V2Target } from '../../src/wire/types.js'
import { boundedJson } from '../../src/wire/index.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

test(
  '同一Gateway保留Luvus原目录和派发，Herdr目录独立授权且不假报native成功',
  { timeout: 30_000 },
  /** 不启动第二套原生或模型环境。 */ async () => {
    let herdr!: Awaited<ReturnType<typeof createHerdrGatewayResources>>
    let target!: V2Target
    let root: string | undefined
    let releases = 0
    const fixture = await runtimeFixture(
      {},
      /** 只给现有fixture增加实际Herdr资源，不重造Store/Router/身份链。 */ async (context) => {
        root = privateHerdrTestRoot('.mixed-gateway-')
        const schema = join(root, 'schema.json')
        writeFileSync(schema, readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url)), {
          mode: 0o600
        })
        target = { ...context.target, provider_id: 'herdr_mixed' }
        try {
          herdr = await createHerdrGatewayResources({
            config: {
              version: 1,
              target,
              binding_revision: 1,
              config_ref: 'mixed_herdr',
              expected_source: fixedHerdrSource(),
              schema_ref: schema
            }
          })
          context.state.store.defineProvider(herdr.providers[0]!.binding)
          return {
            hosted: [herdr],
            release: /** 资源关闭仅回收原Herdr契约及会话，不宣称停止远端native。 */ async () => {
              releases++
              await herdr.release()
              rmSync(root!, { recursive: true, force: true })
            }
          }
        } catch (error) {
          await herdr?.release()
          rmSync(root, { recursive: true, force: true })
          throw error
        }
      }
    )
    const service = new RuntimeGatewayService({
      ...fixture.mcp,
      catalog: {
        kind: 'mixed',
        select: /** 精确目标委托各自原resolver，不从describe制造Luvus来源。 */ (selected) =>
          boundedJson(selected) === boundedJson(target)
            ? herdr.catalog
            : boundedJson(selected) === boundedJson(fixture.target)
              ? fixture.catalog
              : undefined
      }
    })
    const context = { caller: fixture.caller, wait_signal: new AbortController().signal }
    try {
      await fixture.ready()
      assert.equal(fixture.gateway.transport.status().devices.length, 1)
      const luvus = await service.execute(
        'runtime_describe',
        { target: fixture.target, expected_binding_revision: 1, method: 'task.add' },
        context
      )
      assert.equal(luvus.data.method, 'task.add')
      const described = await service.execute(
        'runtime_describe',
        { target, expected_binding_revision: 1, method: 'agent.prompt' },
        context
      )
      const original = herdr
        .describe()
        .methods.find(/** 取同一Herdr owner的完整原生方法描述作比较。 */ (method) => method.method === 'agent.prompt')!
      assert.deepEqual(described.data.params_schema, original.params_schema)
      const page = await service.execute(
        'runtime_discover',
        { target, expected_binding_revision: 1, limit: 1 },
        context
      )
      assert(page.data.next_cursor)
      assert.equal(Object.hasOwn(page.data.items[0]!, 'params_schema'), false)
      await assert.rejects(
        service.execute(
          'runtime_discover',
          { target: fixture.target, expected_binding_revision: 1, limit: 1, cursor: page.data.next_cursor },
          context
        ),
        { code: 'invalid_cursor' }
      )
      assert.equal(fixture.native.state.responses, 0)
      const first = await service.execute(
        'runtime_call',
        {
          target: fixture.target,
          expected_binding_revision: 1,
          contract_ref: fixture.reference,
          deadline: fixture.state.store.clock() + 30_000,
          native_request: { method: 'task.add', params: { title: 'mixed_fixture' } }
        },
        context
      )
      await fixture.responded(first.data.call_id)
      // 混合目录各自独立解析：Herdr 与 Luvus 目标同时可描述，互不借用对方契约。
      assert.equal(
        (await service.execute('runtime_describe', { target, expected_binding_revision: 1, method: 'ping' }, context))
          .data.method,
        'ping'
      )
      assert.equal(
        (
          await service.execute(
            'runtime_describe',
            { target: fixture.target, expected_binding_revision: 1, method: 'task.add' },
            context
          )
        ).data.method,
        'task.add'
      )
      const second = await service.execute(
        'runtime_call',
        {
          target: fixture.target,
          expected_binding_revision: 1,
          contract_ref: fixture.reference,
          deadline: fixture.state.store.clock() + 30_000,
          native_request: { method: 'task.add', params: { title: 'after_herdr_revoke' } }
        },
        context
      )
      await fixture.responded(second.data.call_id)
      assert.equal(fixture.claims(), 2)
      const result = await fixture.gateway.runAuthenticated(
        fixture.caller,
        /** 仍经过原Wire结果/保留许可，不能从Store直接取正文。 */ () =>
          fixture.gateway.results.open(second.data.call_id)
      )
      const bytes = await fixture.gateway.runAuthenticated(
        fixture.caller,
        /** 每次正文读取重新调用同一组合会话中的原Luvus端口。 */ () => fixture.gateway.results.read(result.result_id)
      )
      assert.deepEqual(JSON.parse(Buffer.from(bytes.data, 'base64').toString()).error, fixture.native.response.error)
      // 本例没有Herdr本机installation与执行端口；目录通过绝不声称Herdr native调用成功。
      assert.equal(fixture.native.state.responses, 2)
    } finally {
      service.close()
      await fixture.close()
    }
    assert.equal(releases, 1)
  }
)
