/** 使用隔离 socket、受控 Bun 子进程和仓库证据验证 RPC 门禁、原生结果保真及产物兼容性。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConnectorCapacityError } from '../../../src/connector/capacity.js'
import { LuvusAdapterError, LuvusRpcAdapter, createLuvusCatalog } from '../../../src/connector/luvus/index.js'
import { parseRpcFrame, requestFrame } from '../../../src/connector/luvus/adapter.js'
import { inspectEndpoint, recheckEndpoint } from '../../../src/connector/luvus/local.js'
import { localLimits } from '../../../src/connector/luvus/local.js'
import { runFixedProcess } from '../../../src/connector/luvus/io.js'
import { bytes, clone, json } from './contract/helpers.js'
import { fixture } from './helpers.js'

/** 构造拒绝断言，检查安全错误码以及可选的派发结果语义。 */
function failure(code: string, outcome?: 'not_dispatched' | 'outcome_unknown') {
  return /* 核对 adapter 错误类型、码和可选结果，同时要求公开消息不携带附加内容。 */ (error: unknown) => {
    assert(error instanceof LuvusAdapterError)
    assert.equal(error.code, code)
    if (outcome) {
      assert.equal(error.outcome, outcome)
    }
    assert.equal(error.message, code)
    return true
  }
}

for (const method of ['task.add', 'terminal.backend.validate']) {
  test(
    'IPC uses full Wire/NativeValidator gates across method family: ' + method,
    /* 对普通和终端方法实际走自建 IPC，验证原生帧、错误保真及 attempt 去重。 */ async (t) => {
      const f = await fixture('ipc', method)
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      const result = await f.adapter.dispatch(f.input())
      assert.deepEqual(result.native_response, f.response)
      assert.equal(result.exit_code, null)
      assert.equal(f.state.claims, 1)
      const request = JSON.parse(f.received())
      assert.equal(request.id, f.binding.native_request_id)
      assert.equal(request.auth, 'test-only-token')
      assert.deepEqual(request.params, f.row.native_request.params)
      assert(f.received().endsWith('\n'))
      await assert.rejects(f.adapter.dispatch(f.input()), failure('attempt_already_observed'))
      assert.equal(f.state.responses, 1)
    }
  )
}

test(
  'fixed CLI preserves native error/data with exit 1 and keeps payload away from argv/env',
  /* 验证固定 CLI 保留原生 error.data，且请求内容只进入 stdin 而不污染 argv 或环境。 */ async (t) => {
    const f = await fixture('cli')
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.row.native_request.params = { title: '汉字 " ; $(touch never) /../../secret' }
    f.configure({ exit_code: 1 })
    const result = await f.adapter.dispatch(f.input())
    assert.deepEqual(result.native_response, f.response)
    assert.equal(result.exit_code, 1)
    assert.equal(result.stderr_bytes, 0)
    assert.deepEqual(f.observed().argv, ['--session', 'synthetic', 'uhp', 'proxy'])
    assert.equal(f.observed().env.LUVUS_HOME, f.stateRoot)
    assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, 'request.jsonl'), 'utf8')).params, f.row.native_request.params)
    assert.equal(existsSync(join(f.cwd, 'never')), false)
  }
)

test(
  'installed schema is the exact fixture bytes and stays separate from session discovery',
  /* 验证安装 schema 字节与仓库 fixture 一致，并确认 schema 读取独立于会话发现。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const result = await f.adapter.installedSchema('test-installed-1')
    assert.deepEqual(result.bytes, bytes)
    assert.equal(result.compiled.identity.binary_sha256, f.config.binary_sha256)
    assert.deepEqual(f.observed().argv, ['--session', 'synthetic', 'uhp', 'schema'])
    const endpoint = await f.adapter.discoverEndpoint()
    assert.equal(endpoint.address, f.endpoint)
    assert.deepEqual(f.observed().argv, ['--session', 'synthetic', 'session', 'list', '--json'])
    assert.equal(f.state.responses, 0)
    assert.equal(f.state.claims, 0)
  }
)

test(
  'endpoint identity detects an actual replacement socket before any request',
  /* 替换真实隔离 socket 后验证身份检查在任何请求写入前拒绝继续。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const original = await inspectEndpoint(f.config, f.endpoint)
    renameSync(f.endpoint, join(f.stateRoot, 'old.sock'))
    const replacement = createServer(
      /* 立即关闭替换 socket 的连接，本用例仅检验其路径身份变化。 */ (socket) => socket.destroy()
    )
    await new Promise<void>(
      /* 等待隔离替换 listener 就绪，启动失败时拒绝测试等待。 */ (resolve, reject) => {
        replacement.once('error', reject)
        replacement.listen(f.endpoint, resolve)
      }
    )
    chmodSync(f.endpoint, 0o600)
    try {
      await assert.rejects(recheckEndpoint(f.config, original), failure('endpoint_identity_changed'))
      assert.equal(f.state.claims, 0)
    } finally {
      await new Promise<void>(
        /* 等待替换 listener 完成关闭后再结束用例。 */ (resolve) =>
          replacement.close(/* 在替换 listener 关闭回调到达时结算清理等待。 */ () => resolve())
      )
    }
  }
)

