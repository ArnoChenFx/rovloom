// 组合端口组件回归：治理帧使用真实Wire/receipt writer，native端口是明确拒绝执行的stub。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {} from 'node:path'
import {} from 'node:url'
import { composeConnectorSessions, composeGatewaySessions } from '../../src/runtime/provider-sessions.js'
import type { ProviderSessionGroup } from '../../src/runtime/provider-sessions.js'
import type { Adapter, Connection, ConnectorWireSession } from '../../src/transport/index.js'
import { boundedJson, decodeWireFrame, encodeWireFrame, MessageWindow } from '../../src/wire/index.js'
import type { AttemptBinding, Direction, ProviderKind, ProviderSnapshot, V2Target } from '../../src/wire/types.js'
import { envelope } from '../../src/transport/common.js'

const connection: Connection = {
  machine_id: 'component_machine',
  recovery_generation: 'component_generation',
  connection_epoch: 'component_epoch',
  authenticated: true,
  active: true,
  negotiated: {
    major: 2,
    minor: 0,
    capabilities: ['rpc', 'provider_snapshot']
  }
}

test(
  '单 provider 来源失效只永久封锁该 binding，健康 provider 保持同 epoch 原端口',
  /** 组件原生端口始终明确拒绝执行；只验证故障域、治理协议与关闭次数。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      {
        ...connection,
        negotiated: {
          ...connection.negotiated,
          capabilities: [...connection.negotiated.capabilities, 'provider_fence']
        }
      },
      [a.descriptor, b.descriptor],
      Date.now
    )
    try {
      assert.equal(combined.readiness().providers.length, 2)
      a.state.closed = true
      const health = combined.readiness()
      assert.equal(
        health.providers.find(/** 失败来源必须不可用。 */ (p) => p.local.kind === 'luvus')!.native_ready,
        false
      )
      assert.equal(
        health.providers.find(/** 健康来源保留自己的观测。 */ (p) => p.local.kind === 'herdr')!.native_ready,
        true
      )
      a.state.closed = false
      assert.equal(
        combined.readiness().providers.find(/** 底层恢复不能复活旧 binding/epoch。 */ (p) => p.local.kind === 'luvus')!
          .native_ready,
        false
      )
      const heartbeat = envelope(connection, 'heartbeat', { sequence: 0 })
      assert.deepEqual(
        combined.adapter.decode(combined.adapter.encode(heartbeat, 'connector_to_gateway'), 'connector_to_gateway'),
        heartbeat
      )
      assert.throws(
        /** 健康 provider 仍调用自己的原端口；该端口明确没有原生后端。 */ () => combined.adapter.checkResult(b.attempt),
        /stub_native_unavailable_herdr/
      )
      assert.equal(b.state.calls, 1)
      assert.equal(a.state.calls, 0)
    } finally {
      combined.close()
    }
    assert.deepEqual([a.state.adapters, a.state.owners, b.state.adapters, b.state.owners], [1, 1, 1, 1])
  }
)

