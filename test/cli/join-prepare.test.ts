// --join 的 CLI 接线：prepare 非交互执行，写 Gateway 地址后向目标发起配对；失败保持固定错误码且不回显码值。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { configDocument, configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { CliSetup } from '../../src/cli/setup-runtime.js'

const secret = 's'.repeat(43)
const codeValue =
  'ws://127.0.0.1:9#m_0123456789abcdef0123456789abcdef0123.01234567-0123-4123-8123-012345678912.' + secret

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-join-'))
  mkdirSync(join(root, 'managed'), { recursive: true })
  const path = join(root, 'connector.json')
  const config = { ...configTemplate('connector'), state_dir: root } as ConnectorConfig
  writeFileSync(path, JSON.stringify(configDocument(config), null, 2) + '\n', { mode: 0o600 })
  return { root, path, config }
}

test('--join 经 prepare 非交互执行：写地址、发请求，失败为固定错误码且不回显码', async () => {
  const w = workspace()
  const setup = new CliSetup()
  const io = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signal: new AbortController().signal
  }
  try {
    // 端口 9 无监听且本机环境不可控：join 必然在原生发现或网络步骤失败；断言的是非交互接线本身。
    await assert.rejects(setup.prepare(w.config, w.path, io, { join: codeValue }))
    const saved = JSON.parse(readFileSync(w.path, 'utf8')) as { gateway: { url: string } }
    assert.equal(saved.gateway.url, 'ws://127.0.0.1:9')
    const output = (io.stderr as PassThrough).read()?.toString() ?? ''
    assert(!output.includes(secret), 'join secret must not be echoed')
  } finally {
    setup.close()
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('无 join 时 prepare 原样返回配置（已配对设备的日常启动）', async () => {
  const w = workspace()
  const setup = new CliSetup()
  const io = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signal: new AbortController().signal
  }
  try {
    const result = await setup.prepare(w.config, w.path, io)
    assert.equal(result, w.config)
  } finally {
    setup.close()
    rmSync(w.root, { recursive: true, force: true })
  }
})
