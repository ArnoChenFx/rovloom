// 在线原生激活：已交付认领的设备提交实测安装清单，Gateway 按管理员创建申请时选定的 policy_ref
// 与批准认领的管理员主体完成与本机 setup 仪式相同的落盘、provider 定义与运行时重开。
// 这里没有终端可依托：批准已在管理面发生（pairings_create 选策略 + pairings_claim_approve 批准具体认领），
// 本模块只做程序核验与持久化，不接受设备自报的授权内容，所有授权由 selectedSetupPolicies 确定性推导。
import { createHash, randomBytes } from 'node:crypto'
import type { openGatewayState } from '../runtime/state.js'
import type { DeviceCredential } from '../transport/identity.js'
import type { PairingClaim } from '../storage/devices.js'
import { boundedJson, fields, object } from '../wire/index.js'
import { canonicalLoopbackHost } from '../mcp/listen.js'
import { CliError, type GatewayConfig } from './config.js'
import { publishSetupSchemas, reviewSetupManifest } from './setup-manifest.js'
import { selectedSetupPolicies, setupProviderKinds, setupSessions } from './setup-policy.js'
import { mergeSetupCallers, mergeSetupProviders, publish, publishFirstCallers } from './setup-gateway.js'
import { readSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'
import { readRuntimeConfig } from './runtime-config.js'

type State = ReturnType<typeof openGatewayState>

export type OnlineActivationHost = Readonly<{
  state: State
  config: GatewayConfig
  // 激活落盘完成后唤醒宿主重开 Gateway，使新 provider 与 caller 来源以真实工厂路径生效。
  reload: () => void
}>

type ClientRecord = Readonly<{
  attempt_id: string
  principal_id: string
  token: string
  issued_at: number
  expires_at: number
}>

// 激活的身份事实：第一台设备建立独立 MCP 客户端记录与谱系；后续设备沿用同一谱系。
// 管理批准主体独立记账；授权始终并入该记录绑定的 MCP caller，不把管理账号变成 MCP 身份。
function activationFacts(
  host: OnlineActivationHost,
  claim: PairingClaim
): { lineage?: string; additional: boolean; resource: string; principal: string; client?: ClientRecord } {
  if (!claim.approved_by) {
    throw new CliError('configuration_required')
  }
  const hostname = canonicalLoopbackHost(host.config.mcp_hostname)
  const resource = new URL('http://' + hostname + ':' + host.config.mcp_port + '/mcp').href
  const raw = readSetupJson(runtimeReference(host.config.state_dir, 'mcp-client'))
  if (raw === undefined) {
    return { additional: false, resource, principal: 'caller_' + claim.claim_id }
  }
  const client = object(raw)
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
    client.resource !== resource ||
    typeof client.attempt_id !== 'string' ||
    typeof client.principal_id !== 'string' ||
    typeof client.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(client.token) ||
    !Number.isSafeInteger(client.issued_at) ||
    !Number.isSafeInteger(client.expires_at) ||
    Number(client.expires_at) <= Number(client.issued_at)
  ) {
    throw new CliError('configuration_required')
  }
  // This record also identifies the policy lineage. Expiry or deletion of its MCP token
  // must not prevent another Connector from pairing; authentication still checks the registry.
  const additional = client.attempt_id !== claim.claim_id
  return {
    ...(additional ? { lineage: client.attempt_id as string } : {}),
    additional,
    principal: client.principal_id as string,
    resource,
    client: {
      attempt_id: client.attempt_id as string,
      principal_id: client.principal_id as string,
      token: client.token as string,
      issued_at: Number(client.issued_at),
      expires_at: Number(client.expires_at)
    }
  }
}

function planFacts(claim: PairingClaim, principal: string, lineage?: string) {
  return {
    attempt_id: claim.claim_id,
    actor: principal,
    ...(lineage ? { lineage } : {})
  }
}

// 状态查询：与本机 /pairing/status 同形，Connector 用同一交叉核对验证授权不被网关单方面放大。
export function onlineActivationStatus(
  host: OnlineActivationHost,
  claim: PairingClaim,
  providers: unknown,
  sessions: unknown
) {
  const kinds = setupProviderKinds(providers ?? ['luvus'])
  const checkedSessions = setupSessions(sessions)
  const facts = activationFacts(host, claim)
  const authorization = selectedSetupPolicies(
    planFacts(claim, facts.principal, facts.lineage),
    claim.machine_id,
    kinds,
    checkedSessions
  )
  return {
    attempt_id: claim.claim_id,
    machine_id: claim.machine_id,
    recovery_generation: host.state.store.generation(),
    phase: claim.status === 'activated' ? 'configured' : 'paired',
    ...(facts.lineage ? { lineage: facts.lineage } : {}),
    authorization
  }
}

