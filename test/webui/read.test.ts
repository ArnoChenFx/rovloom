/** 使用同一共享管理 DTO 验证消费层；fixture 通过不等于真实管理后端或授权完成。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagementPageRead, type ManagementReadTransport } from '../../src/webui/read.js'
import { ReadError } from '../../src/webui/reader.js'
import { fixtureReply, fixtureSnapshot, fixtureDevice } from './fixtures.js'
import { checkPage } from '../../src/webui/validate.js'

const listRoute = { machineId: null, cursor: null, providerCursor: null }
const detailRoute = { machineId: 'fixture-a', cursor: null, providerCursor: null }

test(
  '前后状态取较早观测时间，后续旧观测不能被新读取续期',
  /** 即便全局 fence 未变，也保留读取前后状态中较早的观测年龄。 */
  async () => {
    let statuses = 0
    const read = createManagementPageRead(
      /** 第二个状态保持同一代次，但来自一分钟前的观测。 */
      async (name, args) => {
        const reply = fixtureReply(name, args)
        if (name === 'status' && ++statuses === 2) {
          Object.assign(reply, { observed_at: fixtureSnapshot(listRoute).serverTime - 60_000 })
        }
        return reply
      }
    )
    const result = await read(listRoute, new AbortController().signal)
    assert.equal(result.observedAt, result.serverTime - 60_000)
    checkPage(result, listRoute)
  }
)

// 消费操作必须只使用既有共享名和参数，不能从页面注入管理身份。
test(
  '只读取共享操作，列表页有界且不续 scope',
  /* 消费操作必须只使用既有共享名和参数，不能从页面注入管理身份。 */ async () => {
    const calls: { name: string; args: unknown }[] = []
    /** 记录操作与参数，验证读取端不会注入管理员身份。 */
    const transport: ManagementReadTransport = async (name, args) => {
      calls.push({ name, args })
      return fixtureReply(name, args)
    }
    const result = await createManagementPageRead(transport)(
      { ...listRoute, cursor: 'fixture-cursor' },
      new AbortController().signal
    )
    assert.deepEqual(calls, [
      { name: 'status', args: {} },
      { name: 'devices_list', args: { limit: 50, cursor: 'fixture-cursor' } },
      { name: 'status', args: {} }
    ])
    assert.equal(result.value.devices.items.length, 2)
    assert.equal(result.sessionExpiresAt, null)
    checkPage(result, listRoute)
  }
)

// 详情包含 provider 和短期权限提示，读取前后设备 fence 必须一致。
test(
  '设备详情复用共享 DTO，provider 与权限隔离',
  /* 详情包含 provider 和短期权限提示，读取前后设备 fence 必须一致。 */ async () => {
    const calls: string[] = []
    const read = createManagementPageRead(
      /** 记录固定共享操作，不提供 AdminContext 或身份参数。 */
      async (name, args) => {
        calls.push(name)
        return fixtureReply(name, args)
      }
    )
    const result = await read(detailRoute, new AbortController().signal)
    assert.deepEqual(calls, ['status', 'devices_get', 'providers_list', 'permissions_get', 'devices_get', 'status'])
    assert.equal(result.value.device?.machine_id, 'fixture-a')
    assert.equal(result.value.providers.items[1]?.runtime.verification, 'verified')
    checkPage(result, detailRoute)
  }
)

// Provider 403/503 可部分失败，401 等会话错误必须整页向上传递。
for (const problem of ['forbidden', 'not_found', 'unavailable', 'unauthenticated'] as const) {
  test(
    `provider ${problem} 不伪装设备离线或授权成功`,
    /* 验证 `provider ${problem} 不伪装设备离线或授权成功` 的读取与展示边界。 */ async () => {
      const read = createManagementPageRead(
        /** 仅 provider 读取失败。 */
        async (name, args) => {
          if (name === 'providers_list') {
            throw new ReadError(problem)
          }
          return fixtureReply(name, args)
        }
      )
      if (problem === 'unauthenticated') {
        await assert.rejects(read(detailRoute, new AbortController().signal), { problem })
      } else {
        const result = await read(detailRoute, new AbortController().signal)
        assert.equal(result.value.device?.persisted_state, 'online')
        assert.equal(result.value.providersProblem, problem === 'not_found' ? 'forbidden' : problem)
        assert.deepEqual(result.value.providers.items, [])
      }
    }
  )
}

