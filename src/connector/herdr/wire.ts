/** 将已评审 Herdr 普通 RPC 接入现有 Wire 接口；不提供原生流、对象传输或取消保证。 */
import {
  assertBinding,
  boundedJson,
  decodeWireFrame,
  encodeWireFrame,
  fail,
  MessageWindow,
  WireError
} from '../../wire/index.js'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedEnvelope,
  Direction,
  JsonObject,
  WireEnvelope
} from '../../wire/types.js'
import { createHerdrReadonlyAdapter } from './readonly.js'
import type { HerdrReadonlyBackend } from './readonly.js'

/** 从完整绑定剥离连接字段；没有新 ID、重试队列或其它持久化身份。 */
function identityOf(binding: AttemptBinding): AttemptIdentity {
  const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...identity } = binding
  return identity
}

/** 对宿主异常只返回稳定错误码，避免将本机配置或原生内容带入通道错误。 */
function guarded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return /** 只保留已有 Wire 错误，其余失败收敛为适配器不可用。 */ (...args) => {
    try {
      return fn(...args)
    } catch (error) {
      if (error instanceof WireError) {
        throw error
      }
      fail('native_adapter_unavailable')
    }
  }
}

/** 共用同一 core 保存 permit；宿主原生执行和 Wire 编解码不能创建互不关联的两套许可。 */
export function createHerdrWireAdapter(backend: HerdrReadonlyBackend, core = createHerdrReadonlyAdapter(backend)) {
  const windows = new Map<Direction, { connection: string; window: MessageWindow }>()

  /** 只接受普通 RPC 与连接治理帧；即使协商了其它能力也不能暗中使用。 */
  function ordinary(frame: WireEnvelope): void {
    if (
      ![
        'request',
        'accepted',
        'dispatch_refused',
        'response',
        'cancel',
        'heartbeat',
        'error',
        // 平台声明属于连接本身，不属于任何一个 provider，仍由 Wire codec 完整校验。
        'device_platform',
        'host_profile'
      ].includes(frame.type)
    ) {
      fail('herdr_transport_unsupported')
    }
  }

  /** 以同一完整 binding 重新核对私有句柄；调用方不能把另一个 epoch 拼到原身份上。 */
  function resolve(binding: AttemptBinding) {
    const context = core.resolve(identityOf(binding))
    assertBinding(binding, context.binding)
    return context
  }

  /** 校验当前读取边界，并在提供响应时先验证原生来源、完整 schema 和精确 request ID。 */
  function checkResult(binding: AttemptBinding, response?: JsonObject): void {
    const context = resolve(binding)
    if (response !== undefined) {
      core.validator.validateResponse(response, context)
    }
    core.checkResult(context)
  }

  return Object.freeze({
    /** 只在完整 Wire 校验成功后准备原请求；准备不发送原生字节或代表执行已完成。 */
    encode: guarded(
      /** 完整校验成功后仅建立本桥接的原请求 permit。 */ (frame: WireEnvelope, direction: Direction): string => {
        const snapshot = JSON.parse(boundedJson(frame)) as WireEnvelope
        ordinary(snapshot)
        const raw = encodeWireFrame(snapshot, core.wireContext(direction))
        if (snapshot.type === 'request') {
          const context = core.resolve(snapshot.payload.attempt)
          core.encodeRequest({ ...snapshot.payload.native_request, id: context.binding.native_request_id }, context)
        }
        return raw
      }
    ),
    /** 解码只做普通 Wire 校验；实际原生派发仍由宿主消费同一 core 的准备入口。 */
    decode: guarded(
      /** 在现有认证上下文解析普通 RPC。 */ (input: string | Uint8Array, direction: Direction): WireEnvelope => {
        const frame = decodeWireFrame(input, core.wireContext(direction))
        ordinary(frame)
        return frame
      }
    ),
    checkResult: guarded(checkResult),
    checkResultRetention: guarded(checkResult),
    /** 已认证消息按当前连接和方向去重；冲突不会生成第二个原生调用。 */
    observeMessage: guarded(
      /** 对同一连接方向检查有界消息 ID 窗口。 */ (
        frame: AuthenticatedEnvelope,
        direction: Direction
      ): 'new' | 'duplicate' => {
        ordinary(frame)
        const context = core.wireContext(direction)
        const stamp = boundedJson(context.connection)
        let entry = windows.get(direction)
        if (!entry || entry.connection !== stamp) {
          entry = { connection: stamp, window: new MessageWindow() }
          windows.set(direction, entry)
        }
        return entry.window.observe(frame, context, backend.now())
      }
    ),
    /** 证据计划来自同一原生 permit 和固定 Store 锚点；提交由已有 Store 事务完成。 */
    planEvidence: guarded(
      /** 在原锚点上生成受治理的响应证据。 */ (frame: Extract<AuthenticatedEnvelope, { type: 'response' }>) =>
        core.planEvidence(frame)
    ),
    /** 释放桥接等待和私有句柄，不发送 Herdr cancel、不关闭 pane，也不回滚原生工作。 */
    release: guarded(
      /** 仅释放私有等待，不产生原生控制动作。 */ (binding: AttemptBinding): void => {
        core.releaseBinding(binding)
      }
    ),
    /** 关闭本 adapter 的桥接状态与去重窗，不停止 Herdr 实例。 */
    close(): void {
      windows.clear()
      core.close()
    },
    /** 只公开资源计数和关闭状态，不暴露请求、结果或来源令牌。 */
    stats() {
      return core.stats()
    }
  })
}