test(
  '启动时不可用配置没有替代 adapter 或 native owner，只撤回该 provider 并保留真实健康会话',
  /** 不可用配置只供声明失效，不能以拒绝 stub 冒充可执行来源。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const selected: Connection = {
      ...connection,
      negotiated: {
        ...connection.negotiated,
        capabilities: [...connection.negotiated.capabilities, 'provider_fence']
      }
    }
    const combined = composeConnectorSessions(selected, [a.descriptor], Date.now, b.descriptor.providers)
    try {
      assert.deepEqual(combined.providerFences!(), [b.binding])
      assert.equal(
        combined.readiness().providers.find(/** 原配置明确不可用。 */ (p) => p.local.kind === 'herdr')!.native_ready,
        false
      )
      const message = envelope(selected, 'provider_fenced', { binding: b.binding })
      assert.deepEqual(
        combined.adapter.decode(combined.adapter.encode(message, 'connector_to_gateway'), 'connector_to_gateway'),
        message
      )
      combined.fenceProvider!(b.binding)
      assert.throws(
        /** 不可用声明没有原生执行或读取端口。 */ () => combined.adapter.checkResult(b.attempt),
        /provider_not_ready/
      )
      assert.throws(
        /** 不可用也不能换成其它 revision。 */ () => combined.fenceProvider!({ ...b.binding, binding_revision: 2 }),
        /provider_binding_mismatch/
      )
      assert.throws(
        /** 健康会话仍调用它原来的明确拒绝测试端口。 */ () => combined.adapter.checkResult(a.attempt),
        /stub_native_unavailable_luvus/
      )
      assert.equal(a.state.calls, 1)
      assert.deepEqual([b.state.calls, b.state.adapters, b.state.owners], [0, 0, 0])
    } finally {
      combined.close()
    }
    const legacy = group('luvus')
    assert.throws(
      /** 对端未协商撤回时不能把不完整来源静默当作正常会话。 */ () =>
        composeConnectorSessions(connection, [legacy.descriptor], Date.now, b.descriptor.providers),
      /provider_fence_required/
    )
    assert.deepEqual([legacy.state.adapters, legacy.state.owners], [1, 1])
  }
)

test(
  '失败 owner 清理不能确认时拒绝继续分配上下文，不能把未回收预算算作已释放',
  /** 清理失败是原通道资源故障；正常单来源失效仍由独立隔离回归覆盖。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      {
        ...connection,
        negotiated: {
          ...connection.negotiated,
          capabilities: [...connection.negotiated.capabilities, 'provider_fence']
        }
      },
      [a.descriptor, b.descriptor],
      Date.now
    )
    a.state.failing = true
    a.state.closed = true
    a.state.contexts = 128
    try {
      assert.throws(
        /** 原 owner 抛错不能被视为预算已经回收。 */ () => combined.readiness(),
        /runtime_session_close_failed/
      )
      assert.throws(
        /** 健康原端口也不能在全局资源回收未确认时分配新上下文。 */ () => combined.adapter.checkResult(b.attempt),
        /runtime_session_close_failed/
      )
      assert.equal(b.state.calls, 0)
    } finally {
      assert.throws(
        /** 原关闭结果持续失败，但仍尝试所有原 owner。 */ () => combined.close(),
        /runtime_session_close_failed/
      )
    }
    assert.deepEqual([a.state.adapters, a.state.owners, b.state.adapters, b.state.owners], [1, 1, 1, 1])
  }
)

test(
  '非空provider_snapshot没有attempt，按完整target/binding经原codec编码解码',
  /** 使用官方能力原值和真实Wire治理codec；不构造native许可或安装成功。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const c = group('luvus')
    const d = group('herdr')
    const capabilities = JSON.parse(
      readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
    )
    capabilities.result.session = a.target.session
    capabilities.result.server_generation = 'a'.repeat(32)
    const snapshot: ProviderSnapshot = {
      binding: a.binding,
      target: a.target,
      source: {
        provider_kind: 'luvus',
        protocol_family: 'uhp',
        binary_version: '0.14.3',
        binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
        schema_sha256: '00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6',
        schema_origin: 'installed_cli',
        schema_command: 'luvus uhp schema',
        server_version: '0.14.3',
        native_protocol_version: '1.0',
        runtime_generation: capabilities.result.server_generation,
        adapter_revision: 'managed-owned-luvus-0.14.3-1',
        classification_revision: 'managed-owned-rpc-1',
        support_basis: 'live_catalog'
      },
      capabilities,
      capability_revision: 'a'.repeat(64)
    }
    const connector = composeConnectorSessions(connection, [a.descriptor, b.descriptor], Date.now)
    const gateway = composeGatewaySessions(connection, [c.descriptor, d.descriptor], Date.now)
    try {
      const frame = envelope(connection, 'provider_snapshot', snapshot)
      assert.equal(Object.hasOwn(frame.payload, 'attempt'), false)
      const bytes = connector.adapter.encode(frame, 'connector_to_gateway')
      const decoded = gateway.adapter.decode(bytes, 'connector_to_gateway')
      assert.deepEqual(decoded, frame)
      assert.equal(gateway.adapter.observeMessage(decoded, 'connector_to_gateway'), 'new')
      assert.throws(
        /** 错kind不能借同一个provider名称选择另一原组。 */ () =>
          connector.adapter.encode(
            { ...frame, payload: { ...snapshot, binding: { ...a.binding, kind: 'herdr' } } },
            'connector_to_gateway'
          )
      )
      assert.throws(
        /** 选中原codec后，实际epoch校验继续有效。 */ () =>
          connector.adapter.encode({ ...frame, connection_epoch: 'foreign_epoch' }, 'connector_to_gateway')
      )
    } finally {
      connector.close()
      gateway.close()
    }
  }
)

