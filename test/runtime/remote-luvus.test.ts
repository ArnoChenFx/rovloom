// 用固定官方离线契约与合成身份验证 remote pin、epoch、快照和 raw 边界；本文件不构成 native 或双机证据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkDispatch, createNativeValidator } from '../../src/native-contract/index.js'
import type { DispatchAuthorization } from '../../src/native-contract/index.js'
import type { TrustedAttempt } from '../../src/integration/luvus-wire.js'
import type { Connection } from '../../src/transport/index.js'
import { boundedJson, contractRef, hash } from '../../src/wire/index.js'
import type { AttemptBinding, ContractSource } from '../../src/wire/types.js'
import {
  checkedRemoteLuvusConfig,
  createPinnedRemoteLuvus,
  type LuvusProductionRemoteConfig
} from '../../src/runtime/remote-luvus.js'
import { FIXED_LUVUS_SCHEMA_SHA256, FIXED_LUVUS_SHA256 } from '../../src/runtime/native-control.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.js'
import type { RuntimeProvider } from '../../src/runtime/types.js'

const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
const capabilitiesBytes = readFileSync(
  new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url),
  'utf8'
)
const reference = 'remote_config'

/** 原始 schema 字符串保持原字节；配置中的所有身份仅属于此离线测试。 */
function input(rawGrant?: LuvusProductionRemoteConfig['raw_grant']) {
  return {
    kind: 'luvus',
    authentication: 'remote_connector',
    binding: {
      machine_id: 'remote_machine',
      provider_id: 'remote_provider',
      kind: 'luvus',
      config_ref: reference,
      binding_revision: 1,
      enabled: true
    },
    target: {
      machine_id: 'remote_machine',
      provider_id: 'remote_provider',
      profile: 'session' as const,
      session: 'synthetic'
    },
    contract: {
      binary_version: '0.14.3',
      binary_sha256: FIXED_LUVUS_SHA256,
      schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      schema_bundle: schema
    },
    peer_policy_revision: 'local1',
    ...(rawGrant ? { raw_grant: rawGrant } : {})
  }
}

/** 这里只构造单元测试连接值；真实来源认证和 socket 闭包由 transport 集成回归负责。 */
function connection(epoch = 'epoch1'): Connection {
  return {
    machine_id: 'remote_machine',
    recovery_generation: 'recovery1',
    connection_epoch: epoch,
    authenticated: true,
    active: true,
    negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'provider_snapshot'] }
  }
}

/** 完整官方能力仍有 197 个方法，只替换本轮合成 session 与 generation。 */
function snapshot() {
  const capabilities = JSON.parse(capabilitiesBytes)
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = 'generation1'
  const source: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: FIXED_LUVUS_SHA256,
    schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: 'generation1',
    adapter_revision: MANAGED_LUVUS_REVISION,
    classification_revision: MANAGED_LUVUS_CLASSIFICATION,
    support_basis: 'live_catalog'
  }
  const configured = checkedRemoteLuvusConfig(reference, input())
  return {
    binding: structuredClone(configured.binding),
    target: structuredClone(configured.target),
    source,
    capabilities,
    capability_revision: hash(boundedJson(capabilities.result))
  }
}

/** 为原校验器构造完整合成 attempt；deadline 固定为 200，不因检查或快照接纳刷新。 */
function attempt(
  provider: RuntimeProvider,
  epoch = 'epoch1',
  method = 'workspace.rename',
  principal = 'alice'
): TrustedAttempt {
  const { machine_id, recovery_generation, connection_epoch } = connection(epoch)
  const binding: AttemptBinding = {
    machine_id,
    recovery_generation,
    connection_epoch,
    call_id: 'call1',
    attempt_id: 'attempt1',
    native_request_id: 'native1',
    target: provider.target,
    provider_kind: 'luvus',
    binding_revision: 1,
    contract_ref: contractRef(provider.contract.wire.source),
    registration: { deadline: 200, caller_policy_revision: 'caller1', local_policy_revision: 'local1' }
  }
  return {
    binding,
    principal_id: principal,
    method,
    mode: 'raw-contract',
    native_request: {
      method,
      params:
        method === 'workspace.rename' ? { workspace_id: 'selected', name: 'literal' } : { workspace_id: 'selected' }
    }
  }
}

