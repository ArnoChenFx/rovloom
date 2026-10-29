// Luvus 登记前复用既有请求结构校验，不建立调用、来源、候选或执行许可。
import { NativeRequestPreflightError } from '../preflight.js'
import { GatewayError } from '../../contracts.js'
import { createNativeValidator } from './contract/index.js'
import type { CompiledContract } from './contract/index.js'
import { luvusOperationDescriptor, luvusOperationValidation, validateLuvusOperationParams } from './operations.js'
import { luvusParameterDiagnostic, publicLuvusParameterDiagnostic } from './parameter-help.js'
import { LuvusAdapterError } from './types.js'

function invalidRequest(request?: unknown): NativeRequestPreflightError {
  const diagnostic = luvusParameterDiagnostic(request)
  return new NativeRequestPreflightError(diagnostic ? publicLuvusParameterDiagnostic(diagnostic) : undefined)
}

/** Store 首次登记事务传入其分配的真实原生 ID，失败回滚原登记，不触及 transport。 */
export function createLuvusRequestPreflight(contract: CompiledContract): (request: unknown) => void {
  const validator = createNativeValidator(contract)
  return /** 结构检查不替代后续原 Wire、在线能力、raw 授权、分类及紧贴 IO 的最终复验。 */ (request) => {
    const checked = validator.checkRequestShape(request)
    if (!checked.ok) {
      if (checked.error.code === 'native_request_invalid') {
        throw invalidRequest(request)
      }
      throw new GatewayError(checked.error.code)
    }
    // generic 原生 schema 之后仍检查 Rovloom 已审核子集，错误在登记前返回相同的安全字段诊断。
    const native = request as { method: string; params?: unknown }
    if (luvusOperationDescriptor(native.method)) {
      try {
        validateLuvusOperationParams(native.method, native.params)
      } catch (error) {
        if (error instanceof LuvusAdapterError && error.code === 'luvus_operation_params_invalid') {
          throw invalidRequest(request)
        }
        throw error
      }
    }
  }
}

/**
 * Luvus 已审核的普通方法各自要求固定验证模式（通用参数方法为 raw-contract，条件分支方法为 strict）。
 * 调用方未指定时按方法选择；显式指定了不同模式则在登记前确定拒绝，而不是等到 Wire 编码失败后
 * 把已派发的尝试置为 outcome_unknown 并断开设备连接。
 */
export function luvusValidation<T extends { validation?: 'strict' | 'raw-contract' }>(
  kind: string,
  request: { method: string },
  options: T
): T {
  if (kind !== 'luvus' || !luvusOperationDescriptor(request.method)) {
    return options
  }
  const required = luvusOperationValidation(request.method)
  if (options.validation === undefined) {
    return { ...options, validation: required }
  }
  if (options.validation !== required) {
    throw invalidRequest()
  }
  return options
}
