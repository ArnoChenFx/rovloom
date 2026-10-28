// 用真实 Store、Wire 与纯模拟执行验证按调用清理的线性成本、容量回收和当前读取门禁；不启动原生进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuvusWireAdapter } from '../../src/connector/luvus/wire.js'
import { persistentBackend } from '../../src/connector/luvus/persistence.js'
import type { V2Target } from '../../src/wire/types.js'
import { fixture, until } from './helpers.js'

/** 仅包装 Gateway 自己的原 Wire 计数，所有读取、释放和持久状态仍经真实实现。 */
function trackedFixture(readContexts = 128) {
  const counts = { contentStatus: 0, checks: [] as string[], releases: [] as string[] }
  const f = fixture(
    {
      retainOriginalRead: true,
      limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 150, read_contexts: readContexts }
    },
    { retention: { result_ttl: 10 } },
    {
      /** 为实际认证连接创建独立原 Wire，计数不改变当前主体、授权或内容状态。 */
      adapter(_connection, _channel, services) {
        const backend = persistentBackend(f.store, services)
        const contentStatus = backend.contentStatus
        backend.contentStatus =
          /** 记录原 maintain 的全部内容查询，以识别目标清理是否又套全量遍历。 */
          (binding) => {
            counts.contentStatus++
            return contentStatus(binding)
          }
        const wire = createLuvusWireAdapter(backend)
        return {
          ...wire,
          /** 记录实际检查的调用 ID，继续执行原 Wire 的完整读取门禁。 */
          checkResult(binding, response) {
            counts.checks.push(binding.call_id)
            return wire.checkResult(binding, response)
          },
          /** 记录容量清理的实际释放，不用计数器模拟状态回收。 */
          release(binding) {
            counts.releases.push(binding.call_id)
            wire.release(binding)
          }
        }
      }
    }
  )
  return Object.assign(f, { counts })
}

/** 只派发一次明确新意图，并等待真实 Gateway 响应事务完成。 */
async function completed(f: ReturnType<typeof trackedFixture>, target: V2Target) {
  const call = f.call(target)
  f.gateway.dispatch(call.call_id)
  await until(
    /** Store 的 responded 才表示已提交原模拟响应，accepted 不作为完成依据。 */
    () => f.store.call(f.principal.id, call.call_id).state === 'responded'
  )
  return call
}

for (const count of [1, 8, 16]) {
  test(
    `保留 ${count} 个原结果时，目标读取为线性内容查询且响应只清理本调用`,
    { timeout: 15_000 },
    /** 以调用次数断言复杂度，不依赖磁盘性能或放宽生产时限。 */
    async () => {
      const f = trackedFixture()
      try {
        const device = f.pair(`mock_target_prune_${count}`)
        const client = f.connector(/** 仅返回本 fixture 已兑换的设备凭据。 */ () => device.credential)
        await until(/** 等待当前连接真实完成认证与 provider readiness。 */ () => client.status().phase === 'ready')
        let last = ''
        for (let index = 0; index < count; index++) {
          const call = f.call(device.target)
          f.counts.checks.length = 0
          f.gateway.dispatch(call.call_id)
          assert.deepEqual(f.counts.checks, [], '读取容量未满时派发不扫描原结果')
          await until(
            /** 等待原响应提交与当前同步接收处理结束。 */
            () => f.store.call(f.principal.id, call.call_id).state === 'responded'
          )
          assert.deepEqual(f.counts.checks, [call.call_id], '响应提交只清理本调用')
          last = call.call_id
        }
        f.counts.contentStatus = 0
        f.counts.checks.length = 0
        assert(f.gateway.resolveOriginalRead(last))
        assert.deepEqual(f.counts.checks, [last, last])
        assert.equal(f.counts.contentStatus, 2 * count + 2, '两个原门禁各维护 N 个状态并检查目标内容')
        f.counts.checks.length = 0
        assert.equal(f.gateway.status().read_contexts, count)
        assert.equal(f.counts.checks.length, count, '状态统计保持全量清理语义')
        assert.equal(f.executions, count)
      } finally {
        f.stop()
      }
    }
  )
}