/** 运行真正的候选和 checkDispatch，避免只比较 authority 字段而漏掉原 raw gate。 */
function dispatch(provider: RuntimeProvider, request: TrustedAttempt, now = 100, allowed = true) {
  const source = provider.source(request.binding)
  assert(source)
  const validator = createNativeValidator(provider.contract.compiled)
  const view = validator.bindCapabilities(provider.contract.capabilities, source)
  assert(view.ok)
  const candidate = validator.checkRawRequest(view.value, {
    id: request.binding.native_request_id,
    ...request.native_request
  })
  assert(candidate.ok)
  const policy = {
    machines: ['remote_machine'],
    sessions: [request.binding.target.session!],
    methods: allowed ? [request.method] : [],
    host: false
  }
  const authority: DispatchAuthorization = {
    ...provider.authority(request, source.binding),
    source,
    principal_id: request.principal_id,
    caller_policy: policy,
    local_policy: policy,
    mode: 'raw_contract',
    now
  }
  return { result: checkDispatch(candidate.value, authority), authority }
}

test(
  'remote 静态 pin 复制原 schema 字节并冻结完整配置，输入不能事后改变 raw 权限',
  /** 受保护配置校验只建立静态事实，不创建 live 来源。 */ () => {
    const original = input({ principal_id: 'alice', methods: ['workspace.rename'] })
    const checked = checkedRemoteLuvusConfig(reference, original)
    assert.equal(checked.contract.schema_bundle, schema)
    assert.equal(hash(checked.contract.schema_bundle), FIXED_LUVUS_SCHEMA_SHA256)
    const methods = original.raw_grant!.methods as string[]
    methods.push('workspace.close')
    original.binding.config_ref = 'changed'
    assert.deepEqual(checked.raw_grant!.methods, ['workspace.rename'])
    assert.equal(checked.binding.config_ref, reference)
    for (const value of [
      checked,
      checked.binding,
      checked.target,
      checked.contract,
      checked.raw_grant,
      checked.raw_grant!.methods
    ]) {
      assert(Object.isFrozen(value))
    }
  }
)

test(
  'remote 静态配置拒绝摘要不符、错误修订/引用和越界 raw 方法',
  /** 摘要相同的声明不能替代原字节；raw 只接受独立显式的已审方法集合。 */ () => {
    for (const [field, value] of [
      ['schema_sha256', 'b'.repeat(64)],
      ['adapter_revision', 'other_adapter'],
      ['classification_revision', 'other_classification'],
      ['schema_bundle', JSON.stringify(JSON.parse(schema))]
    ] as const) {
      const changed = input()
      changed.contract[field] = value
      assert.throws(
        /** 固定安装 pin 的任意漂移均在编译前拒绝。 */ () => checkedRemoteLuvusConfig(reference, changed),
        /remote_luvus_pin_invalid/
      )
    }
    assert.throws(
      /** 引用必须对应同一 canonical config_ref。 */ () => checkedRemoteLuvusConfig('other', input()),
      /remote_luvus_pin_invalid/
    )
    for (const methods of [['workspace.rename', 'workspace.rename'], ['']]) {
      assert.throws(
        /** raw 不因认证或 scope 名称扩大到未审方法。 */ () =>
          checkedRemoteLuvusConfig(reference, input({ principal_id: 'alice', methods })),
        /remote_luvus_raw_grant_invalid/
      )
    }
    assert.throws(
      /** raw 主体必须为明确非空标识。 */ () =>
        checkedRemoteLuvusConfig(reference, input({ principal_id: '', methods: ['workspace.rename'] }))
    )
  }
)

test(
  'remote open 拒绝未认证、inactive、其它 machine 或未协商快照的连接',
  /** 这些静态连接条件不满足时连合成 guard 都不能建立 epoch。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      const unauthenticated = connection()
      unauthenticated.authenticated = false as unknown as true
      const inactive = connection()
      inactive.active = false as unknown as true
      const otherMachine = connection()
      otherMachine.machine_id = 'other_machine'
      const unnegotiated = connection()
      unnegotiated.negotiated.capabilities = ['rpc']
      let checked = 0
      for (const invalid of [unauthenticated, inactive, otherMachine, unnegotiated]) {
        assert.throws(
          /** 无效连接不能靠 callback 自报通过。 */ () =>
            factory.provider.open(
              invalid,
              /** 记录该 callback 是否被错误调用。 */ () => {
                checked++
              }
            ),
          /remote_luvus_epoch_unavailable/
        )
      }
      assert.equal(checked, 0)
      assert.equal(factory.provider.ready(), false)
    } finally {
      factory.close()
    }
  }
)

