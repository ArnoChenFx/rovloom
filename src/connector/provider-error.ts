/** provider 的固定错误码与未派发语义；不携带原生路径、请求正文或底层输出。 */
export type LocalFailureOutcome = 'not_dispatched' | 'outcome_unknown'

export class ProviderAdapterError extends Error {
  /** 创建只包含安全错误码和本地结果语义的异常，不携带原始请求或底层输出。 */
  constructor(
    readonly code: string,
    readonly outcome: LocalFailureOutcome = 'not_dispatched'
  ) {
    // 不把路径、token、参数、stdout/stderr 或底层异常拼入普通错误。
    super(code)
    this.name = 'ProviderAdapterError'
  }
}
