/** 登记前拒绝的公共错误身份；参数规则和安全诊断由各 provider 生成。 */
import { GatewayError } from '../contracts.js'
import type { ParameterDiagnostic } from '../mcp/diagnostic.js'

export class NativeRequestPreflightError extends GatewayError {
  readonly outcome = 'not_dispatched' as const
  constructor(readonly parameterDiagnostic?: ParameterDiagnostic) {
    super('native_request_invalid')
  }
}
