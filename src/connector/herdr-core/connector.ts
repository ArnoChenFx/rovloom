/**
 * herdr-core 的 Connector 生产资源：只附着已运行的 core，交付已验证的执行会话。
 * 不启动/停止 core、不订阅事件、不打开 Gateway Store，也不把读取以外的档位接进 Wire。
 */
import { GatewayError } from '../../contracts.js'
import { readSchema } from '../schema-store.js'
import { DispatchClaims } from '../claims.js'
import { connectorAdmissionAdapter } from '../../runtime/connector-attempts.js'
import { ConnectorAttemptBook } from '../../runtime/connector-attempts.js'
import { contractRef, fail } from '../../wire/index.js'
import type { Connection, ConnectorWireSession } from '../../transport/index.js'
import type { ProviderBinding, V2Target } from '../../wire/types.js'
import { createHerdrCoreConnectorRuntime } from './runtime.js'
import { HerdrCoreInstallation, assertHerdrCoreSessionFits } from './installation.js'
import type { HerdrCoreAttachment } from './installation.js'
import { parseHerdrCoreProviderRefConfig } from './provider.js'
import type { HerdrCoreProviderRefConfig } from './provider.js'
import { pinTerminalExecution } from '../terminal-execution.js'

export const HERDR_CORE_CONNECTOR_MAX_DEADLINE_MS = 10 * 60_000

export type HerdrCoreConnectorResources = Readonly<{
  kind: 'provider'
  providers: readonly Readonly<{ binding: ProviderBinding; target: V2Target }>[]
  session(connection: Connection): ConnectorWireSession
  release(): Promise<void>
  release_timeout_ms: number
}>

/** 只生成共享 canonical provider 配置；不注册、启用或修改任何 Store 中的 binding。 */
function provider(config: HerdrCoreProviderRefConfig): Readonly<{
  machine_id: string
  provider_id: string
  kind: 'herdr-core'
  config_ref: string
  binding_revision: number
  enabled: true
}> {
  return Object.freeze({
    machine_id: config.target.machine_id,
    provider_id: config.target.provider_id,
    kind: 'herdr-core',
    config_ref: config.config_ref,
    binding_revision: config.binding_revision,
    enabled: true
  })
}

/** 只接受已发布、摘要一致且本次实例契约匹配的 schema 字节。 */
function publishedSchema(config: HerdrCoreProviderRefConfig): void {
  readSchema(
    config.schema_ref,
    config.expected_source.schema_sha256,
    'herdr_core_schema_unreviewed',
    'herdr_core_provider_file_invalid'
  )
}

/** 由唯一 loader 在认证与设备凭据前置校验后调用；本模块不创建身份或凭据。 */
export async function createHerdrCoreConnectorResources(
  input: Readonly<{
    config: unknown
    now(): number
    /** 本机直接终端输入开关；省略即关闭。控制档在目录、Gateway 登记与最终写入三处受它约束。 */
    allow_terminal_execution?: boolean
    open?(config: HerdrCoreProviderRefConfig): Promise<HerdrCoreAttachment>
  }>
): Promise<HerdrCoreConnectorResources> {
  const config = parseHerdrCoreProviderRefConfig(input.config)
  const connector = config.connector
  if (!connector) {
    fail('herdr_core_connector_owner_required')
  }
  if (typeof input.now !== 'function') {
    fail('herdr_core_connector_owner_required')
  }
  assertHerdrCoreSessionFits(connector.session, connector.endpoint)
  publishedSchema(config)
  const installation =
    input.open !== undefined
      ? await input.open(config)
      : await HerdrCoreInstallation.open({
          config: connector,
          expected: config.expected_source,
          now: input.now
        })
  const reference = contractRef(config.expected_source)
  if (contractRef(installation.record().wire.source) !== reference) {
    installation.close()
    fail('herdr_core_installation_changed')
  }
  const binding = provider(config)
  // 只接受显式布尔值；省略保持关闭，字符串、数字和对象均不能隐式开启。
  const terminalExecution = pinTerminalExecution(input.allow_terminal_execution)
  const terminalExecutionState = /** 目录与 Gateway 读同一个本机观察值。 */ () => terminalExecution
  const book = new ConnectorAttemptBook({ maximum_deadline_ms: HERDR_CORE_CONNECTOR_MAX_DEADLINE_MS, now: input.now })
  let claims: DispatchClaims | undefined
  const sessions = new Set<ConnectorWireSession>()
  let closed = false
  let releasing: Promise<void> | undefined
  const releaseTimeout = 5000

  /** 先同步停止全部 epoch，再释放本机 writer；失败仍逐项清理且只执行一次。 */
  function release(): Promise<void> {
    if (!releasing) {
      closed = true
      releasing = Promise.resolve().then(
        /** 释放顺序固定：会话、共享墓碑、外部 core 连接。 */ () => {
          let failed = false
          for (const action of [
            ...[...sessions].map(/** 不等待单个 epoch，先同步阻止所有新执行。 */ (session) => () => session.close()),
            /** 保留原发送墓碑，只关闭 writer。 */ () => claims?.close(),
            /** 安装关闭只断开本机连接，不停止外部 core。 */ () => installation.close()
          ]) {
            try {
              action()
            } catch {
              failed = true
            }
          }
          sessions.clear()
          if (failed) {
            throw new GatewayError('herdr_core_connector_release_failed')
          }
        }
      )
      void releasing.catch(/** 原角色会观察释放结果，内部也消费无人 await 的晚到拒绝。 */ () => {})
    }
    return releasing
  }
  try {
    claims = new DispatchClaims({ ...connector.claims, now: input.now })
    const sendClaims = claims
    return Object.freeze({
      kind: 'provider',
      release,
      release_timeout_ms: releaseTimeout,
      providers: Object.freeze([Object.freeze({ binding, target: config.target })]),
      /** 每个实际认证 epoch 独立准入正文，长期 book/claim 仍由同一资源所有者持有。 */
      session(connection) {
        if (closed) {
          fail('herdr_core_provider_closed')
        }
        installation.assert()
        let runtime: ReturnType<typeof createHerdrCoreConnectorRuntime> | undefined
        let session: ConnectorWireSession | undefined
        try {
          runtime = createHerdrCoreConnectorRuntime(
            {
              installation,
              connection,
              target: config.target,
              principal_id: connector.principal_id,
              binding,
              now: input.now,
              terminalExecution: terminalExecutionState
            },
            sendClaims,
            book
          )
          const current = runtime
          session = {
            ...current.session,
            adapter: connectorAdmissionAdapter(current.admission, current.session.adapter),
            close: /** 先停原 Wire 与执行等待，再销毁本 epoch 的准入锚点。 */ () => {
              try {
                current.session.close()
              } finally {
                if (session) {
                  sessions.delete(session)
                }
              }
            }
          }
          if (closed) {
            fail('herdr_core_provider_closed')
          }
          sessions.add(session)
          return session
        } catch (error) {
          runtime?.session.close()
          throw error
        }
      }
    })
  } catch (error) {
    try {
      await release()
    } catch {
      /* 保留原启动错误；释放失败已由 release 自己的结果观察。 */
    }
    throw error
  }
}
