// 验证显式可信CLI宿主打开实际Store并释放writer；测试仅用空授权、隔离目录，不接入设备或签发凭据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configTemplate, createStoreCliRuntime, type GatewayConfig } from '../../src/cli/index.js'

test(
  '真实Store CLI宿主保留文件保护与单writer，关闭释放资源，Connector仍不可用',
  /* 打开同一实际数据库验证锁竞争与重开，不以服务stub替代持久层。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-cli-store-'))
    const config = { ...configTemplate('gateway'), state_dir: directory } as GatewayConfig
    const runtime = createStoreCliRuntime({
      authentication: {
        authenticate: /* 合成绑定只用于本测试，不会由OS用户名自动获得权限。 */ () => ({ principal_id: 'synthetic_cli' })
      },
      identities: {
        principal: /* 共享身份来源只有空tuple授权，没有管理员能力。 */ () => ({
          id: 'synthetic_cli',
          policy: { revision: 'test_1', grants: [] }
        }),
        administrator: /* 未配置独立管理认证时明确拒绝，MCP身份不升级。 */ () => null
      }
    })
    let running = await runtime.gateway!(config)
    try {
      const database = join(directory, 'gateway.db')
      assert.equal(statSync(database).mode & 0o777, 0o600)
      assert(existsSync(database + '.lock'))
      assert.deepEqual(
        (
          await running.service.execute(
            'machines_list',
            {},
            { caller: { principal_id: 'synthetic_cli' }, wait_signal: new AbortController().signal }
          )
        ).data.items,
        []
      )
      await assert.rejects(runtime.gateway!(config))
      assert.equal(runtime.connector, undefined)
      await running.close()
      assert(!existsSync(database + '.lock'))
      running = await runtime.gateway!(config)
    } finally {
      await running.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