test(
  'remote 无快照不 ready，完整快照幂等接纳并生成 Gateway 本地真实编译上下文',
  /** 编译句柄只能来自本地原工厂，原快照与外部对象不能在接纳后修改它。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      assert.equal(factory.provider.ready(), false)
      const epoch = factory.provider.open(connection(), /** 合成 unit guard 不代表实际 socket 认证。 */ () => {})
      assert.equal(factory.provider.ready(), false)
      const observed = snapshot()
      const live = epoch.accept(observed)
      assert.equal(epoch.accept(structuredClone(observed)), live)
      assert.equal(factory.provider.ready(), true)
      assert.equal(live.ready(), true)
      assert.equal((live.contract.capabilities as { result: { methods: string[] } }).result.methods.length, 197)
      const request = attempt(live)
      const proven = live.source(request.binding)!
      assert.equal(proven.binding.connection_epoch, 'epoch1')
      assert.equal(proven.binding.contract.schema_sha256, FIXED_LUVUS_SCHEMA_SHA256)
      const validator = createNativeValidator(live.contract.compiled)
      assert.equal(validator.bindCapabilities(live.contract.capabilities, proven).ok, true)
      observed.capabilities.result.methods.length = 0
      assert.equal((live.contract.capabilities as { result: { methods: string[] } }).result.methods.length, 197)
      assert(Object.isFrozen(live.contract.capabilities))
    } finally {
      factory.close()
    }
  }
)

test(
  'remote 快照交叉核对完整 binding、target、pin、generation 与能力摘要',
  /** 重算能力摘要也不能绕过原完整 shape 和固定契约审核。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      const epoch = factory.provider.open(connection(), /** 仅用于离线输入检查的合成 guard。 */ () => {})
      const changes: ((value: ReturnType<typeof snapshot>) => void)[] = [
        /** 同一 machine 上其它 provider 也不是当前来源。 */ (value) => {
          value.target.provider_id = 'other_provider'
        },
        /** 相同 provider 标签不能跨 session。 */ (value) => {
          if (value.target.profile === 'session') {
            value.target.session = 'other_session'
          }
        },
        /** config_ref 参与完整 canonical binding 核对。 */ (value) => {
          value.binding.config_ref = 'other_config'
        },
        /** binding revision 不从设备广告回写。 */ (value) => {
          value.binding.binding_revision++
        },
        /** 启用状态同样属于完整 binding。 */ (value) => {
          value.binding.enabled = false
        },
        /** 源代次必须对应能力中的代次。 */ (value) => {
          value.source.runtime_generation = 'other_generation'
        },
        /** 设备不能更改二进制 pin。 */ (value) => {
          value.source.binary_sha256 = 'a'.repeat(64)
        },
        /** 设备不能更改安装 schema pin。 */ (value) => {
          value.source.schema_sha256 = 'b'.repeat(64)
        },
        /** 原能力摘要必须匹配完整 result。 */ (value) => {
          value.capability_revision = 'c'.repeat(64)
        },
        /** 错误 session 即使重算摘要仍拒绝。 */ (value) => {
          value.capabilities.result.session = 'other_session'
          value.capability_revision = hash(boundedJson(value.capabilities.result))
        },
        /** 全目录重复不能靠正确摘要放行。 */ (value) => {
          value.capabilities.result.methods[1] = value.capabilities.result.methods[0]
          value.capability_revision = hash(boundedJson(value.capabilities.result))
        },
        /** 终端执行预算也须通过原 shape。 */ (value) => {
          value.capabilities.result.terminal.limits.request_bytes = 0
          value.capability_revision = hash(boundedJson(value.capabilities.result))
        }
      ]
      for (const change of changes) {
        const observed = snapshot()
        change(observed)
        assert.throws(/** 尚未接纳的坏快照不能制造 ready 或 live context。 */ () => epoch.accept(observed))
        assert.equal(factory.provider.ready(), false)
      }
      assert.equal(epoch.accept(snapshot()).ready(), true)
    } finally {
      factory.close()
    }
  }
)

