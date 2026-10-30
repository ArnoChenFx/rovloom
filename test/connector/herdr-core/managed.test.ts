/**
 * managed core：私有目录、二进制发现、拉起参数（绝不走 hc）与环境。
 * 只验证拉起与等待策略；真实 core 的 managed 全链路在 e2e 里覆盖。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import {
  ensureHerdrCoreManaged,
  findHerdrCoreBinary,
  herdrCoreManagedDirs,
  herdrCoreManagedEnv
} from '../../../src/connector/herdr-core/managed.js'

/** 运行目录（套接字所在）默认落在 XDG_RUNTIME_DIR 或 /tmp：改到本文件自己的沙箱，测完整体删除，不在外面留 rovloom-hc-*。 */
const sandbox = mkdtempSync(join(tmpdir(), 'rhc-run-'))
chmodSync(sandbox, 0o700)
const previousRuntime = process.env.XDG_RUNTIME_DIR
process.env.XDG_RUNTIME_DIR = sandbox
after(() => {
  if (previousRuntime === undefined) {
    delete process.env.XDG_RUNTIME_DIR
  } else {
    process.env.XDG_RUNTIME_DIR = previousRuntime
  }
  rmSync(sandbox, { recursive: true, force: true })
})

function root(): string {
  return mkdtempSync(join(tmpdir(), 'rovloom-hc-managed-'))
}

/** 一个真实的 Unix 套接字文件；isSocket() 需要真的 socket。 */
async function listen(path: string): Promise<Server> {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return server
}

