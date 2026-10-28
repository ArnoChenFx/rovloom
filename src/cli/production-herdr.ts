/** 唯一 CLI 的 Herdr 生产来源：Gateway 委托原工厂，Connector 只持有本次显式启动的真实 child。 */
import { ChildProcess } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { HerdrInstallation } from '../connector/herdr/installation.js'
import {
  HerdrLocalError,
  herdrEndpoint,
  inspectHerdrPath,
  launchHerdrProcess,
  verifyHerdrInstallation
} from '../connector/herdr/local.js'
import { createHerdrConnectorResources, parseHerdrProviderRefConfig } from '../connector/herdr/provider.js'
import type { HerdrProviderRefConfig } from '../connector/herdr/provider.js'
import { createNativeRecord, nativeRecordStamp, removeNativeRecord } from '../runtime/native-record-files.js'
import { boundedJson, fields, hash, object, parseJson } from '../wire/index.js'
import type { Connection } from '../transport/index.js'
import { CliError } from './config.js'
import type { ProductionCliSources, ProductionProviderReference } from './production.js'
import { startAttachedHerdr } from './herdr-attached.js'
import { createHerdrProductSources } from './herdr-sources.js'
import { HERDR_OWNER_FORMAT, currentProcessIdentity, recoverHerdrCrashResidue } from './herdr-crash-recovery.js'
import { recoverLuvusClaimsLock } from '../runtime/native-crash-recovery.js'
import { readRuntimeFile } from './runtime-files.js'
import { ProviderUnavailableError } from './provider-unavailable.js'
import { pinTerminalExecution } from '../connector/terminal-execution.js'

export type HerdrProductionOwnerConfig = Readonly<{
  kind: 'herdr'
  config: HerdrProviderRefConfig & { connector: NonNullable<HerdrProviderRefConfig['connector']> }
  native: Readonly<{ mode: 'managed' | 'attach' }>
}>

/** 只在内存复制受保护引用；JSON 只能选择明确 managed 配置，不能构造 installation 或 attach 来源。 */
function reference(input: readonly ProductionProviderReference[]): HerdrProductionOwnerConfig {
  try {
    if (input.length !== 1) {
      throw new CliError('invalid_config')
    }
    const entry = object(parseJson(boundedJson(input[0], 16_384)))
    fields(entry, ['reference', 'value'])
    const value = object(entry.value)
    fields(value, ['kind', 'config', 'native'], ['policies'])
    const native = object(value.native)
    fields(native, ['mode'])
    const config = parseHerdrProviderRefConfig(value.config)
    if (
      value.kind !== 'herdr' ||
      (native.mode !== 'managed' && native.mode !== 'attach') ||
      !config.connector ||
      // 记录里的模式与本地配置的 attach 标志必须一致，不能靠改一处切换信任模型。
      (native.mode === 'attach') !== (config.connector.local.attach === true) ||
      config.config_ref !== entry.reference
    ) {
      throw new CliError('invalid_config')
    }
    return {
      kind: 'herdr',
      config: { ...config, connector: config.connector },
      native: { mode: native.mode }
    }
  } catch {
    throw new CliError('invalid_config')
  }
}

