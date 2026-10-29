// 真实Streamable HTTP SDK客户端验证门面业务契约；服务明确为隔离stub，不代表native验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, type CallToolResult, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { runCli } from '../../src/cli/run.js'
import { startHttpFacade } from '../../src/mcp/http.js'
import { MAX_MCP_BYTES, PRODUCT_VERSION, toolNames } from '../../src/mcp/schema.js'
import { stubFixture } from './stub-fixture.js'
import { syntheticHeaders } from './http-fixture.js'

const target = { machine_id: 'machine', provider_id: 'provider', profile: 'session', session: 'isolated' }
const base = { target, expected_binding_revision: 1 }
const call = /* 构造显式目标、契约和期限的无秘密调用参数，不接真实原生实例。 */ (method: string) => ({
  ...base,
  contract_ref: 'a'.repeat(64),
  deadline: 2_000_000_000_000,
  native_request: { method }
})

// 比较结构化内容和 JSON 文本副本后取业务数据，暴露任何保真差异。
function data(reply: CallToolResult): Record<string, unknown> {
  assert(reply.structuredContent)
  const content = reply.content[0]
  assert(content?.type === 'text')
  assert.deepEqual(JSON.parse(content.text), reply.structuredContent)
  return reply.structuredContent.data as Record<string, unknown>
}

