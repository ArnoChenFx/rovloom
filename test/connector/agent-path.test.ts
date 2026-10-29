/** 验证本地 Agent 目录、两个 provider 环境与原进程归属检查；只执行自有合成程序。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  agentSearchPath,
  effectiveBinDirectories,
  inheritedPathDirectories
} from '../../src/connector/local/agent-path.js'
import { childEnvironment, pinConfig } from '../../src/connector/luvus/local.js'
import { herdrEnvironment, pinHerdrConfig } from '../../src/connector/herdr/local.js'
import { OwnedNativeProcess } from '../../src/connector/luvus/host/native-process.js'
import { LuvusRpcAdapter } from '../../src/connector/luvus/adapter.js'
import { fixture } from './luvus/helpers.js'
import { G, validator, view, rejects } from './luvus/contract/helpers.js'

test(
  'Agent directories keep default PATH and use platform-specific absolute path rules',
  /** 配置不是任意 PATH 字符串；未配置保持原值，显式目录按平台分隔符依次前置且不展开变量。 */ () => {
    assert.equal(agentSearchPath(undefined, '/usr/bin:/bin'), '/usr/bin:/bin')
    assert.equal(
      agentSearchPath(['/home/owned/Agent Tools/bin', '/opt/other/bin'], '/usr/bin:/bin', 'linux'),
      '/home/owned/Agent Tools/bin:/opt/other/bin:/usr/bin:/bin'
    )
    assert.equal(
      agentSearchPath(['C:\\Users\\owned\\Agent Tools\\bin', 'D:\\tools'], 'C:\\Windows\\System32', 'win32'),
      'C:\\Users\\owned\\Agent Tools\\bin;D:\\tools;C:\\Windows\\System32'
    )
    for (const directories of [
      '',
      '/single/string/is/not/a/list',
      null,
      true,
      [],
      {},
      [''],
      [null],
      ['relative/bin'],
      ['~/.local/bin'],
      ['$HOME/bin'],
      ['/home/owned/../bin'],
      ['/home/owned/bin/'],
      ['/one:/two'],
      ['/same', '/same'],
      ['/ok', '/bad\npath'],
      ['/bad\0path'],
      Array.from({ length: 17 }, (_, index) => '/d' + index)
    ]) {
      assert.throws(
        /** 非规范目录、非数组、重复项、超量及控制字符均不能改变启动环境。 */ () =>
          agentSearchPath(directories, '/usr/bin:/bin', 'linux'),
        /agent_bin_dirs_invalid/
      )
    }
    assert.throws(
      /** Windows 的路径列表也不能伪装成单个目录。 */ () => agentSearchPath(['C:\\one;C:\\two'], '', 'win32'),
      /agent_bin_dirs_invalid/
    )
  }
)

test(
  'inherited PATH keeps only existing, normalized, non-writable directories owned by root or the current user',
  /** 默认从启动 PATH 找程序，但可写目录、相对条目和不存在的目录不能进入固化的搜索路径。 */ async () => {
    const f = await fixture()
    try {
      const safe = join(f.root, 'safe')
      const safeToo = join(f.root, 'safe-too')
      const writable = join(f.root, 'writable')
      for (const directory of [safe, safeToo, writable]) {
        mkdirSync(directory, { mode: 0o700 })
      }
      chmodSync(writable, 0o777)
      const file = join(f.root, 'plain-file')
      writeFileSync(file, '', { mode: 0o600 })
      const link = join(f.root, 'link')
      symlinkSync(safe, link)
      const path = [safe, '', 'relative/bin', join(f.root, 'missing'), writable, file, link, safe, safeToo].join(':')
      // 符号链接条目（含 usrmerge 的 /bin）、可写目录、文件与相对条目均被跳过。
      assert.deepEqual(inheritedPathDirectories(path, 'linux'), [safe, safeToo])
      // 固定系统目录本来就是兜底 PATH；显式目录永远排在继承条目之前。
      assert.deepEqual(effectiveBinDirectories(undefined, path + ':/usr/bin', 'linux'), [safe, safeToo])
      assert.deepEqual(effectiveBinDirectories([safeToo, '/opt/explicit'], path, 'linux'), [
        safeToo,
        '/opt/explicit',
        safe
      ])
      assert.deepEqual(effectiveBinDirectories(undefined, '', 'linux'), [])
      assert.deepEqual(
        effectiveBinDirectories(undefined, undefined, 'linux').every((entry) => entry.startsWith('/')),
        true
      )
      // 上限内显式目录不被挤掉，多余的继承条目被丢弃。
      const many = Array.from({ length: 16 }, (_, index) => '/explicit' + index)
      assert.deepEqual(effectiveBinDirectories(many, path, 'linux'), many)
    } finally {
      await f.close()
    }
  }
)

