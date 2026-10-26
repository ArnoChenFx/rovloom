// 用实际 E2E 输出收集器验证重启边界，不启动真实原生进程。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConnectorOutput } from '../../scripts/e2e/connector-output.mjs'

const ready = 'connector_transport ready provider_ready=true\n'

test('旧 ready 后新增断连日志不能通过重启验收，必须再收到新的完整 ready 行', () => {
  const output = createConnectorOutput()
  output.write(ready)
  const before = output.readyCount
  output.write('connector_disconnect close_reason=transport_unavailable\n')
  assert.equal(output.readyCount > before, false)
  output.write(ready.slice(0, -1))
  assert.equal(output.readyCount > before, false)
  output.write('\n')
  assert.equal(output.readyCount > before, true)
})

test('日志尾部满额并滚动后仍能识别新的 ready，分块及过长伪行不误计数', () => {
  const output = createConnectorOutput()
  output.write(ready)
  output.write('x'.repeat(20000))
  output.write(ready)
  assert.equal(output.readyCount, 1)
  assert.equal(output.stderr.length, 16384)
  const before = output.readyCount
  output.write(Buffer.from(ready.slice(0, 17)))
  output.write(Buffer.from(ready.slice(17)))
  assert.equal(output.stderr.length, 16384)
  assert.equal(output.readyCount, before + 1)
})
