/** native 程序与 Agent 的安装目录：显式数组优先，其后才是启动 PATH 中的安全条目，最后是固定系统目录。 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import type { ConnectorConfig } from '../../src/cli/config.js'
import { assertSetupNativePath, setupAgentDirectories, setupBinary } from '../../src/cli/setup-native.js'
import type { SetupConsole } from '../../src/cli/setup-console.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

/** 以给定 PATH 运行；只改本进程环境变量并在结束后恢复。 */
function withPath<T>(value: string, run: () => T): T {
  const previous = process.env.PATH
  process.env.PATH = value
  try {
    return run()
  } finally {
    process.env.PATH = previous
  }
}

function connector(native?: Record<string, unknown>): ConnectorConfig {
  const document = { ...configDocument(configTemplate('connector', 'linux')), ...(native ? { native } : {}) }
  return parseConfig(document, 'linux') as ConnectorConfig
}

function program(directory: string, name: string): string {
  mkdirSync(directory, { mode: 0o700, recursive: true })
  const path = join(directory, name)
  writeFileSync(path, '#!/bin/sh\n', { mode: 0o700 })
  return path
}

test('runtime 程序默认从启动 PATH 查找；显式目录数组优先且可分别放不同程序', () => {
  const root = privateHerdrTestRoot('.native-dirs-')
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const onPath = join(root, 'on-path')
    const luvusFirst = program(first, 'luvus')
    const herdrSecond = program(second, 'herdr')
    const herdrOnPath = program(onPath, 'herdr')
    // 没有显式目录：直接在 PATH 里找。
    withPath(onPath, () => assert.equal(setupBinary(connector(), 'herdr'), herdrOnPath))
    // 显式数组按顺序搜索，不同程序可在不同目录。
    const explicit = connector({ runtime_bin_dirs: [first, second] })
    withPath('/nonexistent', () => {
      assert.equal(setupBinary(explicit, 'luvus'), luvusFirst)
      assert.equal(setupBinary(explicit, 'herdr'), herdrSecond)
    })
    // 显式目录优先于 PATH 里的同名程序。
    withPath(onPath, () => assert.equal(setupBinary(explicit, 'herdr'), herdrSecond))
    // 哪里都找不到就拒绝，而不是猜测。
    withPath('/nonexistent', () =>
      assert.throws(() => setupBinary(connector(), 'luvus'), { code: 'configuration_required' })
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Agent 目录 = 显式数组 + 启动 PATH 的安全条目；没有额外目录时保持固定系统 PATH', () => {
  const root = privateHerdrTestRoot('.native-dirs-')
  try {
    const own = join(root, 'own')
    const onPath = join(root, 'on-path')
    const unsafe = join(root, 'unsafe')
    for (const directory of [own, onPath, unsafe]) {
      mkdirSync(directory, { mode: 0o700 })
    }
    chmodSync(unsafe, 0o777)
    withPath(`${onPath}:${unsafe}:/usr/bin:/bin`, () => {
      assert.deepEqual(setupAgentDirectories(connector()), { agent_bin_dirs: [onPath] })
      assert.deepEqual(setupAgentDirectories(connector({ agent_bin_dirs: [own] })), { agent_bin_dirs: [own, onPath] })
    })
    withPath('/usr/bin:/bin', () => assert.deepEqual(setupAgentDirectories(connector()), {}))
    withPath('/usr/bin:/bin', () =>
      assert.deepEqual(setupAgentDirectories(connector({ agent_bin_dirs: [own] })), { agent_bin_dirs: [own] })
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Herdr 私有 socket 路径检查按更长的 herdr-client.sock 计算（Herdr 绑定不了会直接退出）', () => {
  const shown: string[] = []
  // 只行使 show；io 提供语言/信号字段的形状，语言缺省按英文。
  const terminal = {
    io: { signal: new AbortController().signal },
    show: (text: string) => shown.push(text)
  } as unknown as SetupConsole
  // herdr.sock 恰好 107 字节但 herdr-client.sock 超限：旧检查会放行，随后 Herdr 启动即退出。
  const suffix = '/hr/c/herdr/herdr.sock'
  const dataDirectory = '/' + 'a'.repeat(107 - suffix.length - 1)
  assert.equal(Buffer.byteLength(dataDirectory + suffix), 107)
  // 只有隔离（managed）实例把 socket 放在 Connector 数据目录里；附着模式不受这个长度限制。
  const config = connector({ provider: 'herdr', herdr: { mode: 'managed' } })
  const tooLong = { ...config, state_dir: dataDirectory } as ConnectorConfig
  assert.throws(() => assertSetupNativePath(tooLong, terminal), { code: 'configuration_required' })
  assert.match(shown.join(''), /native_state_path_too_long/)
  // 再缩短 7 字节（herdr-client.sock 比 herdr.sock 长 7）后放行。
  const fits = { ...config, state_dir: dataDirectory.slice(0, -7) } as ConnectorConfig
  assert.doesNotThrow(() => assertSetupNativePath(fits, terminal))
  // 附着模式（默认）的端点在用户自己的配置目录，数据目录再长也不受此限制。
  const attached = { ...connector({ provider: 'herdr' }), state_dir: dataDirectory } as ConnectorConfig
  assert.doesNotThrow(() => assertSetupNativePath(attached, terminal))
})
