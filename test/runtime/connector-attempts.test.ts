// 使用既有真实 Wire/原生契约 fixture 检查 Connector 独立准入，不把测试来源当生产认证。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuvusWireAdapter } from '../../src/connector/luvus/wire.js'
import {
  ConnectorAttemptBook,
  connectorAdmissionAdapter,
  createConnectorAdmissionBackend
} from '../../src/runtime/connector-attempts.js'
import { fixture } from '../connector/luvus/helpers.js'

/** 在 fixture 的受保护端口上建立独立内存准入；不使用它预先登记的 attempt 查询。 */
async function admitted() {
  const f = await fixture()
  const book = new ConnectorAttemptBook({
    maximum_deadline_ms: 60_000,
    now: /** 提供 fixture 独立时间，供固定期限测试控制。 */ () => f.state.now
  })
  const options = {
    connection: f.backend.connection(),
    routes: [{ target: f.binding.target, principal_id: 'synthetic' }],
    source: f.backend,
    book
  }
  const backend = createConnectorAdmissionBackend(options)
  const adapter = connectorAdmissionAdapter(backend, createLuvusWireAdapter(backend))
  return {
    f,
    book,
    options,
    backend,
    adapter,
    /** 先停有维护 timer 的 Wire，再删除本用例自有安装和 listener。 */
    async close() {
      adapter.close()
      await f.close()
    }
  }
}

test(
  'Connector admission starts without a Gateway attempt record and commits only after full Wire validation',
  /** 原始真实 decode 建立许可后才让准入查询看见已提交请求。 */ async () => {
    const a = await admitted()
    try {
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.adapter.decode(a.f.input(), 'gateway_to_connector').type, 'request')
      assert.deepEqual(a.backend.attempt('call1', 'attempt1'), a.f.row)
      const changed = structuredClone(a.f.envelope)
      changed.payload.native_request.params = { title: 'changed' }
      assert.throws(
        /** 相同 attempt 的正文不可替换。 */ () => a.adapter.decode(JSON.stringify(changed), 'gateway_to_connector'),
        new RegExp('attempt_request_mismatch')
      )
      assert.deepEqual(a.backend.attempt('call1', 'attempt1')?.native_request, a.f.row.native_request)
      a.adapter.release(a.f.binding)
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.book.dedupExpires(a.f.binding), a.f.binding.registration.deadline)
    } finally {
      await a.close()
    }
  }
)

test(
  'a failed original native gate removes the staged candidate and does not reserve a dedup deadline',
  /** 即便 preflight 通过，来源拒绝仍由原 Wire 决定且不能留下锚点。 */ async () => {
    const a = await admitted()
    try {
      a.f.state.trusted = false
      assert.throws(
        /** 未认证的原生来源不能通过原生 gate。 */ () => a.adapter.decode(a.f.input(), 'gateway_to_connector'),
        new RegExp('native_source_untrusted')
      )
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.throws(
        /** 失败请求未提交 book 记录。 */ () => a.book.dedupExpires(a.f.binding),
        new RegExp('attempt_anchor_unavailable')
      )
      a.f.state.trusted = true
      a.f.state.now = 200
      a.adapter.decode(a.f.input(), 'gateway_to_connector')
      assert.equal(a.book.dedupExpires(a.f.binding), a.f.binding.registration.deadline)
    } finally {
      await a.close()
    }
  }
)

test(
  'connection, route, policy revisions and caller self-report cannot establish an admission anchor',
  /** 分别破坏独立门禁，所有失败后均无候选残留。 */ async () => {
    const a = await admitted()
    try {
      const changed = structuredClone(a.f.envelope)
      changed.connection_epoch = 'other'
      assert.throws(
        /** 别的连接不能复用认证外壳。 */ () => a.adapter.decode(JSON.stringify(changed), 'gateway_to_connector'),
        new RegExp('attempt_binding_mismatch')
      )
      changed.connection_epoch = a.f.envelope.connection_epoch
      changed.payload.attempt.target.provider_id = 'other'
      assert.throws(
        /** 完整目标必须命中受保护本机路由。 */ () => a.adapter.decode(JSON.stringify(changed), 'gateway_to_connector'),
        new RegExp('connector_route_unavailable')
      )
      changed.payload.attempt.target.provider_id = 'p1'
      const spoof = { ...a.f.envelope, principal_id: 'owner' }
      assert.throws(
        /** 自报主体作为未声明字段由原 codec 拒绝。 */ () =>
          a.adapter.decode(JSON.stringify(spoof), 'gateway_to_connector'),
        new RegExp('invalid_frame_fields')
      )
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
    } finally {
      await a.close()
    }
  }
)