test(
  'remote 同 epoch 只容许精确重复快照，已合法变更的能力或 generation 也不能热换',
  /** 差异必须由新认证 epoch 独立接纳，原 live 对象继续绑定原快照。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      const epoch = factory.provider.open(connection(), /** 只为此 unit 场景提供合成 guard。 */ () => {})
      const live = epoch.accept(snapshot())
      for (const generation of [false, true]) {
        const changed = snapshot()
        if (generation) {
          changed.source.runtime_generation = changed.capabilities.result.server_generation = 'generation2'
        } else {
          changed.capabilities.result.event_sequence++
        }
        changed.capability_revision = hash(boundedJson(changed.capabilities.result))
        assert.throws(
          /** 合法的新快照仍不能替换旧 epoch 上下文。 */ () => epoch.accept(changed),
          /remote_luvus_snapshot_changed/
        )
      }
      assert.equal(epoch.accept(snapshot()), live)
      assert.equal(live.source(attempt(live).binding)!.binding.server_generation, 'generation1')
    } finally {
      factory.close()
    }
  }
)

test(
  'remote 来源使用私有 connection 副本，完整 attempt 身份漂移均拒绝',
  /** 外部连接对象修改不能改变旧上下文的核验依据或接纳另一个 epoch。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      const original = connection()
      const retained = structuredClone(original)
      const epoch = factory.provider.open(original, /** 本测试仅检查对象隔离。 */ () => {})
      const live = epoch.accept(snapshot())
      original.connection_epoch = 'changed_after_open'
      const request = attempt(live)
      assert.equal(live.source(request.binding)!.binding.connection_epoch, 'epoch1')
      assert.equal(live.catalogSource!(retained, request.binding.registration).binding.connection_epoch, 'epoch1')
      assert.throws(
        /** 目录也不接受事后修改的旧输入对象。 */ () => live.catalogSource!(original, request.binding.registration),
        /remote_luvus_epoch_unavailable/
      )
      for (const field of ['machine_id', 'recovery_generation', 'connection_epoch', 'contract_ref'] as const) {
        const changed = structuredClone(request.binding)
        changed[field] = field === 'contract_ref' ? 'a'.repeat(64) : 'other_identity'
        assert.throws(
          /** 原 source 不接受跨 machine、generation、epoch 或契约。 */ () => live.source(changed),
          /remote_luvus_binding_mismatch/
        )
      }
      const changed = structuredClone(request.binding)
      changed.target = { ...changed.target, provider_id: 'other_provider' }
      assert.throws(
        /** 相同 attempt ID 也不能换完整 target。 */ () => live.source(changed),
        /remote_luvus_binding_mismatch/
      )
    } finally {
      factory.close()
    }
  }
)

test(
  'remote 旧 epoch/关闭对象不会因新连接或晚 close 复活，当前 guard 失效逐次拒绝',
  /** 保留两个 live 对象证明旧句柄不能转用新连接，旧 close 不能销毁新 epoch。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      let current = 'epoch1'
      const epoch = factory.provider.open(
        connection(),
        /** 合成当前 epoch fence 可受控撤销。 */ () => {
          if (current !== 'epoch1') {
            throw new Error('unit_epoch_revoked')
          }
        }
      )
      const old = epoch.accept(snapshot())
      current = 'epoch2'
      assert.equal(old.ready(), false)
      assert.throws(/** 旧来源不能沿用此前 guard 成功。 */ () => old.source(attempt(old).binding), /unit_epoch_revoked/)
      epoch.close()
      const next = factory.provider.open(
        connection('epoch2'),
        /** 新 epoch 有自己独立的合成 fence。 */ () => {
          if (current !== 'epoch2') {
            throw new Error('unit_epoch_revoked')
          }
        }
      )
      const live = next.accept(snapshot())
      epoch.close()
      assert.equal(live.ready(), true)
      assert.equal(live.source(attempt(live, 'epoch2').binding)!.binding.connection_epoch, 'epoch2')
      assert.throws(
        /** 已关闭 accept 不能把旧数据送入新 epoch。 */ () => epoch.accept(snapshot()),
        /remote_luvus_epoch_unavailable/
      )
      assert.throws(
        /** 旧 live 对象即使引用仍存也拒绝。 */ () => old.source(attempt(old).binding),
        /remote_luvus_epoch_unavailable/
      )
      factory.close()
      assert.equal(live.ready(), false)
      assert.throws(
        /** 工厂关闭后不能再次打开。 */ () =>
          factory.provider.open(connection('epoch3'), /** 不应被调用的 guard。 */ () => {}),
        /remote_luvus_epoch_unavailable/
      )
    } finally {
      factory.close()
    }
  }
)

