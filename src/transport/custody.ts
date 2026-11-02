// 将配对凭据交给独立授权的专用 sink，严格核对交付确认并隔离普通返回值。
import { randomUUID } from 'node:crypto'
import { fail, hash, id } from '../wire/index.js'
import type { DeviceCredential } from './identity.js'

export type PairingRequest = { registration_id: string; enrollment: string }
export type CredentialDeliveryContext = { delivery_id: string; revision: number }
export type CredentialDeliveryAck = CredentialDeliveryContext & { machine_id: string; recovery_generation: string }
export interface PairingBackend {
  /** 复用 Store 的原子一次性兑换，secret 返回只可进入受保护的专用 custody。 */
  redeem(enrollment: string): { machine_id: string; credential: string }
  /** 读取受信账本当前恢复代次，禁止从消息字段建立当前来源。 */
  generation(): string
}
export interface DeliveryLedger {
  /** 交付失败或结果未知时拒绝该精确凭据摘要，设备须经确认重新配对。 */
  rejectDelivery(machine: string, digest: string): void
  /** 读取当前凭据的交付关联序号，不返回 secret。 */
  credentialRevision(machine: string): number
}
export interface CredentialSink {
  /** 只供已认证宿主创建的专用 sink；禁止请求指定路径或 principal，完成 custody 后才返回精确交付确认。 */
  deliver(
    credential: DeviceCredential,
    signal: AbortSignal,
    context: CredentialDeliveryContext
  ): Promise<CredentialDeliveryAck>
  /** 关闭专用 secret 通道并拒绝后续交付，不输出或重发凭据。 */
  close(): void
}
type Receipt = { machine_id: string; delivery_id: string; state: 'delivered' }

/** 组合一次性 Store 兑换、持久 hash 变更和专用 sink，普通调用方只收到非秘密 receipt。 */
export function createPairingDelivery(options: {
  backend: PairingBackend
  identities: DeliveryLedger
  /** 根据独立渠道身份和精确操作/目标创建专用 sink，不允许业务输入指定路径或 principal。 */
  authorizeChannel(context: { machine_id: string; delivery_id: string; operation: 'enroll' }): CredentialSink
  timeout_ms?: number
  concurrency?: number
}) {
  const timeout = options.timeout_ms ?? 5000
  const concurrency = options.concurrency ?? 4
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 64
  ) {
    fail('pairing_limit')
  }
  const pending = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>
      /** 结束本次交付等待并关闭 sink；未完成发送仍须计入并发额度。 */
      abort(): void
    }
  >()
  let closed = false
  /** 在并发和超时预算内交付单次凭据；确认匹配全部关联轴，失败按精确 hash 跨 revision 拒绝。 */
  async function transfer(
    machine: string,
    operation: 'enroll',
    issue: () => { machine_id: string; credential: string }
  ): Promise<Receipt> {
    if (closed || pending.size >= concurrency) {
      fail('pairing_unavailable')
    }
    id(machine)
    const deliveryId = randomUUID()
    let sink: CredentialSink
    try {
      sink = options.authorizeChannel({ machine_id: machine, delivery_id: deliveryId, operation })
    } catch {
      fail('pairing_channel_forbidden')
    }
    if (!sink || typeof sink.deliver !== 'function' || typeof sink.close !== 'function') {
      fail('pairing_channel_forbidden')
    }
    if (closed) {
      try {
        sink.close()
      } catch {
        /* 不透传宿主错误。 */
      }
      fail('pairing_unavailable')
    }
    const controller = new AbortController()
    let rejectAbort!: (reason: Error) => void
    const aborted = new Promise<never>(
      /** 保存中止 Promise 的拒绝入口，使关闭或超时能结束本次等待。 */
      (_, reject) => {
        rejectAbort = reject
      }
    )
    /** 传播 AbortSignal 并关闭专用 sink，隐藏宿主关闭异常原文。 */
    const closeSink = () => {
      controller.abort()
      try {
        sink.close()
      } catch {
        /* 不透传宿主错误原文。 */
      }
    }
    /** 让本次交付进入 unknown，同时保留未真正完成发送所占的并发额度。 */
    const abort = () => {
      closeSink()
      rejectAbort(new Error('pairing_delivery_unknown'))
    }
    const timer = setTimeout(abort, timeout)
    pending.set(deliveryId, { timer, abort })
    let installedMachine: string | undefined
    let installedDigest: string | undefined
    let sending = false
    try {
      const device = issue()
      installedMachine = device.machine_id
      installedDigest = hash(device.credential)
      if (installedMachine !== machine) {
        fail('pairing_target_mismatch')
      }
      const generation = options.backend.generation()
      const credential = { ...device, recovery_generation: generation }
      const revision = options.identities.credentialRevision(machine)
      sending = true
      const delivered = Promise.resolve()
        .then(
          /** 将已提交的凭据交给专用 sink，并固定本次 delivery ID 与 credential revision。 */
          () => sink.deliver(structuredClone(credential), controller.signal, { delivery_id: deliveryId, revision })
        )
        .finally(
          /** 仅在实际发送 Promise 收尾后释放计时器和额度，避免忽略 abort 的发送造成无限并发。 */
          () => {
            clearTimeout(timer)
            pending.delete(deliveryId)
          }
        )
      const ack = await Promise.race([delivered, aborted])
      if (
        !ack ||
        ack.delivery_id !== deliveryId ||
        ack.revision !== revision ||
        ack.machine_id !== machine ||
        ack.recovery_generation !== generation
      ) {
        fail('pairing_ack_mismatch')
      }
      if (closed || controller.signal.aborted) {
        fail('pairing_delivery_unknown')
      }
      return { machine_id: machine, delivery_id: deliveryId, state: 'delivered' }
    } catch {
      if (installedMachine !== undefined && installedDigest !== undefined) {
        try {
          options.identities.rejectDelivery(installedMachine, installedDigest)
        } catch {
          /* 身份库拒绝标记保持封锁。 */
        }
      }
      // 消费或写入是否完成不作回滚推断；丢交付须独立确认同 ID 重配，禁止自动重发。
      return fail('pairing_delivery_unknown')
    } finally {
      clearTimeout(timer)
      closeSink()
      // 忽略关闭的宿主发送仍占额度，直到其 Promise 真正完成。
      if (!sending) {
        pending.delete(deliveryId)
      }
    }
  }
  return {
    /** 校验 enrollment 输入并发起专用兑换交付；不向普通返回值暴露 secret。 */
    async redeem(request: PairingRequest): Promise<Receipt> {
      if (typeof request.enrollment !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(request.enrollment)) {
        fail('invalid_enrollment')
      }
      return transfer(
        request.registration_id,
        'enroll',
        /** 凭据摘要在原子兑换事务内保存；transfer 先记录清理所需身份，再校验目标与读取代次。 */
        () => options.backend.redeem(request.enrollment)
      )
    },
    /** 只报告服务是否关闭和未完成发送数量，不暴露任何凭据内容。 */
    status() {
      return { closed, pending: pending.size }
    },
    /** 关闭所有专用交付并停止其 timer；忽略关闭的发送仍计入未完成额度。 */
    close(): void {
      if (closed) {
        return
      }
      closed = true
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.abort()
      }
    }
  }
}