/** 两个明确synthetic provider的路由描述；native执行端口始终抛固定错误，不能充当CLI成功后端。 */
function group(kind: ProviderKind) {
  const target = {
    machine_id: connection.machine_id,
    provider_id: kind + '_component',
    profile: 'session' as const,
    session: 'component'
  }
  const binding = {
    machine_id: connection.machine_id,
    provider_id: target.provider_id,
    kind,
    config_ref: kind + '_config',
    binding_revision: 1,
    enabled: true
  }
  const state = {
    closed: false,
    adapters: 0,
    owners: 0,
    calls: 0,
    contexts: 0,
    bytes: 0,
    failing: false,
    reenter: undefined as undefined | (() => void)
  }
  const windows = new Map<Direction, MessageWindow>()
  const context = /** 真实治理codec只读取本测试固定连接和canonical provider，不提供native validator。 */ (
    direction: Direction
  ) => ({
    phase: 'authenticated' as const,
    connection,
    direction,
    resolveProvider: /** 精确目标匹配后才返回同一配置。 */ (selected: V2Target) =>
      boundedJson(selected) === boundedJson(target) ? binding : undefined
  })
  const native = /** 显式缺原生后端的测试stub，不返回执行或结果成功。 */ () => {
    state.calls++
    state.reenter?.()
    throw new Error('stub_native_unavailable_' + kind)
  }
  const adapter: Adapter = {
    encode: /** 保留真实治理帧codec及当前连接验证。 */ (frame, direction) => encodeWireFrame(frame, context(direction)),
    decode: /** 完整解码receipt/heartbeat，缺native上下文时request仍会拒绝。 */ (raw, direction) =>
      decodeWireFrame(raw, context(direction)),
    observeMessage: /** 原组使用真实MessageWindow，组合层另验跨组冲突。 */ (frame, direction) => {
      let window = windows.get(direction)
      if (!window) {
        window = new MessageWindow()
        windows.set(direction, window)
      }
      return window.observe(frame, context(direction), 100)
    },
    checkResult: native,
    checkResultRetention: native,
    planEvidence: native,
    release: native,
    stats: /** 只返回可控制的组件计数，不代表原生上下文存在。 */ () => ({
      closed: state.closed,
      executions: state.contexts,
      responses: 0,
      snapshot_bytes: state.bytes
    }),
    close: /** 记录原端口真实被调用次数，故意不替组合层隐藏重复关闭。 */ () => {
      state.closed = true
      state.adapters++
      if (state.failing) {
        throw new Error('stub_close_failed')
      }
    }
  }
  const session: ConnectorWireSession = {
    adapter,
    readiness: /** 只报告本synthetic组件的固定配置。 */ () => ({
      providers: [{ expected: binding, local: binding, native_ready: true }]
    }),
    executeWire: /** 无原生后端，意外执行始终失败。 */ async () => native(),
    close: /** 原owner同样记录调用次数，验证不会因adapter失败而被跳过。 */ () => {
      state.owners++
    }
  }
  const descriptor: ProviderSessionGroup<ConnectorWireSession> = { providers: [{ target, binding }], session }
  const attempt: AttemptBinding = {
    machine_id: connection.machine_id,
    recovery_generation: connection.recovery_generation,
    connection_epoch: connection.connection_epoch,
    call_id: kind + '_call',
    attempt_id: kind + '_attempt',
    native_request_id: kind + '_request',
    target,
    provider_kind: kind,
    binding_revision: 1,
    contract_ref: (kind === 'luvus' ? 'a' : 'b').repeat(64),
    registration: { deadline: 1000 }
  }
  return { descriptor, state, target, binding, session, attempt }
}