test(
  'minimal child environment excludes inherited selectors and synthetic credentials',
  /* 用合成环境凭据验证子进程仅继承固定环境白名单。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const previous = process.env.ROVLOOM_TEST_CREDENTIAL
    process.env.ROVLOOM_TEST_CREDENTIAL = 'test-only-not-a-real-key'
    try {
      await f.adapter.discoverEndpoint()
      const env = f.observed().env
      assert.equal(env.ROVLOOM_TEST_CREDENTIAL, undefined)
      assert.equal(env.HOME, f.home)
      assert.equal(env.XDG_RUNTIME_DIR, join(f.home, 'runtime'))
      assert.equal(env.PATH, '/usr/bin:/bin')
    } finally {
      if (previous === undefined) {
        delete process.env.ROVLOOM_TEST_CREDENTIAL
      } else {
        process.env.ROVLOOM_TEST_CREDENTIAL = previous
      }
    }
  }
)

test(
  'caller id/auth and generic strict methods fail before local transport',
  /* 验证 caller 注入认证字段及未获严格许可的方法在 transport 启动前被拒绝。 */ async (t) => {
    const f = await fixture()
    const generic = await fixture('ipc', 'workspace.list')
    t.after(
      /* 顺序关闭本用例创建的两个 fixture，释放各自连接和私有目录。 */ async () => {
        await f.close()
        await generic.close()
      }
    )
    f.envelope.payload.native_request.auth = 'caller-token'
    await assert.rejects(f.adapter.dispatch(f.input()), failure('reserved_request_field'))
    assert.equal(existsSync(join(f.cwd, 'observed.json')), false)
    await assert.rejects(
      generic.adapter.dispatch(generic.input()),
      /* 要求未获严格许可的方法返回 schema 类错误，且无本地传输副作用。 */ (error: unknown) => {
        assert(error instanceof LuvusAdapterError)
        assert.match(error.code, /schema/)
        return true
      }
    )
    assert.equal(existsSync(join(generic.cwd, 'observed.json')), false)
  }
)

test(
  'identity proof hooks are mandatory; local_owner is never the fallback',
  /* 验证身份验证器缺失和认证为空都不能回退到 local_owner。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    delete f.host.verifyPeer
    await assert.rejects(f.adapter.dispatch(f.input()), failure('native_identity_verifier_required'))
    assert.equal(existsSync(join(f.cwd, 'observed.json')), false)
    f.host.verifyPeer = /* 仅为本用例自建 listener 返回合成 peer 身份，便于继续检验空认证门禁。 */ async () => ({
      pid: process.pid,
      uid: process.geteuid!(),
      gid: process.getegid!()
    })
    f.state.auth = ''
    await assert.rejects(f.adapter.dispatch(f.input()), failure('native_auth_required'))
    assert.equal(f.state.claims, 0)
    assert.equal(f.received(), '')
  }
)

test(
  'peer mismatch is rejected before auth/dispatch and sends no frame',
  /* 提供 uid 不匹配的合成 peer，验证任何认证和请求写入都尚未发生。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.host.verifyPeer = /* 故意返回错误 uid，使 adapter 的 peer 归属核验拒绝连接。 */ async () => ({
      pid: process.pid,
      uid: process.geteuid!() + 1,
      gid: process.getegid!()
    })
    await assert.rejects(f.adapter.dispatch(f.input()), failure('native_peer_mismatch', 'not_dispatched'))
    assert.equal(f.state.claims, 0)
    assert.equal(f.received(), '')
  }
)

