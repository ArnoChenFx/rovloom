// 断连观测只保留固定原因词与有界关闭码；对端正文、路径、凭据和不可信 getter 一律不进入输出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundedDisconnect, DisconnectLog, remoteDisconnect } from '../../src/transport/disconnect.js'
import type { DisconnectObservation } from '../../src/transport/disconnect.js'

const secret = 'SYNTHETIC_SECRET token=/etc/passwd 你好'

test('对端关闭事件只保留白名单原因与有界关闭码', () => {
  // 与 Gateway 实际发送的 1008 transport_closed 一致。
  assert.deepEqual(remoteDisconnect({ code: 1008, reason: 'transport_closed', wasClean: true }), {
    code: 1008,
    reason: 'transport_closed'
  })
  assert.deepEqual(remoteDisconnect({ code: 1000, reason: 'transport_closed' }), {
    code: 1000,
    reason: 'transport_closed'
  })
  // 无关闭帧（TCP 被掐/terminate）按异常关闭 1006 定性。
  assert.deepEqual(remoteDisconnect({ code: 1006, reason: '', wasClean: false }), {
    code: 1006,
    reason: 'transport_abnormal'
  })
  // 有码但原因未命中白名单时只保留数值码，任意文本被丢弃。
  assert.deepEqual(remoteDisconnect({ code: 1008, reason: secret }), { code: 1008, reason: 'transport_unclassified' })
  assert.deepEqual(remoteDisconnect({ code: 1011, reason: '' }), { code: 1011, reason: 'transport_unclassified' })
  // 白名单原因命中但关闭码不可信时只保留原因，不伪造未实际观察到的码。
  for (const code of ['1008', 999, 5000, 1008.5, null, undefined]) {
    const observed = remoteDisconnect({ code, reason: 'transport_closed' })
    assert.deepEqual(observed, { reason: 'transport_closed' })
    assert.equal(Object.hasOwn(observed, 'code'), false)
  }
  // 原因不是字符串时按未命中白名单处理，只保留可信的有界关闭码。
  assert.deepEqual(remoteDisconnect({ code: 1008, reason: 42 }), { code: 1008, reason: 'transport_unclassified' })
  // 完全没有事件对象时按未收到关闭帧定性，绝不读取任意值的属性。
  for (const event of [null, undefined, 'close', 42, true]) {
    const observed = remoteDisconnect(event)
    assert.deepEqual(observed, { reason: 'transport_abnormal' })
    assert.equal(JSON.stringify(observed).includes(secret), false)
  }
})

test('不可信关闭事件字段的 getter 不泄漏原文也不中断观测', () => {
  const hostile = Object.defineProperties(
    {},
    {
      code: {
        // 宿主事件对象的嵌套 getter 不可信，异常原文不得穿透观测端口。
        get() {
          throw new Error(secret)
        }
      },
      reason: {
        // 第二个 getter 同样不应被调用。
        get() {
          throw new Error(secret)
        }
      }
    }
  )
  const observed = remoteDisconnect(hostile)
  assert.deepEqual(observed, { reason: 'transport_abnormal' })
  assert.equal(JSON.stringify(observed).includes('SYNTHETIC_SECRET'), false)
  assert.deepEqual(boundedDisconnect(hostile), undefined)
})

test('status 交付的断开观测二次复核：原因必须在固定词表内且码有界', () => {
  assert.deepEqual(boundedDisconnect({ code: 1008, reason: 'transport_closed' }), {
    code: 1008,
    reason: 'transport_closed'
  })
  assert.deepEqual(boundedDisconnect({ reason: 'handshake_timeout' }), { reason: 'handshake_timeout' })
  assert.deepEqual(boundedDisconnect({ code: 1006, reason: 'transport_idle' }), {
    code: 1006,
    reason: 'transport_idle'
  })
  for (const value of [
    { code: 1008, reason: secret },
    { code: 1008, reason: 'TRANSPORT_CLOSED' },
    { code: '1008', reason: 'transport_closed' },
    { code: -1, reason: 'transport_closed' },
    { code: 1e9, reason: 'transport_closed' },
    { code: 1008 },
    { reason: 42 },
    {},
    null,
    'transport_closed',
    42
  ]) {
    assert.equal(boundedDisconnect(value), undefined)
  }
  // 白名单内的每个固定原因都可交付，避免新增原因被静默丢弃。
  for (const reason of [
    'transport_closed',
    'transport_abnormal',
    'transport_unavailable',
    'handshake_timeout',
    'transport_idle',
    'connector_failure',
    'connector_disconnected',
    'connector_stopped',
    'transport_unclassified'
  ]) {
    assert.deepEqual(boundedDisconnect({ reason }), { reason })
  }
})

