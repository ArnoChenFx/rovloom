// 回放原生 fixture 与 SDK 探针，验证离线审计能识别损坏证据和协议边界回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fixtureRoot,
  inspectFixtures,
  coverage,
  offlineSchemas,
  readJson,
  sha256
} from '../../scripts/luvus/audit-fixtures.mjs'
import { verifyNativeTrace } from '../../scripts/luvus/native-trace.mjs'

// 核对原始交换的来源 pin、逐字摘要及完整请求/响应 schema，不赋予生产来源信任。
function nativeExchange(name) {
  const fixture = JSON.parse(readFileSync(new URL(`../fixtures/luvus/0.14.3/${name}.json`, import.meta.url)))
  const provenance = JSON.parse(readFileSync(new URL('../fixtures/luvus/0.14.3/provenance.json', import.meta.url)))
  assert.equal(fixture.binary_version, '0.14.3')
  assert.equal(fixture.binary_sha256, provenance.binary_sha256)
  assert.equal(
    fixture.schema_sha256,
    sha256(readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url)))
  )
  assert.equal(fixture.records.length, 2)
  assert.equal(fixture.records[0].kind, 'send')
  assert.equal(fixture.records[1].kind, 'receive')
  for (const record of fixture.records) {
    assert.equal(sha256(record.wire), record.wire_sha256)
  }
  const request = JSON.parse(fixture.records[0].wire)
  const response = JSON.parse(fixture.records[1].wire)
  const bundle = readJson('schema-bundle.json')
  const ajv = offlineSchemas(bundle)
  assert(ajv.getSchema(bundle.request.$id)(request))
  assert(ajv.getSchema(bundle.response.$id)(response))
  assert.equal(request.method, 'terminal.backend.control')
  assert.equal(response.id, request.id)
  return { fixture, request, response }
}

test(
  '真实无效 pane 样本保留原始 wire 与来源，schema 通过不能冒充原生参数有效',
  /* 回放失败采集的原始交换，区分 schema 形状约束与原生语义拒绝。 */ () => {
    const { fixture, request, response } = nativeExchange('invalid-pane')
    assert.equal(fixture.source.capture_completed, false)
    assert.equal(fixture.source.archive_sha256, 'c96e145ad04b7ffd42a5d96624db81a68599ca769b5a10d8e15857e900e3fb23')
    assert.equal(request.params.pane_id, '9999999999')
    assert.equal(response.error.code, 'invalid_params')
    assert.equal(response.error.message, 'pane_id is invalid')
  }
)

test(
  '真实合法 pane 形状仍因终端路由不匹配返回 stale_route',
  /* 保留补充采集的真实路由拒绝，不把参数格式通过解释为终端身份可用。 */ () => {
    const { fixture, request, response } = nativeExchange('stale-pane')
    assert.equal(fixture.source.capture_completed, true)
    assert.equal(fixture.source.archive_sha256, '71c38aa6ce308cb71fe02746a8380034e2869b75d82c8c288edefd3b4935cc41')
    assert.equal(request.params.server_generation, fixture.terminal_identity.server_generation)
    assert.equal(request.params.terminal_id, fixture.terminal_identity.terminal_id)
    assert.notEqual(request.params.pane_id, fixture.terminal_identity.pane_id)
    assert.equal(response.error.code, 'stale_route')
    assert.equal(response.error.message, 'terminal identity no longer matches the pane route')
  }
)

test(
  '原生 fixture hash、闭包 schema、请求响应关联及清理可重放验证',
  /* 核对完整审计的文档、消息及故意无效请求计数。 */ () => {
    const counts = inspectFixtures()
    assert.equal(counts.documents, 29)
    assert(counts.requests > 20 && counts.responses > 20 && counts.events > 10)
    assert.equal(counts.intentional_invalid, 2)
  }
)

