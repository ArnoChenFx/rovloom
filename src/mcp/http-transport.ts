// 保留官方Streamable HTTP协议处理，补上受限请求关联、取消原因脱敏和公开响应边界。
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { HandleRequestOptions } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js'
import { ARGUMENTS_TOO_LARGE_DATA, MAX_MCP_BYTES } from './schema.js'

type PublicId = string | number
export type RequestReservation = Readonly<{ externalId: PublicId; internalId: number }>
const messages: Record<number, string> = {
  [ErrorCode.ParseError]: 'Parse error',
  [ErrorCode.InvalidRequest]: 'Invalid request',
  [ErrorCode.MethodNotFound]: 'Method not found',
  [ErrorCode.InvalidParams]: 'Invalid params',
  [ErrorCode.InternalError]: 'Internal error'
}

// 将公共ID映射为SDK私有正整数，使0和空字符串取消也遵循同一关联，禁止覆盖在途请求。
export class FacadeHttpTransport extends WebStandardStreamableHTTPServerTransport {
  private readonly external = new Map<PublicId, RequestReservation>()
  private readonly internal = new Map<number, RequestReservation>()
  private readonly delivered = new Set<number>()
  private readonly cancelled = new Set<number>()
  private readonly incoming = new AsyncLocalStorage<RequestReservation | undefined>()
  private nextId = 1
  private stopped = false
  private closing: Promise<void> | undefined

  // 在SDK派发前建立固定错误和取消边界，不重写HTTP握手、版本或会话协议。
  override async start(): Promise<void> {
    const onmessage = this.onmessage
    this.cancelSdk = /* 直接通知SDK私有正整数关联，不反射取消reason。 */ (id) =>
      onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
    this.onmessage = /* 请求关联只来自已由HTTP层预留的合法消息，通知不能自报身份。 */ (message, extra) => {
      if (this.stopped) {
        return
      }
      if ('method' in message && 'id' in message) {
        const reservation = this.incoming.getStore()
        if (reservation === undefined || this.external.get(message.id) !== reservation) {
          return
        }
        const id = reservation.internalId
        this.delivered.add(id)
        if (this.cancelled.has(id)) {
          this.cancelReservation(reservation)
          return
        }
        const schema =
          message.method === 'tools/call'
            ? CallToolRequestSchema
            : message.method === 'tools/list'
              ? ListToolsRequestSchema
              : message.method === 'initialize'
                ? InitializeRequestSchema
                : undefined
        if (schema && !schema.safeParse(message).success) {
          void this.send({
            jsonrpc: '2.0',
            id,
            error: { code: ErrorCode.InvalidParams, message: 'Invalid params' }
          }).catch(
            /* 响应失败只报告固定传输诊断，不能输出非法参数或异常原文。 */ () =>
              this.onerror?.(new Error('response_failed'))
          )
          return
        }
        onmessage?.({ ...message, id }, extra)
        return
      }
      if ('method' in message && message.method === 'notifications/cancelled') {
        const parsed = CancelledNotificationSchema.safeParse(message)
        if (parsed.success && parsed.data.params.requestId !== undefined) {
          this.cancelRequest(parsed.data.params.requestId)
        }
        return
      }
      onmessage?.(message, extra)
    }
    await super.start()
  }

  // 将HTTP请求专属预留延续到SDK异步派发；旧POST不能借同公共ID的新关联执行业务。
  handleReservedRequest(
    request: Request,
    options: HandleRequestOptions,
    reservation: RequestReservation | undefined
  ): Promise<Response> {
    return this.incoming.run(
      reservation,
      /* SDK握手、SSE及版本处理仍全部沿用固定官方实现。 */ () => super.handleRequest(request, options)
    )
  }

  // 在SDK修改其请求映射前原子预留ID；并发POST不能覆盖同一会话内的既有请求。
  reserve(message: JSONRPCMessage): RequestReservation | false | undefined {
    if (!('method' in message && 'id' in message)) {
      return undefined
    }
    if (
      this.stopped ||
      (typeof message.id === 'string' && Buffer.byteLength(message.id) > 128) ||
      (typeof message.id === 'number' && !Number.isSafeInteger(message.id)) ||
      this.external.has(message.id) ||
      this.internal.size >= 1024 ||
      !Number.isSafeInteger(this.nextId)
    ) {
      return false
    }
    const id = this.nextId++
    const reservation = Object.freeze({ externalId: message.id, internalId: id })
    this.external.set(message.id, reservation)
    this.internal.set(id, reservation)
    return reservation
  }

  // HTTP层提前拒绝时释放尚未派发的预留，已经执行的请求必须由回复或取消释放。
  releaseUndelivered(reservation: RequestReservation | undefined): void {
    if (
      reservation &&
      this.external.get(reservation.externalId) === reservation &&
      !this.delivered.has(reservation.internalId)
    ) {
      this.external.delete(reservation.externalId)
      this.internal.delete(reservation.internalId)
      this.cancelled.delete(reservation.internalId)
    }
  }