test(
  '读取容量满时才全扫，显式释放原 Wire 后直接派发可回收容量',
  /** 满额拒绝发生在派发事务前；不靠额外 resolve 或 status 帮助回收。 */
  async () => {
    const f = trackedFixture(2)
    try {
      const device = f.pair('mock_target_prune_capacity')
      const client = f.connector(/** 仅使用本次测试配对得到的设备身份。 */ () => device.credential)
      await until(/** 两个保留结果必须属于同一个实际认证 epoch。 */ () => client.status().phase === 'ready')
      const first = await completed(f, device.target)
      const second = await completed(f, device.target)
      const original = f.gateway.resolveOriginalRead(first.call_id)!
      const next = f.call(device.target)
      f.counts.checks.length = 0
      assert.throws(
        /** 两条有效上下文满额时不能提前提交第三条 attempt。 */ () => f.gateway.dispatch(next.call_id),
        /transport_concurrency_limit/
      )
      assert.deepEqual(f.counts.checks, [first.call_id, second.call_id])
      assert.equal(f.store.call(f.principal.id, next.call_id).state, 'created')
      assert.equal(f.executions, 2)
      original.wire.release(original.binding)
      f.counts.releases.length = 0
      f.counts.checks.length = 0
      f.gateway.dispatch(next.call_id)
      assert.deepEqual(f.counts.checks, [first.call_id, second.call_id])
      assert.deepEqual(f.counts.releases, [first.call_id])
      await until(
        /** 仅显式提交的新调用执行一次，满额拒绝没有排队或自动重放。 */
        () => f.store.call(f.principal.id, next.call_id).state === 'responded'
      )
      assert.equal(f.gateway.resolveOriginalRead(first.call_id), undefined)
      assert(f.gateway.resolveOriginalRead(second.call_id))
      assert(f.gateway.resolveOriginalRead(next.call_id))
      assert.equal(f.gateway.status().read_contexts, 2)
      assert.equal(f.executions, 3)
    } finally {
      f.stop()
    }
  }
)

test(
  '目标清理保留当前撤权门禁，丢弃与固定 TTL 到期仍拒绝旧结果且不驱逐其它调用',
  /** 同一活 Wire 在撤权期间拒绝读取，恢复授权不重建上下文；内容失效则不可复活。 */
  async () => {
    const f = trackedFixture()
    try {
      const device = f.pair('mock_target_prune_gates')
      const client = f.connector(/** 只为本次空白账本提供 mock 身份。 */ () => device.credential)
      await until(
        /** 当前认证与双方 provider 配置必须都通过，才开始原结果测试。 */
        () => client.status().phase === 'ready'
      )
      const discarded = await completed(f, device.target)
      f.now++
      const expired = await completed(f, device.target)
      f.now++
      const live = await completed(f, device.target)
      const original = f.gateway.resolveOriginalRead(discarded.call_id)!
      const expiredOriginal = f.gateway.resolveOriginalRead(expired.call_id)!
      f.counts.releases.length = 0
      f.store.discardResponse(f.principal.id, discarded.call_id)
      assert.equal(f.gateway.resolveOriginalRead(discarded.call_id), undefined)
      assert.deepEqual(f.counts.releases, [discarded.call_id])
      assert.throws(/** 持久清理后旧引用不能恢复内容读取。 */ () => original.wire.checkResult(original.binding))
      f.now = f.store.call(f.principal.id, expired.call_id).content_expires
      f.store.expire()
      assert.equal(f.gateway.resolveOriginalRead(expired.call_id), undefined)
      assert.throws(
        /** 到达原内容截止即拒绝，不因目标清理或读取刷新期限。 */
        () => expiredOriginal.wire.checkResult(expiredOriginal.binding)
      )
      assert(f.gateway.resolveOriginalRead(live.call_id))
      assert.deepEqual(f.counts.releases, [discarded.call_id, expired.call_id])
      assert.equal(f.executions, 3)
    } finally {
      f.stop()
    }
  }
)