for (const transport of ['ipc', 'cli'] as const) {
  test(
    'claim capacity diagnosis survives ' + transport + ' IO wrapping with resource and reclaim time',
    /* claim 门禁在写入前以容量不足拒绝时，IPC 与固定 CLI 两条 IO 路径都必须原样带回容量类别与最早回收时间，且不发送任何帧。 */ async (
      t
    ) => {
      const f = await fixture(transport)
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      f.host.claimDispatch = /* 在派发登记处直接以容量不足拒绝，模拟账本满额。 */ async () => {
        throw new ConnectorCapacityError('claim_entries', 1_234_567)
      }
      await assert.rejects(f.adapter.dispatch(f.input()), (error: unknown) => {
        assert(error instanceof ConnectorCapacityError)
        assert.equal(error.code, 'claim_capacity')
        assert.equal(error.outcome, 'not_dispatched')
        assert.deepEqual(error.capacity, { resource: 'claim_entries', reclaim_at: 1_234_567 })
        return true
      })
      assert.equal(f.received(), '')
    }
  )
}

test(
  'binary/source and complete provider target cannot be cross-bound',
  /* 验证二进制来源和完整 provider target 不能与已登记许可交叉绑定。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const mismatched = new LuvusRpcAdapter({ ...f.config, binary_sha256: 'a'.repeat(64) }, f.host)
    t.after(/* 释放用于错误二进制绑定检查的额外 Wire 实例。 */ () => mismatched.close())
    await assert.rejects(mismatched.dispatch(f.input()), failure('local_binding_mismatch'))
    const other = new LuvusRpcAdapter({ ...f.config, target: { ...f.config.target, provider_id: 'other' } }, f.host)
    t.after(/* 释放用于错误 provider 检查的额外 Wire 实例。 */ () => other.close())
    await assert.rejects(other.dispatch(f.input()), failure('local_binding_mismatch'))
    assert.equal(existsSync(join(f.cwd, 'observed.json')), false)
  }
)

test(
  'unsafe fixed session selectors and limit widening are refused',
  /* 验证固定会话选择器拒绝路径、选项和 shell 文本，同时禁止扩大限制。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    for (const session of ['../private', '--machine', '";touch x', 'a/b']) {
      assert.throws(
        /* 尝试用不安全会话构造 adapter，断言配置在启动任何命令前被拒绝。 */ () =>
          new LuvusRpcAdapter({ ...f.config, target: { ...f.config.target, session } }, f.host)
      )
    }
    assert.throws(
      /** 尝试扩大默认响应预算，断言本地限制校验拒绝配置。 */
      () => new LuvusRpcAdapter({ ...f.config, limits: { response_bytes: 1_048_577 } }, f.host),
      failure('invalid_local_limits')
    )
  }
)

test(
  'discovery rejects offline, duplicate, remote and escaping endpoints',
  /* 逐项验证离线、重复、远端及逃出状态根目录的发现条目均被拒绝。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const row = { name: 'synthetic', running: true, endpoint: { transport: 'unix_socket', address: f.endpoint } }
    for (const [sessions, code] of [
      [[{ ...row, running: false }], 'native_session_unavailable'],
      [[row, row], 'native_session_unavailable'],
      [[{ ...row, endpoint: { transport: 'tcp', address: '127.0.0.1:9999' } }], 'native_endpoint_unsupported'],
      [
        [{ ...row, endpoint: { transport: 'unix_socket', address: join(f.root, 'outside.sock') } }],
        'endpoint_outside_state_root'
      ],
      [
        [{ ...row, endpoint: { transport: 'unix_socket', address: f.stateRoot + '/../private.sock' } }],
        'local_path_invalid'
      ]
    ] as const) {
      f.configure({ listing: { sessions } })
      await assert.rejects(f.adapter.discoverEndpoint(), failure(code))
    }
  }
)

test(
  'socket symlinks, public modes and inode replacement fail closed',
  /* 验证 socket 符号链接、公开权限和身份戳改变均不能通过本地归属检查。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const link = join(f.stateRoot, 'link.sock')
    symlinkSync(f.endpoint, link)
    await assert.rejects(inspectEndpoint(f.config, link), failure('local_path_untrusted'))
    chmodSync(f.endpoint, 0o666)
    await assert.rejects(inspectEndpoint(f.config, f.endpoint), failure('local_path_untrusted'))
    chmodSync(f.endpoint, 0o600)
    const original = await inspectEndpoint(f.config, f.endpoint)
    await assert.rejects(
      recheckEndpoint(f.config, { ...original, stamp: original.stamp + 'changed' }),
      failure('endpoint_identity_changed')
    )
    chmodSync(f.stateRoot, 0o755)
    await assert.rejects(f.adapter.discoverEndpoint(), failure('local_path_untrusted'))
  }
)

test(
  'binary change after discovery is rejected before durable dispatch claim',
  /* 在认证等待期间修改受控二进制，验证 claim 和请求写入均未发生。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.host.nativeAuth = /* 模拟认证等待期间的安装替换，只返回测试认证串供来源复核拦截。 */ async () => {
      writeFileSync(f.binary, '#!/bin/false\n')
      return 'test-only-token'
    }
    await assert.rejects(f.adapter.dispatch(f.input()), failure('binary_identity_changed'))
    assert.equal(f.state.claims, 0)
    assert.equal(f.received(), '')
  }
)

