/** 用真实 Store、原 NativeValidator 与 Wire 验证共同结果门禁和逐 provider 上限，不构造 Herdr 许可替身。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/store.js'
import { createProviderResultAccess } from '../../src/runtime/results.js'
import type { ProviderResultAccessOptions } from '../../src/runtime/results.js'
import { commitLuvusResponse } from '../../src/wire/persistence.js'
import type { Principal } from '../../src/router.js'
import { management, responseFrame } from '../storage/helpers.js'
import { nativeBackend } from '../storage/native-backend.js'

/** 同一 Store 内建立两个各持原 Wire 的真实测试 provider；内容与句柄共用同一份额度。 */
function fixture(contentBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-provider-results-'))
  const path = join(directory, 'state.sqlite')
  const state = { now: 100, available: true }
  const store = new Store(path, /** 共同结果与原 Wire 使用同一受控可信时钟。 */ () => state.now, {
    management,
    retention: {
      result_ttl: 10,
      ...(contentBytes === undefined ? {} : { content_bytes: contentBytes })
    }
  })
  const inspect = new DatabaseSync(path, { readOnly: true })
  const first = nativeBackend(store)
  store.defineProvider({
    ...store.provider(first.target.machine_id, first.target.provider_id)!,
    provider_id: 'second_provider',
    config_ref: 'second_config'
  })
  const second = nativeBackend(store, { device: first.device, provider_id: 'second_provider' })
  const calls = [first, second].map(
    /** 经真实原许可派发并提交完整响应，不模拟结果授权成功。 */ (native) => {
      const call = native.create()
      const binding = native.dispatch(call.call_id)
      const frame = responseFrame(binding, {
        error: { code: 'isolated', message: 'preserved', data: { text: 'x'.repeat(256) } }
      })
      commitLuvusResponse(store, native.adapter, frame)
      return store.call('synthetic', call.call_id)
    }
  )
  const principal: Principal = { id: 'synthetic' }
  const ports: ProviderResultAccessOptions = { store, principal: () => principal }
  return {
    path,
    store,
    state,
    first,
    second,
    calls,
    principal,
    ports,
    access: createProviderResultAccess(ports),
    /** 只读连接核对实际句柄个数，不能借此创建或恢复原许可。 */
    handles() {
      return Number(inspect.prepare('SELECT count(*) AS n FROM results').get()!.n)
    },
    /** 释放本 fixture 独立 Wire、Store 与临时文件，保留真实共享预算检验。 */
    close() {
      first.adapter.close()
      second.adapter.close()
      inspect.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('已提交结果按字节分页，原连接释放后仍能读取且不续期', (t) => {
  const f = fixture()
  t.after(() => f.close())
  for (const call of f.calls) {
    const meta = f.access.open(call.call_id)
    const chunks: Buffer[] = []
    const native = call.provider_id === f.first.target.provider_id ? f.first : f.second
    native.adapter.close()
    let cursor = 0
    while (true) {
      const page = f.access.read(meta.result_id, cursor, 32)
      chunks.push(Buffer.from(page.data, 'base64'))
      assert.equal(page.hash, meta.hash)
      assert.equal(page.expires, 110)
      cursor = page.next_cursor
      if (page.eof) {
        break
      }
    }
    assert.equal(Buffer.concat(chunks).toString(), call.response)
    f.state.now = 105
    assert.deepEqual(f.access.open(call.call_id), meta)
    assert.equal(native.state.sends, 1)
  }
  assert.equal(f.handles(), 2)
})

test('每次结果操作都使用当前 token 的设备范围与归属，不依赖旧策略', (t) => {
  const f = fixture()
  t.after(() => f.close())
  const call = f.calls[0]!
  const meta = f.access.open(call.call_id)
  f.principal.device_scope = { mode: 'selected', machine_ids: [] }
  assert.throws(() => f.access.open(call.call_id), /forbidden/)
  assert.throws(() => f.access.read(meta.result_id), /forbidden/)
  assert.throws(() => f.access.discard(call.call_id), /forbidden/)
  delete f.principal.device_scope
  f.principal.id = 'another'
  assert.throws(() => f.access.open(call.call_id), /call_not_found/)
  assert.throws(() => f.access.read(meta.result_id), /call_not_found/)
  f.principal.id = 'synthetic'
  f.access.discard(call.call_id)
  assert.throws(() => f.access.read(meta.result_id), /result_not_found/)
  assert.throws(() => f.access.open(call.call_id), /result_not_ready/)
})

test('结果页有界，TTL 到期后不能复活正文或句柄', (t) => {
  const f = fixture()
  t.after(() => f.close())
  const meta = f.access.open(f.calls[0]!.call_id)
  for (const [cursor, bytes] of [
    [-1, 1],
    [0, 0],
    [0, 65537],
    [meta.bytes + 1, 1]
  ]) {
    assert.throws(() => f.access.read(meta.result_id, cursor, bytes), /invalid_result_cursor/)
  }
  assert.equal(f.handles(), 1)
  f.state.now = 110
  assert.throws(() => f.access.read(meta.result_id), /result_not_found/)
  assert.throws(() => f.access.open(f.calls[0]!.call_id), /result_not_ready/)
})

test('多个 provider 共用唯一 Store 内容预算，不能从原连接补回未保存的内容', (t) => {
  const f = fixture(700)
  t.after(() => f.close())
  assert.notEqual(f.calls[0]!.response, null)
  assert.equal(f.calls[1]!.state, 'responded')
  assert.equal(f.calls[1]!.content_status, 'unavailable')
  const meta = f.access.open(f.calls[0]!.call_id)
  assert.throws(() => f.access.open(f.calls[1]!.call_id), /result_not_ready/)
  assert.equal(f.access.read(meta.result_id).bytes, meta.bytes)
  assert.equal(f.handles(), 1)
})

test('身份解析失败不交付结果且不回显底层错误', (t) => {
  const f = fixture()
  t.after(() => f.close())
  const access = createProviderResultAccess({
    store: f.store,
    principal() {
      throw new Error('private secret')
    }
  })
  assert.throws(() => access.open(f.calls[0]!.call_id), { code: 'result_unavailable', message: 'result_unavailable' })
  assert.equal(f.handles(), 0)
})