test(
  '完整target/kind选择原端口，治理codec仍拒绝错epoch，stub不会变成执行成功',
  /** 不启动设备或native进程。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定隔离时钟，不访问产品或用户会话。 */ () => 100
    )
    try {
      assert.throws(
        /** 确认Luvus端口收到原binding且明确拒绝执行。 */ () => combined.adapter.checkResult(a.attempt),
        /stub_native_unavailable_luvus/
      )
      assert.throws(
        /** 确认Herdr端口收到原binding且明确拒绝执行。 */ () => combined.adapter.checkResult(b.attempt),
        /stub_native_unavailable_herdr/
      )
      assert.throws(
        /** 另一session不能借相同provider取得原端口。 */ () =>
          combined.adapter.checkResult({ ...a.attempt, target: { ...a.target, session: 'other' } }),
        /provider_binding_mismatch/
      )
      assert.throws(
        /** 篡改provider kind不能切换另一原会话。 */ () =>
          combined.adapter.checkResult({ ...a.attempt, provider_kind: 'herdr' }),
        /provider_binding_mismatch/
      )
      assert.deepEqual([a.state.calls, b.state.calls], [1, 1])
      const raw = boundedJson(envelope(connection, 'heartbeat', { sequence: 0 }))
      assert.equal(combined.adapter.decode(raw, 'connector_to_gateway').type, 'heartbeat')
      assert.throws(
        /** 错epoch必须由原治理codec拒绝。 */ () =>
          combined.adapter.decode(raw.replace(connection.connection_epoch, 'other_epoch'), 'connector_to_gateway'),
        /connection_binding_mismatch/
      )
      assert.equal(combined.readiness().providers.length, 2)
    } finally {
      combined.close()
    }
  }
)

test(
  '组合层共享消息窗口，保留去重且拒绝相同ID不同载荷',
  /** 使用真实原MessageWindow。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定隔离时钟，不刷新业务期限。 */ () => 100
    )
    try {
      const first = { ...envelope(connection, 'heartbeat', { sequence: 0 }), message_id: 'shared_message' }
      assert.equal(combined.adapter.observeMessage(first, 'connector_to_gateway'), 'new')
      assert.equal(combined.adapter.observeMessage(first, 'connector_to_gateway'), 'duplicate')
      assert.throws(
        /** 跨provider复用同一消息ID但改变内容必须拒绝。 */ () =>
          combined.adapter.observeMessage({ ...first, payload: { sequence: 1 } }, 'connector_to_gateway'),
        /message_id_conflict/
      )
    } finally {
      combined.close()
    }
  }
)

