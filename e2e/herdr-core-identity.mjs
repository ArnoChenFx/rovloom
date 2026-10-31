/**
 * 对真实 herdr-core 验证两处身份失败关闭：同机转发代理冒充、socket 目录权限不对。
 * 由 quickstart --herdr-core 在真实 core 运行时调用；只读 /proc、只连本机套接字，不改 core 状态。
 * 用法：HERDR_CORE_SOCKET=... HERDR_CORE_SESSION=... HERDR_CORE_RUNTIME=... \
 *       HERDR_CORE_PROXY_ROOT=... bun e2e/herdr-core-identity.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { openHerdrCoreClient } from '../src/connector/herdr-core/client.js'
import { herdrCorePeerFacts, inspectHerdrCoreSocket } from '../src/connector/herdr-core/identity.js'
import { HERDR_CORE_CLASSIFICATION_REVISION } from '../src/connector/herdr-core/methods.js'
import { compileHerdrCoreContract } from '../src/connector/herdr-core/schema.js'
import { boundedJson, hash } from '../src/wire/index.js'

const env = process.env
const socket = env.HERDR_CORE_SOCKET
const session = env.HERDR_CORE_SESSION
const runtime = env.HERDR_CORE_RUNTIME
const proxyRoot = env.HERDR_CORE_PROXY_ROOT
assert(socket && session && runtime && proxyRoot, 'herdr-core identity environment is required')

/** 从真实 core 取本次契约与进程事实，作为代理测试的期望来源。 */
async function expectedSource() {
  const client = await openHerdrCoreClient(socket)
  try {
    const discovered = boundedJson(await client.request('rpc.discover', {}, 10_000), 4 * 1024 * 1024)
    const contract = compileHerdrCoreContract(discovered)
    const status = contract.validateResult('server.status', await client.request('server.status', {}, 10_000))
    const facts = herdrCorePeerFacts(client.peer(), status.pid, session)
    return {
      provider_kind: 'herdr-core',
      protocol_family: 'herdr-core-jsonrpc',
      binary_version: client.hello.version,
      binary_sha256: facts.binary_sha256,
      schema_sha256: hash(discovered),
      schema_origin: 'live_instance',
      schema_command: 'rpc.discover',
      server_version: typeof status.version === 'string' ? status.version : null,
      native_protocol_version: String(client.hello.generation),
      runtime_generation: null,
      adapter_revision: 'adapter-herdr-core-1',
      classification_revision: HERDR_CORE_CLASSIFICATION_REVISION,
      support_basis: 'schema_and_version'
    }
  } finally {
    client.close()
  }
}

/** 只转发字节的代理：SO_PEERCRED 看到代理 pid，server.status 仍由真 core 自报真 pid。 */
async function proxy(realSocket, directory) {
  mkdirSync(join(directory, 'herdr-core'), { recursive: true, mode: 0o700 })
  const path = join(directory, 'herdr-core', `${session}.sock`)
  const sockets = new Set()
  const server = createServer((client) => {
    const upstream = createConnection(realSocket)
    sockets.add(client)
    sockets.add(upstream)
    client.pipe(upstream)
    upstream.pipe(client)
    const close = /** 任一端结束就一并回收，避免测试留下半开连接。 */ () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', close)
    upstream.on('error', close)
    client.on('close', close)
    upstream.on('close', close)
  })
  await new Promise((resolve) => server.listen(path, resolve))
  return {
    path,
    directory: join(directory, 'herdr-core'),
    async close() {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

const source = await expectedSource()
const proxyDirectory = join(proxyRoot, 'proxy')
rmSync(proxyDirectory, { recursive: true, force: true })
mkdirSync(proxyDirectory, { recursive: true, mode: 0o700 })
const forwarder = await proxy(socket, proxyDirectory)
const evidence = {
  source_binary_sha256: source.binary_sha256.slice(0, 16),
  schema_sha256: source.schema_sha256.slice(0, 16)
}
try {
  const { HerdrCoreInstallation } = await import('../src/connector/herdr-core/installation.js')
  await assert.rejects(
    HerdrCoreInstallation.open({
      config: { session, endpoint: { runtime_dir: proxyDirectory } },
      expected: source
    }),
    /** 代理可以转发真 core 的自报 pid，但内核 peer 是代理进程。 */ (error) =>
      error instanceof Error && error.code === 'herdr_core_peer_pid_mismatch'
  )
  evidence.proxy_refused = 'herdr_core_peer_pid_mismatch'
  assert.doesNotThrow(() => inspectHerdrCoreSocket(forwarder.path))
  chmodSync(forwarder.directory, 0o755)
  assert.throws(() => inspectHerdrCoreSocket(forwarder.path), /herdr_core_endpoint_untrusted/u)
  chmodSync(forwarder.directory, 0o700)
  evidence.permissions_refused = 'herdr_core_endpoint_untrusted'
  console.log(JSON.stringify({ ok: true, ...evidence }))
} finally {
  await forwarder.close()
  rmSync(proxyDirectory, { recursive: true, force: true })
}
