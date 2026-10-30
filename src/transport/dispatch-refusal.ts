// 仅信任当前 provider 的真实本机异常类型及确定未写出语义；普通 Error 和原生回包不能生成拒绝。
import { HerdrLocalError } from '../connector/herdr/local.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import { ProviderAdapterError } from '../connector/provider-error.js'
import type { AttemptBinding, DispatchRefusalCode, ProviderKind } from '../wire/types.js'

/**
 * herdr-core 在执行前就能确定「没有写出」的固定码：本机开关关闭、终端三元组不符、
 * 读不到终端事实或 blocked、以及附着连接已断（重新附着在写入之前失败）。
 * 写入之后才失败的写类调用不在这个集合里，仍按 `outcome_unknown` 走保守路径。
 */
const HERDR_CORE_REFUSALS: readonly string[] = Object.freeze([
  'terminal_execution_disabled',
  'herdr_core_terminal_blocked',
  'herdr_core_terminal_identity_mismatch',
  'herdr_core_terminal_unavailable',
  'herdr_core_connection_closed',
  // 启动前的模板核对与本地容量上限：都在写发送墓碑之前判定。
  'herdr_core_template_unavailable',
  'herdr_core_template_ambiguous',
  'herdr_core_run_capacity',
  // core 明确拒绝的类别：连接还在，core 已答复，没有写入。
  'herdr_core_native_status_mismatch',
  'herdr_core_native_blocked',
  'herdr_core_native_finished',
  'herdr_core_native_not_found',
  'herdr_core_native_machine_unknown',
  'herdr_core_native_invalid_params',
  'herdr_core_native_name_taken',
  'herdr_core_native_invalid_template'
])

export interface DispatchRefusalLedger {
  /** 仅真正提交确定拒绝时返回 true；已 unknown/终态返回 false，不得据此驱逐原结果上下文。 */
  commitDispatchRefusal(binding: AttemptBinding, code: DispatchRefusalCode): boolean
}

/** 固定白名单只覆盖确定未写出的终局门禁；未知、可能已写出或其它 provider 的异常仍走保守失败路径。 */
export function dispatchRefusal(error: unknown, kind: ProviderKind): DispatchRefusalCode | undefined {
  if (
    ((kind === 'herdr' && error instanceof HerdrLocalError) ||
      (kind === 'luvus' && error instanceof LuvusAdapterError)) &&
    error.outcome === 'not_dispatched' &&
    error.code === 'terminal_execution_disabled'
  ) {
    return error.code
  }
  // herdr-core 的固定码只在本地判定为 not_dispatched 时才成立；已写出后的同类异常仍是未知结局。
  if (
    kind === 'herdr-core' &&
    error instanceof ProviderAdapterError &&
    error.outcome === 'not_dispatched' &&
    HERDR_CORE_REFUSALS.includes(error.code)
  ) {
    return error.code as DispatchRefusalCode
  }
  return undefined
}
