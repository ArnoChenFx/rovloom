/** 显式初始化沿用真实独占文件发布，不启动角色、不读取stdin或生成配对身份。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runCli } from '../../src/cli/run.js'
import { configDocument, readConfig } from '../../src/cli/config.js'

/** 每次只使用当前测试 home；未提供任何角色宿主，误启动会返回失败。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'rovloom-config-init-'))
  return {
    home,
    path: (role: string) => join(home, '.config', 'rovloom', role + '.json'),
    async run(...args: string[]) {
      const out = new PassThrough()
      const err = new PassThrough()
      let stdout = ''
      let stderr = ''
      out.on(
        'data',
        /** 收集本例输出。 */ (value) => {
          stdout += value.toString()
        }
      )
      err.on(
        'data',
        /** 诊断只保留稳定代码。 */ (value) => {
          stderr += value.toString()
        }
      )
      const code = await runCli(
        args,
        { stdin: new PassThrough(), stdout: out, stderr: err, signal: new AbortController().signal },
        {},
        { home, platform: process.platform }
      )
      return { code, stdout, stderr }
    },
    close: /** 删除本用例生成的配置。 */ () => rmSync(home, { recursive: true, force: true })
  }
}

for (const provider of ['luvus', 'herdr', 'mixed']) {
  test('explicit provider initializes without Ctrl-C, running a role or editing JSON: ' + provider, async () => {
    const f = fixture()
    try {
      assert.deepEqual(await f.run('config', 'init', 'connector', '--provider', provider), {
        code: 0,
        stdout: '',
        stderr: 'config_ready\n'
      })
      const config = readConfig(f.path('connector'))
      assert.equal(config.role, 'connector')
      assert.equal(config.role === 'connector' && config.native?.provider, provider)
      assert.equal(existsSync(config.state_dir), false)
      const before = readFileSync(f.path('connector'))
      assert.equal((await f.run('config', 'init', 'connector', '--provider', provider)).code, 0)
      assert.deepEqual(readFileSync(f.path('connector')), before)
      const other = provider === 'herdr' ? 'luvus' : 'herdr'
      assert.equal((await f.run('config', 'init', 'connector', '--provider', other)).stderr, 'config_exists\n')
      assert.deepEqual(readFileSync(f.path('connector')), before)
    } finally {
      f.close()
    }
  })
}

test('container initialization selects container management listeners while normal startup defaults stay wildcard MCP and loopback management', async () => {
  const f = fixture()
  try {
    assert.equal((await f.run('config', 'init', 'gateway')).code, 0)
    const local = readConfig(f.path('gateway'))
    assert(local.role === 'gateway')
    // 新默认：MCP 通配绑定并明文 LAN 放行，设备通道通配；管理页保持回环。
    assert.equal(local.mcp_hostname, '0.0.0.0')
    assert.equal(local.device_hostname, '0.0.0.0')
    assert.equal(local.management_hostname, '127.0.0.1')
    const localDocument = JSON.parse(readFileSync(f.path('gateway'), 'utf8'))
    assert.equal(localDocument.mcp.hostname, '0.0.0.0')
    assert.equal(localDocument.mcp.lan, undefined)
    assert.equal(localDocument.management.hostname, '127.0.0.1')
    const before = readFileSync(f.path('gateway'))
    // --container 与新默认的差异只剩管理页监听：已有文件不覆盖，仍报 config_exists。
    assert.equal((await f.run('config', 'init', 'gateway', '--container')).stderr, 'config_exists\n')
    assert.deepEqual(readFileSync(f.path('gateway')), before)
    const explicit = join(f.home, 'container.json')
    assert.equal((await f.run('config', 'init', 'gateway', '--container', '--config', explicit)).code, 0)
    const container = readConfig(explicit)
    assert.equal(container.role, 'gateway')
    if (container.role !== 'gateway') {
      assert.fail('wrong_role')
    }
    assert.deepEqual(
      [container.mcp_hostname, container.device_hostname, container.management_hostname],
      ['0.0.0.0', '0.0.0.0', '0.0.0.0']
    )
    const document = JSON.parse(readFileSync(explicit, 'utf8'))
    assert.equal(document.management.hostname, '0.0.0.0')
    assert.equal(document.mcp.lan, undefined)
    assert.equal(document.management.lan, undefined)
    assert.equal(container.state_dir, local.state_dir)
    assert.equal(existsSync(container.state_dir), false)
    assert.equal((await f.run('config', 'init', 'gateway', '--container', '--config', explicit)).code, 0)
    assert.deepEqual(JSON.parse(readFileSync(explicit, 'utf8')), document)
    // 已有回环管理页配置与 --container 冲突时明确提示，保留用户文件等待显式编辑。
    writeFileSync(explicit, JSON.stringify({ ...document, management: { ...document.management, hostname: '127.0.0.1' } }))
    const previous = readFileSync(explicit)
    assert.equal(
      (await f.run('config', 'init', 'gateway', '--container', '--config', explicit)).stderr,
      'config_exists\n'
    )
    assert.deepEqual(readFileSync(explicit), previous)
  } finally {
    f.close()
  }
})