  // 只停止相应SDK等待并关闭其HTTP流；无event store，不保留可重放消息或晚到回复。
  cancelRequest(externalId: PublicId): void {
    const reservation = this.external.get(externalId)
    if (reservation) {
      this.cancelReservation(reservation)
    }
  }

  // HTTP结束只清理该请求实际拥有的关联，旧响应断开不能取消复用同ID的新请求。
  cancelReservation(reservation: RequestReservation): void {
    if (this.external.get(reservation.externalId) !== reservation) {
      return
    }
    const { externalId, internalId: id } = reservation
    if (!this.delivered.has(id)) {
      // SDK尚未派发时保留公共ID占用，直至其旧POST完成，防止旧SDK流覆盖新关联。
      this.cancelled.add(id)
      return
    }
    this.external.delete(externalId)
    this.internal.delete(id)
    this.delivered.delete(id)
    this.cancelled.delete(id)
    this.cancelSdk?.(id)
    super.closeSSEStream(externalId)
    // SDK无event store时在不可投递响应分支释放关联；先关流，因此不会发送取消响应。
    void super
      .send({ jsonrpc: '2.0', id: externalId, error: { code: -32800, message: 'Request cancelled' } })
      .catch(/* 流已经关闭的固定清理拒绝已被观察，不作为业务失败或泄密诊断。 */ () => {})
  }

  private cancelSdk?: (id: number) => void

  // 响应恢复公共ID；仅重建固定的参数超限诊断，其余SDK错误data和异常原文全部移除。
  override async send(message: JSONRPCMessage): Promise<void> {
    if (this.stopped) {
      return
    }
    let outgoing = message
    let internalId: number | undefined
    if ('id' in message && !('method' in message)) {
      internalId = typeof message.id === 'number' ? message.id : undefined
      const reservation = internalId === undefined ? undefined : this.internal.get(internalId)
      if (reservation === undefined) {
        return
      }
      const id = reservation.externalId
      const data = 'error' in message ? message.error.data : undefined
      outgoing =
        'error' in message
          ? {
              jsonrpc: '2.0',
              id,
              error: {
                code: message.error.code,
                message: messages[message.error.code] ?? 'Request failed',
                ...(message.error.code === ErrorCode.InvalidParams &&
                typeof data === 'object' &&
                data !== null &&
                'reason' in data &&
                data.reason === ARGUMENTS_TOO_LARGE_DATA.reason &&
                'limit_bytes' in data &&
                data.limit_bytes === MAX_MCP_BYTES
                  ? { data: ARGUMENTS_TOO_LARGE_DATA }
                  : {})
              }
            }
          : { ...message, id }
    }
    if (Buffer.byteLength(JSON.stringify(outgoing)) > MAX_MCP_BYTES) {
      const error = new Error('response_too_large')
      this.onerror?.(error)
      // 没有关联的通知/服务端请求只拒绝本次发送，让发送方结清等待，不能关闭共享会话。
      if (internalId === undefined || !('id' in outgoing)) {
        throw error
      }
      // 交给 SDK 正常投递一个有界终态，释放当前 HTTP 流与双方关联，不声明原生未派发。
      outgoing = {
        jsonrpc: '2.0',
        id: outgoing.id,
        error: {
          code: ErrorCode.InternalError,
          message: 'Internal error',
          data: { reason: 'response_too_large', limit_bytes: MAX_MCP_BYTES }
        }
      }
    }
    try {
      await super.send(outgoing)
    } finally {
      if (internalId !== undefined) {
        const reservation = this.internal.get(internalId)
        this.internal.delete(internalId)
        this.delivered.delete(internalId)
        this.cancelled.delete(internalId)
        if (reservation !== undefined && this.external.get(reservation.externalId) === reservation) {
          this.external.delete(reservation.externalId)
        }
      }
    }
  }

  // 只清理本MCP会话的协议等待，不释放共享业务service或取消native工作。
  override close(): Promise<void> {
    this.stopped = true
    this.closing ??= Promise.resolve().then(
      /* SDK1.32.1 close不清请求映射，先阻止新流登记，再通过官方closed分支结清既有映射。 */ async () => {
        const reservations = Array.from(this.internal.values())
        try {
          await super.close()
        } finally {
          for (const reservation of reservations) {
            await super
              .send({
                jsonrpc: '2.0',
                id: reservation.externalId,
                error: { code: -32800, message: 'Request cancelled' }
              })
              .catch(/* 未登记流的预留没有SDK关联；已有映射沿官方closed分支释放。 */ () => {})
          }
          this.external.clear()
          this.internal.clear()
          this.delivered.clear()
          this.cancelled.clear()
          this.incoming.disable()
        }
      }
    )
    return this.closing
  }
}