test(
  'fixed local dedup expiry survives release and disconnect and cannot move to a new epoch',
  /** 第一次固定截止跨重复校验不变，旧 attempt 不因重连成为新意图。 */ async () => {
    const a = await admitted()
    try {
      a.adapter.decode(a.f.input(), 'gateway_to_connector')
      a.f.state.now = 1000
      a.adapter.decode(a.f.input(), 'gateway_to_connector')
      assert.equal(a.book.dedupExpires(a.f.binding), a.f.binding.registration.deadline)
      a.adapter.close()
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.book.dedupExpires(a.f.binding), a.f.binding.registration.deadline)
      const connection = { ...a.options.connection, connection_epoch: 'e2' }
      const nextBackend = createConnectorAdmissionBackend({ ...a.options, connection })
      const next = connectorAdmissionAdapter(nextBackend, createLuvusWireAdapter(nextBackend))
      try {
        const changed = { ...a.f.envelope, connection_epoch: 'e2' }
        assert.throws(
          /** 固定 book 将已登记 attempt 与原 epoch 一并核对。 */ () =>
            next.decode(JSON.stringify(changed), 'gateway_to_connector'),
          new RegExp('attempt_binding_mismatch')
        )
        a.f.state.now = a.f.binding.registration.deadline
        assert.throws(
          /** 原 deadline 到期后不能重新准入。 */ () => next.decode(JSON.stringify(changed), 'gateway_to_connector'),
          new RegExp('deadline_exceeded')
        )
      } finally {
        next.close()
      }
    } finally {
      await a.close()
    }
  }
)

test(
  'execution deadline stays fixed when verification advances the trusted clock',
  /** 正常校验耗时不能刷新原意图的执行期限。 */ async () => {
    const a = await admitted()
    try {
      a.book.admit(
        a.f.row,
        /** 模拟真实校验经过一毫秒，二次门禁仍应沿用首次本机截止。 */ () => {
          a.f.state.now++
        }
      )
      assert.equal(a.book.dedupExpires(a.f.binding), a.f.binding.registration.deadline)
    } finally {
      await a.close()
    }
  }
)

test(
  'Connector admission rejects excessive deadline windows, duplicate keys and unprotected principal ambiguity',
  /** 错误配置和预算不能退化成宽松默认授权或覆盖固定记录。 */ async () => {
    const a = await admitted()
    try {
      const short = new ConnectorAttemptBook({ maximum_deadline_ms: 1, now: a.options.source.now })
      const backend = createConnectorAdmissionBackend({ ...a.options, book: short })
      const wire = connectorAdmissionAdapter(backend, createLuvusWireAdapter(backend))
      try {
        assert.throws(
          /** 执行 deadline 不能超过受保护的本机窗口。 */ () => wire.decode(a.f.input(), 'gateway_to_connector'),
          new RegExp('connector_deadline_limit')
        )
      } finally {
        wire.close()
      }
      assert.throws(
        /** 相同目标不能存在两条路由。 */ () =>
          createConnectorAdmissionBackend({ ...a.options, routes: [...a.options.routes, ...a.options.routes] }),
        new RegExp('connector_route_invalid')
      )
      assert.throws(
        /** 当前后端没有按调用选择结果读取主体的接口，多个主体保持拒绝。 */ () =>
          createConnectorAdmissionBackend({
            ...a.options,
            routes: [
              ...a.options.routes,
              { target: { ...a.f.binding.target, provider_id: 'p2' }, principal_id: 'other' }
            ]
          }),
        new RegExp('connector_principal_ambiguous')
      )
    } finally {
      await a.close()
    }
  }
)

test(
  'attempt book releases expired metadata while preserving active bindings and deadline rejection',
  /** 超过旧 4096 累计量，回收不依赖断连或释放正文；仍在期限内的原意图不得被挤出。 */ async () => {
    const a = await admitted()
    try {
      const book = new ConnectorAttemptBook({
        maximum_deadline_ms: 60_000,
        now: /** 独立受控时钟。 */ () => a.f.state.now
      })
      for (let index = 0; index < 4200; index++) {
        const next = structuredClone(a.f.row)
        next.binding.call_id = 'call' + index
        next.binding.registration.deadline = a.f.state.now + 1
        book.admit(next, /** 合成已成功校验的请求，不创建原生许可。 */ () => {})
        a.f.state.now++
      }
      a.f.state.now = a.f.binding.registration.deadline
      assert.throws(
        /** 已到期的原意图不得重新准入。 */ () =>
          book.admit(a.f.row, /** 不应进入校验。 */ () => assert.fail('expired intent admitted')),
        new RegExp('deadline_exceeded')
      )
      const limited = new ConnectorAttemptBook({
        maximum_deadline_ms: 60_000,
        limits: { entries: 1, bytes: 4_194_304 },
        now: /** 独立受控时钟。 */ () => a.f.state.now
      })
      const active = structuredClone(a.f.row)
      active.binding.registration.deadline = a.f.state.now + 1000
      limited.admit(active, /** 合成已成功校验的请求。 */ () => {})
      const other = structuredClone(active)
      other.binding.call_id = 'other'
      assert.throws(
        /** 未到期记录占满预算时不能挤出它。 */ () => limited.admit(other, /** 不应执行。 */ () => {}),
        new RegExp('connector_attempt_capacity')
      )
      assert.equal(limited.dedupExpires(active.binding), active.binding.registration.deadline)
    } finally {
      await a.close()
    }
  }
)
