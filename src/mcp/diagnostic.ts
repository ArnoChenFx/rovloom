/** 公共 MCP 诊断字段只描述已拒绝的参数位置与规则，不含 provider 专属方法语义。 */
export type ParameterIssueRule =
  | 'required'
  | 'object'
  | 'required_true'
  | 'one_of'
  | 'range'
  | 'pattern'
  | 'invalid_value'

export type ParameterDiagnostic = Readonly<{
  method: string
  issues: readonly Readonly<{ path: string; rule: ParameterIssueRule }>[]
}>