test(
  '平台声明属于连接本身，组合层不得把它当成 provider 帧转给原 adapter',
  /** 两个 provider 的 stub 都会把意外帧变成失败；这里只验证治理路由。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const platformConnection: Connection = {
      ...connection,
      negotiated: { major: 2, minor: 1, capabilities: ['rpc', 'provider_fence', 'device_platform'] }
    }
    const combined = composeConnectorSessions(
      platformConnection,
      [a.descriptor, b.descriptor],
      /** 固定隔离时钟。 */ () => 100
    )
    try {
      const frame = envelope(platformConnection, 'device_platform', {
        os: 'linux',
        arch: 'x64',
        distribution: { id: 'ubuntu', version_id: '24.04' }
      })
      const raw = combined.adapter.encode(frame, 'connector_to_gateway')
      assert.deepEqual(combined.adapter.decode(raw, 'connector_to_gateway'), frame)
      assert.equal(combined.adapter.observeMessage(frame, 'connector_to_gateway'), 'new')
      // 非法平台仍由共享 codec 拒绝，不因组合层放行而降级。
      assert.throws(
        /** 非 Linux 携带发行版不是合法平台。 */ () =>
          combined.adapter.encode(
            envelope(platformConnection, 'device_platform', {
              os: 'darwin',
              arch: 'arm64',
              distribution: { id: 'ubuntu', version_id: null }
            }),
            'connector_to_gateway'
          ),
        /invalid_device_platform/
      )
      // 未协商该能力时组合层也不得接受该帧。
      const withoutCapability = composeConnectorSessions(
        { ...platformConnection, negotiated: { major: 2, minor: 1, capabilities: ['rpc', 'provider_fence'] } },
        [group('luvus').descriptor],
        /** 固定隔离时钟。 */ () => 100
      )
      try {
        assert.throws(
          /** 能力未协商时不能借组合层写入帧。 */ () => withoutCapability.adapter.encode(frame, 'connector_to_gateway'),
          /unsupported_capability/
        )
      } finally {
        withoutCapability.close()
      }
    } finally {
      combined.close()
    }
    assert.deepEqual([a.state.calls, b.state.calls], [0, 0])
  }
)

for (const side of ['connector', 'gateway'] as const) {
  test(`${side} 组合把 host_profile 作为连接帧处理，不调用 provider adapter`, () => {
    const a = group('luvus')
    const b = group('herdr')
    const active: Connection = {
      ...connection,
      negotiated: { major: 2, minor: 2, capabilities: ['rpc', 'host_profile'] }
    }
    const compose = side === 'connector' ? composeConnectorSessions : composeGatewaySessions
    const combined = compose(active, [a.descriptor, b.descriptor], () => 100)
    const frame = envelope(active, 'host_profile', {
      os: { family: 'linux', distribution: null, kernel: null },
      arch: 'x86_64',
      cpus: null,
      memory_bytes: null,
      container: 'unknown',
      agent_version: '0.6.7',
      providers: []
    })
    try {
      const raw = combined.adapter.encode(frame, 'connector_to_gateway')
      assert.deepEqual(combined.adapter.decode(raw, 'connector_to_gateway'), frame)
      assert.equal(combined.adapter.observeMessage(frame, 'connector_to_gateway'), 'new')
      assert.equal(combined.adapter.observeMessage(frame, 'connector_to_gateway'), 'duplicate')
      assert.throws(() =>
        combined.adapter.encode(
          { ...frame, payload: { ...frame.payload, env: {} } } as typeof frame,
          'connector_to_gateway'
        )
      )
      assert.throws(() => combined.adapter.encode(frame, 'gateway_to_connector'))
    } finally {
      combined.close()
    }
    assert.deepEqual([a.state.calls, b.state.calls], [0, 0])
    const old = compose(
      { ...active, negotiated: { major: 2, minor: 1, capabilities: ['rpc', 'provider_fence'] } },
      [group('luvus').descriptor],
      () => 100
    )
    try {
      assert.throws(
        () => old.adapter.encode({ ...frame, protocol_minor: 1 }, 'connector_to_gateway'),
        /unsupported_capability/
      )
    } finally {
      old.close()
    }
  })
}

