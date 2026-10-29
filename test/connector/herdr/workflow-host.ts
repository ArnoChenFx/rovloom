/** 真实 Herdr 工作流的隔离宿主：合成身份只用于本次自有资源，角色、准入和结果均复用生产工厂。 */
import { createHash } from 'node:crypto'
import { chmodSync, constants, copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openGatewayState } from '../../../src/runtime/state.js'
import { createProviderGatewayRuntime } from '../../../src/runtime/gateway.js'
import { createProviderConnectorRuntime } from '../../../src/runtime/connector-host.js'
import type { Connection } from '../../../src/transport/index.js'
import { HerdrInstallation } from '../../../src/connector/herdr/installation.js'
import { launchHerdrProcess, herdrEndpoint, inspectHerdrPath } from '../../../src/connector/herdr/local.js'
import type { HerdrLocalConfig } from '../../../src/connector/herdr/local.js'
import { herdrDeadline, runHerdrCommand } from '../../../src/connector/herdr/io.js'
import { createHerdrGatewayResources, createHerdrConnectorResources } from '../../../src/connector/herdr/provider.js'
import { contractRef, object } from '../../../src/wire/index.js'
import type { JsonObject } from '../../../src/wire/types.js'
import type { GatewayIdentitySource } from '../../../src/mcp/management.js'
import { management } from '../../storage/helpers.js'
import { until } from '../../transport/helpers.js'
import { createOwnedHerdrProcesses } from './owned-processes.js'

export type HerdrWorkflowHostOptions = {
  root: string
  binary: string
  opencode?: string
  synthetic_terminal?: boolean
}
type Gateway = Awaited<ReturnType<typeof createProviderGatewayRuntime>>
type Connector = Awaited<ReturnType<typeof createProviderConnectorRuntime>>
type GatewayResources = Awaited<ReturnType<typeof createHerdrGatewayResources>>
type ConnectorResources = Awaited<ReturnType<typeof createHerdrConnectorResources>>