test(
  'CLI binary changed by discovery is rejected before spawning proxy',
  /* 让发现命令修改自身受控入口，验证 CLI proxy 尚未启动即拒绝派发。 */ async (t) => {
    const f = await fixture('cli')
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.configure({ mutate_binary: f.binary })
    await assert.rejects(f.adapter.dispatch(f.input()), failure('binary_identity_changed', 'not_dispatched'))
    assert.deepEqual(f.observed().argv, ['--session', 'synthetic', 'session', 'list', '--json'])
    assert.equal(existsSync(join(f.cwd, 'request.jsonl')), false)
    assert.equal(f.state.claims, 0)
  }
)

test(
  'spawn failure stays separate from native error without invoking a shell fallback',
  /* 使用不存在的固定解释器制造 spawn 失败，验证没有 shell 回退。 */ async (t) => {
    const f = await fixture('cli')
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const script = '#!/rovloom-test-no-such-interpreter\n'
    writeFileSync(f.binary, script)
    const config = { ...f.config, binary_sha256: createHash('sha256').update(script).digest('hex') }
    await assert.rejects(
      runFixedProcess(config, localLimits(), 'proxy', new AbortController().signal),
      failure('native_spawn_error', 'not_dispatched')
    )
  }
)

test(
  'complete auth/id/LF frame budget is enforced before claiming dispatch',
  /* 验证完整 UTF-8、转义、id、认证和 LF 预算在 claim 前执行并接受恰好上限。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const req = { method: 'task.add', params: { title: '汉字 " \\ \n' } }
    const full = requestFrame(req, 'native_1', 'x'.repeat(256), 1000)
    assert.deepEqual(requestFrame(req, 'native_1', 'x'.repeat(256), full.length), full)
    assert.throws(
      /* 构造比最终帧少一字节的预算，断言完整帧被拒绝。 */ () =>
        requestFrame(req, 'native_1', 'x'.repeat(256), full.length - 1),
      failure('native_request_limit')
    )
    assert.throws(
      /* 提供包含换行的认证串，断言认证格式校验拒绝请求。 */ () => requestFrame(req, 'native_1', '\n', 1000),
      failure('native_auth_required')
    )
    f.state.auth = 'x'.repeat(256)
    const small = new LuvusRpcAdapter({ ...f.config, limits: { request_bytes: 128 } }, f.host)
    t.after(/* 释放仅用于收紧请求预算的额外 adapter。 */ () => small.close())
    await assert.rejects(small.dispatch(f.input()), failure('native_request_limit'))
    assert.equal(f.state.claims, 0)
    assert.equal(f.received(), '')
  }
)

test(
  'revocation during async auth is rechecked before sending',
  /* 在异步认证期间撤销 provider，验证发送前重新检查当前权限。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.host.nativeAuth = /* 模拟认证等待期间撤销 provider，然后返回测试串触发最终许可复核。 */ async () => {
      f.state.enabled = false
      return 'test-only-token'
    }
    await assert.rejects(
      f.adapter.dispatch(f.input()),
      /* 断言撤销导致 provider 错误且结果仍为未派发。 */ (error: unknown) => {
        assert(error instanceof LuvusAdapterError)
        assert.match(error.code, /provider/)
        assert.equal(error.outcome, 'not_dispatched')
        return true
      }
    )
    assert.equal(f.state.claims, 0)
    assert.equal(f.received(), '')
  }
)

