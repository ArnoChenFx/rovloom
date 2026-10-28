// 用真实 SQLite 和原生适配器验证重配提交后回收、跨设备分片隔离及提交失败时整体回滚。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import type { LedgerInvalidation } from '../../src/storage/model.js'
import { createLuvusWireAdapter } from '../../src/wire/native.js'
import { boundedJson } from '../../src/wire/index.js'
import type { AttemptBinding } from '../../src/wire/types.js'
import { nativeBackend } from './native-backend.js'
import { connected, management } from './helpers.js'

// 创建独立磁盘账本；测试宿主不提供 WSS 或真实凭据认证，只验证 Store 事务与 adapter 回收。
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-device-response-'))
  const path = join(root, 'ledger.sqlite')
  const state = {
    failCommit: false,
    approval: undefined as { machine: string; fence: string; confirmation: string } | undefined
  }
  const settings: StoreOptions = {
    maintenanceIntervalMs: 60_000,
    // 只对本次明确批准的设备及 generation/epoch fence 返回管理确认，其它测试管理动作仍使用隔离证明。
    management(request) {
      if (request.action !== 'device_enrollment_reset') {
        return management!(request)
      }
      const approval = state.approval
      return approval && request.target === approval.machine && request.fence === approval.fence
        ? { actor: 'synthetic_admin', confirmation_id: approval.confirmation }
        : { actor: '', confirmation_id: '' }
    },
    // 注入本库最终提交失败，验证重配整体回滚。
    fault(point) {
      if (state.failCommit && point === 'before_commit') {
        throw Error('synthetic ledger commit failure')
      }
    }
  }
  const store = new Store(path, /* 固定可信时间，避免真实时长干扰提交和身份 fence 的断言。 */ () => 100, settings)
  const primary = nativeBackend(store)
  store.defineProvider({ ...store.provider(primary.device.machine_id, 'provider')!, provider_id: 'second' })
  const sameDevice = nativeBackend(store, { device: primary.device, provider_id: 'second' })
  const otherDevice = nativeBackend(store, { device: connected(store, 'other') })
  const natives = [primary, sameDevice, otherDevice]
  const inspect = new DatabaseSync(path, { readOnly: true })
  return {
    path,
    store,
    primary,
    sameDevice,
    otherDevice,
    natives,
    state,
    inspect,
    // 为一次受保护重配登记精确管理确认；不允许其它设备或 epoch 借用。
    approve(machine: string, epoch: string | null) {
      state.approval = {
        machine,
        fence: boundedJson({ recovery_generation: store.generation(), connection_epoch: epoch }),
        confirmation: randomUUID()
      }
    },
    // 关闭本测试创建的适配器和全部 SQLite 连接，再删除隔离目录。
    close() {
      for (const native of natives) {
        native.adapter.close()
      }
      store.close()
      inspect.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

// 用原已派发的绑定生成实际请求帧，验证旧业务在进入 native permit 构造前就被受保护身份门禁拒绝。
function requestFrame(binding: AttemptBinding) {
  const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
  return {
    protocol_major: 2 as const,
    protocol_minor: 0,
    message_id: 'old_request',
    machine_id,
    recovery_generation,
    connection_epoch,
    type: 'request' as const,
    payload: {
      attempt,
      expected_binding_revision: 1,
      native_request: { method: 'task.add', params: { title: 'synthetic' } },
      validation: 'strict' as const
    }
  }
}

test(
  '重配仅在 COMMIT 后失效同设备全部 provider、已完成/未知/仅响应上下文',
  // 独立观察连接在通知时必须已看见 pending；其它设备仍能完成原在途传输。
  () => {
    const f = fixture()
    const events: LedgerInvalidation[] = []
    const observed: unknown[] = []
    try {
      const execution = f.primary.create()
      const binding = f.primary.dispatch(execution.call_id)
      const sealed = f.primary.create()
      f.primary.dispatch(sealed.call_id)
      f.store.discardResponse('synthetic', sealed.call_id)
      const responded = f.primary.create()
      const respondedBinding = f.primary.dispatch(responded.call_id)
      f.primary.respond(respondedBinding)
      const unknown = f.primary.create()
      f.primary.dispatch(unknown.call_id)
      f.store.stop('synthetic', unknown.call_id)
      const pending = f.primary.create()
      const second = f.sameDevice.create()
      f.sameDevice.dispatch(second.call_id)
      f.store.discardResponse('synthetic', second.call_id)
      const unrelated = f.otherDevice.create()
      const unrelatedBinding = f.otherDevice.dispatch(unrelated.call_id)
      const originalEvidence = f.inspect
        .prepare('SELECT response_hash FROM calls WHERE call_id=?')
        .get(responded.call_id)
      const otherBefore = f.otherDevice.adapter.stats()
      f.store.subscribeInvalidation(
        // 只记录观察值，断言放回调外，避免监听异常被 Store 隔离后导致测试假通过。
        (event) => {
          events.push(event)
          observed.push({
            ...f.inspect
              .prepare('SELECT status,epoch FROM machines WHERE machine_id=?')
              .get(f.primary.device.machine_id)
          })
        }
      )
      f.approve(f.primary.device.machine_id, binding.connection_epoch)
      assert.equal(events.length, 0)
      f.store.resetDeviceEnrollment(f.primary.device.machine_id, f.store.generation(), binding.connection_epoch)
      assert.deepEqual(events, [{ kind: 'device_fence', machine_id: f.primary.device.machine_id }])
      assert.deepEqual(observed, [{ status: 'pending', epoch: null }])
      for (const native of [f.primary, f.sameDevice]) {
        assert.equal(native.adapter.stats().executions, 0)
        assert.equal(native.adapter.stats().responses, 0)
        assert.equal(native.adapter.stats().snapshot_bytes, 0)
      }
      assert.deepEqual(f.otherDevice.adapter.stats(), otherBefore)
      assert.equal(f.store.call('synthetic', execution.call_id).state, 'outcome_unknown')
      assert.equal(f.store.call('synthetic', pending.call_id).state, 'not_dispatched')
      assert.equal(f.store.call('synthetic', responded.call_id).state, 'responded')
      assert.deepEqual(
        f.inspect.prepare('SELECT response_hash FROM calls WHERE call_id=?').get(responded.call_id),
        originalEvidence
      )
      assert.equal(f.store.call('synthetic', unrelated.call_id).state, 'dispatching')
      assert.equal(f.primary.state.sends, 4)
      assert.equal(f.sameDevice.state.sends, 1)
      f.otherDevice.respond(unrelatedBinding)
      assert.throws(
        // 即使是原绑定上的可靠响应，也不能在重配后重新建立旧上下文。
        () => f.primary.respond(binding),
        /stale_response/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '设备没有任何调用行时，重配仍发布设备 fence',
  // 回收通知不能依赖 SELECT call_id 有结果。
  () => {
    const f = fixture()
    try {
      const events: LedgerInvalidation[] = []
      f.store.subscribeInvalidation(/* 保存本次重配发布的实际内部事件。 */ (event) => events.push(event))
      f.approve(f.primary.device.machine_id, f.primary.device.epoch)
      f.store.resetDeviceEnrollment(f.primary.device.machine_id, f.store.generation(), f.primary.device.epoch)
      assert.deepEqual(events, [{ kind: 'device_fence', machine_id: f.primary.device.machine_id }])
    } finally {
      f.close()
    }
  }
)

test(
  '重配的本库提交失败时整体回滚：不发 fence、不关闭上下文，恢复 active 后原连接仍有效',
  /** 单事务没有外部阻断需要保留，失败后一切如初。 */ () => {
    const f = fixture()
    try {
      const call = f.primary.create()
      const binding = f.primary.dispatch(call.call_id)
      const beforeMachine = f.inspect
        .prepare('SELECT * FROM machines WHERE machine_id=?')
        .get(f.primary.device.machine_id)
      const beforeCall = f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id)
      const events: LedgerInvalidation[] = []
      f.store.subscribeInvalidation(/** 回滚不得发布假报已完成重配的 Store 通知。 */ (event) => events.push(event))
      f.approve(f.primary.device.machine_id, f.primary.device.epoch)
      f.state.failCommit = true
      assert.throws(
        () => f.store.resetDeviceEnrollment(f.primary.device.machine_id, f.store.generation(), f.primary.device.epoch),
        /storage_degraded/
      )
      assert.deepEqual(
        f.inspect.prepare('SELECT * FROM machines WHERE machine_id=?').get(f.primary.device.machine_id),
        beforeMachine
      )
      assert.deepEqual(f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id), beforeCall)
      assert.deepEqual(events, [])
      f.state.failCommit = false
      f.store.resumeStorage()
      assert.equal(f.store.health().mode, 'active')
      f.store.assertConnection(binding)
      assert.equal(f.primary.state.sends, 1)
    } finally {
      f.close()
    }
  }
)

test(
  '离线 null epoch 重配会销毁该设备残留的旧 epoch 上下文，不影响其它设备',
  // 用真实提交先离线，再刻意从仅 Store 断连通知中隔离一个 adapter，覆盖设备级 fence 对旧状态的完整作用域。
  () => {
    const f = fixture()
    let detached: ReturnType<typeof createLuvusWireAdapter> | undefined
    try {
      let forward = false
      const backend = {
        ...f.primary.backend,
        // 仅故障注入漏掉断连通知，重配时重新转发真实 Store 事件到 adapter 自己的失效处理。
        subscribeInvalidation(listener: (event: LedgerInvalidation) => void) {
          return f.store.subscribeInvalidation(
            // 漏通知阶段不替 adapter 手动清状态；后续必须靠设备 fence 的真实处理完成回收。
            (event) => {
              if (forward) {
                listener(event)
              }
            }
          )
        }
      }
      detached = createLuvusWireAdapter(backend)
      const call = f.primary.create()
      const binding = f.primary.dispatch(call.call_id)
      detached.encode(requestFrame(binding), 'gateway_to_connector')
      assert.equal(detached.stats().executions, 1)
      f.store.disconnect(f.primary.device.machine_id, f.primary.device.epoch)
      assert.equal(detached.stats().executions, 1)
      forward = true
      f.approve(f.primary.device.machine_id, null)
      f.store.resetDeviceEnrollment(f.primary.device.machine_id, f.store.generation(), null)
      assert.equal(detached.stats().executions, 0)
      assert.equal(f.otherDevice.adapter.stats().closed, false)
    } finally {
      detached?.close()
      f.close()
    }
  }
)

for (const failure of ['management', 'epoch'] as const) {
  test(
    `重配在 ${failure} 阶段拒绝时不发布 fence 或销毁仍有效的上下文`,
    // 管理或 fence 失败都在状态变化前拒绝，不能误清原上下文。
    () => {
      const f = fixture()
      try {
        const call = f.primary.create()
        f.primary.dispatch(call.call_id)
        const sealed = f.sameDevice.create()
        f.sameDevice.dispatch(sealed.call_id)
        f.store.discardResponse('synthetic', sealed.call_id)
        const before = f.natives.map(
          /* 保存各 adapter 的真实正文和元数据计量供回滚后核对。 */ (native) => native.adapter.stats()
        )
        const events: LedgerInvalidation[] = []
        f.store.subscribeInvalidation(/* 记录真实提交后通知，拒绝路径应保持为空。 */ (event) => events.push(event))
        if (failure !== 'management') {
          f.approve(f.primary.device.machine_id, f.primary.device.epoch)
        }
        assert.throws(
          // 旧 epoch 或管理未授权在任何状态变化前拒绝。
          () =>
            f.store.resetDeviceEnrollment(
              f.primary.device.machine_id,
              f.store.generation(),
              failure === 'epoch' ? 'epoch_stale' : f.primary.device.epoch
            ),
          failure === 'management' ? /management_authorization_required/ : /device_epoch_mismatch/
        )
        assert.deepEqual(events, [])
        assert.deepEqual(
          f.natives.map(
            /* 从运行中的 adapter 重新读取计量，不能用预先缓存值冒充未回收。 */ (native) => native.adapter.stats()
          ),
          before
        )
        assert.equal(f.store.health().mode, 'active')
      } finally {
        f.close()
      }
    }
  )
}