// 全局恢复代次、策略、history/mode 中任一 fence 变化都会拒绝混合快照。
for (const field of ['recovery_generation', 'policy_revision', 'history', 'mode'] as const) {
  test(
    `${field} 变化拒绝页面拼接`,
    /* 验证 `${field} 变化拒绝页面拼接` 的读取与展示边界。 */ async () => {
      let statuses = 0
      const read = createManagementPageRead(
        /** 第二个 status 故意改变一项全局 fence。 */
        async (name, args) => {
          const result = fixtureReply(name, args)
          if (name === 'status' && ++statuses === 2) {
            Object.assign(result, {
              [field]:
                field === 'history'
                  ? { history_epoch: 'changed', accept_new_until: 1 }
                  : field === 'mode'
                    ? 'storage_degraded'
                    : 'changed'
            })
          }
          return result
        }
      )
      await assert.rejects(read(detailRoute, new AbortController().signal), { problem: 'conflict' })
    }
  )
}

// 设备再次认证产生新 epoch，或资源 revision 更新，都不能复用旧详情。
test(
  '设备 epoch/revision 变化及读取取消不会继续消费旧页',
  /* 设备再次认证产生新 epoch，或资源 revision 更新，都不能复用旧详情。 */ async () => {
    for (const fence of ['epoch', 'revision'] as const) {
      let devices = 0
      const read = createManagementPageRead(
        /** 第二次设备读取改变独立 epoch 或资源 revision。 */
        async (name, args) => {
          const result = fixtureReply(name, args)
          if (name === 'devices_get' && ++devices === 2) {
            const changed = fixtureDevice('fixture-a')
            if (fence === 'revision') {
              changed.resource_revision = 4
            } else if (changed.connection.verification === 'verified') {
              changed.connection.value.connection_epoch_ref = 'changed-epoch'
            }
            Object.assign(result, changed)
          }
          return result
        }
      )
      await assert.rejects(read(detailRoute, new AbortController().signal), { problem: 'conflict' })
    }
    const abort = new AbortController()
    let calls = 0
    const cancelled = createManagementPageRead(
      /** 第一次 status 后取消，后续操作必须停止。 */
      async (name, args) => {
        calls++
        abort.abort()
        return fixtureReply(name, args)
      }
    )
    await assert.rejects(cancelled(listRoute, abort.signal))
    assert.equal(calls, 1)
  }
)

// 空页/详情/部分失败投影互斥，未来心跳及子观测不能制造新鲜状态。
test(
  '拒绝详情夹带列表、部分失败夹带行或游标和未来子观测',
  /* 空页/详情/部分失败投影互斥，未来心跳及子观测不能制造新鲜状态。 */ () => {
    for (const scenario of [
      'detail_list',
      'detail_cursor',
      'partial_rows',
      'partial_cursor',
      'device_time',
      'heartbeat_time',
      'provider_time',
      'permission_time'
    ] as const) {
      const snapshot = fixtureSnapshot(detailRoute)
      if (scenario === 'detail_list') {
        snapshot.value.devices.items = [fixtureDevice('fixture-b')]
      }
      if (scenario === 'detail_cursor') {
        snapshot.value.devices.next_cursor = 'unrelated-page'
      }
      if (scenario === 'partial_rows') {
        snapshot.value.providersProblem = 'forbidden'
      }
      if (scenario === 'partial_cursor') {
        snapshot.value.providersProblem = 'unavailable'
        snapshot.value.providers = { items: [], next_cursor: 'unavailable-page' }
      }
      if (scenario === 'device_time') {
        snapshot.value.device!.observed_at = snapshot.serverTime + 1
      }
      if (scenario === 'heartbeat_time' && snapshot.value.device!.connection.verification === 'verified') {
        snapshot.value.device!.connection.value.last_heartbeat_at = snapshot.serverTime + 1
      }
      if (scenario === 'provider_time' && snapshot.value.providers.items[0]!.runtime.verification === 'verified') {
        snapshot.value.providers.items[0]!.runtime.observed_at = snapshot.serverTime + 1
      }
      if (scenario === 'permission_time') {
        snapshot.value.permissions!.observed_at = snapshot.serverTime + 1
      }
      assert.throws(
        /** 每个不一致组合都只能返回固定失败分类。 */
        () => checkPage(snapshot, detailRoute),
        { problem: 'invalid_response' }
      )
    }
  }
)