/** 只在调用者预建的私有根准备空白实例；不会接管其它 session 或从用户目录导入凭据。 */
export async function createHerdrWorkflowHost(options: HerdrWorkflowHostOptions) {
  const { root } = options
  inspectHerdrPath(root, 'directory')
  if (!root.startsWith('/workspace/')) {
    throw new Error('owned_workspace_root_required')
  }
  if (readdirSync(root).length) {
    throw new Error('owned_empty_root_required')
  }
  const processes = createOwnedHerdrProcesses()
  let child: ChildProcess | undefined
  let installation: HerdrInstallation | undefined
  let runtime: Gateway | undefined
  let connector: Connector | undefined
  let state: ReturnType<typeof openGatewayState> | undefined
  let gatewayResources: GatewayResources | undefined
  let connectorResources: ConnectorResources | undefined
  let ownerReleaseCalls = 0
  let reenteredRelease: Promise<void> | undefined
  let closePromise:
    | Promise<{
        owned_child_exited: boolean
        owned_terminals_reaped: boolean
        known_terminal_pids: number
        resources_closed: boolean
        process_inventory_complete: boolean
        release_owner_once: boolean
        release_promise_shared: boolean
      }>
    | undefined
  const callerId = 'owned_workflow_caller'
  const callerIdentity = Object.freeze({ principal_id: callerId })
  const binding_revision = 1
  const config_ref = 'owned-herdr-workflow'
  const claimsPath = join(root, 'connector', 'claims.sqlite')

  /** 所有本机期限使用同一墙钟基准，底层 Store、receipt、book 和 claims 各自拒绝回拨。 */
  function now(): number {
    return Date.now()
  }

  /** 清理的管理读取仍经原认证作用域、生产派发、真实原生响应和公共结果读取门禁。 */
  async function native(method: string, params: JsonObject): Promise<JsonObject> {
    const active = runtime
    const installed = installation
    if (!active || !installed) {
      throw new Error('workflow_host_not_ready')
    }
    return active.runAuthenticated(
      callerIdentity,
      /** 本次清理操作始终持有原 caller 作用域。 */ async () => {
        const admitted = active.admit({
          target: installed.config.target,
          native_request: { method, params },
          options: {
            binding_revision,
            contract_ref: contractRef(installed.record().wire.source),
            validation: 'strict',
            deadline: now() + 30_000
          }
        })
        await until(
          /** 只认唯一 Store 已提交回应，不把 socket 写入当作结果。 */ () => {
            const call = active.get(admitted.call.call_id)
            if (call.state === 'outcome_unknown' || call.state === 'not_dispatched') {
              throw new Error('workflow_cleanup_call_' + call.state)
            }
            return call.state === 'responded'
          },
          30_000
        )
        const saved = active.results.open(admitted.call.call_id)
        const page = active.results.read(saved.result_id, 0, 65_536)
        if (!page.eof) {
          throw new Error('workflow_cleanup_result_too_large')
        }
        return object(JSON.parse(Buffer.from(page.data, 'base64').toString('utf8')))
      }
    )
  }

  /** 宿主显式结束后才停止角色与真实进程；保留目录给调用者写诊断和最终删除。 */
  function close() {
    closePromise ??= /** 共享同一有界清理，不由客户端断开暗中触发。 */ (async () => {
      let resourcesClosed = true
      let inventoryComplete = !child
      try {
        if (runtime && connector?.transport.status().phase === 'ready') {
          const listed = await native('workspace.list', {})
          if (listed.error || !Array.isArray(object(listed.result).workspaces)) {
            throw new Error('workflow_process_inventory_failed')
          }
          for (const workspace of object(listed.result).workspaces as unknown[]) {
            const panes = await native('pane.list', { workspace_id: object(workspace).workspace_id! })
            if (panes.error || !Array.isArray(object(panes.result).panes)) {
              throw new Error('workflow_process_inventory_failed')
            }
            for (const pane of object(panes.result).panes as unknown[]) {
              const response = await native('pane.process_info', { pane_id: object(pane).pane_id! })
              if (response.error) {
                throw new Error('workflow_process_inventory_failed')
              }
              processes.observe(response)
            }
          }
          inventoryComplete = true
        }
      } catch {
        // readiness 和原生盘点均可能因安装失效失败；仍须释放全部已知自有资源。
        inventoryComplete = false
      }
      for (const release of [
        /** 先关闭 Connector 的真实通道、全部 epoch 与持久 writer。 */ () => connector?.close(),
        /** Gateway 再释放唯一 Store、结果与身份宿主。 */ () => runtime?.close(),
        /** 角色构造尚未完成时资源仍由 fixture 负责回滚；原工厂幂等关闭。 */ () => connectorResources?.release(),
        /** Gateway 工厂不拥有外部 Store；其来源和 Worker 资源单独回收。 */ () => gatewayResources?.release(),
        /** 唯一双库不能因为其它资源失败而跳过。 */ () => state?.close(),
        /** 安装只撤销本机来源，不停止进程；停止由下一个 owner 完成。 */ () => installation?.close()
      ]) {
        try {
          await release()
        } catch {
          resourcesClosed = false
        }
      }
      const stopped = await processes.close(child)
      return {
        ...stopped,
        resources_closed: resourcesClosed,
        process_inventory_complete: inventoryComplete,
        release_owner_once: connectorResources ? ownerReleaseCalls === 1 : ownerReleaseCalls <= 1,
        release_promise_shared: connectorResources ? reenteredRelease === connectorResources.release() : true
      }
    })()
    return closePromise
  }

  try {
    for (const name of ['gateway', 'connector', 'h', 'c', 's', 'a', 't', 'w']) {
      mkdirSync(join(root, name), { mode: 0o700 })
    }
    state = openGatewayState({
      state_directory: join(root, 'gateway'),
      now,
      store: { management },
      /** 身份提交后交给同一 Gateway 关闭所属连接，不直接修改业务连接状态。 */
      changed: (machine) => runtime?.transport.disconnect(machine)
    })
    const opened = state
    const machine = opened.store.register('owned-herdr-workflow')
    const redeemed = opened.store.redeem(opened.store.issueEnrollment(machine.machine_id))
    const credential = { ...redeemed, recovery_generation: opened.store.generation() }
    const target = Object.freeze({
      machine_id: machine.machine_id,
      provider_id: 'owned_herdr',
      profile: 'session' as const,
      session: 'workflow'
    })
    const binary = join(root, 'herdr')
    copyFileSync(options.binary, binary, constants.COPYFILE_EXCL)
    chmodSync(binary, 0o700)
    const config: HerdrLocalConfig = {
      target,
      config_ref,
      binding_revision,
      binary,
      home: join(root, 'h'),
      config_home: join(root, 'c'),
      state_home: join(root, 's'),
      cache_home: join(root, 'a'),
      temporary_home: join(root, 't'),
      cwd: join(root, 'w')
    }
    for (const directory of [
      join(config.config_home, 'herdr'),
      join(config.config_home, 'herdr', 'sessions'),
      join(config.config_home, 'herdr', 'sessions', target.session)
    ]) {
      mkdirSync(directory, { mode: 0o700 })
    }
    let shell = '/bin/bash'
    if (options.synthetic_terminal) {
      // 合成终端只记录输入字节，不解释命令；仍由同一原生进程盘点与 owner 回收。
      shell = join(root, 'synthetic-terminal')
      copyFileSync(new URL('./terminal-fixture.py', import.meta.url), shell, constants.COPYFILE_EXCL)
      chmodSync(shell, 0o700)
    }
    writeFileSync(
      join(config.config_home, 'herdr', 'config.toml'),
      `onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n[terminal]\ndefault_shell = ${JSON.stringify(shell)}\nshell_mode = "non_login"\nnew_cwd = "current"\n`,
      { mode: 0o600, flag: 'wx' }
    )
    const launched = await launchHerdrProcess(config)
    child = launched.child
    await until(
      /** 只等待本次固定 endpoint，不扫描或接管已有 session。 */ () => {
        if (child!.exitCode !== null || child!.signalCode !== null) {
          throw new Error('owned_herdr_exited')
        }
        try {
          herdrEndpoint(config)
          return true
        } catch {
          return false
        }
      },
      10_000
    )
    installation = await HerdrInstallation.open(config, launched.binding)
    const installed = installation
    const scope = herdrDeadline(undefined, 10_000)
    let rawSchema: Buffer
    try {
      rawSchema = await runHerdrCommand(config, 'schema', scope.signal)
    } finally {
      scope.close()
    }
    installed.assert(undefined, true)
    const source = installed.record().wire.source
    if (createHash('sha256').update(rawSchema).digest('hex') !== source.schema_sha256) {
      throw new Error('workflow_schema_export_mismatch')
    }
    const schemaPath = join(root, 'schema.json')
    writeFileSync(schemaPath, rawSchema, { mode: 0o600, flag: 'wx' })
    const providerRef = {
      version: 1,
      target,
      binding_revision,
      config_ref,
      expected_source: source,
      schema_ref: schemaPath,
      connector: {
        local: config,
        principal_id: callerId,
        claims: {
          path: claimsPath,
          mode: 'create',
          ledger_id: 'owned_workflow_claims',
          limits: { entries: 512, bytes: 8_388_608 }
        }
      }
    }
    gatewayResources = await createHerdrGatewayResources({ config: providerRef })
    const gatewayOwned = gatewayResources
    opened.store.defineProvider(gatewayOwned.providers[0]!.binding)
    const offer = {
      major: 2,
      minor: 0,
      capabilities: ['rpc', 'late_evidence'],
      required: ['rpc']
    }
    const identities: GatewayIdentitySource = {
      /** 本自有 fixture 唯一 caller，与设备凭据走独立生产作用域。 */
      principal: (identity) => (identity.principal_id === callerId ? { id: callerId } : null),
      /** 普通 caller 不获得生产管理员或会话管理权。 */ administrator: () => null
    }
    runtime = await createProviderGatewayRuntime({
      ...gatewayOwned,
      lifecycle: opened.lifecycle,
      channels: opened.channels,
      identities,
      listener: {
        hostname: '127.0.0.1',
        port: 0,
        developmentLoopback: true,
        offer,
        limits: { heartbeat_ms: 5000, idle_ms: 30_000, handshake_ms: 5000 }
      },
      /** 全部 Gateway epoch 停止后，由原资源工厂释放契约，再关闭唯一双库。 */
      async release() {
        try {
          await gatewayOwned.release()
        } finally {
          opened.close()
        }
      }
    })
    connectorResources = await createHerdrConnectorResources({
      config: providerRef,
      installation: installed,
      now,
      /** 工厂拥有 writer 和安装关闭；直接进程仍归 fixture，在两个角色关闭后统一回收。 */
      async releaseOwner() {
        ownerReleaseCalls++
        if (connectorResources && ownerReleaseCalls === 1) {
          // 模拟宿主关闭级联同步重入；只观察原 Promise，不 await 自己形成循环等待。
          reenteredRelease = connectorResources.release()
        }
        installed.close()
      }
    })
    const connectorOwned = connectorResources
    connector = await createProviderConnectorRuntime({
      ...connectorOwned,
      transport: {
        url: runtime.transport.url,
        developmentLoopback: true,
        credential: /** 只返回本次真实一次性配对的临时凭据。 */ () => credential,
        offer,
        now,
        limits: { heartbeat_ms: 5000, idle_ms: 30_000, handshake_ms: 5000, reconnect_ms: 1000 }
      },
      /** 保持原生产 session/ledger，只观测真实原生进程信息供所属资源清理。 */
      session(connection: Connection) {
        const current = connectorOwned.session(connection)
        return {
          ...current,
          /** 原 executeWire 的校验、claims 与响应不变，PID 从真实成功响应收集。 */
          async executeWire(raw, signal) {
            const result = await current.executeWire(raw, signal)
            processes.observe(result.native_response)
            return result
          }
        }
      }
    })
    const activeConnector = connector
    const activeRuntime = runtime
    await until(
      /** 两端必须真实完成认证与 provider readiness，不以连接建立替代。 */ () =>
        activeConnector.transport.status().phase === 'ready' &&
        activeRuntime.transport
          .status()
          .devices.some(
            /** 只认本次真实配对的设备。 */ (device) => device.machine_id === target.machine_id && device.ready
          ),
      30_000
    )
    return {
      runtime: activeRuntime,
      installation: installed,
      target,
      binding_revision,
      config_ref,
      config,
      caller_identity: callerIdentity,
      provider_ref: providerRef,
      // 统一MCP服务必须复用创建runtime时同一来源及原owner目录，不从describe重建权限或schema。
      mcp: { runtime: activeRuntime, identities, catalog: gatewayOwned.catalog },
      describe: gatewayOwned.describe,
      connector: activeConnector,
      /** 仅统计 Connector 自己的真实发送墓碑，不读取 Gateway 请求或响应锚点。 */
      claimCount(): number {
        const database = new DatabaseSync(claimsPath, { readOnly: true })
        try {
          return Number(database.prepare('SELECT count(*) AS n FROM luvus_dispatch_claims').get()!.n)
        } finally {
          database.close()
        }
      },
      close
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'workflow_host_start_and_cleanup_failed')
    }
    throw error
  }
}
