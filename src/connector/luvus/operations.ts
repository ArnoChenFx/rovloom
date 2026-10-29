/** 固定 Luvus 0.14.3 的窗口、pane 与 Agent 普通操作及参数子集；不发行凭据或把 generic schema 冒称完整。 */
import type { NativeMethodContract } from './contract/index.js'
import { LUVUS_OPERATION_READ, LUVUS_OPERATION_WRITE, luvusMethod } from './methods.js'
import { LuvusAdapterError } from './types.js'
import { luvusReviewedValidator } from './reviewed-params.js'
import { boundedJson, object } from '../../wire/index.js'

export type LuvusOperationDescriptor = Readonly<{
  native: Readonly<NativeMethodContract>
  effect: 'read' | 'execute'
  native_parameter_schema: 'conditional_branch' | 'generic_params_only'
}>
const conditional = new Set(['pane.list', 'agent.prompt', 'agent.send', 'agent.wait', 'agent.keys'])
const operations = new Map<string, LuvusOperationDescriptor>()
for (const groups of [LUVUS_OPERATION_READ, LUVUS_OPERATION_WRITE]) {
  for (const methods of Object.values(groups)) {
    for (const method of methods) {
      const native = luvusMethod(method)!
      operations.set(
        method,
        Object.freeze({
          native,
          effect: native.access === 'read' ? 'read' : 'execute',
          native_parameter_schema: conditional.has(method) ? 'conditional_branch' : 'generic_params_only'
        })
      )
    }
  }
}
export const LUVUS_OPERATION_METHODS = Object.freeze([...operations.keys()])

/** 返回固定普通接口事实；未知方法、token/admin 和集成伪状态上报不在此清单；终端输入仍须本机显式开关。 */
export function luvusOperationDescriptor(method: string): LuvusOperationDescriptor | undefined {
  return operations.get(method)
}

/** UI 自动选原协议已存在的验证模式；generic 保持事实，通过显式实际本机 Owner 的现有 raw 路径执行。 */
export function luvusOperationValidation(method: string): 'strict' | 'raw-contract' {
  const descriptor = operations.get(method)
  if (!descriptor) {
    throw new LuvusAdapterError('luvus_operation_unreviewed')
  }
  return descriptor.native_parameter_schema === 'conditional_branch' ? 'strict' : 'raw-contract'
}

/** 只返回固定安全错误码，参数值、路径、prompt 和原生输出不进入错误。 */
function invalid(): never {
  throw new LuvusAdapterError('luvus_operation_params_invalid')
}

/**
 * 对普通操作执行参数检查。字段规则（必填、类型、枚举、范围、互斥、依赖、未知字段）只有已审核 schema 这一份，
 * 执行校验、runtime_describe 的 params_schema 与拒绝诊断共用它；这里只做预处理（有界 JSON、必须是对象）和判定。
 * 没有已审核 schema 的操作一律拒绝（fail-closed），不会放行未检查的参数。官方 generic 参数覆盖状态继续保留。
 */
export function validateLuvusOperationParams(method: string, input: unknown): void {
  if (!operations.has(method)) {
    throw new LuvusAdapterError('luvus_operation_unreviewed')
  }
  try {
    const validate = luvusReviewedValidator(method)
    if (!validate || validate(object(JSON.parse(boundedJson(input)))) !== true) {
      invalid()
    }
  } catch {
    invalid()
  }
}
