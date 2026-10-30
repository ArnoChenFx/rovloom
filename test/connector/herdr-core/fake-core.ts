/**
 * 测试用的假 core：在 0700 临时目录里提供 Unix 套接字，按真实 core 的两种模式应答。
 * plain 阶段只处理 hello；`framed:true` 之后按 `[channel u32 LE][kind u8][len u32 LE][payload]` 收发。
 */
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEADER = 9
const DATA = 0
const CREDIT = 1

export type FakeCoreRequest = Readonly<{ id: number; method: string; params: Record<string, unknown> }>

export type FakeCoreOptions = Readonly<{
  /** 每个请求的应答；抛错时按 JSON-RPC 错误返回。 */
  handler?(
    request: FakeCoreRequest
  ): Record<string, unknown> | { error: { code: number; message: string; data?: unknown } }
  hello?: Record<string, unknown>
  /** 返回结果前的人为延迟，用来测超时。 */
  delay_ms?: number
  /** 订阅后推送的事件行；每条一个 JSON 行。 */
  events?: readonly string[]
  /** `rpc.discover` 返回的文档；省略时返回空对象。 */
  discover?: Record<string, unknown>
}>

export type FakeCore = Readonly<{
  socket: string
  session: string
  directory: string
  /** 收到的信用回补（字节数）。 */
  credits: readonly number[]
  /** 收到的请求方法顺序。 */
  requests: readonly string[]
  /** 当前连接数。 */
  connections(): number
  /** 已推送的事件行数。 */
  pushed(): number
  /** 断开所有连接，模拟 core 退出。 */
  disconnect(): void
  close(): Promise<void>
}>

/** 帧编码与 core 的 wire.rs 一致。 */
function frame(channel: number, kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER)
  header.writeUInt32LE(channel, 0)
  header.writeUInt8(kind, 4)
  header.writeUInt32LE(payload.byteLength, 5)
  return Buffer.concat([header, payload])
}

/** 只处理本测试用到的参数形状；其它方法返回固定空结果。 */
function defaultHandler(request: FakeCoreRequest, options: FakeCoreOptions): Record<string, unknown> {
  switch (request.method) {
    case 'rpc.discover':
      return options.discover ?? {}
    case 'server.status':
      return {
        core: { id: '0f0e0d0c0b0a0908', name: 'fake-core' },
        version: '0.1.14',
        pid: process.pid,
        uptime_ms: 42,
        holders: [],
        holder: null,
        installed_by: null,
        live: 1,
        finished: 0
      }
    case 'terminal.list':
      return { terminals: [terminal()], hidden_finished: 0 }
    case 'terminal.get':
      return terminal()
    case 'terminal.read':
      return { text: 'hello\n', complete: true, how: 'screen' }
    case 'terminal.wait':
      return {
        terminal: 't1',
        ended: false,
        reason: 'timeout',
        turn: 0,
        children: [],
        status: null,
        exit_code: null,
        signal: null,
        from: null
      }
    default:
      return {}
  }
}

/** 与真实结果字段一致的终端事实，供三元组核对。 */
function terminal(): Record<string, unknown> {
  return {
    address: 't1',
    created_ms: 1793335137041,
    cols: 200,
    rows: 120,
    cwd: '/tmp',
    argv: ['sh', '-c', 'sleep 1'],
    die_with_parent: false,
    exit_code: null,
    finished_ms: null,
    foreground: null,
    identity: 'ghostty',
    keep: false,
    labels: {},
    name: 'alt',
    notify: true,
    parent: null,
    pid: 1234,
    reason: null,
    reported: false,
    rm: false,
    screen: 'exact',
    signal: null,
    state: 'live',
    status: null,
    status_ms: null
  }
}

