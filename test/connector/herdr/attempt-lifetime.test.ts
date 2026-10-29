/** 真实 Herdr runtime 入口的容量回归；安装是自有 Python 模拟进程，唯一 claim 被显式拒绝，没有 native RPC 或模型调用。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DispatchClaims } from '../../../src/connector/claims.js'
import { ConnectorCapacityError } from '../../../src/connector/capacity.js'
import { observeHerdrServer } from '../../../src/connector/herdr/attach.js'
import { HerdrInstallation } from '../../../src/connector/herdr/installation.js'
import { herdrEnvironment, pinHerdrConfig } from '../../../src/connector/herdr/local.js'
import { createHerdrRuntime } from '../../../src/connector/herdr/runtime.js'
import { contractRef } from '../../../src/wire/index.js'
import { backendFixture, raw } from './helpers.js'
import { privateHerdrTestRoot } from './private-root.js'

test(
  'one Herdr runtime releases its 4096 protected observations only after the original deadlines',
  { skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 120_000 },
  /** Linux peer 测量仍使用真实内核和已安装可执行文件，合成 claim 拒绝不代证 Herdr 原生成功。 */ async () => {
    const root = privateHerdrTestRoot('.herdr-attempt-lifetime-')
    const state = backendFixture()
    state.binding.target.session = 'default'
    for (const name of ['home', 'config', 'state', 'cache', 'tmp', 'work', 'bin']) {
      mkdirSync(join(root, name), { mode: 0o700 })
    }
    mkdirSync(join(root, 'config', 'herdr'), { mode: 0o700 })
    const binary = join(root, 'bin', 'herdr')
    copyFileSync('/usr/bin/python3', binary)
    chmodSync(binary, 0o700)
    writeFileSync(join(root, 'work', 'schema.json'), raw, { mode: 0o600 })
    writeFileSync(join(root, 'work', 'api'), 'import sys\nsys.stdout.buffer.write(open("schema.json","rb").read())\n', {
      mode: 0o600
    })
    writeFileSync(
      join(root, 'work', 'server'),
      'import socket,os\ns=socket.socket(socket.AF_UNIX)\np=os.environ["XDG_CONFIG_HOME"]+"/herdr/herdr.sock"\ns.bind(p)\nos.chmod(p,0o600)\ns.listen(8)\nprint("up",flush=True)\nwhile True:\n c,_=s.accept()\n while c.recv(65536): pass\n c.close()\n',
      { mode: 0o600 }
    )
    const config = pinHerdrConfig({
      target: { ...state.binding.target, profile: 'session', session: 'default' },
      binding_revision: 1,
      config_ref: 'config1',
      binary,
      home: join(root, 'home'),
      config_home: join(root, 'config'),
      state_home: join(root, 'state'),
      cache_home: join(root, 'cache'),
      temporary_home: join(root, 'tmp'),
      cwd: join(root, 'work'),
      attach: true
    })
    const child = spawn(binary, ['server'], {
      cwd: config.cwd,
      env: herdrEnvironment(config),
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let installation: HerdrInstallation | undefined
    let claims: DispatchClaims | undefined
    let runtime: ReturnType<typeof createHerdrRuntime> | undefined
    let now = 100
    let refusedClaims = 0
    let cancelBeforeIo = false
    let activeRequest: AbortController | undefined
    try {
      await once(child.stdout!, 'data')
      installation = await HerdrInstallation.open(config, await observeHerdrServer(config))
      const installed = installation
      const record = installation.record()
      state.binding.contract_ref = contractRef(record.wire.source)
      state.context.resolveContract = /** 只交付这个实际模拟安装编译出的完整根。 */ () => record.wire
      state.backend.contract = /** 与当前受信安装共用不可复制的 Worker 编译句柄。 */ () => record
      state.backend.nativeSource = /** 使用真实安装对象签发的来源，不能用 JSON 伪造安装 token。 */ (binding) =>
        installed.source(binding)
      state.backend.now = /** 为期限边界提供独立、受控墙钟。 */ () => now
      state.backend.responseAnchor = /** 锚点来自本测试的完整原登记，不从请求续期。 */ () => ({
        binding: state.binding,
        method: 'ping',
        mode: 'strict',
        state: 'dispatching',
        content_status: 'available',
        content_expires_at: state.binding.registration.deadline,
        dedup_expires_at: state.binding.registration.deadline
      })
      claims = new DispatchClaims({
        path: join(root, 'claims.sqlite'),
        mode: 'create',
        ledger_id: 'synthetic_herdr_history',
        limits: { entries: 1, bytes: 262_144 },
        /** 同一个受控宿主时钟用于真实 SQLite 元数据。 */ now: () => now
      })
      claims.claim = /** 每次都在原生写入前拒绝，只测入口防重索引，不创建成功 claim。 */ () => {
        refusedClaims++
        throw new ConnectorCapacityError('claim_entries', 600_100)
      }
      const originalContext = state.backend.context
      state.backend.context = /** 模拟验证期间由受信 owner 取消；合法准入仍须完成，后续 IO 必须拒绝。 */ (...args) => {
        if (cancelBeforeIo) {
          activeRequest?.abort('cancelled')
        }
        return originalContext(...args)
      }
      runtime = createHerdrRuntime(installed, state.backend, claims)
      /** 合成 Gateway 使用独立新 ID，锚点与 Wire 必须同时匹配。 */
      function intent(index: number, deadline: number): string {
        state.binding.call_id = 'history_call_' + index
        state.binding.native_request_id = 'history_native_' + index
        state.binding.registration.deadline = deadline
        const { machine_id, recovery_generation, connection_epoch, ...attempt } = state.binding
        return JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'request',
          message_id: 'history_message_' + index,
          machine_id,
          recovery_generation,
          connection_epoch,
          payload: {
            attempt,
            expected_binding_revision: 1,
            validation: 'strict',
            native_request: { method: 'ping', params: {} }
          }
        })
      }
      /** 每次都进入实际 executeWire，执行后按 transport 的责任释放同一 core 的许可。 */
      async function refused(input: string, code: string): Promise<void> {
        try {
          activeRequest = new AbortController()
          await assert.rejects(runtime!.executeWire(input, activeRequest.signal), (error: unknown) => {
            assert(error instanceof Error)
            assert.match(error.message, new RegExp(code))
            if (code === 'claim_capacity') {
              assert(error instanceof ConnectorCapacityError)
              assert.deepEqual(error.capacity, { resource: 'claim_entries', reclaim_at: 600_100 })
            }
            return true
          })
        } finally {
          runtime!.adapter.release(state.binding)
        }
      }
      let original = ''
      let originalBinding = structuredClone(state.binding)
      for (let index = 0; index < 4096; index++) {
        const input = intent(index, 600_100)
        if (index === 0) {
          original = input
          originalBinding = structuredClone(state.binding)
        }
        await refused(input, index === 0 ? 'claim_capacity' : 'herdr_cancelled')
        cancelBeforeIo = true
      }
      assert.equal(refusedClaims, 1)
      await refused(intent(4096, 600_100), 'herdr_runtime_limit')
      assert.equal(refusedClaims, 1)
      now = 600_100
      await refused(intent(4097, now + 10_000), 'herdr_cancelled')
      assert.equal(refusedClaims, 1)
      cancelBeforeIo = false
      Object.assign(state.binding, originalBinding)
      // 原保留锚点到期即拒绝，不能通过回收索引再次进入 claim 或 native 写入。
      await refused(original, 'attempt_anchor_unavailable')
      assert.equal(refusedClaims, 1)
    } finally {
      runtime?.close()
      claims?.close()
      installation?.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'close')
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
)