// 未核实状态必须原样保留，不能由 persisted online 推导认证或 ready。
test(
  'unverified 保留未知，校验后脱离源对象可变引用',
  /* 未核实状态必须原样保留，不能由 persisted online 推导认证或 ready。 */ () => {
    const snapshot = fixtureSnapshot(detailRoute)
    snapshot.value.device!.connection = { verification: 'unverified', reason_code: 'not_recorded' }
    snapshot.value.device!.authentication = { verification: 'unverified', reason_code: 'backend_unavailable' }
    const result = checkPage(snapshot, detailRoute)
    snapshot.value.device!.name = 'changed after read'
    assert.notEqual(result.value.device!.name, 'changed after read')
    assert.equal(result.value.device!.connection.verification, 'unverified')
  }
)

// 未知字段、超限、越机器和错误分支不能进入普通页面快照。
test(
  '拒绝秘密附加字段、超限列表、跨机器和非法状态',
  /* 未知字段、超限、越机器和错误分支不能进入普通页面快照。 */ () => {
    for (const scenario of ['secret', 'oversize', 'wrong_machine', 'invalid_auth', 'future_time', 'scope'] as const) {
      const snapshot = fixtureSnapshot(detailRoute)
      if (scenario === 'secret') {
        Object.assign(snapshot.value.device!, { enrollment_secret: 'fixture-secret-must-not-leak' })
      }
      if (scenario === 'oversize') {
        snapshot.value.devices.items = Array.from(
          { length: 201 },
          /** 重复合成行用于验证列表硬上限。 */
          () => snapshot.value.device!
        )
      }
      if (scenario === 'wrong_machine') {
        snapshot.value.providers.items[0]!.machine_id = 'fixture-b'
      }
      if (scenario === 'invalid_auth') {
        Object.assign(snapshot.value.device!.authentication, { value: { state: 'ready' } })
      }
      if (scenario === 'future_time') {
        snapshot.serverTime = Infinity
      }
      if (scenario === 'scope') {
        snapshot.value.permissions!.target.machine_id = 'fixture-b'
      }
      assert.throws(
        /** 非法 DTO 必须只返回固定错误分类。 */
        () => checkPage(snapshot, detailRoute),
        { problem: 'invalid_response', message: 'invalid_response' }
      )
    }
  }
)

test(
  '设备可读但权限提示404时保持详情，设备复核404仍清空整页',
  /** permissions_read 缺失不能撤回已有 devices_read；设备授权再次核对。 */ async () => {
    let deviceReads = 0
    let revoked = false
    const read = createManagementPageRead(
      /** 权限提示不可见与设备授权失效分别来自独立共享读取。 */
      async (name, args) => {
        if (name === 'permissions_get') {
          throw new ReadError('not_found')
        }
        if (name === 'devices_get' && ++deviceReads % 2 === 0 && revoked) {
          throw new ReadError('not_found')
        }
        return fixtureReply(name, args)
      }
    )
    const page = await read(detailRoute, new AbortController().signal)
    assert.equal(page.value.device?.machine_id, 'fixture-a')
    assert.equal(page.value.permissions, null)
    revoked = true
    await assert.rejects(read(detailRoute, new AbortController().signal), { problem: 'not_found' })
  }
)

// 调用页只在调用路由读取窗口；其它页面不夹带调用数据，部分失败只标记该区块。
test(
  '调用页按路由读取窗口，部分失败不清空设备列表',
  /** 调用读取与设备列表同属全局范围；401 仍整页失败。 */ async () => {
    const callsRoute = { ...listRoute, section: 'calls' as const }
    const seen: string[] = []
    const read = createManagementPageRead(
      /** 记录固定操作，验证不会从浏览器注入设备或身份。 */
      async (name, args) => {
        seen.push(name)
        return fixtureReply(name, args)
      }
    )
    const result = await read(callsRoute, new AbortController().signal)
    assert.deepEqual(seen, ['status', 'devices_list', 'calls_list', 'status'])
    assert.equal(result.value.calls?.aggregate.total, 3)
    assert.equal(result.value.devices.items.length, 2)
    checkPage(result, callsRoute)

    const overview = await read(listRoute, new AbortController().signal)
    assert.equal(overview.value.calls, null)
    assert.equal(overview.value.callsProblem, null)

    const partial = createManagementPageRead(
      /** 调用窗口不可见时设备列表仍然交付。 */
      async (name, args) => {
        if (name === 'calls_list') {
          throw new ReadError('forbidden')
        }
        return fixtureReply(name, args)
      }
    )
    const degraded = await partial(callsRoute, new AbortController().signal)
    assert.equal(degraded.value.callsProblem, 'forbidden')
    assert.equal(degraded.value.calls, null)
    assert.equal(degraded.value.devices.items.length, 2)
    checkPage(degraded, callsRoute)

    const revoked = createManagementPageRead(
      /** 会话失效必须清空整页，而不是只标记调用区块。 */
      async (name, args) => {
        if (name === 'calls_list') {
          throw new ReadError('unauthenticated')
        }
        return fixtureReply(name, args)
      }
    )
    await assert.rejects(revoked(callsRoute, new AbortController().signal), { problem: 'unauthenticated' })
  }
)

