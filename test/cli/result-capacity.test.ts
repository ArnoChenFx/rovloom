/** 真实注册表、CLI、Store/Wire/loopback 的结果释放路径；native 仅为不触发用户工作区的合成回包。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { configDocument, configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { digestToken } from '../../src/cli/token-registry.js'
import { createProviderResultAccess } from '../../src/runtime/results.js'
import { fixture, until } from '../transport/helpers.js'

test(
  'production token can explicitly discard owned results and release capacity beyond 128 calls',
  { timeout: 30_000 },
  /** 默认读取容量不扩大；EOF 不回收，只有显式授权删除才能释放。 */ async () => {
    const f = fixture({ retainOriginalRead: true, limits: { heartbeat_ms: 100, idle_ms: 20_000, handshake_ms: 1000 } })
    const root = mkdtempSync(join(tmpdir(), 'rovloom-result-capacity-'))
    let source: ReturnType<typeof openCallerSource> | undefined
    try {
      const device = f.pair('synthetic_result_capacity')
      const client = f.connector(/** 只返回本 fixture 已配对的凭据。 */ () => device.credential, {
        limits: { heartbeat_ms: 100, idle_ms: 20_000, handshake_ms: 1000 }
      })
      await until(/** 等待真实当前 epoch。 */ () => client.status().phase === 'ready')
      const managed = join(root, 'managed')
      mkdirSync(managed, { mode: 0o700 })
      const config = { ...configTemplate('gateway'), state_dir: root } as GatewayConfig
      const configPath = join(root, 'gateway.json')
      writeFileSync(configPath, JSON.stringify(configDocument(config)), { mode: 0o600 })
      const registryPath = join(managed, 'mcp-callers.json')
      writeFileSync(
        registryPath,
        JSON.stringify({
          schema_version: 2,
          kind: 'mcp-caller-source',
          resource: 'http://127.0.0.1:9/mcp',
          callers: [
            {
              principal: { id: f.principal.id },
              token_sha256: digestToken('a'.repeat(43)),
              issued_at: Date.now() - 1000,
              expires_at: Date.now() + 60_000
            }
          ]
        }),
        { mode: 0o600 }
      )
      source = openCallerSource(registryPath, 'http://127.0.0.1:9/mcp')
      const access = createProviderResultAccess({
        store: f.store,
        principal: /** 生产热读来源，权限不在测试闭包中伪造。 */ () =>
          source!.identities.principal({ principal_id: f.principal.id })!
      })
      const calls: string[] = []
      for (let index = 0; index < 128; index++) {
        const call = f.call(device.target)
        f.gateway.dispatch(call.call_id)
        await until(
          /** 只将实际提交响应视为完成。 */ () => f.store.call(f.principal.id, call.call_id).state === 'responded'
        )
        calls.push(call.call_id)
      }
      const retained = access.open(calls[1]!)
      const first = access.open(calls[0]!)
      assert.equal(access.read(first.result_id, 0, 16384).eof, true)
      const blocked = f.call(device.target)
      assert.throws(
        /** EOF 不等于同意删除。 */ () => f.gateway.dispatch(blocked.call_id),
        /transport_concurrency_limit/
      )
      assert.equal(f.store.call(f.principal.id, blocked.call_id).state, 'created')
      access.discard(calls[0]!)
      for (let index = 0; index < 5; index++) {
        const call = index === 0 ? blocked : f.call(device.target)
        f.gateway.dispatch(call.call_id)
        await until(
          /** 已提交新响应后再读取。 */ () => f.store.call(f.principal.id, call.call_id).state === 'responded'
        )
        const result = access.open(call.call_id)
        assert.equal(access.read(result.result_id, 0, 16384).eof, true)
        access.discard(call.call_id)
        if (index === 0) {
          // 保留一个结果，其余已完成结果由同一显式权限批量释放，后续调用只占短期上下文。
          for (const old of calls.slice(2)) {
            access.discard(old)
          }
          assert.equal(f.gateway.status().read_contexts, 1)
        }
      }
      assert.equal(f.executions, 133)
      assert.equal(client.status().phase, 'ready')
      assert.equal(access.read(retained.result_id, 0, 16384).eof, true)
      access.discard(calls[1]!)
      assert.throws(() => access.read(retained.result_id), /result_not_found/)
    } finally {
      source?.close()
      f.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
