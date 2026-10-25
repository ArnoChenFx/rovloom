// 仅用于HTTP SDK隔离测试的服务stub；不接Store、transport、原生实例或真实授权。
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonical, digest } from '../../src/contracts.js'
import {
  FacadeServiceError,
  type GatewayService,
  type ServiceContext,
  type ServiceReply,
  type ToolArguments,
  type ToolName
} from '../../src/mcp/types.js'

// 每个用例独立持有内存状态及事件文件，不能作为产品默认后端。
export function stubFixture(mode: string, directory: string) {
  const marker = 'SYNTHETIC_SECRET_DO_NOT_PRINT'
  const target = { machine_id: 'machine', provider_id: 'provider', profile: 'session', session: 'isolated' }
  const machine = {
    machine_id: 'machine',
    name: 'isolated',
    status: 'active',
    link: 'ready',
    targets: [target],
    credential: marker
  }
  const methods = ['uhp.ping', 'workspace.list', 'task.list', 'agent.status', 'pane.capture']
  const calls = new Map<string, Record<string, unknown>>()
  const keys = new Map<string, string>()
  let executions = 0
  // 只在测试指定目录追加合成事件，用于观察调用和等待生命周期。
  function record(event: Record<string, unknown>) {
    const destination = join(directory, 'events.jsonl')
    if (destination) {
      appendFileSync(destination, JSON.stringify(event) + '\n')
    }
  }
  const authentication = {
    authenticate: /* 只接受固定合成测试头；撤销文件仅为隔离认证stub的控制信号。 */ (request: Request) => {
      return mode === 'unbound' ||
        existsSync(join(directory, 'revoked')) ||
        request.headers.get('authorization') !== 'Bearer HTTP_TEST_ONLY'
        ? null
        : { principal_id: mode === 'admin' ? 'test-admin' : 'test-caller' }
    }
  }

  // 模拟受控服务响应和拒绝，检验 facade 转交，不实现生产账本或原生后端。
  async function execute<K extends ToolName>(
    name: K,
    args: ToolArguments[K],
    context: ServiceContext
  ): Promise<ServiceReply<K>> {
    record({ operation: name, caller: context.caller.principal_id, args })
    let data: unknown
    let isError = false
    if (name === 'runtime_response_discard') {
      if (context.caller.principal_id !== 'test-admin') {
        throw new FacadeServiceError('forbidden')
      }
    }
    switch (name) {
      case 'machines_list': {
        const page = args as ToolArguments['machines_list']
        if (page.cursor && page.cursor !== 'test-caller-page-2') {
          throw new FacadeServiceError('invalid_cursor')
        }
        data = page.cursor ? { items: [] } : { items: [machine], next_cursor: 'test-caller-page-2' }
        break
      }
      case 'machines_get':
        data = machine
        break
      case 'providers_list':
      case 'providers_get': {
        const provider = {
          machine_id: 'machine',
          provider_id: 'provider',
          kind: 'luvus',
          binding_revision: 1,
          enabled: true,
          readiness: 'ready',
          config_ref: marker
        }
        data = name === 'providers_list' ? { items: [provider] } : provider
        break
      }
      case 'runtime_discover':
        data = {
          items: methods.map(
            /* 为五类方法生成明确的 stub 覆盖标记，避免冒充原生能力。 */ (method) => ({
              method,
              parameter_coverage: 'stub_only'
            })
          )
        }
        break
      case 'runtime_describe':
        data = {
          method: (args as ToolArguments['runtime_describe']).method,
          schema: { type: 'object' },
          stub_only: true
        }
        break
      case 'runtime_call': {
        const call = args as ToolArguments['runtime_call']
        if (canonical(call.target) !== canonical(target)) {
          throw new FacadeServiceError('forbidden')
        }
        if (call.native_request.method === 'stub.throw') {
          throw new Error(`${marker} /private/isolated/path`)
        }
        if (call.native_request.method === 'stub.forbidden') {
          throw new FacadeServiceError('forbidden')
        }
        const key = call.client_request_key
        if (key && keys.has(key)) {
          data = calls.get(keys.get(key)!)
          break
        }
        const callId = `call-${++executions}`
        isError = call.native_request.method === 'stub.native_error'
        data = {
          call_id: callId,
          target: call.target,
          provider_kind: 'luvus',
          binding_revision: call.expected_binding_revision,
          contract_ref: call.contract_ref,
          state: 'responded',
          delivery: 'inline',
          content_status: 'available',
          executions,
          native_response: {
            id: 'stub-native-id',
            ...(isError
              ? {
                  error: {
                    code: 'native_test',
                    message: '原生测试错误',
                    data: { nested: [false, null, { kept: '值' }] }
                  }
                }
              : {
                  result: {
                    method: call.native_request.method,
                    params: call.native_request.params ?? null,
                    value: call.native_request.method === 'stub.large' ? '界'.repeat(30_000) : ['值', false, null, 3.25]
                  }
                })
          }
        }
        calls.set(callId, data as Record<string, unknown>)
        if (key) {
          keys.set(key, callId)
        }
        if (call.native_request.method === 'stub.slow') {
          const created = data as Record<string, unknown>
          created.state = 'connector_accepted'
          setTimeout(
            /* 完成受控执行计时器并记录证据，使等待取消不会终止测试工作。 */ () => {
              created.state = 'responded'
              record({ event: 'execution_finished', call_id: callId })
            },
            120
          )
          await new Promise<void>(
            /* 建立独立前端等待，由短等计时或取消信号结束，不重发执行。 */ (resolve) => {
              const done = /* 移除等待计时器和监听器并通知返回，避免测试泄漏资源。 */ () => {
                clearTimeout(timeout)
                context.wait_signal.removeEventListener('abort', onAbort)
                resolve()
              }
              const onAbort = /* 记录前端停止等待后释放等待 gate，不改变已启动的工作。 */ () => {
                record({ event: 'waiting_stopped', call_id: callId })
                done()
              }
              const timeout = setTimeout(done, call.wait_ms ?? 0)
              context.wait_signal.addEventListener('abort', onAbort, { once: true })
              if (context.wait_signal.aborted) {
                onAbort()
              }
            }
          )
        }
        break
      }
      case 'runtime_call_get': {
        const id = (args as ToolArguments['runtime_call_get']).call_id
        data = calls.get(id)
        if (!data) {
          throw new FacadeServiceError('not_found')
        }
        break
      }
      case 'runtime_call_cancel':
        data = { call_id: (args as ToolArguments['runtime_call_cancel']).call_id, cancellation: 'bridge_stopped' }
        break
      case 'runtime_result_read': {
        const read = args as ToolArguments['runtime_result_read']
        const text = '隔离分页结果😀'.repeat(100)
        if (read.cursor && read.cursor !== 'result-page-2') {
          throw new FacadeServiceError('invalid_cursor')
        }
        const second = read.cursor === 'result-page-2'
        data = {
          result_id: read.result_id,
          chunk: second ? text.slice(text.length / 2) : text.slice(0, text.length / 2),
          encoding: 'utf8',
          ...(second ? {} : { next_cursor: 'result-page-2' }),
          eof: second,
          total_bytes: Buffer.byteLength(text),
          sha256: digest(text),
          expires_at: 2_000_000_000_000
        }
        break
      }
      case 'runtime_response_discard':
        data = { call_id: (args as ToolArguments['runtime_response_discard']).call_id, content_status: 'discarded' }
        break
    }
    return { data, ...(isError ? { is_error: true } : {}) } as ServiceReply<K>
  }
  const service: GatewayService = { execute }
  return { service, authentication }
}