test('断开记录只增计数，远端纠正只订正最新一条且不重复计数', () => {
  const log = new DisconnectLog()
  assert.deepEqual(log.snapshot(), { disconnects: 0, disconnect_recent: [] })
  // 本机收敛先记一次未知原因。
  log.record({ reason: 'transport_unavailable' })
  assert.deepEqual(log.snapshot(), { disconnects: 1, disconnect_recent: [{ reason: 'transport_unavailable' }] })
  // 远端实际观察订正队列里最新一条：计数不变。
  log.refine({ code: 1006, reason: 'transport_abnormal' })
  assert.deepEqual(log.snapshot(), {
    disconnects: 1,
    disconnect_recent: [{ code: 1006, reason: 'transport_abnormal' }]
  })
  // 下一次独立断开才推进计数，并保留更早一条（不再被覆盖）。
  log.record({ code: 1008, reason: 'transport_closed' })
  assert.deepEqual(log.snapshot(), {
    disconnects: 2,
    disconnect_recent: [
      { code: 1006, reason: 'transport_abnormal' },
      { code: 1008, reason: 'transport_closed' }
    ]
  })
  // 再次订正只改最新一条，更早那条保持原值。
  log.refine({ code: 1006, reason: 'transport_unclassified' })
  assert.deepEqual(log.snapshot(), {
    disconnects: 2,
    disconnect_recent: [
      { code: 1006, reason: 'transport_abnormal' },
      { code: 1006, reason: 'transport_unclassified' }
    ]
  })
})

test('未记录时纠正不生效，也不能凭空产生断连计数', () => {
  const log = new DisconnectLog()
  log.refine({ code: 1006, reason: 'transport_abnormal' })
  assert.deepEqual(log.snapshot(), { disconnects: 0, disconnect_recent: [] })
})

test('记录入口本身也不放行非白名单观测', () => {
  const log = new DisconnectLog()
  // 计数仍推进，但不可交付的观测不会出现在队列里，避免原文外泄。
  log.record({ reason: secret } as never)
  assert.deepEqual(log.snapshot(), { disconnects: 1, disconnect_recent: [] })
})

test('队列上限 16：超出只保留最新 16 条，计数仍准确', () => {
  const log = new DisconnectLog()
  assert.equal(DisconnectLog.QUEUE, 16)
  // 记录 20 条，按 code 区分先后：1000+i。
  for (let index = 0; index < 20; index++) {
    log.record({ code: 1000 + index, reason: 'transport_unclassified' })
  }
  const snapshot = log.snapshot()
  // 计数完整记录全部 20 次，队列只留最新 16 条（1004..1019），顺序从旧到新。
  assert.equal(snapshot.disconnects, 20)
  assert.equal(snapshot.disconnect_recent.length, 16)
  assert.deepEqual(
    snapshot.disconnect_recent.map(/** 只取码用于验证先后顺序。 */ (entry) => entry.code),
    Array.from({ length: 16 }, (_, index) => 1004 + index)
  )
  // 订正只作用于最新那条，不动计数。
  log.refine({ code: 1006, reason: 'transport_abnormal' })
  const refined = log.snapshot()
  assert.equal(refined.disconnects, 20)
  assert.deepEqual(refined.disconnect_recent.at(-1), { code: 1006, reason: 'transport_abnormal' })
  assert.deepEqual(refined.disconnect_recent[0], { code: 1004, reason: 'transport_unclassified' })
})

test('队列交付是只读快照，调用方修改不影响内部记录', () => {
  const log = new DisconnectLog()
  log.record({ code: 1008, reason: 'transport_closed' })
  const snapshot = log.snapshot()
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.disconnect_recent), true)
  assert.throws(
    /** 冻结数组拒绝原地修改，避免观测端口被外部回写。 */
    () => (snapshot.disconnect_recent as DisconnectObservation[]).push({ reason: 'transport_abnormal' })
  )
  assert.deepEqual(log.snapshot(), { disconnects: 1, disconnect_recent: [{ code: 1008, reason: 'transport_closed' }] })
})