test(
  '调用窗口游标与采样时点必须落在同一页面 fence 内',
  /** 过期或跨代次的调用采样不能与新的全局状态混拼。 */ async () => {
    const callsRoute = { ...listRoute, section: 'calls' as const, callsCursor: 'fixture-cursor' }
    const seen: unknown[] = []
    let statuses = 0
    const read = createManagementPageRead(
      /** 调用窗口采样早于读取前状态时拒绝整页。 */
      async (name, args) => {
        const reply = fixtureReply(name, args)
        if (name === 'calls_list') {
          seen.push(args)
          Object.assign(reply, { observed_at: fixtureSnapshot(listRoute).serverTime - 30_000 })
        }
        if (name === 'status' && ++statuses === 2) {
          Object.assign(reply, { observed_at: fixtureSnapshot(listRoute).serverTime })
        }
        return reply
      }
    )
    await assert.rejects(read(callsRoute, new AbortController().signal), { problem: 'conflict' })
    assert.deepEqual(seen, [{ limit: 50, cursor: 'fixture-cursor' }])
  }
)

// 调用校验拒绝秘密字段、跨设备与未知状态，合法页可被深拷贝。
test(
  '调用视图拒绝未知状态、秘密字段与非法窗口',
  /** 共享白名单同时约束服务输出与浏览器输入。 */ () => {
    const callsRoute = { ...listRoute, section: 'calls' as const }
    const snapshot = fixtureSnapshot(callsRoute)
    const valid = checkPage(snapshot, callsRoute)
    snapshot.value.calls!.items[0]!.method = 'changed after read'
    assert.notEqual(valid.value.calls!.items[0]!.method, 'changed after read')

    for (const scenario of ['secret', 'state', 'window', 'time', 'partial'] as const) {
      const copy = fixtureSnapshot(callsRoute)
      const calls = copy.value.calls!
      if (scenario === 'secret') {
        Object.assign(calls.items[0]!, { request_json: 'fixture-secret-must-not-leak' })
      }
      if (scenario === 'state') {
        calls.items[0]!.state = 'ready' as never
      }
      if (scenario === 'window') {
        calls.window.last_at = copy.serverTime + 1
      }
      if (scenario === 'time') {
        calls.items[0]!.created_at = copy.serverTime + 1
      }
      if (scenario === 'partial') {
        // 同时存在调用数据与部分失败标记是自相矛盾的。
        copy.value.callsProblem = 'unavailable'
      }
      assert.throws(
        /** 每个非法组合都只返回固定分类。 */
        () => checkPage(copy, callsRoute),
        { problem: 'invalid_response' }
      )
    }
    // 非调用路由不得夹带调用窗口。
    const smuggled = fixtureSnapshot(callsRoute)
    assert.throws(
      /** 概览不能携带调用数据。 */
      () => checkPage(smuggled, listRoute),
      { problem: 'invalid_response' }
    )
  }
)

test(
  '空调用窗口允许零采样并保持统计为零',
  /** 空窗口是合法状态，不能因为 sampled=0 被判为非法响应。 */ () => {
    const callsRoute = { ...listRoute, section: 'calls' as const }
    const snapshot = fixtureSnapshot(callsRoute)
    snapshot.value.calls = {
      items: [],
      observed_at: snapshot.serverTime,
      aggregate: { total: 0, by_state: [], by_provider: [], by_principal: [], by_method: [] },
      window: { since: snapshot.serverTime - 86_400_000, first_at: null, last_at: null, sampled: 0, truncated: false }
    }
    const checked = checkPage(snapshot, callsRoute)
    assert.equal(checked.value.calls?.window.sampled, 0)
    assert.equal(checked.value.calls?.aggregate.total, 0)
  }
)