// 每个用例使用真实回环listener和官方HTTP客户端，finally关闭本例资源。
async function isolated(
  mode: string,
  check: (client: HttpTestClient, transport: RecordingHttp, directory: string) => Promise<void>
) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-mcp-http-'))
  const fixture = stubFixture(mode, directory)
  const diagnostics: string[] = []
  let running: ReturnType<typeof startHttpFacade> | undefined
  let role: Promise<number> | undefined
  const stop = new AbortController()
  let url: string
  if (mode === 'cli') {
    // 端口来自本例临时listener；配置仍只保存固定回环地址与无密钥引用。
    const reservation = startHttpFacade({ ...fixture, port: 0 })
    const port = Number(new URL(reservation.url).port)
    await reservation.close()
    const path = join(directory, 'gateway.json')
    writeFileSync(
      path,
      JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: directory, mcp_port: port })),
      {
        mode: 0o600
      }
    )
    let ready!: (url: string) => void
    const listening = new Promise<string>(
      /* 只由runCli实际创建listener后的回调完成。 */ (resolve) => {
        ready = resolve
      }
    )
    role = runCli(
      ['gateway', '--config', path],
      { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signal: stop.signal },
      {
        gateway: /* 注入明确标注的测试服务与认证，不使用产品默认后端。 */ async () => ({
          ...fixture,
          listening: ready,
          close: /* CLI只负责本次测试宿主生命周期，没有原生资源可取消。 */ async () => {}
        })
      }
    )
    url = await listening
  } else {
    running = startHttpFacade({
      ...fixture,
      port: 0,
      diagnostic: /* 收集受限代码，检查错误没有携带服务原文。 */ (code) => {
        diagnostics.push(code)
      }
    })
    url = running.url
  }
  const transport = new RecordingHttp(new URL(url), { requestInit: { headers: syntheticHeaders } })
  const client = new HttpTestClient({ name: 'rovloom-isolated-http', version: '1' })
  const errors: Error[] = []
  client.onerror = /* 暂存真实SDK异常，成功工作流不能忽略协议错误。 */ (error) => {
    errors.push(error)
  }
  try {
    await client.connect(transport, { timeout: 5000 })
    assert.equal(client.getServerVersion()?.name, 'rovloom')
    assert.equal(client.getServerVersion()?.version, PRODUCT_VERSION)
    const initialized = transport.received.find(
      /* 核对正式HTTP门面的实际初始化revision。 */ (message) => 'result' in message && message.id === 0
    )
    assert(initialized && 'result' in initialized)
    assert.equal(initialized.result.protocolVersion, '2025-11-25')
    await check(client, transport, directory)
    if (mode === 'revoking') {
      assert(
        errors.some(
          /* 撤销后官方客户端必须观察到真实HTTP 401。 */ (error) => (error as Error & { code?: number }).code === 401
        )
      )
      assert(
        errors.every(
          /* 仅允许本例故意触发的未认证拒绝。 */ (error) => (error as Error & { code?: number }).code === 401
        )
      )
    } else {
      assert.deepEqual(errors, [])
    }
    for (const message of transport.received) {
      assert(Buffer.byteLength(JSON.stringify(message)) <= MAX_MCP_BYTES)
    }
    assert(!JSON.stringify(transport.received).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
    assert(
      diagnostics.every(
        /* 普通诊断只能是固定脱敏代码。 */ (code) => ['mcp_service_error', 'mcp_transport_error'].includes(code)
      )
    )
  } finally {
    await client.close()
    stop.abort()
    if (role) {
      assert.equal(await role, 0)
    }
    await running?.close()
    if (mode === 'unbound') {
      assert.equal(existsSync(join(directory, 'events.jsonl')), false)
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

class HttpTestClient extends Client {
  // 真实SDK结果必须满足标准工具结果schema，单次请求仍保留原5秒预算。
  override async callTool(...args: Parameters<Client['callTool']>): Promise<CallToolResult> {
    return CallToolResultSchema.parse(
      await super.callTool(args[0], args[1], { ...args[2], timeout: args[2]?.timeout ?? 5000 })
    )
  }
}
class RecordingHttp extends StreamableHTTPClientTransport {
  readonly received: JSONRPCMessage[] = []
  readonly sent: JSONRPCMessage[] = []
  // 记录实际HTTP接收消息后交给官方客户端，不替代协议处理。
  override async start(): Promise<void> {
    const receive = this.onmessage
    this.onmessage = /* 保留握手及业务回复供大小和秘密断言。 */ (message) => {
      this.received.push(message)
      receive?.(message)
    }
    await super.start()
  }
  // 记录官方客户端发出的消息，保持原始取消及会话行为。
  override async send(...args: Parameters<StreamableHTTPClientTransport['send']>): Promise<void> {
    this.sent.push(...(Array.isArray(args[0]) ? args[0] : [args[0]]))
    await super.send(...args)
  }
}

test(
  '真实 SDK HTTP 完成分页发现、描述、五方法族调用、状态和结果读取；服务为隔离 stub',
  { timeout: 30_000 },
  /* 通过真实HTTP连接验证目录、描述、五类 stub 调用和结果分页。 */ async () => {
    await isolated(
      'ordinary',
      /* 逐页发现并调用受控方法，比较返回原值与可读句柄页。 */ async (client) => {
        const names: string[] = []
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 5000 })
          names.push(...page.tools.map(/* 提取目录名称，用于核对静态工具集合和分页完整性。 */ (tool) => tool.name))
          assert(
            page.tools.every(
              /* 核对每项元数据都声明严格参数和结构化输出。 */ (tool) =>
                tool.inputSchema.additionalProperties === false && tool.outputSchema
            )
          )
          cursor = page.nextCursor
          pages++
        } while (cursor)
        assert.equal(pages, 3)
        assert.deepEqual(names, toolNames())
        await assert.rejects(
          client.listTools({ cursor: 'SYNTHETIC_SECRET_DO_NOT_PRINT' }, { timeout: 5000 }),
          /Invalid params/
        )
        const machines = data(await client.callTool({ name: 'machines_list', arguments: {} }))
        assert.equal((machines.items as unknown[]).length, 1)
        assert.deepEqual(
          data(await client.callTool({ name: 'machines_list', arguments: { cursor: machines.next_cursor } })),
          {
            items: []
          }
        )
        const discovered = data(await client.callTool({ name: 'runtime_discover', arguments: base }))
        for (const item of discovered.items as { method: string }[]) {
          assert.equal(
            data(await client.callTool({ name: 'runtime_describe', arguments: { ...base, method: item.method } }))
              .method,
            item.method
          )
          const args = {
            ...call(item.method),
            native_request: { method: item.method, params: { nested: ['原文', false, null] } }
          }
          const called = data(await client.callTool({ name: 'runtime_call', arguments: args }))
          assert.deepEqual((called.native_response as Record<string, unknown>).result, {
            method: item.method,
            params: { nested: ['原文', false, null] },
            value: ['值', false, null, 3.25]
          })
          assert.deepEqual(
            data(await client.callTool({ name: 'runtime_call_get', arguments: { call_id: called.call_id } })),
            called
          )
        }
        const first = data(
          await client.callTool({ name: 'runtime_result_read', arguments: { result_id: 'result-test' } })
        )
        const second = data(
          await client.callTool({
            name: 'runtime_result_read',
            arguments: { result_id: 'result-test', cursor: first.next_cursor }
          })
        )
        assert.equal(first.eof, false)
        assert.equal(second.eof, true)
        assert.equal((first.chunk as string) + (second.chunk as string), '隔离分页结果😀'.repeat(100))
        assert.equal(
          data(await client.callTool({ name: 'runtime_call_cancel', arguments: { call_id: 'call-1' } })).cancellation,
          'bridge_stopped'
        )
      }
    )
  }
)