test(
  'both native environments resolve a harmless synthetic Agent from the configured directory',
  /** 以真实命令名解析证明自有用户目录可用；不启动真实 Agent，不继承模型凭据或提权。 */ async () => {
    const f = await fixture()
    try {
      const directory = join(f.root, 'Agent Tools')
      mkdirSync(directory, { mode: 0o700 })
      const command = 'synthetic-agent-' + basename(f.root)
      writeFileSync(
        join(directory, command),
        '#!' + process.execPath + ' --no-env-file\nprocess.stdout.write("synthetic-agent\\n")\n',
        { mode: 0o700 }
      )
      const luvus = pinConfig({ ...f.config, agent_bin_dirs: [directory], allow_terminal_execution: false })
      const herdr = pinHerdrConfig({
        target: f.config.target,
        binding_revision: 1,
        config_ref: 'synthetic',
        binary: f.binary,
        home: f.home,
        config_home: join(f.home, 'config'),
        state_home: f.stateRoot,
        cache_home: join(f.home, 'cache'),
        temporary_home: join(f.home, 'runtime'),
        cwd: f.cwd,
        agent_bin_dirs: [directory],
        allow_terminal_execution: false
      })
      assert.equal(childEnvironment(f.config).PATH, '/usr/bin:/bin')
      assert.equal(herdrEnvironment({ ...herdr, agent_bin_dirs: undefined }).PATH, '/usr/bin:/bin')
      assert.throws(
        /** Luvus pin 在任何 native 启动前拒绝错误本地字段。 */ () =>
          pinConfig({ ...f.config, agent_bin_dirs: ['relative/bin'] }),
        /agent_bin_dirs_invalid/
      )
      assert.throws(
        /** Herdr pin 同样不把多目录字符串作为安装目录。 */ () =>
          pinHerdrConfig({ ...herdr, agent_bin_dirs: ['/one:/two'] }),
        /agent_bin_dirs_invalid/
      )
      for (const environment of [childEnvironment(luvus), herdrEnvironment(herdr)]) {
        assert.equal(environment.PATH, directory + ':/usr/bin:/bin')
        assert.equal(Object.hasOwn(environment, 'OPENAI_API_KEY'), false)
        assert.equal(Object.hasOwn(environment, 'SSH_AUTH_SOCK'), false)
        const result = spawnSync(command, ['--version'], {
          cwd: f.cwd,
          env: environment,
          encoding: 'utf8',
          timeout: 2000
        })
        assert.equal(result.error, undefined)
        assert.equal(result.status, 0)
        assert.equal(result.stdout, 'synthetic-agent\n')
      }
      assert.equal(herdr.allow_terminal_execution, false)
      assert.equal(luvus.allow_terminal_execution, false)
    } finally {
      await f.close()
    }
  }
)

test(
  'configured Agent PATH matches the same real owned process and rejects a changed expectation',
  /** 只编译并启动自有等待程序，实际 /proc env 与 pidfd 仍走原实现，不冒充 native 安装实证。 */ async () => {
    const f = await fixture()
    let owned: OwnedNativeProcess | undefined
    try {
      const binary = join(f.root, 'synthetic-owned')
      const build = spawnSync(
        process.execPath,
        [
          '--no-env-file',
          'build',
          fileURLToPath(new URL('./agent-process-fixture.ts', import.meta.url)),
          '--compile',
          '--outfile',
          binary
        ],
        { encoding: 'utf8', timeout: 4000 }
      )
      assert.equal(build.error, undefined)
      assert.equal(build.status, 0, build.stderr)
      const directory = join(f.root, 'agent-bin')
      const config = { ...f.config, binary, agent_bin_dirs: [directory], allow_terminal_execution: false }
      owned = new OwnedNativeProcess(config)
      await owned.started()
      owned.assertLive()
      const output = join(f.home, 'agent-env.json')
      const deadline = Date.now() + 2000
      // 子进程创建文件与写入内容不是原子的；等到内容非空，避免读到半写入的空文件。
      while ((!existsSync(output) || readFileSync(output, 'utf8') === '') && Date.now() < deadline) {
        await new Promise<void>(
          /** 等待自有 child 的实际就绪文件，不根据输入 ack 推断启动。 */ (resolve) => setTimeout(resolve, 5)
        )
      }
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { PATH: directory + ':/usr/bin:/bin' })
      config.agent_bin_dirs = [join(f.root, 'different')]
      assert.throws(
        /** 同一存活进程不能用变更后的 PATH 配置重新解释。 */ () => owned!.assertLive(),
        /owned_process_identity_changed/
      )
      config.agent_bin_dirs = [directory]
      owned.assertLive()
    } finally {
      await owned?.close()
      await f.close()
    }
  }
)

test(
  'Agent installation directory never enables terminal execution or becomes an RPC setting',
  /** 本地安装发现与执行开关独立；MCP 参数不能扩展 Agent 安装目录。 */ async () => {
    const f = await fixture('ipc', 'terminal.backend.submit_text', {
      server_generation: G,
      terminal_id: '1'.repeat(32),
      pane_id: '3',
      text: 'synthetic'
    })
    const adapter = new LuvusRpcAdapter(
      { ...f.config, agent_bin_dirs: [join(f.root, 'bin')], allow_terminal_execution: false },
      f.host
    )
    try {
      await assert.rejects(adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.state.claims, 0)
      assert.equal(f.received(), '')
      rejects(
        validator.checkRequest(view(), {
          id: 'owned',
          method: 'agent.prompt',
          params: { target: 'owned', text: 'synthetic', strict: true, agent_bin_dirs: '/synthetic/bin' }
        }),
        'native_request_invalid'
      )
    } finally {
      adapter.close()
      await f.close()
    }
  }
)