test(
  'remote guard 只接受同步 undefined，并消费异步拒绝；后续异步 guard 也不能 mint 来源',
  /** 回调类型的 void 不能把 Promise 当作已完成认证。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      assert.throws(
        /** 异步成功也尚非同步已验证事实。 */ () =>
          factory.provider.open(connection(), /** 故意返回异步检查。 */ async () => {}),
        /synchronous_remote_source_required/
      )
      assert.throws(
        /** 异步失败只被消费，不逃逸为未处理拒绝。 */ () =>
          factory.provider.open(
            connection(),
            /** 模拟晚拒绝的身份源。 */ async () => {
              throw new Error('late_unit_rejection')
            }
          ),
        /synchronous_remote_source_required/
      )
      await Promise.resolve()
      let asynchronous = false
      const epoch = factory.provider.open(
        connection(),
        /** 同一来源在以后调用改成异步也必须拒绝。 */ () => {
          if (asynchronous) {
            return Promise.resolve()
          }
        }
      )
      const live = epoch.accept(snapshot())
      asynchronous = true
      assert.equal(live.ready(), false)
      assert.throws(
        /** 读取原生绑定仍须同步 guard 完成。 */ () => live.source(attempt(live).binding),
        /synchronous_remote_source_required/
      )
    } finally {
      factory.close()
    }
  }
)

test(
  'remote guard 同步重入关闭后不能返回旧 live 来源',
  /** guard 返回后再次核对生命周期，不能利用关闭回调穿过 fence。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      let closing = false
      const epoch = factory.provider.open(
        connection(),
        /** 首次接纳正常，此后在来源检查中同步关闭。 */ () => {
          if (closing) {
            factory.close()
          }
        }
      )
      const live = epoch.accept(snapshot())
      closing = true
      assert.throws(
        /** 不交付在 guard 内已被关闭的上下文。 */ () => live.source(attempt(live).binding),
        /remote_luvus_epoch_unavailable/
      )
      assert.equal(live.ready(), false)
      assert.equal(factory.provider.ready(), false)
    } finally {
      factory.close()
    }
  }
)

test(
  'remote 无静态 raw 清单仍为已暴露方法生成本次调用许可',
  /** 合法快照、认证 guard 与已审分类均不能自动成为 Owner/raw 权限。 */ async () => {
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, input()))
    try {
      const live = factory.provider.open(connection(), /** 仅用于离线权限组合。 */ () => {}).accept(snapshot())
      const checked = dispatch(live, attempt(live))
      assert.equal(checked.authority.owner, true)
      assert.deepEqual(checked.authority.raw_grant!.methods, ['workspace.rename'])
      assert.equal(checked.result.ok, true)
    } finally {
      factory.close()
    }
  }
)

test('remote 策略 raw grant 保留真实 caller、方法、双端策略和固定截止约束', async () => {
  const factory = await createPinnedRemoteLuvus(
    checkedRemoteLuvusConfig(reference, input({ caller_policy_revision: 'caller1', methods: ['workspace.rename'] }))
  )
  try {
    const live = factory.provider.open(connection(), () => {}).accept(snapshot())
    for (const principal of ['operator_simple_pairing', 'test', 'admin']) {
      const request = attempt(live, 'epoch1', 'workspace.rename', principal)
      const checked = dispatch(live, request)
      assert.equal(checked.result.ok, true)
      assert.equal(checked.authority.raw_grant!.principal_id, principal)
      assert.equal(checked.authority.raw_grant!.expires_at, request.binding.registration.deadline)
      const revoked = dispatch(live, request, 100, false)
      assert(!revoked.result.ok)
      assert.equal(revoked.result.error.code, 'forbidden')
    }
    const stale = attempt(live)
    stale.binding.registration.caller_policy_revision = 'other_policy'
    for (const request of [stale, attempt(live, 'epoch1', 'workspace.get')]) {
      const checked = dispatch(live, request)
      assert(checked.result.ok)
      assert.equal(checked.authority.raw_grant!.expires_at, request.binding.registration.deadline)
    }
  } finally {
    factory.close()
  }
  for (const grant of [
    { caller_policy_revision: '', methods: ['workspace.rename'] },
    { principal_id: 'alice', caller_policy_revision: 'caller1', methods: ['workspace.rename'] },
    { methods: ['workspace.rename'] },
    { caller_policy_revision: 'caller1', methods: ['workspace.rename'], expires_at: null }
  ]) {
    assert.throws(() => checkedRemoteLuvusConfig(reference, { ...input(), raw_grant: grant }))
  }
})

