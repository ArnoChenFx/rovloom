// 定义通道宿主契约、严格连接地址与帧预算，并提供 provider 健康和有界接收去重。
import { randomUUID } from 'node:crypto'
import {
  boundedJson,
  discardFencedWireFrame,
  fail,
  hash,
  id,
  LIMITS,
  object,
  parseJson,
  validateProvider
} from '../wire/index.js'
import type {
  AuthenticatedContext,
  AuthenticatedEnvelope,
  ProviderBinding,
  ProviderSnapshot,
  TerminalExecutionState,
  Direction,
  VersionOffer
} from '../wire/types.js'
import type { createLuvusWireAdapter } from '../integration/luvus-wire.js'

export type Connection = AuthenticatedContext['connection']
/** checkResultRetention 同次核验当前读取及独立保留许可，不能只检查保留位。 */
export type Adapter = Pick<
  ReturnType<typeof createLuvusWireAdapter>,
  'encode' | 'decode' | 'checkResult' | 'checkResultRetention' | 'observeMessage' | 'planEvidence' | 'release' | 'close'
> & {
  /** 共享桥接只观察关闭及执行/响应上下文计数，不要求 provider 暴露协议专有状态。 */
  stats(): { closed: boolean; executions: number; responses: number }
}
export type Readiness = {
  policy_revision: string
  peer_policy_revision: string
  providers: { expected: ProviderBinding; local: ProviderBinding; native_ready: boolean }[]
}
export type Session = {
  adapter: Adapter
  /** 只失效同 epoch 原配置的一个 provider；不得用此入口接纳新 binding 或复活旧来源。 */
  fenceProvider?(binding: ProviderBinding): void
  /** 返回已永久失效的原配置，供 transport 发布有界撤回；不交付原生状态或许可。 */
  providerFences?(): readonly ProviderBinding[]
  /** Connector 返回稳定、深冻结的每 epoch 快照；getter 只轻量复核真实来源仍活，不重建或刷新 generation。 */
  providerSnapshot?(): readonly ProviderSnapshot[]
  /** 当前本机开关的有效值，仅用于目录；不授予请求执行或替代最终 IO 检查。 */
  terminalExecutionState?(): readonly TerminalExecutionState[]
  /** Gateway 同步接纳当前 session 收到的快照；可信 pin/能力核验和关闭时失效由该 epoch 宿主负责。 */
  acceptProviderSnapshot?(snapshot: ProviderSnapshot): void
  /** 从受保护宿主取得双端配置与原生健康，不由设备广告生成可信状态。 */
  readiness(): Readiness
  /** 关闭所属传输或会话资源，不宣称原生动作已停止或回滚。 */
  close(): void
}
/** 只消费原会话的同步失效端口；Promise 或缺端口不代表原来源已撤回。 */
export function fenceSessionProvider(session: Session, binding: ProviderBinding): void {
  if (!session.fenceProvider) {
    fail('provider_fence_backend_unavailable')
  }
  const value: unknown = session.fenceProvider(structuredClone(binding))
  if (value !== undefined) {
    void Promise.resolve(value).catch(/** 违规异步关闭的晚拒绝不复活来源。 */ () => {})
    fail('synchronous_provider_fence_required')
  }
}
/** 只在原 decoder 拒绝后校验并丢弃失效来源的迟到帧，不重建或交付任何原生许可。 */
export function discardProviderFrame(
  raw: string,
  connection: Connection,
  direction: Direction,
  fenced: ReadonlyMap<string, ProviderBinding>
): boolean {
  return (
    fenced.size > 0 &&
    discardFencedWireFrame(
      raw,
      {
        phase: 'authenticated',
        connection,
        direction
      },
      [...fenced.values()]
    )
  )
}
/** 先销毁 adapter 全部上下文并取消账本订阅，再同步关闭宿主资源；任一步失败仍执行另一项清理。 */
export function closeSession(session: Session | undefined): void {
  if (!session) {
    return
  }
  try {
    if (session.adapter.close() !== undefined) {
      fail('synchronous_channel_block_required')
    }
  } finally {
    if (session.close() !== undefined) {
      fail('synchronous_channel_block_required')
    }
  }
}
export const OFFER: VersionOffer = {
  major: 2,
  minor: 0,
  capabilities: ['rpc', 'dispatch_refusal'],
  required: ['rpc']
}
/** 构造绑定当前设备、恢复代次和 epoch 的业务 envelope，并分配独立消息 ID。 */
export const envelope = <K extends AuthenticatedEnvelope['type']>(
  connection: Connection,
  type: K,
  payload: Extract<AuthenticatedEnvelope, { type: K }>['payload']
): Extract<AuthenticatedEnvelope, { type: K }> =>
  ({
    protocol_major: 2,
    protocol_minor: connection.negotiated.minor,
    type,
    message_id: randomUUID(),
    machine_id: connection.machine_id,
    recovery_generation: connection.recovery_generation,
    connection_epoch: connection.connection_epoch,
    payload
  }) as Extract<AuthenticatedEnvelope, { type: K }>