test('managed 目录是私有的、路径够短，socket 落在私有运行目录里', () => {
  const directory = root()
  try {
    const dirs = herdrCoreManagedDirs({ state_dir: join(directory, 'state-root'), session: 'rovloom' })
    assert.equal(dirs.session, 'rovloom')
    assert(dirs.socket.startsWith(dirs.run + '/herdr-core/'))
    // 107 字节上限还要给 holder 套接字留 9 字节。
    assert(dirs.socket.length + 9 + '.holder.'.length < 107, dirs.socket)
    assert(dirs.state.startsWith(join(directory, 'state-root')))
    assert(dirs.config.startsWith(join(directory, 'state-root')))
    // 已存在的非 0700 目录不被修复、直接拒绝。
    const other = root()
    try {
      const stateRoot = join(other, 's')
      const state = join(stateRoot, 'managed', 'herdr-core', 'state')
      mkdirSync(state, { recursive: true, mode: 0o755 })
      chmodSync(state, 0o755)
      assert.throws(
        () => herdrCoreManagedDirs({ state_dir: stateRoot, session: 'rovloom' }),
        /herdr_core_managed_directory_untrusted/u
      )
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('二进制只从显式目录或 PATH 里找，找不到就拒绝', () => {
  const directory = root()
  try {
    const binary = join(directory, 'herdr-core')
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o700)
    assert.equal(findHerdrCoreBinary({ runtime_bin_dirs: [directory] }), binary)
    // 显式目录优先，不会被 PATH 里的同名程序顶替。
    assert.equal(findHerdrCoreBinary({ runtime_bin_dirs: [directory], path: '/nonexistent' }), binary)
    assert.equal(findHerdrCoreBinary({ path: directory }), binary)
    assert.throws(() => findHerdrCoreBinary({ runtime_bin_dirs: ['/nonexistent'] }), /herdr_core_binary_unavailable/u)
    assert.throws(() => findHerdrCoreBinary({ path: '/nonexistent' }), /herdr_core_binary_unavailable/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('拉起环境只给 core 需要的最小集合，身份变量逐个显式设定', () => {
  const directory = root()
  try {
    const dirs = herdrCoreManagedDirs({ state_dir: join(directory, 's'), session: 'rovloom' })
    const env = herdrCoreManagedEnv(dirs)
    assert.equal(env.XDG_RUNTIME_DIR, dirs.run)
    assert.equal(env.XDG_STATE_HOME, dirs.state)
    assert.equal(env.XDG_CONFIG_HOME, dirs.config)
    assert.equal(env.HC_SESSION, 'rovloom')
    // 不透传宿主的环境变量（只保留最小集合）。
    for (const key of ['ROVLOOM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS']) {
      assert.equal(Object.hasOwn(env, key), false)
    }
    // core 启动的终端继承这份环境：PATH 固定系统路径，只被 agent_bin_dirs 前置（与 Luvus、Herdr 一致）。
    assert.equal(env.PATH, '/usr/bin:/bin')
    assert.equal(
      herdrCoreManagedEnv(dirs, ['/opt/agents/bin', '/home/u/tools']).PATH,
      '/opt/agents/bin:/home/u/tools:/usr/bin:/bin'
    )
    assert.throws(() => herdrCoreManagedEnv(dirs, ['relative/bin']), /agent_bin_dirs_invalid/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('managed 直接 exec `herdr-core serve`，不调用 hc；已有套接字时不重复拉起', async () => {
  const directory = root()
  const servers: Server[] = []
  try {
    const dirs = herdrCoreManagedDirs({ state_dir: join(directory, 's'), session: 'rovloom' })
    const calls: { binary: string; argv: readonly string[]; detached?: boolean; env?: Record<string, string> }[] = []
    const spawnProcess = ((
      binary: string,
      argv: readonly string[],
      options: { detached?: boolean; env?: Record<string, string> }
    ) => {
      calls.push({ binary, argv, detached: options.detached, env: options.env })
      // 模拟 serve：稍后创建套接字，而不是真的拉起 core。
      setTimeout(() => {
        void listen(dirs.socket).then((server) => servers.push(server))
      }, 50)
      return { on: () => {}, unref: () => {}, exitCode: null } as never
    }) as never
    await ensureHerdrCoreManaged({ dirs, binary: join(directory, 'herdr-core'), spawnProcess })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.argv, ['serve'])
    assert.equal(calls[0]!.binary, join(directory, 'herdr-core'))
    assert(!calls[0]!.binary.endsWith('hc'))
    assert.equal(calls[0]!.detached, true)
    assert.equal(calls[0]!.env?.HC_SESSION, 'rovloom')
    // 已有套接字：不再拉起第二个实例。
    await ensureHerdrCoreManaged({ dirs, binary: join(directory, 'herdr-core'), spawnProcess })
    assert.equal(calls.length, 1)
  } finally {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('agent_bin_dirs 经 ensure 前置到被拉起 core 的 PATH', async () => {
  const directory = root()
  try {
    const dirs = herdrCoreManagedDirs({ state_dir: join(directory, 's'), session: 'rovloom' })
    let seen: string | undefined
    const spawnProcess = ((_binary: string, _argv: readonly string[], options: { env?: Record<string, string> }) => {
      seen = options.env?.PATH
      return { on: () => {}, unref: () => {}, exitCode: 0 } as never
    }) as never
    await assert.rejects(
      ensureHerdrCoreManaged({
        dirs,
        binary: join(directory, 'herdr-core'),
        spawnProcess,
        timeout_ms: 100,
        agent_bin_dirs: ['/opt/agents/bin']
      }),
      /herdr_core_managed_start_failed/u
    )
    assert.equal(seen, '/opt/agents/bin:/usr/bin:/bin')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('残留的陈旧套接字文件不算就绪：core 被杀光后仍会重新拉起 serve', async () => {
  const directory = root()
  const servers: Server[] = []
  try {
    const dirs = herdrCoreManagedDirs({ state_dir: join(directory, 's'), session: 'rovloom' })
    mkdirSync(dirname(dirs.socket), { recursive: true, mode: 0o700 })
    // 真实的残留：子进程绑定套接字后被 SIGKILL，文件留在原地但没人在听（与 core 与 holder 被杀光一致）。
    spawnSync(process.execPath, [
      '--no-env-file',
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(dirs.socket)}, () => process.kill(process.pid, 'SIGKILL'))`
    ])
    assert.equal(lstatSync(dirs.socket).isSocket(), true, '夹具没有留下陈旧套接字文件')
    let calls = 0
    const spawnProcess = (() => {
      calls += 1
      // 模拟 serve 接管陈旧套接字：先清掉旧文件，再真正监听。
      setTimeout(() => {
        rmSync(dirs.socket, { force: true })
        void listen(dirs.socket).then((server) => servers.push(server))
      }, 50)
      return { on: () => {}, unref: () => {}, exitCode: null } as never
    }) as never
    await ensureHerdrCoreManaged({ dirs, binary: join(directory, 'herdr-core'), spawnProcess })
    assert.equal(calls, 1, '陈旧套接字被当成了就绪，没有重新拉起')
  } finally {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('等不到套接字时给固定码，不无限等', async () => {
  const directory = root()
  try {
    const dirs = herdrCoreManagedDirs({ state_dir: join(directory, 's'), session: 'rovloom' })
    const spawnProcess = (() => ({ on: () => {}, unref: () => {}, exitCode: 0 }) as never) as never
    await assert.rejects(
      ensureHerdrCoreManaged({ dirs, binary: join(directory, 'herdr-core'), spawnProcess, timeout_ms: 150 }),
      /herdr_core_managed_start_failed/u
    )
    await pause(10)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