// 激活仪式：核验清单 → 发布 schema → 建立/并入 MCP caller 与 provider 注册 → 定义 provider → 认领落账 → 重开。
// 与 GatewaySetup.native 同序、同发布语义；已激活认领只核对指纹后原样返回，响应丢失可安全重入。
export async function activateOnlineNative(
  host: OnlineActivationHost,
  claim: PairingClaim,
  installation: unknown,
  signal: AbortSignal,
  assertActive: () => void
): Promise<{ state: 'configured'; fingerprint: string }> {
  const facts = activationFacts(host, claim)
  const { reviewed, authorization, fingerprint } = await reviewSetupManifest(
    installation,
    planFacts(claim, facts.principal, facts.lineage),
    claim.machine_id,
    host.config.state_dir,
    signal
  )
  assertActive()
  if (claim.status === 'activated') {
    if (claim.native_fingerprint !== fingerprint) {
      throw new CliError('configuration_required')
    }
    return { state: 'configured', fingerprint }
  }
  if (claim.status !== 'delivered') {
    throw new CliError('configuration_required')
  }
  if (signal.aborted) {
    throw new CliError('configuration_required')
  }
  // 已有不同 registry 条目不能被在线激活扩大或覆盖；同引用必须与已核验条目完全一致。
  const providers = readRuntimeConfig(host.config).providers
  if (
    providers.some((entry) => {
      const expected = reviewed.find((value) => value.reference === entry.reference)
      return expected
        ? boundedJson(entry.value, 1_048_576) !== boundedJson(expected.value, 1_048_576)
        : !facts.additional
    })
  ) {
    throw new CliError('configuration_required')
  }
  await publishSetupSchemas(reviewed, signal)
  assertActive()
  const clientPath = runtimeReference(host.config.state_dir, 'mcp-client')
  let client = facts.client
  if (!client) {
    const created = {
      schema_version: 1,
      kind: 'mcp-client-credential',
      attempt_id: claim.claim_id,
      resource: facts.resource,
      principal_id: authorization.principal_id,
      token: randomBytes(32).toString('base64url'),
      issued_at: Date.now(),
      expires_at: Date.now() + 30 * 86400_000
    }
    publish(clientPath, created)
    client = created
  }
  const callersPath = runtimeReference(host.config.state_dir, 'mcp-callers')
  const providersPath = runtimeReference(host.config.state_dir, 'providers')
  const reviewedEntries = reviewed.map((entry) => ({ reference: entry.reference, value: entry.value }))
  if (!facts.additional) {
    publishFirstCallers(callersPath, facts.resource, authorization, {
      principal: { id: authorization.principal_id, policy: authorization.policies.caller },
      token_sha256: createHash('sha256').update(client.token).digest('hex'),
      issued_at: client.issued_at,
      expires_at: client.expires_at
    })
    publish(providersPath, { schema_version: 1, role: 'gateway', providers: reviewedEntries }, 1_048_576)
  } else {
    mergeSetupCallers(callersPath, facts.resource, authorization)
    mergeSetupProviders(providersPath, reviewedEntries)
  }
  host.state.store.activatePairingProviders(
    claim.claim_id,
    fingerprint,
    reviewed.map((entry) => entry.binding)
  )
  // 与本机仪式相同：下一事件轮才重开，先让本次响应完成写出。
  setImmediate(() => host.reload())
  return { state: 'configured', fingerprint }
}

// 设备凭据短认证：与 GatewayPairingHttp 相同的 IdentityHost 新鲜 epoch 核验，结束即断开该 epoch。
export async function withOnlineDeviceAuth<T>(
  host: OnlineActivationHost,
  credential: DeviceCredential,
  run: (assertActive: () => void) => Promise<T>
): Promise<T> {
  const identityHost = host.state.lifecycle.identityHost
  const active = identityHost.authenticate(credential.machine_id, credential.recovery_generation, credential.credential)
  try {
    identityHost.assert(active.identity, active.lease)
    const value = await run(() => identityHost.assert(active.identity, active.lease))
    identityHost.assert(active.identity, active.lease)
    return value
  } finally {
    identityHost.disconnect(active.identity)
  }
}