test(
  'current result read gate blocks late content after revocation',
  /* 在响应到达前撤销读取权限，验证旧派发许可不能放行当前禁止的内容。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.respond(
      /* 先撤销当前读取权限再返回原生帧，模拟晚到结果的读取门禁。 */ (socket) => {
        f.state.read = false
        socket.end(JSON.stringify(f.response) + '\n')
      }
    )
    await assert.rejects(f.adapter.dispatch(f.input()), failure('forbidden', 'outcome_unknown'))
  }
)

test(
  'duplicate request cannot remove active cancellation state or replay native input',
  /* 验证重复请求不移除原活动取消状态，也不重放请求或重复 claim。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    let delivered!: /* 声明通知测试原生帧已到达的无参数回调。 */ () => void
    const written = new Promise<void>(
      /* 保存帧到达通知器，让取消断言等待真实写入完成。 */ (resolve) => {
        delivered = resolve
      }
    )
    f.respond(/* 通知测试请求帧已到达，并保持 socket 未回复以便检验取消。 */ () => delivered())
    const pending = f.adapter.dispatch(f.input())
    const cancelled = assert.rejects(pending, failure('native_cancelled', 'outcome_unknown'))
    await written
    f.envelope.message_id = 'duplicate-with-new-id'
    await assert.rejects(f.adapter.dispatch(f.input()), failure('attempt_already_observed'))
    assert.equal(f.adapter.cancel(f.cancel()), true)
    await cancelled
    assert.equal(f.state.responses, 1)
    assert.equal(f.state.claims, 1)
    assert.equal(f.adapter.cancel(f.cancel()), false)
  }
)

test(
  'local wait deadline after write is unknown and does not retry native work',
  /* 在请求已写入后等待超时，验证结果未知且不自动重试原生工作。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.respond(/* 故意保持请求无响应，制造写入后的本地等待超时。 */ () => {})
    const adapter = new LuvusRpcAdapter({ ...f.config, limits: { timeout_ms: 1000 } }, f.host)
    t.after(/* 超时断言结束后释放额外 adapter 的 Wire 维护资源。 */ () => adapter.close())
    await assert.rejects(adapter.dispatch(f.input()), failure('native_timeout', 'outcome_unknown'))
    assert.equal(f.state.responses, 1)
    assert.equal(f.state.claims, 1)
  }
)

test(
  'pre-aborted and stalled peer verification remain not_dispatched',
  /* 验证预取消和永久等待的 peer 验证都不会 claim 或发送原生帧。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(f.adapter.dispatch(f.input(), abort.signal), failure('native_cancelled', 'not_dispatched'))
    const fresh = new LuvusRpcAdapter({ ...f.config, limits: { timeout_ms: 1000 } }, f.host)
    t.after(/* 释放单独验证停滞 peer 等待的额外 adapter。 */ () => fresh.close())
    f.envelope.message_id = 'fresh'
    f.host.verifyPeer = /* 返回永不完成的 peer 验证，检验等待期限能中断派发前准备。 */ () =>
      new Promise(/* 故意不结算验证 promise，使测试只依赖 adapter 的等待期限退出。 */ () => {})
    await assert.rejects(fresh.dispatch(f.input()), failure('native_timeout', 'not_dispatched'))
    assert.equal(f.state.claims, 0)
    assert.equal(f.received(), '')
  }
)

test(
  'CLI timeout kills only the owned bridge and keeps outcome unknown',
  /* 运行忽略 SIGTERM 的受控桥接进程，验证超时仅清理自有子进程且保留结果未知。 */ async (t) => {
    const f = await fixture('cli')
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    f.configure({ mode: 'hang' })
    let pid = 0
    f.host.verifyProxy = /* 记录本用例启动的代理 pid，供超时后验证该自有进程已被清理。 */ async (child) => {
      pid = child.pid!
    }
    const adapter = new LuvusRpcAdapter({ ...f.config, limits: { timeout_ms: 1000 } }, f.host)
    t.after(/* CLI 超时断言结束后释放额外 adapter 的 Wire 维护资源。 */ () => adapter.close())
    await assert.rejects(adapter.dispatch(f.input()), failure('native_timeout', 'outcome_unknown'))
    assert(pid > 0)
    assert.throws(/* 仅探测本用例记录的子进程 pid，断言清理后该进程已经不存在。 */ () => process.kill(pid, 0))
    assert.equal(f.state.claims, 1)
  }
)