/** 限制 provider 数量并逐实例计算可信配置一致性，返回分层健康观测。 */
export function providerHealth(connection: Connection, state: Readiness) {
  if (state.providers.length > 64) {
    fail('provider_limit')
  }
  const seen = new Set<string>()
  return state.providers.map(
    /** 校验 provider 归属和重复 ID，合并双端配置、策略及原生健康为该实例的 ready 状态。 */
    ({ expected, local, native_ready }) => {
      validateProvider(expected)
      validateProvider(local)
      if (expected.machine_id !== connection.machine_id || seen.has(expected.provider_id)) {
        fail('provider_binding_mismatch')
      }
      seen.add(expected.provider_id)
      return {
        provider_id: expected.provider_id,
        ready:
          state.policy_revision.length > 0 &&
          state.policy_revision === state.peer_policy_revision &&
          boundedJson(expected) === boundedJson(local) &&
          expected.enabled &&
          native_ready === true
      }
    }
  )
}

/** 查询指定 provider 或任一实例是否就绪；设备已认证本身不足以返回 true。 */
export function ready(session: Session, connection: Connection, provider?: string): boolean {
  const health = providerHealth(connection, session.readiness())
  return provider
    ? health.some(
        /** 匹配指定实例并要求该实例通过可信 readiness 检查。 */
        (p) => p.provider_id === provider && p.ready
      )
    : health.some(
        /** 判断设备下是否至少有一个可用实例，保留各 provider 的独立健康。 */
        (p) => p.ready
      )
}

/** 仅识别数字 IPv4/IPv6 loopback，不通过 hostname 解析扩大开发 WS 范围。 */
export function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === '[::1]'
}
/** 规范化固定WS/WSS通道 URL，拒绝夹带凭据、查询及路径变化；公网TLS由反向代理终止。 */
export function endpoint(raw: string, _developmentLoopback = false): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('invalid_endpoint')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/connector') {
    fail('invalid_endpoint')
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    fail('tls_required')
  }
  return url
}

/** 通道对端被动关闭事件；code/reason 属于不可信对端输入，只能经白名单归一化后使用。 */
export type CloseEvent = {
  code: number
  reason: string
}

