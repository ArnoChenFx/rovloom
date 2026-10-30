/**
 * 对已运行的 herdr-core 跑一遍只读观察面，并把实证事实打印成 JSON。
 * 用法：bun scripts/herdr-core/verify-observation.ts --socket <路径> [--session <名>] [--binary-sha256 <摘要>]
 * 只调用 hello / rpc.discover / server.status / terminal.list / terminal.get / terminal.read / terminal.wait，
 * 不发送输入、不改终端记录、不拉起或停止 core。
 */
import { openHerdrCoreClient } from '../../src/connector/herdr-core/client.js'
import {
  herdrCoreProcessFacts,
  inspectHerdrCoreSocket,
  type HerdrCoreTerminalIdentity
} from '../../src/connector/herdr-core/identity.js'
import { createHerdrCoreObservation, loadHerdrCoreContract } from '../../src/connector/herdr-core/observation.js'

type Options = Readonly<{ socket: string; session?: string; binary_sha256?: string }>

/** 只接受显式参数，不从环境推断端点或凭据。 */
function options(argv: readonly string[]): Options {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('usage: --socket <path> [--session <name>] [--binary-sha256 <hex>]')
    }
    values.set(key.slice(2), value)
  }
  const socket = values.get('socket')
  if (!socket) {
    throw new Error('usage: --socket <path> [--session <name>] [--binary-sha256 <hex>]')
  }
  return {
    socket,
    ...(values.has('session') ? { session: values.get('session')! } : {}),
    ...(values.has('binary-sha256') ? { binary_sha256: values.get('binary-sha256')! } : {})
  }
}

const input = options(process.argv.slice(2))
const socket = inspectHerdrCoreSocket(input.socket)
const client = await openHerdrCoreClient(input.socket)
try {
  const contract = await loadHerdrCoreContract(client)
  const observation = createHerdrCoreObservation({ client, contract })
  const status = await observation.call('server.status')
  const pid = status.result.pid
  const session = input.session ?? input.socket.slice(input.socket.lastIndexOf('/') + 1).replace(/\.sock$/u, '')
  // 服务端自报的 pid 必须能对上 exe/argv/HC_SESSION，否则身份不成立。
  const process_ = herdrCoreProcessFacts(pid, session)
  if (input.binary_sha256 && process_.binary_sha256 !== input.binary_sha256) {
    throw new Error('binary_sha256_mismatch')
  }
  const list = await observation.call('terminal.list')
  const terminals = (list.terminals ?? []) as readonly HerdrCoreTerminalIdentity[]
  const reads = []
  for (const terminal of terminals.slice(0, 3)) {
    const read = await observation.call('terminal.read', { terminal: terminal.address, lines: 0 })
    const waited = await observation.call('terminal.wait', { terminal: terminal.address, timeout: 0.2 })
    const single = await observation.call('terminal.get', { terminal: terminal.address })
    reads.push({
      terminal,
      how: read.result.how,
      complete: read.result.complete,
      text_bytes: Buffer.byteLength(String(read.result.text)),
      // timeout 只是 check-in：ended=false 不能读成完成。
      wait: { ended: waited.result.ended, reason: waited.result.reason },
      identity_matches: JSON.stringify(single.terminal) === JSON.stringify(terminal)
    })
  }
  console.log(
    JSON.stringify(
      {
        socket: input.socket,
        socket_owner_uid: socket.uid,
        hello: client.hello,
        contract: {
          version: contract.version,
          identity: contract.identity,
          methods: contract.methods.length
        },
        server: {
          version: status.result.version,
          pid: process_.pid,
          exe: process_.exe,
          binary_sha256: process_.binary_sha256,
          argv: process_.argv,
          hc_session: process_.session
        },
        terminals: terminals.length,
        reads
      },
      null,
      2
    )
  )
} finally {
  client.close()
}