for (const [mode, code] of [
  ['overflow', 'native_stdout_limit'],
  ['stderr', 'native_stderr_limit'],
  ['raw', 'native_process_exit']
] as const) {
  test(
    'CLI stdout/stderr overflow and unexpected exit are separate bounded failures: ' + mode,
    /* 每种失败独立创建和释放fixture，保留原断言及5秒期限，不把三次启动挤入一个用例。 */ async (t) => {
      const f = await fixture('cli')
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      f.configure({ mode, raw: JSON.stringify(f.response) + '\n', exit_code: 9 })
      await assert.rejects(f.adapter.dispatch(f.input()), failure(code, 'outcome_unknown'))
    }
  )
}

for (const [reply, code] of [
  ['x'.repeat(513), 'native_stdout_limit'],
  [JSON.stringify({ id: 'native_1', result: {} }), 'native_framing_invalid']
] as const) {
  test(
    'IPC stdout overflow and missing final LF are rejected without partial content: ' + code,
    /* 每种IPC边界独立运行并清理fixture，不改变载荷、错误断言或5秒测试期限。 */ async (t) => {
      const f = await fixture()
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      const adapter = new LuvusRpcAdapter({ ...f.config, limits: { response_bytes: 512 } }, f.host)
      t.after(/* 为每个输出边界分别释放额外 adapter，避免保留私有 Wire。 */ () => adapter.close())
      f.respond(/* 向自建 socket 写入当前边界用例的受控原始响应后结束连接。 */ (socket) => socket.end(reply))
      await assert.rejects(adapter.dispatch(f.input()), failure(code, 'outcome_unknown'))
    }
  )
}

test(
  'P0 CLI frames retain native IDs/errors; malformed and multi-frame outputs fail',
  /* 重放仓库 P0 文本帧检验原生 id 与 error 保真，并拒绝多帧、重复键和非法 UTF-8。 */ () => {
    const transcript = json('transcript.json') as Array<{ label?: string; stdout?: string }>
    for (const label of ['proxy-ping', 'proxy-unknown-method', 'native-wait-timeout']) {
      const row = transcript.find(
        /* 在仓库 transcript 中定位指定标签的原生 CLI 输出。 */ (entry) => entry.label === label
      )!
      assert.deepEqual(parseRpcFrame(Buffer.from(row.stdout!), 1_048_576), JSON.parse(row.stdout!))
    }
    for (const raw of ['{}', '{}\r\n', '{}\n{}\n', '{}\n ', '{\n']) {
      assert.throws(
        /* 解析缺失或错误 framing 的受控帧，断言解析器拒绝输出。 */ () => parseRpcFrame(Buffer.from(raw), 1000),
        LuvusAdapterError
      )
    }
    for (const raw of ['{"id":"x","id":"y"}\n', '{"result":9007199254740993}\n']) {
      assert.throws(
        /* 解析重复键或不安全整数的受控帧，断言原生 JSON 规则拒绝输出。 */ () => parseRpcFrame(Buffer.from(raw), 1000),
        LuvusAdapterError
      )
    }
    assert.throws(
      /* 解析包含无效 UTF-8 字节的受控帧，断言不会容错替换字符。 */ () =>
        parseRpcFrame(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]), 1000),
      LuvusAdapterError
    )
  }
)

test(
  'catalog pagination is scoped by complete binding/query and invalidates on source changes',
  /* 验证目录游标绑定完整来源和查询，来源变化后禁止继续返回方法描述。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const current = clone(f.source())
    const catalog = createLuvusCatalog(f.compiled, f.capabilities, current, {
      now: /* 返回可控测试时间，供目录期限与单调性检查使用。 */ () => f.state.now,
      current: /* 返回本用例可变的完整来源，模拟运行期间绑定改变。 */ () => current,
      expires_at: 200
    })
    const first = catalog.list({ limit: 2 })
    assert.equal(first.methods.length, 2)
    assert(first.next_cursor)
    assert.equal(catalog.list({ limit: 2, cursor: first.next_cursor }).methods.length, 2)
    assert.throws(
      /** 把旧查询游标用于新查询，断言游标作用域校验拒绝读取。 */
      () => catalog.list({ query: 'terminal', cursor: first.next_cursor! }),
      failure('invalid_catalog_cursor')
    )
    assert.equal(catalog.describe('task.add').method, 'task.add')
    current.binding = { ...current.binding, provider_id: 'other' }
    assert.throws(
      /* 在 provider 来源改变后读取目录，断言能力视图立即失效。 */ () => catalog.list(),
      failure('capability_stale')
    )
  }
)