/** 建立假 core；返回的 socket 已可连接。 */
export async function startFakeCore(options: FakeCoreOptions = {}): Promise<FakeCore> {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-hc-'))
  const session = 'test'
  const root = join(directory, 'herdr-core')
  mkdirSync(root, { mode: 0o700 })
  const socketPath = join(root, `${session}.sock`)
  const credits: number[] = []
  const requests: string[] = []
  const sockets = new Set<Socket>()
  let pushed = 0
  const server: Server = createServer(
    /** 每条连接独立握手；不共享请求状态。 */ (socket: Socket) => {
      sockets.add(socket)
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let framed = false
      let subscription: number | undefined
      let credit = 0
      const send = /** 帧模式下的应答。 */ (channel: number, payload: unknown) => {
        socket.write(frame(channel, DATA, Buffer.from(`${JSON.stringify(payload)}\n`)))
      }
      const pump = /** 只在信用允许时推送事件；模拟真实 core 的流控。 */ () => {
        if (subscription === undefined) {
          return
        }
        const lines = options.events ?? []
        while (pushed < lines.length && credit >= Buffer.byteLength(lines[pushed]!) + 1) {
          const line = lines[pushed]!
          pushed += 1
          credit -= Buffer.byteLength(line) + 1
          // 行可以只是 params（按 event 通知），也可以显式给出 method/params（missed、heartbeat）。
          const body = JSON.parse(line) as Record<string, unknown>
          const method = typeof body.method === 'string' ? body.method : 'event'
          const params = method === 'event' && !('params' in body) ? body : body.params
          send(subscription, { jsonrpc: '2.0', method, params })
        }
      }
      const dispatch = /** 请求分发：只回帧，不回 plain 行。 */ (request: FakeCoreRequest) => {
        requests.push(request.method)
        const reply = () => {
          let result: Record<string, unknown>
          try {
            result = options.handler ? options.handler(request) : defaultHandler(request, options)
          } catch {
            send(0, {
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } }
            })
            return
          }
          if ('error' in result) {
            send(0, { jsonrpc: '2.0', id: request.id, error: result.error })
            return
          }
          if (request.method === 'events.subscribe') {
            subscription = 1
            // 真实 core 给新流 256 KiB 初始信用，之后靠客户端回补。
            credit = 256 * 1024
            send(0, { jsonrpc: '2.0', id: request.id, result: { seq: 0, terminals: [terminal()], channel: 1 } })
            pump()
            return
          }
          send(0, { jsonrpc: '2.0', id: request.id, result })
        }
        if (options.delay_ms) {
          setTimeout(reply, options.delay_ms)
          return
        }
        reply()
      }
      const drain = /** 先 plain 行握手，再按帧读。 */ () => {
        for (;;) {
          if (!framed) {
            const end = buffer.indexOf(0x0a)
            if (end < 0) {
              return
            }
            const line = buffer.subarray(0, end).toString('utf8')
            buffer = buffer.subarray(end + 1)
            const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
            if (request.method !== 'hello' || request.params?.framed !== true) {
              socket.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'invalid' } })}\n`
              )
              return
            }
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  generation: 1,
                  version: '0.1.14',
                  core: { id: '0f0e0d0c0b0a0908', name: 'fake-core' },
                  framed: true,
                  methods: ['hello', 'server.status'],
                  features: ['framed', 'events'],
                  ...options.hello
                }
              })}\n`
            )
            framed = true
            continue
          }
          if (buffer.byteLength < HEADER) {
            return
          }
          const channel = buffer.readUInt32LE(0)
          const kind = buffer.readUInt8(4)
          const length = buffer.readUInt32LE(5)
          if (buffer.byteLength < HEADER + length) {
            return
          }
          const payload = buffer.subarray(HEADER, HEADER + length)
          buffer = buffer.subarray(HEADER + length)
          if (kind === CREDIT && length === 4) {
            const bytes = payload.readUInt32LE(0)
            credits.push(bytes)
            credit += bytes
            pump()
            continue
          }
          if (channel !== 0 || kind !== DATA) {
            continue
          }
          const request = JSON.parse(payload.toString('utf8')) as FakeCoreRequest
          dispatch(request)
        }
      }
      socket.on(
        'data',
        /** 累积后解析；单连接上限足够测试使用。 */ (chunk: Buffer) => {
          buffer = buffer.byteLength ? Buffer.concat([buffer, chunk]) : chunk
          try {
            drain()
          } catch {
            socket.destroy()
          }
        }
      )
      socket.on(
        'close',
        /** 关闭只清理本连接。 */ () => {
          sockets.delete(socket)
        }
      )
      socket.on('error', /** 测试客户端断开属于预期。 */ () => {})
    }
  )
  await new Promise<void>(
    /** 监听失败直接抛出，避免测试挂起。 */ (resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    }
  )
  return Object.freeze({
    socket: socketPath,
    session,
    directory,
    credits,
    requests,
    connections: /** 当前活动连接数。 */ () => sockets.size,
    pushed: /** 已推送事件行数。 */ () => pushed,
    disconnect: /** 模拟 core 消失：断开全部连接但保留套接字文件。 */ () => {
      for (const socket of sockets) {
        socket.destroy()
      }
    },
    close: /** 关闭监听并删除临时目录。 */ async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>(
        /** 先停止监听，再删目录。 */ (resolve) => {
          server.close(() => resolve())
        }
      )
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

/** 在假 core 目录里写一个占位二进制，供身份核对使用。 */
export function writeFakeBinary(directory: string, content = '#!/bin/sh\nexit 0\n'): string {
  const path = join(directory, 'herdr-core')
  writeFileSync(path, content, { mode: 0o700 })
  return path
}