test(
  '真实 SDK 区分参数协议错误、授权错误、原生 error 和超大响应，所有错误均无秘密',
  { timeout: 30_000 },
  /* 组合参数、权限、原生错误和大响应负例，区分协议与业务错误。 */ async () => {
    await isolated(
      'ordinary',
      /* 向标准客户端提交非法形状并检查服务记录，防止错误请求越过边界。 */ async (client, _transport, directory) => {
        for (const args of [
          { ...call('uhp.ping'), principal: 'admin' },
          { ...call('uhp.ping'), admin: true },
          { ...call('uhp.ping'), discard_response: true },
          { ...call('uhp.ping'), native_request: { method: 'uhp.ping', id: 'caller-id' } },
          { ...call('uhp.ping'), native_request: { method: 'uhp.ping', auth: 'SYNTHETIC_SECRET_DO_NOT_PRINT' } },
          { ...call('uhp.ping'), target: { ...target, session: '' } },
          { ...call('uhp.ping'), target: { ...target, profile: 'host' } },
          { ...call('uhp.ping'), expected_binding_revision: 0 },
          { ...call('uhp.ping'), wait_ms: 5001 }
        ]) {
          await assert.rejects(client.callTool({ name: 'runtime_call', arguments: args }), /Invalid params/)
        }
        await assert.rejects(
          client.callTool({ name: 'unknown-SYNTHETIC_SECRET_DO_NOT_PRINT', arguments: {} }),
          /Invalid params/
        )
        await assert.rejects(
          client.request({ method: 'tools/call', params: { name: 3 } }, CallToolResultSchema, {
            timeout: 5000
          }),
          /Invalid params/
        )
        assert(
          !readFileSync(join(directory, 'events.jsonl'), { encoding: 'utf8', flag: 'a+' }).includes('runtime_call')
        )
        const discard = await client.callTool({ name: 'runtime_response_discard', arguments: { call_id: 'call-1' } })
        assert.equal(discard.isError, true)
        assert.deepEqual(discard.structuredContent, { gateway_error: { code: 'forbidden' } })
        const error = await client.callTool({ name: 'runtime_call', arguments: call('stub.native_error') })
        assert.equal(error.isError, true)
        assert.deepEqual((data(error).native_response as Record<string, unknown>).error, {
          code: 'native_test',
          message: '原生测试错误',
          data: { nested: [false, null, { kept: '值' }] }
        })
        const thrown = await client.callTool({ name: 'runtime_call', arguments: call('stub.throw') })
        assert.deepEqual(thrown.structuredContent, { gateway_error: { code: 'internal_error' } })
        const large = await client.callTool({ name: 'runtime_call', arguments: call('stub.large') })
        assert.equal(large.isError, true)
        assert.deepEqual(large.structuredContent?.gateway_error, { code: 'response_too_large' })
        const delivery = large.structuredContent?.delivery as Record<string, unknown>
        assert.equal(delivery.truncated, true)
        assert.match(delivery.sha256 as string, /^[a-f0-9]{64}$/)
        assert.equal(delivery.call_id, 'call-2')
        assert.equal(delivery.result_id, undefined)
      }
    )
  }
)

test(
  '受信HTTP认证缺失时初始化拒绝且不进入业务服务',
  /* 独立测试认证stub的缺失身份，不建立真实凭据。 */ async () => {
    await assert.rejects(
      isolated(
        'unbound',
        /* 未认证客户端不能进入任何业务检查回调。 */ async () => {
          throw new Error('unexpected_authenticated_client')
        }
      ),
      { code: 401 }
    )
  }
)

