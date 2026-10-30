// 首次本机批准只覆盖该次完整设备/provider/session；两端共享修订，不保存逐方法权限。
import { CliError, herdrCoreSession, luvusMode, type ConnectorConfig, type NativeProviderKind } from './config.js'
import type { V2Target } from '../wire/types.js'

// 配对双方共用的计划事实：单码直连配对没有逐次人工批准，主体与谱系都是固定常量。
export type SetupPlanFacts = Readonly<{
  attempt_id: string
  actor: string
  lineage?: string
  providers?: readonly NativeProviderKind[]
}>
// 单码直连配对主体及安装谱系标签；不用于调用授权。
export const SIMPLE_SETUP_ACTOR = 'operator_simple_pairing'
export const SIMPLE_SETUP_LINEAGE = 'simple'

// Luvus 会话名随运行方式确定：附着用户真实的 default 会话，或 managed 隔离实例的 rovloom；
// Herdr 固定 default；herdr-core 的会话名来自 Connector 本地配置（默认 default）。
export type SetupSessions = Readonly<{ luvus?: 'default' | 'rovloom'; herdr_core?: string }>

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
    Object.keys(row).some(
      /* 只有这两种 provider 需要显式会话名。 */ (key) => key !== 'luvus' && key !== 'herdr_core'
    ) ||
    (row.luvus !== undefined && row.luvus !== 'default' && row.luvus !== 'rovloom') ||
    (row.herdr_core !== undefined &&
      (typeof row.herdr_core !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(row.herdr_core)))
  ) {
    throw new CliError('configuration_required')
  }
  return Object.freeze({
    ...(row.luvus === undefined ? {} : { luvus: row.luvus as 'default' | 'rovloom' }),
    ...(row.herdr_core === undefined ? {} : { herdr_core: row.herdr_core as string })
  })
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
    session:
      kind === 'luvus'
        ? (sessions.luvus ?? 'rovloom')
        : kind === 'herdr-core'
          ? (sessions.herdr_core ?? 'default')
          : 'default'
  }
}

// 网络选择只接受程序定义的单来源或固定顺序双来源，空值、重复项和未知kind均拒绝。
export function setupProviderKinds(input: unknown): readonly NativeProviderKind[] {
  if (
    !Array.isArray(input) ||
    input.some(
      /* 不能借对象的字符串转换伪装原生kind。 */ (kind) => kind !== 'luvus' && kind !== 'herdr' && kind !== 'herdr-core'
    ) ||
    // 只接受程序定义的单来源或固定顺序双来源；mixed 仍只表示 Luvus + Herdr TUI。
    !['luvus', 'herdr', 'herdr-core', 'luvus,herdr'].includes(input.join(','))
  ) {
    throw new CliError('configuration_required')
  }
  return Object.freeze([...input])
}

// 内部引用不会暴露为用户JSON参数，且精确绑定原attempt以避免不同初始化互为别名。
export function setupReference(attempt: string, kind: NativeProviderKind = 'luvus'): string {
  return kind + '_' + attempt
}

// Connector 按自己的运行方式选择 Luvus 会话：附着 default，managed 用 rovloom。
export function setupSessionsFor(config: ConnectorConfig): SetupSessions {
  return Object.freeze({
    luvus: luvusMode(config) === 'attach' ? ('default' as const) : ('rovloom' as const),
    herdr_core: herdrCoreSession(config)
  })
}
