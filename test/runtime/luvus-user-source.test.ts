/** 用户的 Luvus：会话是否在运行只取自固定的 `session list --json`；自建环境不带其它凭据。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { luvusSessionRunning, userLuvusEnvironment } from '../../src/connector/luvus/host/luvus-user-source.js'
import type { LuvusLocalConfig } from '../../src/connector/luvus/types.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

/** 用一个只回放固定 JSON 的脚本代替 luvus 二进制，检查我们如何解读会话列表。 */
function fixture(sessions: unknown, exit = 0) {
  const root = privateHerdrTestRoot('.luvus-user-')
  const state = join(root, 'luvus-home')
  const home = join(root, 'h')
  const cwd = join(root, 'w')
  for (const path of [state, home, cwd, ...['config', 'data', 'cache', 'runtime'].map((n) => join(home, n))]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const binary = join(root, 'luvus')
  const script = `#!/bin/sh\necho '${JSON.stringify({ sessions })}'\nexit ${exit}\n`
  writeFileSync(binary, script, { mode: 0o700 })
  chmodSync(binary, 0o700)
  const config: LuvusLocalConfig = {
    target: { machine_id: 'm1', provider_id: 'luvus', profile: 'session', session: 'default' },
    binding_revision: 1,
    config_ref: 'luvus_attempt',
    binary,
    binary_sha256: createHash('sha256').update(script).digest('hex'),
    state_root: state,
    home,
    cwd,
    transport: 'ipc',
    attach: true,
    user_home: root
  }
  return { config, close: () => rmSync(root, { recursive: true, force: true }) }
}

const linux = process.platform === 'linux'

test('会话在运行才算存在：running:false（遗留 socket）与缺失都算没有', { skip: !linux }, async () => {
  const signal = new AbortController().signal
  const running = fixture([{ name: 'default', running: true }])
  const stale = fixture([{ name: 'default', running: false }])
  const other = fixture([{ name: 'work', running: true }])
  try {
    assert.equal(await luvusSessionRunning(running.config, signal), true)
    assert.equal(await luvusSessionRunning(stale.config, signal), false)
    assert.equal(await luvusSessionRunning(other.config, signal), false)
  } finally {
    running.close()
    stale.close()
    other.close()
  }
})

test('会话列表无法解析或命令失败时不猜测存在与否', { skip: !linux }, async () => {
  const signal = new AbortController().signal
  const duplicate = fixture([
    { name: 'default', running: true },
    { name: 'default', running: true }
  ])
  const broken = fixture([{ name: 'default', running: true }], 1)
  try {
    // 重复同名按“不是恰好一个”处理为不存在，交给后续附着的身份校验；命令失败则是错误。
    assert.equal(await luvusSessionRunning(duplicate.config, signal), false)
    await assert.rejects(() => luvusSessionRunning(broken.config, signal))
  } finally {
    duplicate.close()
    broken.close()
  }
})

test('自建 server 的环境用真实 HOME，不继承 SSH agent 与 API key', { skip: !linux }, () => {
  const saved = { ...process.env }
  try {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    process.env.OPENAI_API_KEY = 'secret'
    process.env.SHELL = '/bin/sh'
    const f = fixture([])
    try {
      const env = userLuvusEnvironment(f.config)
      assert.equal(env.HOME, f.config.user_home)
      assert.equal(env.LUVUS_HOME, f.config.state_root)
      assert.equal(env.SHELL, '/bin/sh')
      assert.equal(env.SSH_AUTH_SOCK, undefined)
      assert.equal(env.OPENAI_API_KEY, undefined)
    } finally {
      f.close()
    }
  } finally {
    process.env = saved
  }
})