test(
  '受信 caller 撤销后下一次请求立即拒绝',
  /* 单独验证每次请求重读同一合成身份来源。 */ async () => {
    await isolated(
      'revoking',
      /* 先读可见列表再撤销身份，确认每次HTTP请求都会重新认证。 */ async (client, _transport, directory) => {
        assert(data(await client.callTool({ name: 'machines_list', arguments: {} })).items)
        writeFileSync(join(directory, 'revoked'), '')
        await assert.rejects(client.callTool({ name: 'machines_list', arguments: {} }), { code: 401 })
      }
    )
  }
)

test(
  'CLI 注入同一 HTTP facade，实际SDK仍使用标准工具请求',
  /* 单独验证显式CLI测试宿主，不把服务stub当作生产授权或native执行。 */ async () => {
    await isolated(
      'cli',
      /* 经注入 CLI 宿主访问 provider，验证角色入口接到同一 HTTP 门面。 */ async (client) => {
        assert.equal(
          (
            data(await client.callTool({ name: 'providers_list', arguments: { machine_id: 'machine' } }))
              .items as unknown[]
          ).length,
          1
        )
      }
    )
  }
)

test(
  'client_request_key 原样传给服务且不补发；SDK 取消只停止等待，不调用业务 cancel',
  { timeout: 30_000 },
  /* 验证 client_request_key 原样传递及取消只结束等待，不产生业务 cancel 或补发。 */ async () => {
    await isolated(
      'ordinary',
      /* 重复同一历史意图并取消慢请求，核对执行计数和结束证据。 */ async (client, _transport, directory) => {
        const client_request_key = 'key-test'
        const args = { ...call('task.list'), client_request_key }
        const first = data(await client.callTool({ name: 'runtime_call', arguments: args }))
        const again = data(await client.callTool({ name: 'runtime_call', arguments: args }))
        assert.equal(first.call_id, again.call_id)
        assert.equal(again.executions, 1)
        const stop = new AbortController()
        const pending = client
          .callTool({ name: 'runtime_call', arguments: { ...call('stub.slow'), wait_ms: 1000 } }, undefined, {
            signal: stop.signal
          })
          .then(
            /* 立即观察意外成功，不能把尚未挂处理器的Promise留在等待窗口中。 */ () => ({ rejected: false }),
            /* 清理信号也可能在下方短等期间触发；立即收敛拒绝，后续仍断言请求确实被拒绝。 */ () => ({
              rejected: true
            })
          )
        await new Promise(/* 给慢调用建立等待的时间，再发送标准HTTP客户端取消。 */ (resolve) => setTimeout(resolve, 40))
        stop.abort()
        assert.equal((await pending).rejected, true)
        await new Promise(
          /* 等待受控执行计时器完成，证明前端取消未误杀该测试工作。 */ (resolve) => setTimeout(resolve, 150)
        )
        assert.equal(
          data(await client.callTool({ name: 'runtime_call_get', arguments: { call_id: 'call-2' } })).state,
          'responded'
        )
        const events = readFileSync(join(directory, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(/* 解析逐行服务事件，供核对历史参数和独立取消路径。 */ (line) => JSON.parse(line))
        assert.equal(
          events.filter(
            /* 统计传给 stub 的调用次数，检测门面是否自动补发请求。 */ (event) => event.operation === 'runtime_call'
          ).length,
          3
        )
        assert.equal(
          events.filter(
            /* 检查是否错误调用业务取消，区分前端信号与原生动作。 */ (event) =>
              event.operation === 'runtime_call_cancel'
          ).length,
          0
        )
        assert(
          events.some(
            /* 寻找等待停止事件，证明客户端取消已作用于前端等待。 */ (event) => event.event === 'waiting_stopped'
          )
        )
        assert(
          events.some(
            /* 寻找执行完成事件，证明等待取消没有被误报为执行回滚。 */ (event) => event.event === 'execution_finished'
          )
        )
        assert.equal(events[0].args.client_request_key, client_request_key)
        assert.equal(events[0].args.validation, undefined)
        assert.equal('wait_ms' in events[0].args, false)
      }
    )
  }
)
