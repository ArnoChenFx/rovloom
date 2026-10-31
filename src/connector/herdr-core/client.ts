/**
 * herdr-core 的 JSON-RPC 2.0 over Unix socket 客户端：先 plain `hello {framed:true}`，
 * 之后一律按 `[channel u32 LE][kind u8][len u32 LE][payload]` 收发。
 * 只做有界编解码、请求配对与信用回补；方法档位和参数规则由调用方复核。
 */
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'
import { ProviderAdapterError } from '../provider-error.js'
import { boundedJson, fail, object, parseJson } from '../../wire/index.js'
import type { JsonObject } from '../../wire/types.js'
import { readLinuxPeer } from '../local/linux-peer.js'
import type { NativePeer } from '../local/linux-peer.js'
import {
  HERDR_CORE_MAX_FRAME_BYTES,
  HERDR_CORE_MAX_REQUEST_BYTES,
  HERDR_CORE_REQUEST_MAX_MS,
  HERDR_CORE_REVIEW,
  herdrCoreVersionShape
} from './methods.js'

/** 帧头 9 字节；与 core 的 wire.rs 一致。 */
const HEADER = 9
const CHANNEL_CONTROL = 0
const DATA = 0
const CREDIT = 1
const CLOSE = 2
/** core 初始信用 256 KiB；按已消费字节回补，不能一次补成无上限。 */
export const HERDR_CORE_WINDOW_BYTES = 256 * 1024
const MAX_PENDING = 32

export type HerdrCoreHello = Readonly<{
  generation: number
  version: string
  core: Readonly<{ id: string; name: string }>
  methods: readonly string[]
  features: readonly string[]
}>

export type HerdrCoreEvent = Readonly<{
  channel: number
  /** 通知里的 method（event / heartbeat / missed）与原始 JSON 行。 */
  method: string
  message: JsonObject
}>

export type HerdrCoreClientOptions = Readonly<{
  /** 连接与单请求的本地上限；不表示原生工作已停止。 */
  timeout_ms?: number
  now?: () => number
}>

/** 原生错误只保留 JSON-RPC 错误码与 data.kind；不回显 message 里的自由文本。 */
export class HerdrCoreRpcError extends Error {
  constructor(
    readonly code: number,
    readonly kind: string
  ) {
    super(`herdr_core_rpc_error:${kind}`)
    this.name = 'HerdrCoreRpcError'
  }
}

type Pending = Readonly<{
  resolve(value: JsonObject): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
}>

export type HerdrCoreClient = Readonly<{
  hello: HerdrCoreHello
  socket_path: string
  /** 这条已连接套接字的内核 peer（SO_PEERCRED）；服务端自报的 pid 不是证据。非 Linux 明确拒绝。 */
  peer(): NativePeer
  request(method: string, params: JsonObject, timeout_ms?: number): Promise<JsonObject>
  /** 只订阅帧通道上的通知；返回取消函数。 */
  onEvent(listener: (event: HerdrCoreEvent) => void): () => void
  onClose(listener: () => void): () => void
  /** 回补信用：调用方按实际消费的字节数声明。 */
  credit(channel: number, bytes: number): void
  /** 连接是否已关闭；用于断线后重新附着，不表示原生工作已停止。 */
  closed(): boolean
  close(): void
}>

/** 帧长度按 core 的 MAX_PAYLOAD 拒绝，绝不截断后继续读。 */
function frameHeader(channel: number, kind: number, length: number): Buffer {
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 0xffffffff) {
    fail('herdr_core_frame_invalid')
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > HERDR_CORE_MAX_FRAME_BYTES) {
    fail('herdr_core_frame_too_large')
  }
  const header = Buffer.alloc(HEADER)
  header.writeUInt32LE(channel, 0)
  header.writeUInt8(kind, 4)
  header.writeUInt32LE(length, 5)
  return header
}

/** 只接受审核过的 hello 结果形状；不解释未知字段。 */
function helloResult(value: unknown): HerdrCoreHello {
  const result = object(value)
  const core = object(result.core)
  if (
    result.generation !== HERDR_CORE_REVIEW.protocol_generation ||
    result.framed !== true ||
    !herdrCoreVersionShape(result.version) ||
    typeof core.id !== 'string' ||
    !/^[a-f0-9]{8,64}$/u.test(core.id) ||
    typeof core.name !== 'string' ||
    !Array.isArray(result.methods) ||
    !Array.isArray(result.features)
  ) {
    fail('herdr_core_handshake_refused')
  }
  // 不按版本号拒绝：core 升级后的不兼容由后面的契约编译、逐方法严格校验与配对时的摘要钉住来失败关闭。
  return Object.freeze({
    generation: result.generation,
    version: result.version,
    core: Object.freeze({ id: core.id, name: core.name }),
    methods: Object.freeze(result.methods.map(/** 方法名只做字符串核对。 */ (entry) => String(entry))),
    features: Object.freeze(result.features.map(/** 能力名同上。 */ (entry) => String(entry)))
  })
}

