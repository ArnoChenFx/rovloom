/** 验证已有本机 Luvus 的 attach 拒绝边界；普通测试不下载 binary，不读取真实会话或凭据。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConnection, createServer, Socket } from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachExistingLuvus } from '../../../src/connector/luvus/host/native-attach.js'
import { observeLinuxLuvusProcess } from '../../../src/connector/luvus/host/native-process.js'
import { FIXED_LUVUS_SHA256 } from '../../../src/connector/luvus/host/native-control.js'
import { LuvusAdapterError } from '../../../src/connector/luvus/index.js'
import type { LuvusLocalConfig } from '../../../src/connector/luvus/index.js'

/** 使用自有私有目录与不会通过官方哈希检查的标记文件，避免普通测试依赖真实 native 安装。 */
function fixture() {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)), '.native-attach-')
  )
  const home = join(root, 'home')
  for (const path of ['state', 'project', 'home', 'home/config', 'home/data', 'home/cache', 'home/runtime']) {
    mkdirSync(join(root, path), { mode: 0o700 })
  }
  const binary = join(root, 'not-luvus')
  writeFileSync(binary, '#!/bin/sh\nexit 99\n', { mode: 0o500 })
  const config: LuvusLocalConfig = {
    target: { machine_id: 'machine1', provider_id: 'provider1', profile: 'session', session: 'fixedsession' },
    binding_revision: 1,
    config_ref: 'fixedconfig',
    binary,
    binary_sha256: FIXED_LUVUS_SHA256,
    state_root: join(root, 'state'),
    home,
    cwd: join(root, 'project'),
    transport: 'ipc'
  }
  return {
    root,
    config,
    /** 仅删除本测试创建的隔离目录。 */ close() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 错误只允许固定安全码，不把路径、原始 OS message 或内容泄露到上层。 */
function failure(code: string) {
  return /* 比较完整安全错误，而不是依赖底层异常文本。 */ (error: unknown) => {
    assert(error instanceof LuvusAdapterError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    return true
  }
}

test(
  'attach refuses CLI transport and changed installed bytes before executing commands',
  /** attach 不是缺 token 自动 Owner 回退，也不允许任意 binary 进入发现流程。 */ async () => {
    const f = fixture()
    try {
      await assert.rejects(
        attachExistingLuvus({ ...f.config, transport: 'cli' }),
        failure('native_attach_installation_unsupported')
      )
      await assert.rejects(
        attachExistingLuvus({ ...f.config, binary_sha256: '0'.repeat(64) }),
        failure('binary_identity_changed')
      )
      assert.deepEqual(readdirSync(f.config.state_root), [])
    } finally {
      f.close()
    }
  }
)

test(
  'attach hashes bytes before running schema or discovery and creates no ownership records',
  /** 标记脚本从未执行，也没有借 attach 创建/接管 managed root 标记。 */ async () => {
    const f = fixture()
    try {
      await assert.rejects(attachExistingLuvus(f.config), failure('binary_identity_changed'))
      assert.deepEqual(readdirSync(f.config.state_root), [])
      assert.deepEqual(readdirSync(f.config.cwd), [])
      assert.deepEqual(readdirSync(f.config.home).sort(), ['cache', 'config', 'data', 'runtime'])
    } finally {
      f.close()
    }
  }
)

test(
  'attach honors pre-aborted preparation without creating native state',
  /** 取消只结束本地准备，不生成标记或启动 native server。 */ async () => {
    const f = fixture()
    try {
      await assert.rejects(attachExistingLuvus(f.config, { signal: AbortSignal.abort() }), failure('native_cancelled'))
      assert.deepEqual(readdirSync(f.config.state_root), [])
    } finally {
      f.close()
    }
  }
)

test(
  'process observation rejects disconnected sockets and caller supplied PID properties',
  /** 实际 SO_PEERCRED 是唯一 PID 来源，普通对象字段不能建立观察。 */ () => {
    const f = fixture()
    const socket = new Socket()
    try {
      Object.assign(socket, { pid: process.pid, uid: process.geteuid!() })
      assert.throws(
        /* 未连接 socket 没有可用内核 peer。 */ () => observeLinuxLuvusProcess(socket, f.config),
        failure('linux_peer_unavailable')
      )
      assert.throws(
        /* JSON 形状不能替代实际 Socket。 */ () =>
          observeLinuxLuvusProcess({ pid: process.pid } as unknown as Socket, f.config),
        failure('linux_peer_unavailable')
      )
    } finally {
      socket.destroy()
      f.close()
    }
  }
)

test(
  'same-uid live Unix socket server cannot impersonate fixed Luvus argv exe cwd and environment',
  /** 用本测试进程提供真实 socket；即使 uid 相同、peer PID 真实，完整启动身份不符仍拒绝。 */ async () => {
    const f = fixture()
    const clients: Socket[] = []
    const server = createServer(/* 仅保留本测试连接以验证拒绝后原 server 仍活着。 */ (socket) => clients.push(socket))
    const address = join(f.config.state_root, 'impostor.sock')
    let socket: Socket | undefined
    try {
      await new Promise<void>(
        /* 只启动本轮自有 Unix socket。 */ (resolve, reject) => {
          server.once('error', reject)
          server.listen(address, resolve)
        }
      )
      chmodSync(address, 0o600)
      socket = createConnection(address)
      await new Promise<void>(
        /* 等实际连接完成后才读取内核 peer。 */ (resolve, reject) => {
          socket!.once('connect', resolve)
          socket!.once('error', reject)
        }
      )
      assert.throws(
        /* 拒绝只读观察不会终止真实 peer 进程。 */ () => observeLinuxLuvusProcess(socket!, f.config),
        failure('owned_process_identity_changed')
      )
      assert.equal(server.listening, true)
      assert.equal(socket.destroyed, false)
    } finally {
      socket?.destroy()
      for (const client of clients) {
        client.destroy()
      }
      await new Promise<void>(
        /* 只关闭测试自建 listener，不发送任何进程信号。 */ (resolve) =>
          server.close(/* 等待本轮自建 listener 释放 socket。 */ () => resolve())
      )
      f.close()
    }
  }
)