test(
  '安装 schema 保留根约束和条件；缺失引用不能联网补齐',
  /* 以无效消息和缺失引用验证安装版 schema 的约束及离线闭包。 */ () => {
    const bundle = readJson('schema-bundle.json')
    const ajv = offlineSchemas(bundle)
    const request = ajv.getSchema(bundle.request.$id)
    assert.equal(request({ id: 'invalid', method: 'uhp.capabilities', params: { unannounced: true } }), false)
    assert.equal(request({ id: 'invalid', method: 'ping', params: {}, unannounced: true }), false)
    const response = ajv.getSchema(bundle.response.$id)
    assert.equal(response({ result: {} }), false)
    assert.equal(response({ id: 'invalid', result: {}, error: { code: 'internal', message: 'synthetic' } }), false)
    assert.throws(
      /* 外部未知引用应直接编译失败，不能联网补齐。 */ () =>
        ajv.compile({ $ref: 'https://untrusted.invalid/must-not-fetch.json' }),
      /resolve reference/
    )
    const missing = structuredClone(bundle)
    delete missing.documents['https://luvus.dev/protocol/uhp/v1/schema/terminal/common.schema.json']
    assert.throws(/* 删除本地依赖文档后 schema 闭包必须编译失败。 */ () => offlineSchemas(missing), /resolve reference/)
  }
)

test(
  '覆盖账本保持全部方法与 profile；未实现、权限、schema 缺口分开',
  /* 验证账本可重建且正确区分 profile、权限和参数 schema 缺口。 */ () => {
    const generated = coverage()
    assert.deepEqual(
      generated,
      JSON.parse(readFileSync(new URL('../fixtures/native-contract/coverage.json', import.meta.url)))
    )
    assert.deepEqual(generated.counts, {
      union: 223,
      session: 197,
      host: 17,
      schema: 223,
      access_machines: 9,
      stream: 4
    })
    assert(
      generated.methods.every(
        /* 所有原生方法在网关中仍须保持未实现且未授权。 */ (row) =>
          row.gateway_status === 'not_implemented' && row.gateway_permission === 'not_enabled'
      )
    )
    assert(
      generated.methods
        .filter(/* 选出机器访问类方法以检查 profile 阻塞原因。 */ (row) => row.method.startsWith('machine.'))
        .every(/* 机器访问方法应统一因 profile 未暴露而禁用。 */ (row) => row.reason === 'profile_not_exposed')
    )
    assert.equal(
      generated.methods.find(/* 定位已知缺少参数细节的 pane.run。 */ (row) => row.method === 'pane.run').reason,
      'parameter_schema_incomplete'
    )
    assert.equal(
      generated.methods.find(/* 定位要求管理员授权的安装更新方法。 */ (row) => row.method === 'host.update.install')
        .reason,
      'admin_disabled_pending_explicit_authorization'
    )
    const bundle = readJson('schema-bundle.json')
    const check = offlineSchemas(bundle).getSchema(bundle.request.$id)
    const generic = generated.methods.filter(
      /* 选出只有通用参数对象约束的方法以实测 schema 缺口。 */ (row) =>
        row.schema.parameter_detail === 'generic_params_only'
    )
    assert.equal(generic.length, 144)
    // 用无关字段实测通用 object 会放行，不能仅复述账本里的计数。
    for (const row of generic) {
      assert.equal(
        check({ id: 'schema-gap', method: row.method, params: { p0_unannounced: ['synthetic'] } }),
        true,
        row.method
      )
    }
  }
)

test(
  '语义审计独立拒绝错误退出码、伪造 peer、缺失端点检查与不一致副本',
  /* 逐项篡改原始证据，确保语义审计独立检测失真与副本不一致。 */ () => {
    const original = readJson('transcript.json')
    const environment = readJson('environment.json')
    const artifacts = {
      host: readJson('host-capabilities.json'),
      session: readJson('session-capabilities.json'),
      identity: readJson('terminal-identity.json'),
      inventory: readJson('terminal-inventory.json'),
      stalePane: JSON.parse(readFileSync(new URL('../fixtures/luvus/0.14.3/stale-pane.json', import.meta.url)))
    }
    for (const mutate of [
      /* 将应成功的主机信息进程改为失败退出。 */ (trace) => {
        trace.find(/* 定位启动前的主机信息采集步骤。 */ (r) => r.label === 'host-info-before-server').exit_code = 7
      },
      /* 伪造连接对端的用户身份。 */ (trace) => {
        trace.find(/* 定位首条 Unix 对端凭据证据。 */ (r) => r.kind === 'peer_credentials').uid = environment.uid + 1
      },
      /* 删除端点校验，让对端凭据失去前置检查。 */ (trace) => {
        trace.splice(
          trace.findIndex(/* 定位将被移除的首条端点检查。 */ (r) => r.kind === 'endpoint_validation'),
          1
        )
      },
      /* 将清理后的发现结果伪造为仍有会话运行。 */ (trace) => {
        trace.find(/* 定位清理结束后的会话发现记录。 */ (r) => r.label === 'discovery-after-cleanup').stdout =
          '{"sessions":[{"running":true}]}'
      }
    ]) {
      const trace = structuredClone(original)
      mutate(trace)
      assert.throws(
        /* 被篡改的原始证据必须被独立语义审计拒绝。 */ () => verifyNativeTrace(trace, environment, artifacts)
      )
    }
    for (const mutate of [
      /* 移除整份补充证据。 */ (value) => {
        delete value.stalePane
      },
      /* 删除必须存在的拒绝响应。 */ (value) => {
        value.stalePane.records.pop()
      },
      /* 截断响应帧，即使同步修改摘要也不能冒充完整交换。 */ (value) => {
        const row = value.stalePane.records[1]
        row.wire = row.wire.slice(0, -1)
        row.wire_sha256 = sha256(row.wire)
      },
      /* 把拒绝替换成成功响应并同步摘要，仍须被语义校验拒绝。 */ (value) => {
        const row = value.stalePane.records[1]
        row.wire = JSON.stringify({ id: 'control-wrong-pane', result: {} }) + '\n'
        row.wire_sha256 = sha256(row.wire)
      }
    ]) {
      const changed = structuredClone(artifacts)
      mutate(changed)
      assert.throws(() => verifyNativeTrace(original, environment, changed))
    }
    const mismatch = structuredClone(artifacts)
    mismatch.session.result.methods.push('p0.unobserved')
    assert.throws(
      /* 原始记录与能力目录副本不一致时必须拒绝。 */ () => verifyNativeTrace(original, environment, mismatch)
    )
  }
)