/** 连接一个已在运行的 core；本函数不拉起进程、不清理套接字，也不接管实例。 */
export async function openHerdrCoreClient(
  socketPath: string,
  options: HerdrCoreClientOptions = {}
): Promise<HerdrCoreClient> {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('\0')) {
    fail('herdr_core_socket_invalid')
  }
  const timeout = options.timeout_ms ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    fail('herdr_core_timeout_invalid')
  }
  const socket: Socket = createConnection({ path: socketPath })
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let framed = false
  // 握手期间只有 hello 的 plain 回复，读循环不能把它当作普通控制消息消费掉。
  let handshaking = true
  let closed = false
  let nextId = 1
  const pending = new Map<number, Pending>()
  const eventListeners = new Set<(event: HerdrCoreEvent) => void>()
  const closeListeners = new Set<() => void>()
  let ready!: () => void
  let failed!: (error: unknown) => void
  const connected = new Promise<void>(
    /** 连接失败与成功各结算一次；之后不再保留监听。 */ (resolve, reject) => {
      ready = resolve
      failed = reject
    }
  )
  void connected.catch(/** 连接失败由调用方观察，避免无人消费的拒绝。 */ () => {})

  /** 统一结算所有待答请求；已关闭后不再发新请求。 */
  function shutdown(error: unknown): void {
    if (closed) {
      return
    }
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    for (const listener of closeListeners) {
      try {
        listener()
      } catch {
        /* 观察者异常不改变连接已关闭的事实。 */
      }
    }
    closeListeners.clear()
    eventListeners.clear()
    socket.destroy()
  }

  /** 错误响应只保留 JSON-RPC 码与 data.kind；未声明的 data 形状当作协议错误。 */
  function failure(message: JsonObject): HerdrCoreRpcError {
    const error = message.error
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
      fail('herdr_core_protocol_invalid')
    }
    const value = error as JsonObject
    if (!Number.isSafeInteger(value.code)) {
      fail('herdr_core_protocol_invalid')
    }
    const data = value.data
    const kind =
      data && typeof data === 'object' && !Array.isArray(data) && typeof (data as JsonObject).kind === 'string'
        ? ((data as JsonObject).kind as string)
        : 'unknown'
    return new HerdrCoreRpcError(value.code as number, kind)
  }

  /**
   * 一个 DATA 帧的负载是一行或多行 JSON：core 会把紧挨着发生的通知合并进同一帧
   * （真实 core 0.1.14 实测：终端被杀时 `status` 与 `finished` 同帧、两行）。
   * 所以逐行解析，绝不把整帧当成一个 JSON；整帧一个字节都不丢，也不静默跳过坏行。
   */
  function frameLines(payload: Buffer): Buffer[] {
    const lines: Buffer[] = []
    let start = 0
    for (;;) {
      const end = payload.indexOf(0x0a, start)
      const line = payload.subarray(start, end < 0 ? payload.byteLength : end)
      if (line.byteLength > 0) {
        lines.push(line)
      }
      if (end < 0) {
        break
      }
      start = end + 1
    }
    // 空负载没有任何可解析的消息：交给解析去拒绝，和过去一样失败关闭。
    return lines.length > 0 ? lines : [payload]
  }

  /** 控制通道上的 JSON 行：回复按 id 配对，通知交给订阅者。 */
  function control(payload: Buffer): void {
    for (const line of frameLines(payload)) {
      controlLine(line)
    }
  }

  function controlLine(payload: Buffer): void {
    const message = object(parseJson(payload, HERDR_CORE_MAX_FRAME_BYTES))
    if (message.jsonrpc !== '2.0') {
      fail('herdr_core_protocol_invalid')
    }
    if (message.method !== undefined) {
      if (typeof message.method !== 'string') {
        fail('herdr_core_protocol_invalid')
      }
      const event = Object.freeze({ channel: CHANNEL_CONTROL, method: message.method, message })
      for (const listener of eventListeners) {
        listener(event)
      }
      return
    }
    const id = message.id
    if (!Number.isSafeInteger(id)) {
      // 没有 id 的回复无法归属到任何请求；不能静默当成成功。
      fail('herdr_core_protocol_invalid')
    }
    const entry = pending.get(id as number)
    if (!entry) {
      // 超时后到达的回复不再有任何请求可归属，丢弃但不影响连接。
      return
    }
    pending.delete(id as number)
    clearTimeout(entry.timer)
    if (message.error !== undefined && message.result !== undefined) {
      entry.reject(new ProviderAdapterError('herdr_core_protocol_invalid'))
      return
    }
    if (message.error !== undefined) {
      entry.reject(failure(message))
      return
    }
    if (message.result === undefined) {
      entry.reject(new ProviderAdapterError('herdr_core_protocol_invalid'))
      return
    }
    entry.resolve(object(message.result))
  }

  /** 事件通道：每帧是一行或多行 JSON（逐行交付），整帧消费完再按字节数回补信用。 */
  function eventChannel(channel: number, payload: Buffer): void {
    for (const line of frameLines(payload)) {
      const message = object(parseJson(line, HERDR_CORE_MAX_FRAME_BYTES))
      if (typeof message.method !== 'string') {
        fail('herdr_core_protocol_invalid')
      }
      const event = Object.freeze({ channel, method: message.method, message })
      for (const listener of eventListeners) {
        listener(event)
      }
    }
    // 消费完再回补，且一次不超过 core 的窗口。
    send(channel, CREDIT, creditPayload(Math.min(payload.byteLength, HERDR_CORE_WINDOW_BYTES)))
  }

  /** 解析一帧；数据不足时返回 undefined，等待更多字节。 */
  function nextFrame(): Readonly<{ channel: number; kind: number; payload: Buffer }> | undefined {
    if (buffer.byteLength < HEADER) {
      return undefined
    }
    const channel = buffer.readUInt32LE(0)
    const kind = buffer.readUInt8(4)
    const length = buffer.readUInt32LE(5)
    if (length > HERDR_CORE_MAX_FRAME_BYTES) {
      fail('herdr_core_frame_too_large')
    }
    if (buffer.byteLength < HEADER + length) {
      return undefined
    }
    const payload = buffer.subarray(HEADER, HEADER + length)
    buffer = buffer.subarray(HEADER + length)
    return { channel, kind, payload }
  }

  /** 读循环：先 plain 行（握手），切到帧模式后按帧分发。 */
  function drain(): void {
    while (!closed) {
      if (handshaking) {
        return
      }
      if (!framed) {
        const end = buffer.indexOf(0x0a)
        if (end < 0) {
          return
        }
        const line = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        control(line)
        continue
      }
      const frame = nextFrame()
      if (!frame) {
        return
      }
      if (frame.channel === CHANNEL_CONTROL && frame.kind === DATA) {
        control(frame.payload)
        continue
      }
      if (frame.kind === DATA) {
        eventChannel(frame.channel, frame.payload)
        continue
      }
      if (frame.kind === CLOSE) {
        // 通道关闭是原生声明；只结束该通道，不重建任何许可。
        continue
      }
      // CREDIT/RESIZE/FOCUS/FACTS 是 viewer→core 方向，服务端发来属于协议不符。
      fail('herdr_core_protocol_invalid')
    }
  }

  socket.on(
    'data',
    /** 先累积再分发；单次累积超过帧上限即拒绝。 */ (chunk: Buffer) => {
      buffer = buffer.byteLength ? Buffer.concat([buffer, chunk]) : chunk
      if (buffer.byteLength > HERDR_CORE_MAX_FRAME_BYTES + HEADER) {
        shutdown(new ProviderAdapterError('herdr_core_frame_too_large'))
        return
      }
      try {
        drain()
      } catch (error) {
        shutdown(error)
      }
    }
  )
  socket.on(
    'error',
    /** 底层错误不携带路径或系统文本；连接尚未建立时还要结算握手等待。 */ () => {
      const error = new ProviderAdapterError('herdr_core_connection_failed')
      shutdown(error)
      failed(error)
    }
  )
  socket.on(
    'close',
    /** EOF 一律当作重订阅信号，不假设事件完整。 */ () =>
      shutdown(new ProviderAdapterError('herdr_core_connection_closed'))
  )
  socket.once(
    'connect',
    /** 连接建立后立即切换帧模式。 */ () => {
      try {
        socket.write(`${boundedJson({ jsonrpc: '2.0', id: 0, method: 'hello', params: { framed: true } }, 4096)}\n`)
      } catch (error) {
        shutdown(error)
        return
      }
      ready()
    }
  )
  await connected

  /** 握手回复仍走 plain 行；成功后所有后续收发都是帧。 */
  const hello = await (async () => {
    const deadline = Date.now() + timeout
    for (;;) {
      if (closed) {
        throw new ProviderAdapterError('herdr_core_connection_closed')
      }
      const end = buffer.indexOf(0x0a)
      if (end >= 0) {
        const line = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        try {
          const message = object(parseJson(line, HERDR_CORE_MAX_FRAME_BYTES))
          if (message.id !== 0 || message.jsonrpc !== '2.0') {
            fail('herdr_core_protocol_invalid')
          }
          if (message.error !== undefined) {
            throw failure(message)
          }
          const result = helloResult(message.result)
          framed = true
          handshaking = false
          return result
        } catch (error) {
          // 握手形状不符（协议代次、版本串、成员）时也要关闭连接，不能留下半开套接字。
          shutdown(error)
          throw error
        }
      }
      if (Date.now() >= deadline) {
        shutdown(new ProviderAdapterError('herdr_core_timeout'))
        throw new ProviderAdapterError('herdr_core_timeout')
      }
      await pause(5)
    }
  })()

  /** 帧发送：先登记再写，写失败立即结算本请求。 */
  function send(channel: number, kind: number, payload: Buffer): void {
    if (closed) {
      fail('herdr_core_connection_closed')
    }
    try {
      socket.write(Buffer.concat([frameHeader(channel, kind, payload.byteLength), payload]))
    } catch {
      fail('herdr_core_connection_closed')
    }
  }

  /** u32 LE 的信用字节数。 */
  function creditPayload(bytes: number): Buffer {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0xffffffff) {
      fail('herdr_core_credit_invalid')
    }
    const payload = Buffer.alloc(4)
    payload.writeUInt32LE(bytes, 0)
    return payload
  }

  /** 单个请求：登记 id、写帧、按 deadline 结算。 */
  function request(
    method: string,
    params: JsonObject,
    timeoutMs = Math.min(timeout, HERDR_CORE_REQUEST_MAX_MS)
  ): Promise<JsonObject> {
    if (closed) {
      return Promise.reject(new ProviderAdapterError('herdr_core_connection_closed'))
    }
    if (pending.size >= MAX_PENDING) {
      return Promise.reject(new ProviderAdapterError('herdr_core_capacity'))
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HERDR_CORE_REQUEST_MAX_MS) {
      return Promise.reject(new ProviderAdapterError('herdr_core_timeout_invalid'))
    }
    const line = boundedJson({ jsonrpc: '2.0', id: nextId, method, params }, HERDR_CORE_MAX_REQUEST_BYTES)
    const id = nextId++
    return new Promise<JsonObject>(
      /** 定时器与回复共用一次结算；超时只结束本地等待。 */ (resolve, reject) => {
        const timer = setTimeout(
          /** 超时后清掉登记，迟到的回复按未知 id 丢弃。 */ () => {
            pending.delete(id)
            reject(new ProviderAdapterError('herdr_core_timeout'))
          },
          timeoutMs
        )
        pending.set(id, { resolve, reject, timer })
        try {
          send(CHANNEL_CONTROL, DATA, Buffer.from(line))
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      }
    )
  }

  return Object.freeze({
    hello,
    socket_path: socketPath,
    peer: /** 每次现读内核值，不缓存。 */ () => readLinuxPeer(socket),
    request,
    closed: /** 只报告本连接的事实，不推断 core 进程状态。 */ () => closed,
    onEvent: /** 只登记观察者，不改变订阅状态。 */ (listener: (event: HerdrCoreEvent) => void) => {
      eventListeners.add(listener)
      return /** 取消只移除本观察者。 */ () => eventListeners.delete(listener)
    },
    onClose: /** 连接已关闭时立即通知，避免调用方等一个不会到来的事件。 */ (listener: () => void) => {
      if (closed) {
        listener()
        return () => {}
      }
      closeListeners.add(listener)
      return /** 取消只移除本观察者。 */ () => closeListeners.delete(listener)
    },
    credit: /** 显式信用回补只用于事件通道之外的流。 */ (channel: number, bytes: number) =>
      send(channel, CREDIT, creditPayload(bytes)),
    close: /** 幂等关闭；不发任何原生 stop/restart。 */ () => shutdown(new ProviderAdapterError('herdr_core_closed'))
  })
}
