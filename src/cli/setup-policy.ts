// 首次本机批准只覆盖该次完整设备/provider/session；两端共享修订，不保存逐方法权限。
import { CliError, luvusMode, type ConnectorConfig, type NativeProviderKind } from './config.js'
import type { ProviderPolicies, ProviderPolicy, V2Target } from '../wire/types.js'

// 配对双方共用的计划事实：单码直连配对没有逐次人工批准，主体与谱系都是固定常量。
export type SetupPlanFacts = Readonly<{
  attempt_id: string
  actor: string
  lineage?: string
  providers?: readonly NativeProviderKind[]
}>
// 单码直连配对的调用主体与策略修订标签：所有设备共用同一修订，加入新设备无需谱系协商。
export const SIMPLE_SETUP_ACTOR = 'operator_simple_pairing'
export const SIMPLE_SETUP_LINEAGE = 'simple'

/** MCP token 按设备范围授权；内部 Wire 使用全方法标志，不持久化配对时的方法快照。 */
export function allExposedMethods(policy: ProviderPolicy): ProviderPolicy {
  return {
    ...policy,
    grants: policy.grants.map((grant) => ({
      ...grant,
      methods: ['*'],
      actions: ['dispatch', 'read', 'cancel']
    }))
  }
}

// Luvus 会话名随运行方式确定：附着用户真实的 default 会话，或 managed 隔离实例的 rovloom；Herdr 固定 default。
export type SetupSessions = Readonly<{ luvus?: 'default' | 'rovloom' }>

// 只接受程序定义的两个会话名；其它形态一律拒绝，不能借配对请求选择任意会话。
export function setupSessions(input: unknown): SetupSessions {
  if (input === undefined) {
    return Object.freeze({})
  }
  const row = input as Record<string, unknown>
  if (
    row === null ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Object.keys(row).some(/* 目前只有 Luvus 可选择会话。 */ (key) => key !== 'luvus') ||
    (row.luvus !== undefined && row.luvus !== 'default' && row.luvus !== 'rovloom')
  ) {
    throw new CliError('configuration_required')
  }
  return Object.freeze(row.luvus === undefined ? {} : { luvus: row.luvus })
}

// 每种首次实例的完整业务Target由程序确定，仍由实际安装、身份和每个原Wire门禁核验。
export function setupTarget(
  machine: string,
  kind: NativeProviderKind = 'luvus',
  sessions: SetupSessions = {}
): V2Target & { profile: 'session' } {
  return {
    machine_id: machine,
    provider_id: kind,
    profile: 'session',
    session: kind === 'luvus' ? (sessions.luvus ?? 'rovloom') : 'default'
  }
}

// 网络选择只接受程序定义的单来源或固定顺序双来源，空值、重复项和未知kind均拒绝。
export function setupProviderKinds(input: unknown): readonly NativeProviderKind[] {
  if (
    !Array.isArray(input) ||
    input.some(/* 不能借对象的字符串转换伪装原生kind。 */ (kind) => kind !== 'luvus' && kind !== 'herdr') ||
    !['luvus', 'herdr', 'luvus,herdr'].includes(input.join(','))
  ) {
    throw new CliError('configuration_required')
  }
  return Object.freeze([...input])
}

// 两个来源各有精确 Target；方法由当前 provider 的暴露面决定，不在配对时冻结。
// 修订标签取自 lineage（首台设备那次引导的 attempt）：所有设备的本机策略共用同一修订，Gateway 才能同时就绪；
// 标签只是命名这一代引导，策略内容（授权集合）随加入的设备增长。
export function selectedSetupPolicies(
  plan: Pick<SetupPlanFacts, 'attempt_id' | 'actor' | 'lineage'>,
  machine: string,
  kinds: readonly NativeProviderKind[],
  sessions: SetupSessions = {}
): { principal_id: string; policies: ProviderPolicies } {
  const grants = setupProviderKinds(kinds).map(
    /* 每条授权只覆盖该来源的固定首次session。 */ (kind) => ({
      target: setupTarget(machine, kind, sessions),
      methods: ['*'],
      actions: ['dispatch', 'read', 'cancel'] as ('dispatch' | 'read' | 'cancel')[]
    })
  )
  return {
    principal_id: plan.actor,
    policies: {
      caller: { revision: 'setup_caller_' + (plan.lineage ?? plan.attempt_id), grants },
      local: { revision: 'setup_local_' + (plan.lineage ?? plan.attempt_id), grants: structuredClone(grants) }
    }
  }
}

// 内部引用不会暴露为用户JSON参数，且精确绑定原attempt以避免不同初始化互为别名。
export function setupReference(attempt: string, kind: NativeProviderKind = 'luvus'): string {
  return kind + '_' + attempt
}

// Connector 按自己的运行方式选择 Luvus 会话：附着 default，managed 用 rovloom。
export function setupSessionsFor(config: ConnectorConfig): SetupSessions {
  return Object.freeze({ luvus: luvusMode(config) === 'attach' ? ('default' as const) : ('rovloom' as const) })
}

// 单码直连配对的固定授权：主体与修订都是常量，Connector 与 Gateway 各自本地推导出逐字节一致的结果。
export function simpleSetupAuthorization(
  machine: string,
  kinds: readonly NativeProviderKind[],
  sessions: SetupSessions = {}
): { principal_id: string; policies: ProviderPolicies } {
  return selectedSetupPolicies(
    { attempt_id: SIMPLE_SETUP_LINEAGE, actor: SIMPLE_SETUP_ACTOR, lineage: SIMPLE_SETUP_LINEAGE },
    machine,
    kinds,
    sessions
  )
}
