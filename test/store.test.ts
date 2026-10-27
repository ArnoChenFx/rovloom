// 验证 v5 设备配对、provider 调用幂等、连接栅栏和磁盘恢复，保留原生错误及失败关闭规则。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { canonical, validateRequest, validateTarget } from '../src/contracts.js'
import type { Target } from '../src/contracts.js'
import { connected, management, options, respond } from './storage/helpers.js'

test(
  'normalized names remain unique; rename preserves ID; IDs are not reused',
  /* 验证名称归一化后唯一、改名保留 ID，且新注册不复用旧身份。 */ () => {
    const s = new Store(':memory:')
    try {
      const m = s.register(' Linux ')
      assert.equal(m.name, 'linux')
      assert.throws(/* 以不同大小写再次注册同名机器，要求唯一性约束拒绝。 */ () => s.register('LINUX'))
      assert.equal(s.rename(m.machine_id, 'mac').machine_id, m.machine_id)
      assert.notEqual(s.register('linux').machine_id, m.machine_id)
      assert.throws(/* 使用含路径片段的机器名称，要求名称校验拒绝。 */ () => s.register('../escape'), /invalid_name/)
    } finally {
      s.close()
    }
  }
)
test(
  'enrollment expiration, one-time consumption and sibling-token invalidation',
  /* 验证配对码到期、单次兑换及同机其他码随首次兑换失效。 */ () => {
    let time = 100
    const s = new Store(':memory:', /* 提供可推进时钟，准确测试配对码到期。 */ () => time)
    try {
      const m = s.register('a')
      const expired = s.issueEnrollment(m.machine_id, 1)
      time++
      assert.throws(/* 兑换已到期配对码，要求拒绝。 */ () => s.redeem(expired), /invalid_enrollment/)
      const first = s.issueEnrollment(m.machine_id)
      const sibling = s.issueEnrollment(m.machine_id)
      s.redeem(first)
      assert.throws(/* 再次兑换已消费配对码，要求拒绝。 */ () => s.redeem(first), /invalid_enrollment/)
      assert.throws(
        /* 兑换被兄弟码消费操作一并失效的配对码，要求拒绝。 */ () => s.redeem(sibling),
        /invalid_enrollment/
      )
      assert.throws(
        /* 为已配对设备再签发配对码，要求状态校验拒绝。 */ () => s.issueEnrollment(m.machine_id),
        /invalid_machine_state/
      )
    } finally {
      s.close()
    }
  }
)
test(
  'identity authenticates credentials, rejects clones, fences old disconnect',
  /* 验证凭据认证、重复连接拒绝与旧 epoch 断线不能覆盖新连接。 */ () => {
    const s = new Store(':memory:', Date.now, { management })
    try {
      const d = connected(s)
      assert.throws(
        /* 使用错误凭据连接设备，要求认证失败。 */ () => s.connect(d.machine_id, 'wrong'),
        /invalid_device_credential/
      )
      assert.throws(
        /* 为已在线设备重复建立连接，要求拒绝。 */ () => s.connect(d.machine_id, d.credential),
        /duplicate_device_connection/
      )
      s.disconnect(d.machine_id, d.epoch)
      const next = s.connect(d.machine_id, d.credential)
      assert.notEqual(next, d.epoch)
      s.disconnect(d.machine_id, d.epoch)
      assert.equal(s.machine(d.machine_id).status, 'online')
      s.revoke(d.machine_id)
      assert.throws(
        /* 撤销设备后以原凭据重连，要求拒绝。 */ () => s.connect(d.machine_id, d.credential),
        /invalid_device_credential/
      )
    } finally {
      s.close()
    }
  }
)
test(
  'idempotency binds principal, entire target and canonical request; errors are preserved',
  /* 验证 key 幂等绑定主体、完整 provider 目标及规范化请求，并保留原生错误结构。 */ () => {
    const s = new Store(':memory:', /* 固定时钟，避免时间推进干扰幂等测试。 */ () => 100, { management })
    try {
      const d = connected(s)
      const o = options({ client_request_key: 'k' })
      const request = { method: 'pane.read', params: { pane: 3, lines: 10 } }
      const c = s.createCall('alice', d.target, request, o)
      assert.equal(
        s.createCall('alice', d.target, { params: { lines: 10, pane: 3 }, method: 'pane.read' }, o).call_id,
        c.call_id
      )
      assert.throws(
        /* 同一 key 改用另一会话目标，要求意图冲突。 */ () =>
          s.createCall('alice', { ...d.target, session: 'other' }, request, o),
        /request_key_conflict/
      )
      assert.notEqual(
        /* 其他主体复用同一 key 只得到自己的独立调用，去重按主体隔离。 */ s.createCall('bob', d.target, request, o)
          .call_id,
        c.call_id
      )
      assert.throws(/* 其他主体读取已有调用，要求隐藏记录。 */ () => s.call('bob', c.call_id), /call_not_found/)
      const b = s.dispatch('alice', c.call_id, d.epoch)
      respond(s, b, { error: { code: 'conflict', message: 'synthetic', data: { revision: 14 } } }, 100)
      assert.equal(JSON.parse(s.call('alice', c.call_id).response!).error.data.revision, 14)
      assert.throws(
        /* 对已收到错误响应的调用再派发，要求防止重放。 */ () => s.dispatch('alice', c.call_id, d.epoch),
        /dispatch_rejected/
      )
      s.revoke(d.machine_id)
      assert.throws(/* 设备撤销后读取其调用，要求调用不再可见。 */ () => s.call('alice', c.call_id), /call_not_found/)
    } finally {
      s.close()
    }
  }
)
test(
  'two machines with pane 3 never accept each other responses; disconnect is unknown, no replay',
  /* 验证同 pane ID 的不同机器不能串收响应，断线后未知调用不会重放。 */ () => {
    const s = new Store(':memory:', /* 固定时钟，使两台机器的区别仅来自身份与连接绑定。 */ () => 100, { management })
    try {
      const a = connected(s, 'a')
      const b = connected(s, 'b')
      const req = { method: 'pane.read', params: { pane: 3 } }
      const o = options({ client_request_key: 'k' })
      const c = s.createCall('alice', a.target, req, o)
      const unsent = s.createCall('alice', a.target, req, options())
      const anchor = s.dispatch('alice', c.call_id, a.epoch)
      assert.throws(
        /* 以另一机器的 ID 查询响应锚点，要求绑定检查拒绝。 */ () =>
          s.responseAnchor({ ...anchor, machine_id: b.machine_id }),
        /binding_mismatch/
      )
      s.disconnect(a.machine_id, a.epoch)
      assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown')
      assert.equal(s.call('alice', unsent.call_id).state, 'not_dispatched')
      const next = s.connect(a.machine_id, a.credential)
      assert.throws(
        /* 重连后提交旧 epoch 的响应证据，要求拒绝过期连接。 */ () => respond(s, anchor, { result: {} }, 100),
        /stale_response/
      )
      assert.throws(
        /* 在新 epoch 重派结果未知调用，要求拒绝。 */ () => s.dispatch('alice', c.call_id, next),
        /dispatch_rejected/
      )
      assert.throws(
        /* 在新 epoch 重派已收敛为未派发的旧调用，要求拒绝。 */ () => s.dispatch('alice', unsent.call_id, next),
        /dispatch_rejected/
      )
      assert.equal(s.createCall('alice', a.target, req, o).state, 'outcome_unknown')
      s.disconnect(a.machine_id, next)
      assert.throws(
        /* 设备离线后登记新调用，要求拒绝。 */ () => s.createCall('alice', a.target, req, options()),
        /machine_offline/
      )
    } finally {
      s.close()
    }
  }
)
test(
  'disk recovery marks offline, never replays, excludes plaintext secrets, enforces writer lock',
  /* 验证数据库重开收敛连接与调用状态，凭据不明文落盘且 writer 锁独占。 */ () => {
    const dir = mkdtempSync(join(tmpdir(), 'rovloom-store-'))
    const path = join(dir, 'state.sqlite')
    let s = new Store(path, /* 固定初始存储时钟，让重启状态测试与真实时间无关。 */ () => 100, { management })
    try {
      const d = connected(s)
      const pending = s.createCall('alice', d.target, { method: 'ping' }, options())
      const sent = s.createCall('alice', d.target, { method: 'ping' }, options())
      s.dispatch('alice', sent.call_id, d.epoch)
      assert.throws(/* 已有 writer 持锁时打开同一数据库，要求独占锁拒绝。 */ () => new Store(path), /EEXIST/)
      assert.equal(statSync(path).mode & 0o777, 0o600)
      s.close()
      const bytes = readFileSync(path)
      assert(!bytes.includes(Buffer.from(d.credential)))
      assert(!bytes.includes(Buffer.from(d.enrollment)))
      s = new Store(path, /* 重开时使用同一可信时钟，验证状态收敛而非时钟漂移。 */ () => 100, { management })
      assert.equal(s.machine(d.machine_id).status, 'offline')
      assert.equal(s.call('alice', pending.call_id).state, 'not_dispatched')
      assert.equal(s.call('alice', sent.call_id).state, 'outcome_unknown')
      s.connect(d.machine_id, d.credential)
    } finally {
      s.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
test(
  'explicit targets, JSON and reserved fields fail closed',
  /* 验证原生目标必须显式、保留字段被拒绝，且不能规范化非 JSON 值。 */ () => {
    assert.throws(
      /* 为 session 目标省略会话，要求拒绝。 */ () => validateTarget({ machine_id: 'm', profile: 'session' } as Target),
      /session_required/
    )
    assert.throws(
      /* 为 host 目标混入 session 字段，要求拒绝不一致的 profile。 */ () =>
        validateTarget({ machine_id: 'm', profile: 'host', session: 'x' } as unknown as Target),
      /invalid_profile/
    )
    assert.throws(
      /* 在请求中传入网关保留的 auth 字段，要求拒绝。 */ () => validateRequest({ method: 'x', auth: 'secret' }),
      /reserved_request_field/
    )
    assert.throws(
      /* 在请求中传入网关保留的 id 字段，要求拒绝。 */ () => validateRequest({ method: 'x', id: 'caller' }),
      /reserved_request_field/
    )
    assert.throws(/* 规范化非有限数字，要求拒绝非 JSON 值。 */ () => canonical({ value: NaN }), /invalid_json/)
    assert.throws(
      /* 规范化含 undefined 的属性，要求拒绝非 JSON 值。 */ () => canonical({ value: undefined }),
      /invalid_json/
    )
  }
)