test(
  'remote 旧 raw 主体和方法清单不再限制 MCP，逐次许可仍绑定当前主体及截止',
  /** 用真实 raw gate 证明范围和固定截止，而非只断言配置字段。 */ async () => {
    const factory = await createPinnedRemoteLuvus(
      checkedRemoteLuvusConfig(reference, input({ principal_id: 'alice', methods: ['workspace.rename'] }))
    )
    try {
      const live = factory.provider.open(connection(), /** 只有本测试的合成当前 epoch。 */ () => {}).accept(snapshot())
      const request = attempt(live)
      const granted = dispatch(live, request)
      assert.equal(granted.result.ok, true)
      assert.equal(granted.authority.raw_grant!.expires_at, request.binding.registration.deadline)
      assert.deepEqual(granted.authority.raw_grant!.methods, ['workspace.rename'])
      assert.deepEqual(granted.authority.raw_grant!.binding, live.source(request.binding)!.binding)
      for (const denied of [
        attempt(live, 'epoch1', 'workspace.rename', 'bob'),
        attempt(live, 'epoch1', 'workspace.get')
      ]) {
        const checked = dispatch(live, denied)
        assert.equal(checked.authority.owner, true)
        assert(checked.result.ok)
        assert.equal(checked.authority.raw_grant!.principal_id, denied.principal_id)
        assert.deepEqual(checked.authority.raw_grant!.methods, [denied.method])
      }
      const expired = dispatch(live, request, request.binding.registration.deadline)
      assert.equal(expired.result.ok, false)
      if (!expired.result.ok) {
        assert.equal(expired.result.error.code, 'raw_contract_grant_expired')
      }
    } finally {
      factory.close()
    }
  }
)

test(
  'remote 实际安装可使用陌生版本/摘要，缺少可选方法仍保留健康 RPC',
  /** 独立 Gateway 从未知原字节真实编译并接纳实际快照；不把版本标签作为门禁或扩大 raw 授权。 */ async () => {
    const configured = input({ principal_id: 'alice', methods: ['workspace.rename'] })
    configured.contract.binary_version = 'configured-diagnostic-version'
    configured.contract.binary_sha256 = 'd'.repeat(64)
    configured.contract.schema_bundle += '\n'
    configured.contract.schema_sha256 = hash(configured.contract.schema_bundle)
    const factory = await createPinnedRemoteLuvus(checkedRemoteLuvusConfig(reference, configured))
    try {
      const observed = snapshot()
      observed.source.binary_version = 'observed-future-version'
      observed.source.server_version = 'different-server-version'
      observed.source.binary_sha256 = configured.contract.binary_sha256
      observed.source.schema_sha256 = configured.contract.schema_sha256
      observed.capabilities.result.methods = observed.capabilities.result.methods.filter(
        /** 实际安装缺少一个已接入的可选方法。 */ (name: string) => name !== 'agent.wait'
      )
      observed.capabilities.result.method_contracts = observed.capabilities.result.method_contracts.filter(
        /** 同一实际目录同步删除对应描述，不伪造残缺快照。 */ (row: { method: string }) => row.method !== 'agent.wait'
      )
      if (observed.capabilities.result.access) {
        observed.capabilities.result.access.allowed_methods =
          observed.capabilities.result.access.allowed_methods.filter(
            /** 本轮访问提示也来自同一实际方法目录。 */ (name: string) => name !== 'agent.wait'
          )
      }
      observed.capability_revision = hash(boundedJson(observed.capabilities.result))
      const epoch = factory.provider.open(connection(), /** 合成连接 guard 不授予真实认证。 */ () => {})
      const live = epoch.accept(observed)
      assert(live.ready())
      assert.equal(live.contract.wire.source.binary_version, 'observed-future-version')
      assert.equal(dispatch(live, attempt(live)).result.ok, true)
      const request = attempt(live)
      const view = createNativeValidator(live.contract.compiled).bindCapabilities(
        live.contract.capabilities,
        live.source(request.binding)!
      )
      assert(view.ok)
      assert(
        !view.value.methods.some(/** 缺失方法不可被目录或调用冒称可用。 */ (method) => method.method === 'agent.wait')
      )
    } finally {
      factory.close()
    }
  }
)
