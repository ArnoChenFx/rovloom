/** 真实短期子进程验证smoke失败清理，不向生产工厂提供任何假native来源或成功响应。 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createDualRoleManagementRead,
  startDualRoleSmokeProcess,
  assertConnectorDiagnostics
} from '../../scripts/release/dual-role-smoke.mjs'

/** 只构造不读取环境或运行用户命令的受控shell child，所有输出和状态均为本轮合成值。 */
function fixture(body, limits) {
  const root = mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.dual-role-process-'))
  const script = join(root, 'child.sh')
  const marker = join(root, 'ready')
  const path = join(root, 'empty-path')
  mkdirSync(path, { mode: 0o700 })
  writeFileSync(script, body, { mode: 0o700 })
  const child = startDualRoleSmokeProcess('/bin/sh', script, marker, root, { PATH: path, HOME: root }, limits)
  return {
    child,
    marker,
    /** 失败stop也必须真实回收直接child后才能删除测试根。 */
    async close() {
      try {
        await child.stop()
      } catch {
        // 预期失败在测试主体断言，此处仍独立核对物理退出。
      }
      assert.equal(existsSync(`/proc/${child.child.pid}`), false, 'synthetic_child_not_reaped')
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 有界等待自己的标记文件，不能按PID或名字接管其它进程。 */
async function until(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) {
      return
    }
    await pause(10)
  }
  assert.fail('synthetic_child_marker_timeout')
}

test(
  'dual-role stop is idempotent and waits for the real child close',
  { skip: process.platform !== 'linux' },
  /** TERM处理只由本轮shell响应，不模拟任何产品或native协议。 */ async () => {
    const f = fixture('trap \'exit 0\' TERM\n: > "$2"\nwhile :; do /bin/sleep 0.02; done\n', { timeout: 2000 })
    try {
      await until(f.marker)
      const first = f.child.stop()
      assert.equal(f.child.stop(), first)
      await first
      assert.equal(existsSync(`/proc/${f.child.child.pid}`), false)
    } finally {
      await f.close()
    }
  }
)

test(
  'dual-role timeout requests TERM and retains the original failure',
  { skip: process.platform !== 'linux' },
  /** 本轮标记证明先收到正常TERM，正常退出不能把原超时改判成功。 */ async () => {
    const f = fixture('trap \': > "$2.term"; exit 0\' TERM\n: > "$2"\nwhile :; do /bin/sleep 0.02; done\n', {
      timeout: 250,
      killAfter: 1000
    })
    try {
      await until(f.marker + '.term')
      await assert.rejects(f.child.stop(), /dual_role_smoke_timeout/u)
      assert.equal(existsSync(`/proc/${f.child.child.pid}`), false)
    } finally {
      await f.close()
    }
  }
)

test(
  'dual-role ignored TERM requires bounded KILL and remains a failure',
  { skip: process.platform !== 'linux' },
  /** exec沿用本例唯一child与忽略TERM状态，不创建需要追踪或补杀的孙进程。 */ async () => {
    const f = fixture('trap "" TERM\n: > "$2"\nexec /bin/sleep 30\n', { timeout: 2000, killAfter: 100 })
    try {
      await until(f.marker)
      await assert.rejects(f.child.stop(), /dual_role_shutdown_timeout/u)
      assert.equal(existsSync(`/proc/${f.child.child.pid}`), false)
    } finally {
      await f.close()
    }
  }
)

test(
  'dual-role management timeout retains safe fetch diagnostics and remains unavailable',
  /** 使用原一秒请求期限触发真实取消；合成异常中的秘密不能进入最终失败。 */ async () => {
    const secret = 'synthetic-token-and-body-must-not-leak'
    const signal = AbortSignal.timeout(1000)
    const read = createDualRoleManagementRead(
      /* 不访问网络，直到同一个请求信号取消才拒绝。 */ async (_path, init) => {
        assert.equal(init.signal, signal)
        return new Promise(
          /* 仅产生取消失败，不构造任何成功HTTP响应。 */ (_resolve, reject) =>
            signal.addEventListener(
              'abort',
              /* 原异常消息和非错误码字段均含合成秘密，用于验证诊断投影。 */ () =>
                reject(Object.assign(new Error(secret), { code: 'ABORT_ERR', token: secret, body: secret })),
              { once: true }
            )
        )
      }
    )
    await assert.rejects(
      /* 请求仍走现有页面读取分类，不绕过失败适配器。 */ () => read('devices_get', { machine_id: secret }, signal),
      /* 只允许安全的三个诊断字段，最终错误继续拒绝且不携带原始异常。 */ (error) => {
        assert.equal(error.problem, 'unavailable')
        assert.deepEqual(Object.keys(error.smoke_fetch).sort(), ['aborted', 'code', 'elapsed_ms'])
        assert.equal(error.smoke_fetch.aborted, true)
        assert.equal(error.smoke_fetch.code, 'ABORT_ERR')
        assert(Number.isSafeInteger(error.smoke_fetch.elapsed_ms) && error.smoke_fetch.elapsed_ms >= 0)
        assert.equal(error.cause, undefined)
        assert.equal(JSON.stringify(error).includes(secret), false)
        assert.equal(error.stack.includes(secret), false)
        return true
      }
    )
  }
)

test(
  'dual-role management connection rejection retains only whitelisted codes and remains unavailable',
  /** 连接拒绝不误标成取消；嵌套错误码可读，未知码和原始秘密不出边界。 */ async () => {
    const secret = 'synthetic-token-and-body-must-not-leak'
    for (const code of ['ECONNREFUSED', secret]) {
      const signal = new AbortController().signal
      const read = createDualRoleManagementRead(
        /* 模拟fetch的嵌套连接错误，不记录URL、消息、token或正文。 */ async () => {
          throw new Error(secret, { cause: Object.assign(new Error(secret), { code, token: secret, body: secret }) })
        }
      )
      await assert.rejects(
        /* 合成设备名也不得出现在失败诊断里。 */ () => read('devices_get', { machine_id: secret }, signal),
        /* 未知错误码投影为空，不能让任意异常字符串混入CI输出。 */ (error) => {
          assert.equal(error.problem, 'unavailable')
          assert.deepEqual(Object.keys(error.smoke_fetch).sort(), ['aborted', 'code', 'elapsed_ms'])
          assert.equal(error.smoke_fetch.aborted, false)
          assert.equal(error.smoke_fetch.code, code === secret ? null : code)
          assert(Number.isSafeInteger(error.smoke_fetch.elapsed_ms) && error.smoke_fetch.elapsed_ms >= 0)
          assert.equal(error.cause, undefined)
          assert.equal(JSON.stringify(error).includes(secret), false)
          assert.equal(error.stack.includes(secret), false)
          return true
        }
      )
    }
  }
)

test('Connector release smoke accepts transport diagnostics and rejects unknown or secret output', () => {
  assertConnectorDiagnostics('')
  assertConnectorDiagnostics(
    'connector_transport connecting provider_ready=false\nconnector_transport ready provider_ready=true\n'
  )
  /* 断开诊断是独立行，允许有界四位关闭码与固定原因词；快速重连时可紧跟 ready 行。 */
  assertConnectorDiagnostics(
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect code=1008 close_reason=transport_closed\n' +
      'connector_disconnect close_reason=handshake_timeout\n' +
      'connector_transport ready provider_ready=true\n'
  )
  /* 同一采样窗口内两次断开必须允许连续两行诊断，且顺序为旧→新（更早的 1008 不被覆盖）。 */
  assertConnectorDiagnostics(
    'connector_transport ready provider_ready=true\n' +
      'connector_disconnect code=1008 close_reason=transport_closed\n' +
      'connector_disconnect code=1006 close_reason=transport_abnormal\n' +
      'connector_transport ready provider_ready=true\n'
  )
  assert.throws(() => assertConnectorDiagnostics('runtime_failed\n'))
  assert.throws(() => assertConnectorDiagnostics('Bearer (private): synthetic-secret\n'))
  /* 相位行不再附带关闭码，避免同一事件重复且避免 ready 行挂历史关闭码。 */
  assert.throws(() => assertConnectorDiagnostics('connector_transport disconnected provider_ready=false code=1008\n'))
  assert.throws(() => assertConnectorDiagnostics('connector_disconnect code=1008 close_reason=synthetic-secret\n'))
  /* 关闭码必须有界四位；任意长度或非数字的码都不属于固定诊断格式。 */
  assert.throws(() => assertConnectorDiagnostics('connector_disconnect code=10080 close_reason=transport_closed\n'))
  assert.throws(() => assertConnectorDiagnostics('connector_disconnect close_reason=transport_closed code=1008\n'))
})
