// 在唯一产品Gateway双库上接入本机终端配对与实测来源批准；首次完成时在已核验终端创建并只显示一次管理页管理员口令，不修改原认证门禁。
import { createHash, randomBytes } from 'node:crypto'
import type { openGatewayState } from '../runtime/state.js'
import type { RuntimeCliGateway } from './runtime.js'
import { boundedJson, fields, object } from '../wire/index.js'
import { managementSourceExists, writeAdminFiles } from './admin-command.js'
import { CliError, type GatewayConfig } from './config.js'
import { cliMessages, formatMessage } from './messages.js'
import { isAdminPlaceholder } from './admin-registry.js'
import type { CallerRegistry } from './token-registry.js'
import { SetupApproval } from './setup-approval.js'
import { GatewayPairingHttp, type SetupNativeRequest } from './pairing-http.js'
import { SetupTerminal } from './setup-terminal.js'
import { publishSetupSchemas, reviewSetupManifest } from './setup-manifest.js'
import { readSetupJson, setupFileStamp, writeSetupFile, writeSetupJson } from './setup-files.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { readRuntimeConfig } from './runtime-config.js'
import { REGISTRY_MAX_BYTES, parseRegistry } from './token-registry.js'
import type { ProviderGrant, ProviderPolicy } from '../wire/types.js'
import { canonicalLoopbackHost } from '../mcp/listen.js'

type State = ReturnType<typeof openGatewayState>

// 相同计划的重入只接纳完全相同的程序数据；未知条目、部分内容或外部改动不被覆盖。
export function publish(path: string, value: unknown, maximum = 16_384): void {
  const current = readSetupJson(path, maximum)
  if (current === undefined) {
    writeSetupJson(path, value, false, maximum)
  } else if (boundedJson(current, maximum) !== boundedJson(value, maximum)) {
    throw new CliError('configuration_required')
  }
}

// 把新设备的授权并入已有策略：同一目标已有授权时必须完全相同（重入），不同则拒绝，绝不静默改写已批准的权限。
export function unionGrants(existing: readonly ProviderGrant[], added: readonly ProviderGrant[]): ProviderGrant[] {
  const merged = [...existing]
  for (const grant of added) {
    const found = merged.find(/* 同一精确目标。 */ (entry) => boundedJson(entry.target) === boundedJson(grant.target))
    if (!found) {
      merged.push(grant)
    } else if (boundedJson(found) !== boundedJson(grant)) {
      throw new CliError('configuration_required')
    }
  }
  return merged
}

export type SetupCallerEntry = {
  principal: { id: string; policy: ProviderPolicy }
  token_sha256: string
  issued_at: number
  expires_at: number
}

// 首台设备的调用方发布：注册表缺失时全新发布；已有注册表时只保留管理员占位主体（首次配对前
// rovloom admin create 建立）或与本次完全相同的原条目（中断后的重入），本机策略整体替换，
// 绝不覆盖或扩大任何真实 MCP 主体。
export function publishFirstCallers(
  path: string,
  resource: string,
  authorization: { principal_id: string; policies: { caller: ProviderPolicy; local: ProviderPolicy } },
  caller: SetupCallerEntry
): void {
  const previous = readSetupJson(path, REGISTRY_MAX_BYTES)
  const created: CallerRegistry = {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource,
    local_policy: authorization.policies.local,
    callers: [caller]
  }
  if (previous === undefined) {
    parseRegistry(JSON.parse(boundedJson(created, REGISTRY_MAX_BYTES)))
    writeSetupFile(path, boundedJson(created, REGISTRY_MAX_BYTES), false)
    return
  }
  const registry = parseRegistry(previous, resource)
  const kept = registry.callers.filter(
    /* 管理员占位保留；非占位条目必须是同一请求的原样重入，其余状态一律拒绝。 */ (entry) =>
      isAdminPlaceholder(entry) ||
      entry.scope === 'gateway' ||
      boundedJson(entry, REGISTRY_MAX_BYTES) === boundedJson(caller, REGISTRY_MAX_BYTES)
  )
  if (kept.length !== registry.callers.length) {
    throw new CliError('configuration_required')
  }
  // 原样重入的条目已存在时不重复追加；管理员占位保留在设备主体之前。
  const callers = [...kept]
  if (!callers.some((entry) => boundedJson(entry, REGISTRY_MAX_BYTES) === boundedJson(caller, REGISTRY_MAX_BYTES))) {
    callers.push(caller)
  }
  const merged: CallerRegistry = { ...created, callers }
  parseRegistry(JSON.parse(boundedJson(merged, REGISTRY_MAX_BYTES)), resource)
  const stamp = setupFileStamp(path)
  writeSetupFile(path, boundedJson(merged, REGISTRY_MAX_BYTES), true, stamp)
}