// Bun 原生 API 的局部类型，避免为 transport 改动公共工具链依赖。
export type Socket = {
  /** 将已编码文本交给 socket，并返回写入或背压状态供调用方判定。 */
  send(data: string): number
  /** 关闭所属传输或会话资源，不宣称原生动作已停止或回滚。 */
  close(code?: number, reason?: string): void
  /** 立即终止底层传输，用于拒绝或停止后的有界清理。 */
  terminate(): void
  bufferedAmount: number
  readyState: number
  /** 在链路建立后启动认证握手，不直接建立业务 ready。 */
  onopen: null | (() => void)
  /** 处理对端帧并核对认证、方向和 epoch 后再进入业务。 */
  onmessage: null | ((event: { data: string | Uint8Array }) => void)
  /** 回收该 socket 的状态，并由所属角色决定是否退避重连；关闭码/原因须经白名单归一化。 */
  onclose: null | ((event: CloseEvent) => void)
  /** 将网络失败收敛为关闭；事件正文完全不读，也不向普通输出透传错误原文。 */
  onerror: null | ((event: unknown) => void)
}
export type ServerSocket<T> = Pick<Socket, 'send' | 'close' | 'terminate'> & {
  data: T
  /** 取得底层缓冲字节数，写出前用于背压预算。 */
  getBufferedAmount(): number
}
export type Listener = {
  port: number
  /** 停止 listener，并按参数关闭活动连接，不建立新的业务通道。 */
  stop(closeActiveConnections?: boolean): void
}
type ServeOptions<T> = {
  hostname: string
  port: number
  tls?: { cert: string; key: string }
  /** 检查固定升级路径与配额，仅为允许的请求创建 socket。 */
  fetch(
    request: Request,
    server: {
      /** 把获准 HTTP 请求升级为绑定预留 peer 的 socket，返回是否升级成功。 */
      upgrade(request: Request, options: { data: T }): boolean
    }
  ): Response | undefined | Promise<Response | undefined>
  websocket: {
    maxPayloadLength: number
    backpressureLimit: number
    closeOnBackpressureLimit: boolean
    perMessageDeflate: false
    /** 把新 socket 交给该连接的资源状态，不能仅据链路打开宣布 ready。 */
    open(ws: ServerSocket<T>): void
    /** 接收该 socket 的单帧输入，并由角色自己的认证/业务边界校验。 */
    message(ws: ServerSocket<T>, message: string | Uint8Array): void
    /** 关闭所属传输或会话资源，不宣称原生动作已停止或回滚。 */
    close(ws: ServerSocket<T>): void
  }
}
/** 取得 Bun 原生 listener API 的局部类型视图，保持公共工具链依赖不变。 */
export const runtime = () =>
  (
    globalThis as unknown as {
      Bun: {
        /** 用受限配置创建 Bun listener；TLS、认证和生命周期仍由宿主实现。 */
        serve<T>(options: ServeOptions<T>): Listener
      }
    }
  ).Bun
/** 创建使用系统信任及严格hostname校验的出站socket，不接受自管CA或跳过验证选项。 */
export const socket = (url: string): Socket =>
  new (WebSocket as unknown as new (url: string, options: { tls: { rejectUnauthorized: true } }) => Socket)(url, {
    tls: { rejectUnauthorized: true }
  })

/** 按 UTF-8 字节核对整帧预算，超限时在写出前拒绝。 */
export function budget(raw: string, max: number = LIMITS.frame_bytes): string {
  if (Buffer.byteLength(raw) > max) {
    fail('frame_too_large')
  }
  return raw
}
/** 验证资源配置为有界正安全整数，避免非法配额进入运行状态。 */
export function positive(value: number, max = 86_400_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail('transport_limit')
  }
  return value
}

// 先抑制已接收的重复帧，再进入可能已释放原生 handle 的 adapter；满窗拒绝，不提前淘汰。
export class ReceiveWindow {
  private readonly entries = new Map<string, { digest: string; expires: number }>()
  /** 维护有界接收去重窗口；相同载荷返回 duplicate，冲突或满窗拒绝且不提前淘汰有效记录。 */
  observe(raw: string, now: number): 'new' | 'duplicate' {
    const frame = object(parseJson(raw))
    id(frame.message_id)
    for (const [key, value] of this.entries) {
      if (value.expires <= now) {
        this.entries.delete(key)
      }
    }
    const digest = hash(boundedJson(frame))
    const previous = this.entries.get(frame.message_id)
    if (previous) {
      if (previous.digest !== digest) {
        fail('message_id_conflict')
      }
      return 'duplicate'
    }
    if (this.entries.size >= LIMITS.dedup_entries) {
      fail('dedup_window_full')
    }
    this.entries.set(frame.message_id, { digest, expires: now + 60_000 })
    return 'new'
  }
}