test(
  'catalog checks generation, epoch, policy, binary, expiry and monotonic time independently',
  /* 逐项改变 generation、epoch、策略、安装身份及时间，验证目录均按当前来源失效。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    for (const key of [
      'server_generation',
      'connection_epoch',
      'capability_revision',
      'caller_policy_revision',
      'local_policy_revision',
      'classification_revision'
    ] as const) {
      const current = clone(f.source())
      const catalog = createLuvusCatalog(f.compiled, f.capabilities, current, {
        now: /* 返回可控测试时间，供目录期限与单调性检查使用。 */ () => f.state.now,
        current: /* 返回本轮可变来源，供逐字段失效断言使用。 */ () => current,
        expires_at: 200
      })
      current.binding = { ...current.binding, [key]: 'changed' }
      assert.throws(
        /* 在单个绑定字段改变后查询方法描述，断言旧目录失效。 */ () => catalog.describe('task.add'),
        failure('capability_stale')
      )
    }
    const current = clone(f.source())
    const catalog = createLuvusCatalog(f.compiled, f.capabilities, current, {
      now: /* 返回可控测试时间，供回退和到期边界断言使用。 */ () => f.state.now,
      current: /* 返回本用例可变完整来源，供安装身份变更断言使用。 */ () => current,
      expires_at: 200
    })
    catalog.list()
    f.state.now = 99
    assert.throws(
      /* 在宿主时钟回退后读取目录，断言拒绝返回旧能力。 */ () => catalog.list(),
      failure('capability_stale')
    )
    f.state.now = 200
    assert.throws(/* 在目录恰好到期时读取，断言期限边界拒绝内容。 */ () => catalog.list(), failure('capability_stale'))
    f.state.now = 100
    current.binding = { ...current.binding, contract: { ...current.binding.contract, binary_sha256: 'a'.repeat(64) } }
    assert.throws(
      /* 在二进制身份改变后读取目录，断言来源绑定校验拒绝内容。 */ () => catalog.list(),
      failure('capability_stale')
    )
  }
)

test(
  'new adapter entry builds as Bun ESM and artifact preserves native validator handle identity',
  /* 实际构建 Bun ESM 并运行隔离产物，验证原生编译句柄在 adapter 与目录间保持一致。 */ async (t) => {
    const f = await fixture()
    t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
    const outdir = join(f.root, 'artifact')
    const env = { PATH: '/usr/bin:/bin', HOME: f.home, LANG: 'C.UTF-8' }
    const build = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        `const {compilerWorkerPlugin} = await import(${JSON.stringify(new URL('../../../scripts/connector/worker-plugin.mjs', import.meta.url).href)});
        const built = await Bun.build({entrypoints: [${JSON.stringify(fileURLToPath(new URL('../../../src/connector/luvus/index.ts', import.meta.url)))}], target:'bun', format:'esm', outdir:${JSON.stringify(outdir)}, plugins:[await compilerWorkerPlugin()]});
        if(!built.success) throw new AggregateError(built.logs, 'artifact build failed')`
      ],
      { env, encoding: 'utf8', timeout: 30_000 }
    )
    assert.ifError(build.error)
    assert.equal(build.status, 0, build.stdout + build.stderr)
    const code = `
    const api = await import(${JSON.stringify(pathToFileURL(join(outdir, 'index.js')).href)})
    const config = ${JSON.stringify(f.config)}
    const adapter = new api.LuvusRpcAdapter(config, { backend: {} })
    const schema = await adapter.installedSchema('artifact-1')
    const source = ${JSON.stringify(f.source())}
    source.binding.contract = schema.compiled.identity
    const catalog = api.createLuvusCatalog(schema.compiled, ${JSON.stringify(f.capabilities)}, source,
      { now: /* 返回固定产物测试时间。 */ () => 100, current: /* 返回产物编译句柄所绑定的测试来源。 */ () => source, expires_at: 200 })
    console.log(JSON.stringify({ bytes: schema.bytes.length, method: catalog.describe('task.add').method }))
  `
    const smoke = spawnSync(process.execPath, ['--no-env-file', '-e', code], { env, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(smoke.error)
    assert.equal(smoke.status, 0, smoke.stdout + smoke.stderr)
    assert.deepEqual(JSON.parse(smoke.stdout), { bytes: bytes.length, method: 'task.add' })
  }
)
