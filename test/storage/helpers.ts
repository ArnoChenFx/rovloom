// 提供存储测试使用的隔离注册、策略和响应证据构造工具，仅适用于合成身份。

import { randomUUID } from 'node:crypto'
import { contractRef, planResponseEvidence } from '../../src/wire/index.js'
import type { AttemptBinding, AuthenticatedContext, AuthenticatedEnvelope, V2Target } from '../../src/wire/types.js'
import { Store } from '../../src/store.js'
import type { CallOptions, StoreOptions } from '../../src/store.js'
import { context, fixtureValidator, source } from '../wire/helpers.js'

// 仅自建 fixture 权限与来源；生产不得导入此管理授权/原生 validator 工厂。
export const management: StoreOptions['management'] =
  /* 生成合成管理者和一次性确认标识，避免测试中的管理确认被意外重放。 */ () => ({
    actor: 'synthetic_admin',
    confirmation_id: randomUUID()
  })
export const options = /* 生成与固定 fixture 契约及策略版本匹配的调用选项，并接纳显式覆盖。 */ (
  extra: Partial<CallOptions> = {}
): CallOptions => ({
  binding_revision: 1,
  contract_ref: contractRef(source),
  ...extra
})
// 注册并连接合成设备，启用测试 provider 后返回凭据、连接 epoch 和目标。
export function connected(store: Store, name = 'linux') {
  const machine = store.register(name)
  const enrollment = store.issueEnrollment(machine.machine_id)
  const device = store.redeem(enrollment)
  const epoch = store.connect(machine.machine_id, device.credential)
  store.defineProvider({
    machine_id: machine.machine_id,
    provider_id: 'provider',
    kind: 'luvus',
    config_ref: 'synthetic',
    binding_revision: 1,
    enabled: true
  })
  const target: V2Target = {
    machine_id: machine.machine_id,
    provider_id: 'provider',
    profile: 'session',
    session: 'test'
  }
  return { ...device, epoch, target, enrollment }
}
// 为指定目标构造调用者或本地策略，仅授予测试所需的方法与操作。
export function policy(target: V2Target, local = false): ProviderPolicy {
  return {
    revision: local ? 'local_policy_1' : 'caller_policy_1',
    grants: [
      {
        target,
        methods: ['pane.read', 'ping', 'host.capabilities'],
        actions: ['dispatch', 'read', 'cancel']
      }
    ]
  }
}
/* 为绑定尝试构造已认证连接上下文，并按存储当前状态解析 provider。 */ export function evidenceContext(
  store: Store,
  binding: AttemptBinding
): AuthenticatedContext {
  const ctx = context('connector_to_gateway', fixtureValidator(), binding, store.call('alice', binding.call_id).method)
  ctx.connection = {
    machine_id: binding.machine_id,
    recovery_generation: binding.recovery_generation,
    connection_epoch: binding.connection_epoch,
    authenticated: true,
    active: true,
    negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'] }
  }
  ctx.resolveProvider = /* 从存储读取当前绑定 provider，使证据校验使用最新配置与版本。 */ () =>
    store.provider(binding.machine_id, binding.target.provider_id)
  return ctx
}
// 构造携带完整尝试绑定的响应帧，并允许测试覆盖原生响应字段。
export function responseFrame(
  binding: AttemptBinding,
  nativeResponse: Record<string, unknown>
): Extract<AuthenticatedEnvelope, { type: 'response' }> {
  const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
  return {
    protocol_major: 2,
    protocol_minor: 0,
    message_id: randomUUID(),
    machine_id,
    recovery_generation,
    connection_epoch,
    type: 'response',
    payload: { attempt, native_response: { id: binding.native_request_id, ...nativeResponse } }
  }
}
/* 在存储证据事务内规划合成响应，并按参数控制是否授权保留内容。 */ export function respond(
  store: Store,
  binding: AttemptBinding,
  nativeResponse: Record<string, unknown>,
  now: number
) {
  const frame = responseFrame(binding, nativeResponse)
  return store.commitEvidence(
    binding,
    /* 在提交事务中按当前锚点和认证上下文规划响应证据，保留真实校验路径。 */ () =>
      planResponseEvidence(frame, evidenceContext(store, binding), store.responseAnchor(binding), now)
  )
}

import type { ProviderPolicy } from '../legacy-policy.js'