/** 关闭接缝只消费直接 ChildProcess，不建立原生来源；真实来源仍仅由 launch/open 签发。 */
export function createHerdrChildOwner(
  child: ChildProcess,
  limits: Readonly<{ grace_ms: number; exit_ms: number }> = { grace_ms: 500, exit_ms: 2000 }
) {
  const bounds = { ...limits }
  if (
    !(child instanceof ChildProcess) ||
    !Number.isSafeInteger(child.pid) ||
    !Number.isSafeInteger(bounds.grace_ms) ||
    bounds.grace_ms < 1 ||
    bounds.grace_ms > 500 ||
    !Number.isSafeInteger(bounds.exit_ms) ||
    bounds.exit_ms < 1 ||
    bounds.exit_ms > 2000
  ) {
    throw new HerdrLocalError('herdr_production_child_invalid')
  }
  let closing: Promise<void> | undefined
  // signal 失败的 error 通知也须被消费；它不改变独立的物理退出事实。
  child.on('error', /** 后续信号与等待结果会给出稳定失败码，不泄露底层路径或系统文本。 */ () => {})
  /** exitCode/signalCode 由真实退出事件建立，killed 或 signal 成功不能替代物理退出。 */
  function hasExited(): boolean {
    return child.exitCode !== null || child.signalCode !== null
  }
  /** 仅等待自己的真实 child 退出；每次结束本地等待都移除对应监听和计时器。 */
  function wait(milliseconds: number): Promise<boolean> {
    if (hasExited()) {
      return Promise.resolve(true)
    }
    return new Promise(
      /** 超时仅表示尚未确认退出。 */ (resolve) => {
        /** 退出与定时器共用一次结算，不保留新的重试任务。 */
        const finish = () => {
          clearTimeout(timer)
          child.removeListener('exit', finish)
          resolve(hasExited())
        }
        const timer = setTimeout(finish, milliseconds)
        child.once('exit', finish)
        if (hasExited()) {
          finish()
        }
      }
    )
  }
  /** 只对原 child handle 发信号，失败只产生固定诊断，不按发现 PID 补杀或接管其它实例。 */
  function send(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
  return Object.freeze({
    hasExited,
    /** 并发、重入和迟到观察均复用同一关闭结果，超时不会被后来退出改判成功。 */
    release(): Promise<void> {
      closing ??= Promise.resolve().then(
        /** 先发布共享 Promise，再触发可能重入的 child 信号回调。 */ async () => {
          if (hasExited()) {
            return
          }
          if (send('SIGTERM') && (await wait(bounds.grace_ms))) {
            return
          }
          const sent = send('SIGKILL')
          if (!(await wait(bounds.exit_ms))) {
            throw new HerdrLocalError(
              sent ? 'herdr_production_child_exit_timeout' : 'herdr_production_child_signal_failed'
            )
          }
        }
      )
      void closing.catch(/** 角色 owner 仍会观察同一失败，不产生无人消费的关闭拒绝。 */ () => {})
      return closing
    }
  })
}

export type HerdrProductionShutdown = Readonly<{
  release(): Promise<void>
  status(): Readonly<{ launch_uncertain: boolean; exit_confirmed: boolean; owner_held: boolean }>
}>

export class HerdrProductionStartupError extends HerdrLocalError {
  /** 保留原启动和清理错误供受信 owner 观察；公开消息只有稳定码，不反射路径、配置或凭据。 */
  constructor(
    readonly startupError: unknown,
    readonly shutdown: HerdrProductionShutdown,
    readonly cleanupError: unknown
  ) {
    super('herdr_production_startup_cleanup_failed')
  }
}

/** session 端点所在的逐级目录；default 会话直接位于 herdr 目录。 */
function herdrEndpointDirectories(config: HerdrProductionOwnerConfig['config']): string[] {
  const local = config.connector.local
  const directories = [join(local.config_home, 'herdr')]
  if (local.target.session !== 'default') {
    directories.push(join(directories[0]!, 'sessions'), join(directories[0]!, 'sessions', local.target.session))
  }
  return directories
}

/** 含 herdr.sock 的目录。 */
function herdrEndpointDirectory(config: HerdrProductionOwnerConfig['config']): string {
  return herdrEndpointDirectories(config).at(-1)!
}

/** 已存在的端点明确拒绝；现有目录仍逐级验证，不能把链接或另一个 session 当作可认领实例。 */
export function assertHerdrProductionEndpointAbsent(config: HerdrProductionOwnerConfig['config']): void {
  const directories = herdrEndpointDirectories(config)
  for (const directory of directories) {
    try {
      lstatSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw new HerdrLocalError('herdr_production_endpoint_unavailable')
    }
    inspectHerdrPath(directory, 'directory')
  }
  try {
    lstatSync(join(directories.at(-1)!, 'herdr.sock'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw new HerdrLocalError('herdr_production_endpoint_unavailable')
  }
  // 未取得 child/owner/writer，不能删除或接管既有端点；只声明此原配置不可用。
  throw new ProviderUnavailableError({
    target: config.target,
    binding: {
      machine_id: config.target.machine_id,
      provider_id: config.target.provider_id,
      kind: 'herdr',
      config_ref: config.config_ref,
      binding_revision: config.binding_revision,
      enabled: true
    }
  })
}

/** 仅等待当前受监管 child 的 endpoint；来源、schema 与实际 socket peer 继续由原 installation 核验。 */
async function endpointReady(config: HerdrProductionOwnerConfig['config'], child: ChildProcess): Promise<void> {
  const deadline = performance.now() + 10_000
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new HerdrLocalError('herdr_production_child_exited')
    }
    try {
      herdrEndpoint(config.connector.local)
      return
    } catch (error) {
      if (performance.now() >= deadline) {
        throw error
      }
    }
    await pause(25)
  }
}

/** 由唯一 loader 在 CA/既有设备凭据前置校验后调用；本模块不创建或读取身份凭据。 */
export function createHerdrProductionSources(): ProductionCliSources {
  return Object.freeze({
    ...createHerdrProductSources(),
    /** 单个 Connector 只交付一个真实 provider，会话、receipt、claims 与原始预算完全复用现有工厂。 */
    async connector(roleConfig, input) {
      const terminalExecution =
        roleConfig.allow_terminal_execution === undefined
          ? undefined
          : /** 每次写入仍从单文件角色配置读取显式开关，不改变原生安装记录。 */ () =>
              pinTerminalExecution(roleConfig.allow_terminal_execution)
      terminalExecution?.()
      const selected = reference(input)
      const config = selected.config
      const local = config.connector.local
      // 坏 schema/binary 在任何启动和 owner 记录创建前拒绝；原工厂仍会在最终边界重新核对。
      const bytes = readRuntimeFile(config.schema_path, 16_777_216)
      try {
        if (hash(bytes) !== config.expected_source.schema_sha256) {
          throw new HerdrLocalError('herdr_schema_unreviewed')
        }
      } finally {
        bytes.fill(0)
      }
      verifyHerdrInstallation(local, config.expected_source.binary_sha256)
      if (selected.native.mode === 'attach') {
        // 附着模式：用户自己的会话，不创建 owner 记录、不拥有进程，也不做 managed 的端点清理；
        // 但 claim 账本锁是 Connector 自己的，持有者已死才接管（账本墓碑原样保留）。
        if (recoverLuvusClaimsLock(config.connector.claims.path + '.lock')) {
          process.stderr.write('claims_lock_recovered\n')
        }
        return startAttachedHerdr(selected, terminalExecution ? { terminalExecution } : {})
      }
      const ownerPath = join(local.config_home, `.rovloom-herdr-${local.target.session}.owner.json`)
      // 上一个 Connector 若崩溃，只有证明其已死且端点无人监听才清理；否则下面仍按原样拒绝。
      if (
        await recoverHerdrCrashResidue({
          ownerPath,
          endpointDirectory: herdrEndpointDirectory(config),
          claimsLockPath: config.connector.claims.path + '.lock'
        })
      ) {
        process.stderr.write('herdr_crash_residue_cleared\n')
      }
      assertHerdrProductionEndpointAbsent(config)
      const processIdentity = currentProcessIdentity()
      let stamp: string | undefined = createNativeRecord(ownerPath, {
        format: HERDR_OWNER_FORMAT,
        ...(processIdentity ? { process: processIdentity } : {}),
        target: config.target,
        config_ref: config.config_ref,
        binding_revision: config.binding_revision
      })
      let childOwner: ReturnType<typeof createHerdrChildOwner> | undefined
      let installation: HerdrInstallation | undefined
      let resources: Awaited<ReturnType<typeof createHerdrConnectorResources>> | undefined
      let launchUncertain = false
      let stopping = false
      let closing: Promise<void> | undefined
      /** 未确认退出或 launch 原 API 未交回 child 时保留排他记录，不从 PID/JSON 伪造回收成功。 */
      function status() {
        return {
          launch_uncertain: launchUncertain,
          exit_confirmed: childOwner?.hasExited() ?? !launchUncertain,
          owner_held: stamp !== undefined
        }
      }
      /** 所有 epoch、持久 writer 和安装先关闭；真实 child 退出确认后才移除本轮同 inode 的 owner 记录。 */
      function release(): Promise<void> {
        stopping = true
        closing ??= Promise.resolve().then(
          /** 所有步骤独立尝试，某一失败不会跳过 child 清理。 */ async () => {
            const errors: unknown[] = []
            for (const close of [
              /** 原工厂负责全部 epoch 和独立账本的关闭。 */ () => resources?.release(),
              /** 安装尚未交给工厂时也撤去实际来源。 */ () => installation?.close(),
              /** 即使原资源清理失败，仍等待同一个直接 child 的退出。 */ () => childOwner?.release()
            ]) {
              try {
                await close()
              } catch (error) {
                errors.push(error)
              }
            }
            if (launchUncertain) {
              errors.push(new HerdrLocalError('herdr_production_launch_unconfirmed'))
            } else if (stamp !== undefined && (!childOwner || childOwner.hasExited())) {
              try {
                removeNativeRecord(ownerPath, stamp)
                stamp = undefined
              } catch (error) {
                errors.push(error)
              }
            }
            if (errors.length) {
              throw new AggregateError(errors, 'herdr_production_release_failed')
            }
          }
        )
        void closing.catch(/** 同一拒绝同时交由角色或 startup shutdown 持有。 */ () => {})
        return closing
      }
      try {
        launchUncertain = true
        const launched = await launchHerdrProcess(local)
        childOwner = createHerdrChildOwner(launched.child)
        launchUncertain = false
        await endpointReady(config, launched.child)
        installation = await HerdrInstallation.open(local, launched.binding)
        resources = await createHerdrConnectorResources({
          config,
          installation,
          now: Date.now,
          ...(terminalExecution ? { terminalExecution } : {}),
          /** installation 关闭不等于进程退出，原 child 始终由本 owner 有界停止。 */
          releaseOwner: childOwner.release
        })
        const active = resources
        return Object.freeze({
          ...active,
          /** 关闭 fence 同步生效；原 session 仍负责完整来源、schema、claims 和 peer。 */
          session(connection: Connection) {
            if (stopping || stamp === undefined || nativeRecordStamp(ownerPath) !== stamp) {
              throw new HerdrLocalError('herdr_production_source_closed')
            }
            return active.session(connection)
          },
          release
        })
      } catch (startupError) {
        try {
          await release()
        } catch (cleanupError) {
          throw new HerdrProductionStartupError(startupError, Object.freeze({ release, status }), cleanupError)
        }
        throw startupError
      }
    }
  })
}
