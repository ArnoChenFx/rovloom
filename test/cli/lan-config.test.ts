// 用户配置没有 lan 字段；hostname 决定监听网卡，管理页不以监听地址限制代理域名。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import type { GatewayConfig } from '../../src/cli/config.js'

const base = configDocument(configTemplate('gateway')) as {
  mcp: Record<string, unknown>
  devices: Record<string, unknown>
  management: Record<string, unknown>
}

test('wildcard bindings round-trip without lan fields and loopback keeps explicit management hostname', () => {
  // 模板默认：MCP/设备通道通配，管理页回环；三个 hostname 全部显式落盘。
  assert.deepEqual(base.mcp, { hostname: '0.0.0.0', port: 9444 })
  assert.deepEqual(base.devices, { hostname: '0.0.0.0', port: 9443 })
  assert.deepEqual(base.management, { enabled: true, hostname: '127.0.0.1', port: 9445 })
  assert.deepEqual(configDocument(parseConfig(base) as GatewayConfig), base)
  // 通配管理页绑定往返一致，序列化不添任何 lan 字段。
  const wildcardManagement = parseConfig({
    ...base,
    management: { ...base.management, hostname: '0.0.0.0' }
  }) as GatewayConfig
  assert.deepEqual(configDocument(wildcardManagement), {
    ...base,
    management: { ...base.management, hostname: '0.0.0.0' }
  })
  // lan 字段已删除：任何分组出现即拒绝，不接受 true/false/其它值。
  assert.throws(() => parseConfig({ ...base, mcp: { ...base.mcp, lan: true } }))
  assert.throws(() => parseConfig({ ...base, mcp: { ...base.mcp, lan: false } }))
  assert.throws(() => parseConfig({ ...base, management: { ...base.management, lan: true } }))
  assert.throws(() => parseConfig({ ...base, management: { ...base.management, lan: 'yes' } }))
})
