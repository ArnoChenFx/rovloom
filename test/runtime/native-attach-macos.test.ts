/** macOS 上附着用户自己的 Luvus：用真实 Unix socket 服务进程验证 LOCAL_PEERPID/PEERCRED + libproc 的进程身份证明。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { observeLuvusProcess } from '../../src/connector/luvus/host/native-process.js'
import { LuvusAdapterError } from '../../src/connector/luvus/index.js'
import type { EndpointIdentity, LuvusLocalConfig } from '../../src/connector/luvus/index.js'
import { listenerExecutable } from '../platform/listener-fixture.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

const darwin = process.platform === 'darwin'
function fixture() {
  const root = privateHerdrTestRoot('.luvus-mac-')
  for (const name of ['state', 'home', 'work', 'bin']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  const binary = join(root, 'bin', 'luvus')
  copyFileSync(listenerExecutable(), binary)
  chmodSync(binary, 0o700)
  const config = {
    target: { machine_id: 'm', provider_id: 'p', profile: 'session', session: 'fixedsession' },
    binding_revision: 1,
    config_ref: 'attach-mac',
    binary,
    binary_sha256: '0'.repeat(64),
    state_root: join(root, 'state'),
    home: join(root, 'home'),
    cwd: join(root, 'work'),
    transport: 'ipc',
    attach: true
  } as unknown as LuvusLocalConfig
  const socket = join(root, 'state', 's.sock')
  const children: ChildProcess[] = []
  const clients: Socket[] = []
  /** 启动监听端点的服务进程，并返回连到它的实际客户端 socket。 */
  async function serve(path = binary, args: string[] = ['--session', 'fixedsession', 'server']) {
    const child = spawn(path, args, {
      cwd: join(root, 'work'),
      env: { PATH: '/usr/bin:/bin', FIXTURE_SOCKET: socket },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    children.push(child)
    await once(child.stdout!, 'data')
    const client = connect(socket)
    clients.push(client)
    await once(client, 'connect')
    return { child, client }
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'close')
    }
    rmSync(socket, { force: true })
  }
  return {
    root,
    config,
    binary,
    serve,
    stop,
    close: async () => {
      for (const client of clients) {
        client.destroy()
      }
      await Promise.all(children.map(stop))
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const endpoint = {} as EndpointIdentity

test('实际 socket 的对端是固定 luvus 服务端：观察得到其身份，进程消失后失效', { skip: !darwin }, async () => {
  const f = fixture()
  try {
    const { child, client } = await f.serve()
    const observation = observeLuvusProcess(client, f.config, endpoint)
    assert.equal(observation.identity().pid, child.pid)
    assert.equal(observation.identity().uid, process.geteuid!())
    observation.assertLive()
    await f.stop(child)
    assert.throws(() => observation.assertLive(), LuvusAdapterError)
    observation.close()
  } finally {
    await f.close()
  }
})

test('监听者不是已安装的 luvus（不同文件）或命令行不是固定 server 形态，一律拒绝', { skip: !darwin }, async () => {
  const f = fixture()
  try {
    // 另一份二进制（不同 inode）在端点监听：uid 相同、peer pid 真实，也不是配置里那个 luvus。
    const impostor = join(f.root, 'bin', 'impostor')
    copyFileSync(listenerExecutable(), impostor)
    chmodSync(impostor, 0o700)
    const fake = await f.serve(impostor)
    assert.throws(() => observeLuvusProcess(fake.client, f.config, endpoint), {
      code: 'attached_process_identity_changed'
    })
    await f.stop(fake.child)
    // 同一个二进制但命令行不是 `--session fixedsession server`。
    const wrong = await f.serve(f.binary, ['other', 'extra'])
    assert.throws(() => observeLuvusProcess(wrong.client, f.config, endpoint), {
      code: 'attached_process_identity_changed'
    })
  } finally {
    await f.close()
  }
})

test('未连接或自造的 socket 没有对端，调用方字段不能建立观察', { skip: !darwin }, () => {
  const f = fixture()
  try {
    assert.throws(() => observeLuvusProcess({ pid: process.pid } as unknown as Socket, f.config, endpoint), {
      code: 'macos_peer_unavailable'
    })
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
