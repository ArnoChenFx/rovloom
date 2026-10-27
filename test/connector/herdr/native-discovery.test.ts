/** 用合成变化的原生 schema 检验逐功能接纳，不运行真实 Herdr 或创建实际身份。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { HerdrSchemaCompiler } from '../../../src/connector/herdr/compiler-host.js'
import { createHerdrCompilerWorker } from '../../../src/connector/herdr/compiler-location.js'
import { observedHerdrSource } from '../../../src/connector/herdr/review.js'
import { createHerdrCodec } from '../../../src/connector/herdr/readonly.js'
import { describeHerdrContract } from '../../../src/connector/herdr/discovery.js'
import { parseHerdrProviderRefConfig } from '../../../src/connector/herdr/provider.js'

test(
  'Herdr discovers healthy methods beside local reference branches',
  /** 完整编译接受的未知引用分支不应阻断已知方法，已知本地引用仍携带实际参数。 */ async () => {
    const document = JSON.parse(
      readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
    )
    const request = document.schemas.request
    const index = request.oneOf.findIndex(
      /** 把可选等待分支替换成未知扩展。 */ (branch: any) => branch.properties.method.const === 'agent.wait'
    )
    const extension = request.oneOf.splice(index, 1)[0]
    extension.properties.method.const = 'future.extension'
    request.$defs.independentFuture = extension
    request.oneOf.push({ $ref: '#/schemas/request/$defs/independentFuture' })
    const pingIndex = request.oneOf.findIndex(
      /** 健康的已知方法也可由原生本地引用表达。 */ (branch: any) => branch.properties?.method?.const === 'ping'
    )
    request.$defs.independentPing = request.oneOf[pingIndex]
    request.oneOf[pingIndex] = { $ref: '#/schemas/request/$defs/independentPing' }
    const bytes = JSON.stringify(document)
    const compiler = new HerdrSchemaCompiler(createHerdrCompilerWorker)
    try {
      const schemas = await compiler.compile(bytes)
      const source = observedHerdrSource(
        'synthetic-diagnostic',
        'e'.repeat(64),
        createHash('sha256').update(bytes).digest('hex'),
        schemas.protocol
      )
      const codec = createHerdrCodec(source, schemas)
      assert(codec.encode({ id: 'synthetic', method: 'ping', params: {} }).length > 0)
      const catalog = describeHerdrContract({
        target: {
          machine_id: 'synthetic-machine',
          provider_id: 'synthetic-provider',
          profile: 'session',
          session: 'synthetic'
        },
        binding_revision: 1,
        source,
        document,
        source_basis: 'configured_connector_contract'
      })
      assert(catalog.methods.some(/** 引用的健康 ping 仍可发现。 */ (method) => method.method === 'ping'))
      assert(!catalog.methods.some(/** 被移除的方法不冒称支持。 */ (method) => method.method === 'agent.wait'))
    } finally {
      compiler.close()
    }
  }
)

test(
  'Herdr discovers changed protocol/schema bytes and keeps healthy methods when an optional method is absent',
  /** 原字节未命中历史摘要；完整编译、实际目录和 codec 共用同一协议/方法事实。 */ async () => {
    const document = JSON.parse(
      readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
    )
    document.protocol = 27
    document.schema_version = 3
    document.schemas.request.oneOf = document.schemas.request.oneOf.filter(
      /** 合成安装不支持等待接口。 */ (branch: any) => branch.properties.method.const !== 'agent.wait'
    )
    delete document.schemas.event
    delete document.schemas.subscription_event
    const bytes = JSON.stringify(document)
    const compiler = new HerdrSchemaCompiler(createHerdrCompilerWorker)
    try {
      const schemas = await compiler.compile(bytes)
      const source = observedHerdrSource(
        'synthetic-future-version',
        'd'.repeat(64),
        createHash('sha256').update(bytes).digest('hex'),
        schemas.protocol
      )
      assert.equal(source.binary_version, 'synthetic-future-version')
      const target = {
        machine_id: 'synthetic-machine',
        provider_id: 'synthetic-provider',
        profile: 'session' as const,
        session: 'synthetic'
      }
      assert.doesNotThrow(
        /** 配置不再限定已知发行版摘要与版本标签。 */ () =>
          parseHerdrProviderRefConfig({
            version: 1,
            target,
            binding_revision: 1,
            config_ref: 'synthetic-config',
            expected_source: source,
            schema_path: '/synthetic/schema.json'
          })
      )
      const catalog = describeHerdrContract({
        target,
        binding_revision: 1,
        source,
        document,
        source_basis: 'configured_connector_contract'
      })
      assert(catalog.methods.some(/** 健康的 ping 仍可发现。 */ (method) => method.method === 'ping'))
      assert(!catalog.methods.some(/** 缺失的等待接口不冒称支持。 */ (method) => method.method === 'agent.wait'))
      const codec = createHerdrCodec(source, schemas)
      const request = { id: 'synthetic', method: 'ping', params: {} }
      assert(codec.encode(request))
      const reply = { id: 'synthetic', result: { type: 'pong', version: 'different-server-diagnostic', protocol: 27 } }
      assert.deepEqual(codec.decode(Buffer.from(JSON.stringify(reply) + '\n'), request), reply)
      assert.throws(
        /** 缺失功能报告原生契约错误，其它方法继续工作。 */ () =>
          codec.encode({ id: 'synthetic', method: 'agent.wait', params: { target: 'synthetic', until: ['idle'] } }),
        /herdr_native_request_invalid/
      )
      assert.throws(
        /** 不支持的参数仍由完整原生根拒绝。 */ () =>
          codec.encode({ id: 'synthetic', method: 'agent.prompt', params: {} }),
        /herdr_native_request_invalid/
      )
      assert.throws(
        /** 不把另一协议实例的响应当成本轮结果。 */ () =>
          codec.decode(
            Buffer.from(JSON.stringify({ ...reply, result: { ...reply.result, protocol: 22 } }) + '\n'),
            request
          ),
        /herdr_native_response_invalid/
      )
    } finally {
      compiler.close()
    }
  }
)

test(
  'Herdr missing required RPC roots rejects only that schema and leaves the same Worker usable',
  /** 实际未知输入必须创建 Worker；普通 schema 拒绝不污染其它安装的健康编译。 */ async () => {
    const raw = readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url))
    const document = JSON.parse(raw.toString('utf8'))
    delete document.schemas.request
    let starts = 0
    const compiler = new HerdrSchemaCompiler(
      /** 所有本例任务共用真实 Worker，不靠补建掩盖退役。 */ () => {
        starts++
        return createHerdrCompilerWorker()
      }
    )
    try {
      await assert.rejects(compiler.compile(JSON.stringify(document)), {
        message: 'herdr_schema_schema_root_unavailable'
      })
      assert.equal(starts, 1)
      const changed = Buffer.concat([raw, Buffer.from('\n')])
      const schemas = await compiler.compile(changed)
      assert.equal(starts, 1)
      assert.equal(schemas.schema_sha256, createHash('sha256').update(changed).digest('hex'))
      assert(schemas.request({ id: 'synthetic', method: 'ping', params: {} }))
      assert(!schemas.request({ id: 'synthetic', method: 'agent.prompt', params: {} }))
    } finally {
      compiler.close()
    }
  }
)
