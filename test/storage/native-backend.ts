// 为隔离 SQLite 测试构造真实原生校验与 Wire 后端，记录模拟发送并提交响应证据。
import type { Store } from '../../src/store.js'
import type { CallOptions } from '../../src/store.js'
import { contractRef } from '../../src/wire/index.js'
import { createLuvusWireAdapter } from '../../src/wire/native.js'
import { commitLuvusResponse, persistentBackend } from '../../src/wire/persistence.js'
import type { NativeBinding } from '../../src/connector/luvus/contract/index.js'
import type { AttemptBinding, AuthenticatedContext } from '../../src/wire/types.js'
import { compiled, G, identity, json } from '../native-contract/helpers.js'
import { source } from '../wire/helpers.js'
import { connected, options, responseFrame } from './helpers.js'

// 只用固定 P0 fixture 和隔离身份；编码/响应检查使用真实 NativeValidator 与 Wire adapter。
export function nativeBackend(
  store: Store,
  configuration: {
    method?: string
    params?: Record<string, unknown>
    device?: ReturnType<typeof connected>
    provider_id?: string
    limits?: Parameters<typeof createLuvusWireAdapter>[1]
  } = {}
) {
  const device = configuration.device ?? connected(store)
  const target = {
    ...device.target,
    provider_id: configuration.provider_id ?? device.target.provider_id,
    session: 'synthetic'
  }
  const nativeRequest = {
    method: configuration.method ?? 'task.add',
    params: configuration.params ?? { title: 'synthetic' }
  }
  const origin = { ...source, runtime_generation: G, classification_revision: 'review1' }
  const bindings = new Map<string, AttemptBinding>()
  const state = { sourceVerified: true, sends: 0 }
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = G
  const connection: AuthenticatedContext['connection'] = {
    machine_id: device.machine_id,
    recovery_generation: store.generation(),
    connection_epoch: device.epoch,
    authenticated: true,
    active: true,
    negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'] }
  }
  const backend = persistentBackend(store, {
    // 提供建档时的合成连接快照，当前 epoch 有效性由 persistentBackend 向 Store 核验。
    connection: () => connection,
    // 从同一隔离 Store 查询连接器配置，供适配器核对完整 provider 绑定。
    localProvider: () => store.provider(device.machine_id, target.provider_id),
    // 返回已固定来源的真实编译契约与能力广告，避免 mock 绕过原生校验。
    contract: () => ({
      wire: { source: origin, support_status: 'validated' },
      compiled,
      capabilities,
      capability_revision: 'caps1'
    }),
    // 仅为本辅助器登记且尝试编号匹配的调用构造原生来源，故障开关控制来源可信性。
    nativeSource: (call, attempt) => {
      const binding = bindings.get(call)
      if (!binding || binding.attempt_id !== attempt) {
        return undefined
      }
      const nativeBinding: NativeBinding = {
        kind: 'luvus',
        provider_id: target.provider_id,
        binding_revision: 1,
        contract_source_ref: binding.contract_ref,
        target: { machine_id: device.machine_id, profile: 'session', session: 'synthetic' },
        server_generation: G,
        connection_epoch: device.epoch,
        recovery_generation: store.generation(),
        capability_revision: 'caps1',
        classification_revision: 'review1',
        contract: identity
      }
      return { authenticated: true, source_verified: state.sourceVerified, binding: nativeBinding }
    },
    // 为实际测试方法提供当前双端精确 grant，避免其它方法借用授权。
    // 返回测试显式配置的完整分类及秘密边界权限事实。
    validateAttempt: () => {},
    // 把当前读取者固定为合成身份，使测试不接触真实账号。
    currentPrincipal: () => 'synthetic'
  })
  const adapter = createLuvusWireAdapter(backend, configuration.limits)
  return {
    backend,
    device,
    target,
    adapter,
    state,
    // 使用固定测试身份及契约、策略版本登记调用，允许显式覆盖单次调用选项。
    create(extra: Partial<CallOptions> = {}) {
      return store.createCall(
        'synthetic',
        target,
        nativeRequest,
        options({
          contract_ref: contractRef(origin),
          ...extra
        })
      )
    },
    // 先持久化完整派发锚点再通过真实 Wire 编码，仅将编码成功计为模拟发送。
    dispatch(callId: string) {
      const binding = store.dispatch('synthetic', callId, device.epoch)
      bindings.set(callId, binding)
      const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
      adapter.encode(
        {
          protocol_major: 2,
          protocol_minor: 0,
          message_id: binding.attempt_id,
          machine_id,
          recovery_generation,
          connection_epoch,
          type: 'request',
          payload: { attempt, expected_binding_revision: 1, native_request: nativeRequest, validation: 'strict' }
        },
        'gateway_to_connector'
      )
      state.sends++
      return binding
    },
    // 构造绑定原 attempt 的响应，并经真实适配器与 Store 同事务提交证据。
    respond(binding: AttemptBinding, result: Record<string, unknown> = { id: 'task-created' }) {
      return commitLuvusResponse(store, adapter, responseFrame(binding, { result }))
    }
  }
}