test(
  'manifest 不允许漏列必需文件或夹带无关文件',
  /* 在临时副本中分别注入多余文件和删去清单项，验证审计拒绝并清理副本。 */ () => {
    const root = mkdtempSync(join(tmpdir(), 'p0-fixture-audit-'))
    try {
      cpSync(fixtureRoot, root, { recursive: true })
      writeFileSync(join(root, 'unrelated-synthetic.txt'), 'synthetic, no secret')
      assert.throws(/* 未列入清单的额外文件必须被拒绝。 */ () => inspectFixtures(root), /unrelated/)
      rmSync(join(root, 'unrelated-synthetic.txt'))
      const manifest = readJson('manifest.json', root)
      delete manifest.files['environment.json']
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
      assert.throws(/* 缺少必需文件的清单必须被拒绝。 */ () => inspectFixtures(root), /required artifact/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '真实终端拒绝、队列 ack、消费证据、事件 replay 和取消边界不变',
  /* 回放终端控制、观察和重放证据，核对拒绝原因及关闭边界。 */ () => {
    const transcript = readJson('transcript.json')
    // 按通道提取并解码接收消息，供终端行为断言复用。
    const received = (channel) =>
      transcript
        .filter(/* 保留指定通道的入站记录。 */ (r) => r.kind === 'receive' && r.channel === channel)
        .map(/* 解码原始报文以检查响应和事件字段。 */ (r) => JSON.parse(r.wire))
    for (const [channel, code] of [
      ['control-stale-generation', 'stale_server'],
      ['control-wrong-terminal', 'stale_terminal'],
      ['control-lease-conflict', 'control_conflict']
    ]) {
      assert.equal(received(channel)[0].error.code, code)
    }
    assert.equal(
      received('terminal-control').find(/* 查找合法输入的队列确认。 */ (r) => r.id === 'input-1').result.dispatch,
      'queued'
    )
    assert(
      received('terminal-observe').some(
        /* 查找终端处理输入后的输出标记以证明输入被消费。 */ (r) => r.data?.text?.includes('CONSUMED:321cba-tupni-0p')
      )
    )
    const snapshot = received('snapshot-after-create')[0].result
    const closed = received('events-primary').find(
      /* 取主事件流中的终端关闭通知。 */ (r) => r.event === 'terminal.closed'
    )
    assert(closed.sequence > snapshot.event_sequence)
    assert.deepEqual(
      received('events-replay').find(/* 取重放流中的同类关闭通知以核对内容。 */ (r) => r.event === 'terminal.closed'),
      closed
    )
    const deadline = transcript.find(/* 查找客户端自行超时退出的进程记录。 */ (r) => r.label === 'client-deadline')
    assert.equal(deadline.timed_out, true)
    assert.equal(deadline.stdout, '')
    assert.equal(received('validate-after-deadline')[0].result.state, 'alive')
    assert.equal(received('validate-after-terminal-close')[0].result.state, 'gone')
  }
)