export class GatewaySetup {
  readonly approval: SetupApproval
  #begun = false
  #active: GatewayPairingHttp | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #reload: (() => void) | undefined
  reconfigure: Promise<void> = new Promise(/* 未提交配置时不唤醒角色重开。 */ () => {})

  // 只有正式prepare取得的真实本地终端可以构造；网络请求不能选择批准来源。
  constructor(
    readonly config: GatewayConfig,
    readonly terminal: SetupTerminal,
    // repair：重新配对引导式配对过的设备（只换设备凭据），而不是首次配对。
    private readonly options: { repair?: boolean; addDevice?: boolean } = {}
  ) {
    this.approval = new SetupApproval(terminal, config.state_dir)
  }

  // 绑定已取得唯一writer的实际state；每次重开先撤下旧handler，避免跨库/epoch复用。
  attach(state: State): GatewayPairingHttp {
    this.approval.attach(state)
    this.reconfigure = new Promise(
      /* 只由同一实例完整提交native配置后唤醒。 */ (resolve) => {
        this.#reload = resolve
      }
    )
    const http = new GatewayPairingHttp(
      state,
      this.approval,
      /* 原生来源仍由配对设备证明和独立本机确认共同约束。 */ (request) => this.native(state, request),
      /* 重新配对交付确认后重开 Gateway，由新一轮 listening 观察设备用新凭据真实连上。 */ () =>
        setImmediate(() => this.#reload?.())
    )
    this.#active = http
    return http
  }

  // 设备listener和MCP真实启动后再显示一次性码；只写已核验TTY，不写普通stdout或诊断日志。
  async listening(gateway: RuntimeCliGateway, mcpUrl: string): Promise<void> {
    if (this.options.repair && !this.#begun) {
      this.#begun = true
      const active = this.approval.active()
      if (active?.repair && active.phase === 'configured') {
        this.terminal.show(cliMessages(this.terminal.io.language)['setup.gateway.resumeRePairing'])
      } else {
        const issued = await this.approval.issueRepair()
        this.terminal.show(
          formatMessage(cliMessages(this.terminal.io.language)['setup.gateway.repairCodeBlock'], {
            mcpUrl,
            endpoint: gateway.transport.url.replace(/\/connector$/, ''),
            code: issued.code
          })
        )
      }
    }
    const current = this.approval.active()
    // --add-device：引导已完成（ready）后再配对一台 Connector；未完成的引导仍按原流程继续。
    if (
      !this.#begun &&
      (current?.phase === 'ready' ? this.options.addDevice === true : current?.phase !== 'configured')
    ) {
      this.#begun = true
      this.terminal.show(
        formatMessage(cliMessages(this.terminal.io.language)['setup.gateway.endpoints'], {
          mcpUrl,
          endpoint: gateway.transport.url.replace(/\/connector$/, '')
        })
      )
      const issued = await this.approval.issue()
      if (issued.declined) {
        // 拒绝终端配对不退出：Gateway 保持运行，首台 Connector 改在管理页完成在线配对。
        const page = this.config.management_enabled ? 'http://127.0.0.1:' + this.config.management_port + '/' : ''
        this.terminal.show(
          cliMessages(this.terminal.io.language)['setup.gateway.unpairedRunning'] +
            (page
              ? formatMessage(cliMessages(this.terminal.io.language)['setup.gateway.managementFirstPairing'], { page })
              : cliMessages(this.terminal.io.language)['setup.gateway.managementDisabled'])
        )
        this.terminal.finishQuestions()
        return
      }
      if (issued.code) {
        this.terminal.show(
          formatMessage(cliMessages(this.terminal.io.language)['setup.gateway.pairingCodeBlock'], { code: issued.code })
        )
      } else {
        this.terminal.show(cliMessages(this.terminal.io.language)['setup.gateway.resumingExisting'])
      }
    }
    const plan = this.approval.active()
    if (plan?.phase === 'ready') {
      this.terminal.finishQuestions()
      return
    }
    if (plan?.phase === 'configured') {
      this.terminal.finishQuestions()
      let previous = ''
      this.#timer = setInterval(
        /* 只读正式transport观察；HTTP响应或静态配置不能自报ready。 */ () => {
          try {
            const device = gateway.transport
              .status()
              .devices.find(/* 精确原machine才可完成此计划。 */ (entry) => entry.machine_id === plan.machine_id)
            const current = device?.authenticated
              ? 'connector_authenticated native_pending'
              : 'gateway_waiting_for_connector'
            if (current !== previous) {
              previous = current
              this.terminal.show(current + '\n')
            }
            if (
              device?.authenticated &&
              device.ready &&
              (plan.providers ?? ['luvus']).every(
                /* 所选来源必须分别实际ready；单一健康来源不能代替混合配置全部就绪。 */ (kind) =>
                  device.providers.some(
                    /* 只核对原machine上的精确provider。 */ (entry) => entry.provider_id === kind && entry.ready
                  )
              )
            ) {
              this.approval.finishReady(plan.attempt_id)
              this.terminal.show(cliMessages(this.terminal.io.language)['setup.gateway.connectorReady'])
              clearInterval(this.#timer)
              this.#timer = undefined
            }
          } catch {
            this.terminal.io.stderr.write('setup_observation_unavailable\n')
            clearInterval(this.#timer)
            this.#timer = undefined
          }
        },
        250
      )
    }
  }

  // 配对设备交付原schema字节和测量身份，Gateway自己编译核验；仅本机明确批准后创建同一完整路由权限。
  private async native(state: State, request: SetupNativeRequest): Promise<unknown> {
    const { reviewed, kinds, authorization, fingerprint } = await reviewSetupManifest(
      request.input,
      request.plan,
      request.credential.machine_id,
      this.config.state_dir,
      request.signal
    )
    if (request.plan.phase === 'configured') {
      if (request.plan.native_fingerprint !== fingerprint) {
        throw new CliError('configuration_required')
      }
      return { state: 'configured', fingerprint }
    }
    if (request.signal.aborted) {
      throw new CliError('configuration_required')
    }
    // 已有不同registry或caller不能被首次引导扩大权限或覆盖；每个来源都必须属于同一批准清单。
    const providers = readRuntimeConfig(this.config).providers
    const additional = request.plan.lineage !== undefined
    if (
      providers.some(
        /* 恢复时只允许原attempt完全相同的条目；加入新设备时其它设备的条目不属于本次，但同引用必须一致。 */ (entry) => {
          const expected = reviewed.find(/* 同一原条目。 */ (value) => value.reference === entry.reference)
          return expected ? boundedJson(entry.value, 1_048_576) !== boundedJson(expected.value, 1_048_576) : !additional
        }
      )
    ) {
      throw new CliError('configuration_required')
    }
    await this.approval.approveNative(
      request.plan.attempt_id,
      kinds,
      fingerprint,
      formatMessage(cliMessages(this.terminal.io.language)['setup.prompt.gatewayNativeInstallations'], {
        entries: reviewed
          .map(
            /* 显示实际来源、完整Target及安装摘要，所有者能核对每份独立权限范围。 */ (entry) =>
              entry.kind +
              ' ' +
              entry.label +
              ', Target ' +
              boundedJson(entry.target) +
              ', binary SHA-256 ' +
              entry.binary_sha256
          )
          .join('; ')
      }),
      request.signal
    )
    this.terminal.assertOwner()
    if (request.signal.aborted) {
      throw new CliError('configuration_required')
    }
    await publishSetupSchemas(reviewed, request.signal)
    // 本机客户端凭据记录的资源地址用规范回环地址，不写通配绑定地址。
    const hostname = canonicalLoopbackHost(this.config.mcp_hostname)
    const resource = new URL('http://' + hostname + ':' + this.config.mcp_port + '/mcp').href
    const clientPath = runtimeReference(this.config.state_dir, 'mcp-client')
    const original = readSetupJson(clientPath)
    if (additional && original === undefined) {
      // 第 2 台及以后设备复用首台设备建立的 MCP 凭据；没有它说明引导状态不完整。
      throw new CliError('configuration_required')
    }
    const client =
      original === undefined
        ? {
            schema_version: 1,
            kind: 'mcp-client-credential',
            attempt_id: request.plan.attempt_id,
            resource,
            principal_id: authorization.principal_id,
            token: randomBytes(32).toString('base64url'),
            issued_at: Date.now(),
            expires_at: Date.now() + 30 * 86400_000
          }
        : object(original)
    fields(client, [
      'schema_version',
      'kind',
      'attempt_id',
      'resource',
      'principal_id',
      'token',
      'issued_at',
      'expires_at'
    ])
    if (
      client.schema_version !== 1 ||
      client.kind !== 'mcp-client-credential' ||
      client.attempt_id !== (request.plan.lineage ?? request.plan.attempt_id) ||
      client.resource !== resource ||
      client.principal_id !== authorization.principal_id ||
      typeof client.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(client.token) ||
      !Number.isSafeInteger(client.issued_at) ||
      !Number.isSafeInteger(client.expires_at) ||
      Number(client.expires_at) <= Date.now()
    ) {
      throw new CliError('configuration_required')
    }
    publish(clientPath, client)
    const callersPath = runtimeReference(this.config.state_dir, 'mcp-callers')
    const providersPath = runtimeReference(this.config.state_dir, 'providers')
    const reviewedEntries = reviewed.map(
      /* 只保存已核验清单的程序配置；Gateway文件路径始终由本机程序选择。 */ (entry) => ({
        reference: entry.reference,
        value: entry.value
      })
    )
    if (!additional) {
      publishFirstCallers(callersPath, resource, authorization, {
        principal: { id: authorization.principal_id, policy: authorization.policies.caller },
        token_sha256: createHash('sha256')
          .update(client.token as string)
          .digest('hex'),
        issued_at: client.issued_at as number,
        expires_at: client.expires_at as number
      })
      publish(providersPath, { schema_version: 1, role: 'gateway', providers: reviewedEntries }, 1_048_576)
    } else {
      mergeSetupCallers(callersPath, resource, authorization)
      mergeSetupProviders(providersPath, reviewedEntries)
    }
    for (const entry of reviewed) {
      const binding = state.store.provider(entry.target.machine_id, entry.target.provider_id)
      if (!binding) {
        state.store.defineProvider(entry.binding)
      } else if (boundedJson(binding) !== boundedJson(entry.binding)) {
        throw new CliError('configuration_required')
      }
    }
    this.approval.finishNative(request.plan.attempt_id, fingerprint)
    // 同时为管理页创建管理员：口令只在这个已核验的本地终端显示一次；失败不影响配对，可稍后手动 rovloom admin create。
    let adminNote = ''
    if (this.config.management_enabled && !managementSourceExists(this.config)) {
      const page = 'http://127.0.0.1:' + this.config.management_port + '/'
      try {
        const admin = writeAdminFiles(this.config, 'admin', Date.now())
        adminNote = formatMessage(cliMessages(this.terminal.io.language)['setup.gateway.adminBlock'], {
          page,
          secret: admin.secret
        })
      } catch {
        adminNote = cliMessages(this.terminal.io.language)['setup.gateway.adminNotCreated']
      }
    }
    this.terminal.show(
      formatMessage(cliMessages(this.terminal.io.language)['setup.gateway.nativeSaved'], {
        clientPath,
        url: this.config.mcp_public_url ?? resource,
        targets: boundedJson(
          reviewed.map(/* 显示每个完整目标，不能合并成provider或session通配符。 */ (entry) => entry.target)
        )
      }) +
        (additional
          ? cliMessages(this.terminal.io.language)['setup.gateway.bearerAdditional']
          : formatMessage(cliMessages(this.terminal.io.language)['setup.gateway.bearerSecret'], {
              token: client.token
            })) +
        adminNote +
        '\n'
    )
    // 不将响应写出当作业务确认；若本响应因重开丢失，客户端只查询原attempt，不重复签发或初始化。
    setImmediate(/* 下一事件轮才关闭旧listener，先让原认证/响应调用完成其finally。 */ () => this.#reload?.())
    return { state: 'configured', fingerprint }
  }

  // 关闭原HTTP交付并等待其不确定凭据拒绝完成，然后撤下唯一state引用。
  async detach(state: State): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    const http = this.#active
    this.#active = undefined
    await http?.close()
    this.approval.detach(state)
  }
}

// 加入新设备：本机策略与安装时建立的 MCP 主体策略并入新设备的授权；修订标签沿用首台设备，已批准的授权不改写。
// 之后用 rovloom token create --like 克隆出的其它主体是创建时的快照，需要重新克隆才包含新设备。
// 本机 setup 仪式与在线激活共用此实现，避免两条路径的并入口径漂移。
export function mergeSetupCallers(
  path: string,
  resource: string,
  authorization: { principal_id: string; policies: { caller: ProviderPolicy; local: ProviderPolicy } }
): void {
  const stamp = setupFileStamp(path)
  // parseRegistry 返回冻结对象；在深拷贝上并入授权。
  const registry = structuredClone(parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES), resource)) as ReturnType<
    typeof parseRegistry
  >
  if (registry.local_policy.revision !== authorization.policies.local.revision) {
    throw new CliError('configuration_required')
  }
  registry.local_policy.grants = unionGrants(registry.local_policy.grants, authorization.policies.local.grants)
  for (const entry of registry.callers) {
    if (entry.principal.id === authorization.principal_id) {
      if (entry.principal.policy.revision !== authorization.policies.caller.revision) {
        throw new CliError('configuration_required')
      }
      entry.principal.policy.grants = unionGrants(entry.principal.policy.grants, authorization.policies.caller.grants)
    }
  }
  parseRegistry(JSON.parse(boundedJson(registry, REGISTRY_MAX_BYTES)), resource)
  writeSetupFile(path, boundedJson(registry, REGISTRY_MAX_BYTES), true, stamp)
}

// 加入新设备：已有设备的 provider 条目原样保留，只追加本次已核验的条目（同引用必须完全相同）。
export function mergeSetupProviders(path: string, entries: readonly { reference: string; value: unknown }[]): void {
  const stamp = setupFileStamp(path)
  const document = object(readRuntimeJson(path, 1_048_576))
  fields(document, ['schema_version', 'role', 'providers'])
  if (document.schema_version !== 1 || document.role !== 'gateway' || !Array.isArray(document.providers)) {
    throw new CliError('configuration_required')
  }
  const merged = [...(document.providers as { reference: string; value: unknown }[])]
  for (const entry of entries) {
    const found = merged.find(/* 同一引用。 */ (value) => value.reference === entry.reference)
    if (!found) {
      merged.push(entry)
    } else if (boundedJson(found.value, 1_048_576) !== boundedJson(entry.value, 1_048_576)) {
      throw new CliError('configuration_required')
    }
  }
  if (merged.length > 32) {
    throw new CliError('configuration_required')
  }
  writeSetupFile(path, boundedJson({ ...document, providers: merged }, 1_048_576), true, stamp)
}
