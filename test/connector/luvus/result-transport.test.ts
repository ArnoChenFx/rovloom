/** 组合 PR47 真实通道、原 Wire 和 Store；仅用自建 IPC fixture，不视为真实 Luvus 或授权一致性验收。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLuvusResultAccess } from '../../../src/connector/luvus/index.js'
import { until } from '../../transport/helpers.js'
import { wireFixture } from '../../transport/wire-execution-helpers.js'

/** 经真实 adapter 和证据提交取得单帧内的较大错误；所有宿主查询保持纯读，身份仅具 fixture 效力。 */
async function completed() {
  const f = await wireFixture({
    frameBytes: 131_072,
    store: { retention: { result_ttl: 10 } }
  })
  const data = { text: '你好🌍'.repeat(8_000), nested: [{ preserved: true, code: -7 }] }
  f.native.respond(
    /** 使用 IPC 实际收到的 native id，返回有界、跨多页读取的多字节 error.data。 */
    (socket, input) => {
      const request = JSON.parse(input.trim().split('\n').at(-1)!)
      socket.end(JSON.stringify({ id: request.id, error: { code: 'mock_large', message: 'preserve', data } }) + '\n')
    }
  )
  try {
    const device = f.pair('mock_result_transport')
    const client = f.connect(device)
    await f.ready(client)
    const call = f.f.call(device.target)
    const binding = f.f.gateway.dispatch(call.call_id)
    await until(
      /** responded 必须由 Gateway 的真实 commitLuvusResponse 事务发布，原生完成本身不算。 */
      () => f.f.store.call(f.f.principal.id, call.call_id).state === 'responded'
    )
    const ports = {
      store: f.f.store,
      principal: () => f.f.principal
    }
    return {
      f,
      client,
      call,
      binding,
      data,
      ports,
      access: createLuvusResultAccess(ports)
    }
  } catch (error) {
    await f.close()
    throw error
  }
}

test(
  '真实 IPC 较大错误经原 Wire 提交后，由真实保留门禁创建句柄并分页核对完整 hash 与固定 TTL',
  { timeout: 20_000 },
  /** 联合验证实际接口，不把合成身份的正向组合计为同步撤权或真实原生验收通过。 */
  async () => {
    const { f, call, binding, data, access } = await completed()
    try {
      const original = f.f.gateway.resolveOriginalRead(call.call_id)!
      assert.equal(original.wire, f.f.gateway.resolveOriginalRead(call.call_id)!.wire)
      const meta = access.open(call.call_id)
      assert.equal(meta.expires, 1010)
      const parts: Buffer[] = []
      let cursor = 0
      while (true) {
        const page = access.read(meta.result_id, cursor, 65_535)
        assert.equal(page.result_id, meta.result_id)
        assert.equal(page.expires, meta.expires)
        assert.equal(page.bytes, meta.bytes)
        assert.equal(page.hash, meta.hash)
        const bytes = Buffer.from(page.data, 'base64')
        assert(bytes.length <= 65_535)
        assert.equal(page.next_cursor, cursor + bytes.length)
        parts.push(bytes)
        cursor = page.next_cursor
        if (page.eof) {
          break
        }
      }
      const bytes = Buffer.concat(parts)
      assert(parts.length > 1)
      assert.equal(bytes.length, meta.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.hash)
      assert.equal(bytes.toString('utf8'), f.f.store.call(f.f.principal.id, call.call_id).response)
      assert.deepEqual(JSON.parse(bytes.toString('utf8')), {
        id: binding.native_request_id,
        error: { code: 'mock_large', message: 'preserve', data }
      })
      f.f.now = 1009
      assert.deepEqual(access.open(call.call_id), meta)
      assert.equal(access.read(meta.result_id, 0, 1).expires, 1010)
      f.f.now = 1010
      assert.throws(
        /** 句柄与内容同期限，到期后读取立即拒绝，不以正文尚有效为由续期或重开。 */
        () => access.read(meta.result_id, 0, 1),
        /result_not_found|result_not_ready/
      )
      f.f.store.expire()
      assert.throws(
        /** 正文固定期限到达后不能新建句柄或恢复原上下文。 */
        () => access.open(call.call_id)
      )
      assert.equal(f.f.gateway.resolveOriginalRead(call.call_id), undefined)
      assert.equal(f.state.auth, 1)
      assert.equal(f.state.claim, 1)
      assert.equal(f.claimCount(), 1)
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.f.executions, 0)
      assert.deepEqual(f.failures, [])
    } finally {
      await f.close()
    }
  }
)

test(
  '真实组合结果断线后仍可读取，设备范围撤销即时拒绝读取与清理',
  { timeout: 20_000 },
  /** 在操作之间撤销当前事实，保留独立 discard 权限及正文与原上下文的不同生命周期。 */
  async () => {
    const { f, call, client, access } = await completed()
    try {
      const meta = access.open(call.call_id)
      f.f.principal.device_scope = { mode: 'selected', machine_ids: [] }
      assert.throws(() => access.read(meta.result_id, 0, 32), /forbidden/)
      assert.throws(() => access.discard(call.call_id), /forbidden/)
      delete f.f.principal.device_scope
      client.stop()
      await until(
        /** 等 Gateway 确认连接已关闭后再查询原上下文，不以客户端本地 close 代替。 */
        () => f.f.gateway.status().connections === 0
      )
      assert.equal(f.f.gateway.resolveOriginalRead(call.call_id), undefined)
      assert.equal(Buffer.from(access.read(meta.result_id, 0, 32).data, 'base64').length, 32)
      access.discard(call.call_id)
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).response, null)
      assert.throws(
        /** 显式清理删除真实句柄，不能在原 Wire 关闭后另建许可。 */
        () => f.f.store.resultCall(f.f.principal.id, meta.result_id),
        /result_not_found/
      )
      assert.equal(f.claimCount(), 1)
      assert.equal(f.native.state.responses, 1)
    } finally {
      await f.close()
    }
  }
)