test(
  'adapter失败仍逆序释放全部owner，并发和重入不重复调用原close',
  /** 故意失败只用于关闭计量。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定关闭组件的隔离时钟。 */ () => 100
    )
    b.state.failing = true
    assert.throws(/** 原adapter失败必须被观察。 */ () => combined.adapter.close(), /close_failed/)
    assert.throws(/** owner清理仍应尝试且保留原失败结果。 */ () => combined.close(), /close_failed/)
    assert.throws(/** 重复关闭不能把失败改判成功。 */ () => combined.close(), /close_failed/)
    assert.deepEqual([a.state.adapters, b.state.adapters, a.state.owners, b.state.owners], [1, 1, 1, 1])
  }
)

test(
  '共享上下文和快照字节预算不能按provider倍增，重入关闭不返回原端口结果',
  /** 只控制统计stub，无真实native资源。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定共享预算测试的可信时间。 */ () => 100
    )
    a.state.contexts = 64
    b.state.contexts = 65
    assert.throws(/** 多个provider的上下文总数超额必须拒绝。 */ () => combined.readiness(), /attempt_capacity/)
    assert.deepEqual([a.state.owners, b.state.owners], [1, 1])
    const c = group('luvus')
    const d = group('herdr')
    const bytes = composeGatewaySessions(
      connection,
      [c.descriptor, d.descriptor],
      /** 固定字节预算测试时间。 */ () => 100
    )
    c.state.bytes = 10_000_000
    d.state.bytes = 10_000_000
    assert.throws(/** 多个provider的原快照总量超额必须拒绝。 */ () => bytes.readiness(), /attempt_capacity/)
    const e = group('luvus')
    const f = group('herdr')
    const reentrant = composeGatewaySessions(
      connection,
      [e.descriptor, f.descriptor],
      /** 固定关闭重入测试时间。 */ () => 100
    )
    e.state.reenter = /** 外部回调吞掉重入错误也不能恢复组合关闭fence。 */ () => {
      try {
        reentrant.readiness()
      } catch {
        /* 外部回调吞掉重入错误也不能恢复关闭fence。 */
      }
    }
    assert.throws(/** 原端口回调重入关闭后不得继续正常返回。 */ () => reentrant.adapter.checkResult(e.attempt))
    assert.equal(reentrant.adapter.stats().closed, true)
    reentrant.close()
  }
)

test(
  '快照聚合保留稳定原getter并逐次复验，不给Herdr补造广告',
  /** 空元数据fixture不证明任何安装能力。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const original = Object.freeze([])
    let current = original
    let reads = 0
    a.session.providerSnapshot = /** 原getter显式计数，每次均重新检查来源引用。 */ () => {
      reads++
      return current
    }
    const combined = composeGatewaySessions(connection, [a.descriptor, b.descriptor], /** 固定隔离时钟。 */ () => 100)
    const first = combined.providerSnapshot!()
    assert.equal(combined.providerSnapshot!(), first)
    assert(Object.isFrozen(first))
    assert.equal(reads, 2)
    current = Object.freeze([])
    assert.throws(
      /** 同内容的新数组也不能刷新原generation或被当作稳定getter。 */ () => combined.providerSnapshot!(),
      /snapshot_changed/
    )
    combined.close()
    assert.throws(/** 关闭后不得继续调用原快照getter。 */ () => combined.providerSnapshot!(), /adapter_closed/)
    assert.equal(reads, 3)
  }
)

test(
  '路由快照构建失败仍释放已交付的全部原会话',
  /** 非可复制元数据只用于构建失败反例，没有原生执行后端。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const invalid = {
      ...a.descriptor,
      providers: [
        {
          binding: a.binding,
          target: {
            ...a.target,
            invalid: /** 配置里不可出现函数；确保structuredClone在正常校验前拒绝。 */ () => undefined
          }
        }
      ]
    }
    assert.throws(
      /** 调用方已移交所有权，构建失败也必须回收两个原owner。 */ () =>
        composeGatewaySessions(connection, [invalid, b.descriptor], /** 固定隔离时钟。 */ () => 100)
    )
    assert.deepEqual([a.state.adapters, b.state.adapters, a.state.owners, b.state.owners], [1, 1, 1, 1])
  }
)
