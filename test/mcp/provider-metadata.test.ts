// 使用真实 schema/Store/HTTP 门面，来源为合成 fixture；不代证 native 版本的实际机器测量。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { StoreGatewayService } from '../../src/mcp/store-service.js'
import { contractRef } from '../../src/wire/index.js'
import { catalogFixture } from './catalog-fixture.js'
import { httpFixture } from './http-fixture.js'
import { target } from './store-fixture.js'

test('Luvus provider 的版本、契约状态与摘要穿过 HTTP 白名单，缺失或不符来源不猜版本', async () => {
  const f = catalogFixture()
  const http = httpFixture(f.service, { authentication: { authenticate: () => ({ principal_id: 'alice' }) } })
  try {
    await http.client.connect(http.transport, { timeout: 5000 })
    const original = f.source()
    const read = async () => {
      const values: unknown[] = []
      for (const [name, args] of [
        ['providers_get', { machine_id: target.machine_id, provider_id: target.provider_id }],
        ['providers_list', { machine_id: target.machine_id }]
      ] as const) {
        const result = CallToolResultSchema.parse(
          await http.client.callTool({ name, arguments: args }, CallToolResultSchema)
        )
        assert(!result.isError)
        const data = result.structuredContent!.data as Record<string, unknown>
        const provider = name === 'providers_list' ? (data.items as Record<string, unknown>[])[0]! : data
        values.push({
          native_version: provider.native_version,
          schema_status: provider.schema_status,
          schema_sha256: provider.schema_sha256
        })
        assert.equal(provider.contract, undefined)
        assert.equal(provider.config_ref, undefined)
      }
      assert.deepEqual(values[0], values[1])
      return values[0]
    }
    assert.deepEqual(await read(), {
      native_version: '0.14.3',
      schema_status: 'validated',
      schema_sha256: original.record.wire.source.schema_sha256
    })
    const missing = { native_version: null, schema_status: 'unavailable', schema_sha256: null }
    f.setSource(undefined)
    assert.deepEqual(await read(), missing)
    f.setSource({ ...original, expires_at: f.store.clock() })
    assert.deepEqual(await read(), missing)
    f.setSource({
      ...original,
      record: {
        ...original.record,
        wire: {
          ...original.record.wire,
          source: { ...original.record.wire.source, schema_sha256: 'b'.repeat(64) }
        }
      }
    })
    assert.deepEqual(await read(), missing)
    const origin = { ...original.record.wire.source, binary_version: 'unavailable' }
    f.setSource({
      ...original,
      record: { ...original.record, wire: { ...original.record.wire, source: origin } },
      source: { ...original.source, binding: { ...original.source.binding, contract_source_ref: contractRef(origin) } }
    })
    assert.deepEqual(await read(), {
      native_version: null,
      schema_status: 'validated',
      schema_sha256: origin.schema_sha256
    })
  } finally {
    await http.close()
    f.service.close()
    f.close()
  }
})

test('元数据 resolver 同步撤销 caller 时仍拒绝整条读取，不以 unknown 元数据绕过授权', async () => {
  const f = catalogFixture()
  const source = f.source()
  const service = new StoreGatewayService({
    store: f.store,
    identities: f.identities,
    localPolicies: f.localPolicies,
    catalog: {
      resolve: () => {
        f.setCaller(null)
        return source
      }
    }
  })
  try {
    await assert.rejects(
      service.execute(
        'providers_get',
        { machine_id: target.machine_id, provider_id: target.provider_id },
        {
          caller: { principal_id: 'alice' },
          wait_signal: new AbortController().signal
        }
      ),
      { code: 'unauthenticated' }
    )
  } finally {
    service.close()
    f.service.close()
    f.close()
  }
})
