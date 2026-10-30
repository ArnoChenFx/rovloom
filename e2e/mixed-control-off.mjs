/**
 * 多 provider、allow_terminal_execution=false 时的检查：三个来源的输入/启动类都不可用且调用被拒，
 * 读取照常。core 在 Gateway 登记前就拒绝（forbidden）；Luvus / Herdr 的门禁在 Connector 的最终写入前，
 * 因此是确定未派发（not_dispatched + reason=terminal_execution_disabled）。
 * 用法：MCP_CONFIG=... bun e2e/mixed-control-off.mjs
 */
import assert from 'node:assert/strict'
import { connectMixed } from './mixed-client.mjs'

const { client, tool, discover, invoke, call } = await connectMixed()
// 只用「总是需要开关」的直接输入方法：workspace.new 之类的启动方法在省略命令行时允许（参数敏感）。
const controls = {
  luvus: ['pane.send_input', 'pane.run'],
  herdr: ['pane.send_text', 'pane.send_keys'],
  'herdr-core': ['terminal.send', 'terminal.run']
}
const reads = { luvus: ['workspace.list', {}], herdr: ['ping', {}], 'herdr-core': ['server.status', {}] }
const report = {}
try {
  for (const kind of ['luvus', 'herdr', 'herdr-core']) {
    const { target, page, entry } = await discover(kind)
    // 输入/启动类不可用：core 显式标 available:false；Luvus/Herdr 由目录隐藏。
    for (const method of controls[kind]) {
      const found = entry(method)
      if (found) {
        assert.equal(found.available, false, `${kind}/${method} should be unavailable: ${JSON.stringify(found)}`)
      }
      const result = await tool('runtime_call', {
        target,
        expected_binding_revision: 1,
        contract_ref: page.items[0].contract_ref,
        native_request:
          kind === 'herdr-core'
            ? {
                method,
                params:
                  method === 'terminal.run'
                    ? { line: 'true' }
                    : { terminal: 't1', core_id: 'a'.repeat(16), created_ms: 0, text: 'x' }
              }
            : { method, params: {} },
        deadline: Date.now() + 30_000
      })
      if (kind === 'herdr-core') {
        assert.equal(result.isError, true, `${kind}/${method}:${JSON.stringify(result.raw)}`)
        assert.equal(result.raw?.gateway_error?.code, 'forbidden', `${kind}/${method}`)
      } else if (result.isError) {
        // 也可以被准入直接拒；只要不是成功。
        assert.notEqual(result.raw?.gateway_error?.code, undefined)
      } else {
        const view = await invoke(target, page.items[0].contract_ref, {
          method,
          params: {}
        })
        assert.equal(view.state, 'not_dispatched', `${kind}/${method}:${JSON.stringify(view)}`)
        assert.equal(view.reason, 'terminal_execution_disabled', JSON.stringify(view))
      }
    }
    // 读取不受开关影响。
    const [method, params] = reads[kind]
    const value = await call(kind, method, params)
    assert.equal(typeof value, 'object', `${kind}/${method}`)
    report[kind] = { controls: controls[kind], read: method }
  }
  console.log(JSON.stringify({ ok: true, switch: 'off', report }))
} finally {
  await client.close()
}