test('ROVLOOM_CONTAINER=1 makes first-run gateway defaults use container listeners; connector and unset paths stay local', async () => {
  const f = fixture()
  const previous = process.env.ROVLOOM_CONTAINER
  process.env.ROVLOOM_CONTAINER = '1'
  try {
    // 环境变量与 --container 等价：镜像默认入口（rovloom gateway）首次生成即容器监听值。
    // 角色启动路径（gateway 子命令）才会创建首配，这里直接用 gateway 启动前的初始化入口生成。
    assert.equal((await f.run('config', 'init', 'gateway')).code, 0)
    const gateway = readConfig(f.path('gateway'))
    assert(gateway.role === 'gateway')
    assert.deepEqual(
      [gateway.mcp_hostname, gateway.device_hostname, gateway.management_hostname],
      ['0.0.0.0', '0.0.0.0', '0.0.0.0']
    )
    const document = JSON.parse(readFileSync(f.path('gateway'), 'utf8'))
    assert.equal(document.management.hostname, '0.0.0.0')
    // 已存在文件不重新生成：环境变量只影响首次生成，不改写既有配置。
    const before = readFileSync(f.path('gateway'))
    delete process.env.ROVLOOM_CONTAINER
    assert.equal((await f.run('config', 'init', 'gateway')).code, 0)
    assert.deepEqual(readFileSync(f.path('gateway')), before)
    // 未设变量时首次生成仍是回环监听；connector 角色不受容器变量影响。
    assert.equal((await f.run('config', 'init', 'connector')).code, 0)
    const connector = readConfig(f.path('connector'))
    assert.equal(connector.role, 'connector')
    const plain = join(f.home, 'plain-gateway.json')
    assert.equal((await f.run('config', 'init', 'gateway', '--config', plain)).code, 0)
    const local = readConfig(plain)
    assert(local.role === 'gateway')
    // 未设变量时新默认：MCP/设备通道通配，管理页回环。
    assert.equal(local.mcp_hostname, '0.0.0.0')
    assert.equal(local.device_hostname, '0.0.0.0')
    assert.equal(local.management_hostname, '127.0.0.1')
  } finally {
    if (previous === undefined) {
      delete process.env.ROVLOOM_CONTAINER
    } else {
      process.env.ROVLOOM_CONTAINER = previous
    }
    f.close()
  }
})

test('invalid initialization flags and corrupt existing files never overwrite configuration', async () => {
  const f = fixture()
  try {
    for (const args of [
      ['connector', '--container'],
      ['gateway', '--provider', 'herdr'],
      ['connector', '--provider', 'unknown'],
      ['connector', '--provider'],
      ['gateway', '--container', '--container'],
      ['gateway', '--unknown', 'secret']
    ]) {
      assert.equal((await f.run('config', 'init', ...args)).stderr, 'invalid_arguments\n')
      assert.equal(existsSync(join(f.home, '.config')), false)
    }
    await f.run('config', 'init', 'connector', '--provider', 'herdr')
    const config = readConfig(f.path('connector'))
    writeFileSync(f.path('connector'), JSON.stringify({ ...configDocument(config), private_unknown: true }))
    const before = readFileSync(f.path('connector'))
    assert.equal((await f.run('config', 'init', 'connector', '--provider', 'herdr')).stderr, 'invalid_config\n')
    assert.deepEqual(readFileSync(f.path('connector')), before)
  } finally {
    f.close()
  }
})
