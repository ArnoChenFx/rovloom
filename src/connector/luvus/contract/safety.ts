// 核验原生方法、原生访问面、参数覆盖程度与实际来源，登记本次请求的内存派发句柄。
import { candidates, views } from './internal.js'
import { luvusMethod } from '../methods.js'
import { attempt, equal, fail, object, snapshot } from './json.js'
import { verifySource } from './validator.js'
import type { Check, DispatchAuthorization, DispatchCandidate, DispatchPermit, ResultAuthorization } from './types.js'

// 抛出来源与阶段均为授权的失败信息。
function reject(code: string, reason?: string): never {
  return fail(code, 'authorization', reason, 'authorization')
}

// 核验候选句柄、来源和主体时间字段，并冻结授权输入以防后续变更。
function checkedAuthorization(candidate: DispatchCandidate, input: DispatchAuthorization): DispatchAuthorization {
  const stored = candidates.get(candidate)
  if (!stored || !views.has(stored.view)) {
    reject('invalid_request_handle')
  }
  const context = snapshot(input) as unknown as DispatchAuthorization
  if (!context.source?.authenticated) {
    reject('unauthenticated')
  }
  const current = verifySource(context.source)
  if (!equal(current, candidate.binding)) {
    reject('capability_stale')
  }
  if (
    typeof context.principal_id !== 'string' ||
    !context.principal_id.trim() ||
    !Number.isSafeInteger(context.now) ||
    context.now < 0
  ) {
    reject('invalid_authorization_context')
  }
  return context
}

// 许可必须是 checkDispatch 签发的形状，且其候选仍是本校验器登记过的请求。
export function checkedPermit(permit: DispatchPermit): void {
  if (!permit || permit.kind !== 'permit' || !candidates.has(permit.candidate)) {
    reject('invalid_permit_handle')
  }
}

// 方法必须在静态表中，且实际安装契约广告的原生提示与表逐字段一致；表外方法一律拒绝。
function checkListed(candidate: DispatchCandidate): void {
  const stored = candidates.get(candidate)!
  const listed = luvusMethod(candidate.method)
  if (!listed) {
    reject('method_not_listed')
  }
  if (!equal(listed, stored.descriptor.native_contract)) {
    reject('method_contract_mismatch')
  }
  if (
    candidate.binding.target.profile !== 'session' ||
    (stored.descriptor.transport !== 'unclassified' && stored.descriptor.transport !== 'single_request_rpc')
  ) {
    reject('unsupported_transport')
  }
}

// 原生 access-only 端点自带方法白名单；缺失或未包含本次方法一律拒绝，不用静态表替代原生授权。
function checkNativeAccess(candidate: DispatchCandidate): void {
  const stored = candidates.get(candidate)!
  const capabilities = views.get(stored.view)!.capabilities
  if (capabilities.access === undefined) {
    return
  }
  const access = object(capabilities.access)
  if (!Array.isArray(access.allowed_methods) || !access.allowed_methods.includes(candidate.method)) {
    reject('forbidden', 'native_access')
  }
}

// 全部安全门禁通过后签发内存许可；raw 仅豁免参数 schema 完整性要求。
export function checkDispatch(candidate: DispatchCandidate, input: DispatchAuthorization): Check<DispatchPermit> {
  return attempt(
    'authorization',
    /* 验证当前授权上下文并执行各项门禁，最后登记许可及其主体。 */ () => {
      const context = checkedAuthorization(candidate, input)
      checkListed(candidate)
      checkNativeAccess(candidate)
      // raw 只放宽参数 schema 覆盖要求；方法表、原生访问面和传输门禁仍须全部通过。
      if (context.mode === 'strict') {
        if (candidate.validation === 'generic') {
          reject('parameter_schema_incomplete')
        }
        if (candidate.validation === 'unavailable') {
          reject('schema_unavailable')
        }
      } else if (context.mode !== 'raw_contract') {
        reject('invalid_execution_mode')
      }
      return Object.freeze({
        kind: 'permit' as const,
        candidate,
        principal_id: context.principal_id,
        binding: candidate.binding,
        method: candidate.method,
        mode: context.mode,
        validation: candidate.validation
      })
    }
  )
}

// 在执行上下文内核验原请求主体与内容状态。
export function checkResultBoundary(permit: DispatchPermit, input: ResultAuthorization): Check<void> {
  return attempt(
    'result',
    /* 读取真实许可并检查结果仍可用，拒绝其它主体或已撤权的读取。 */ () => {
      checkedPermit(permit)
      const context = snapshot(input) as unknown as ResultAuthorization
      if (permit.principal_id !== context.principal_id) {
        reject('forbidden')
      }
      if (context.content_status !== 'available') {
        reject('content_unavailable')
      }
    }
  )
}

// 保存门禁独立于读取：只有派发时的同一主体、同一当前来源才能保留原文。
export function checkResultRetention(permit: DispatchPermit, input: DispatchAuthorization): Check<void> {
  return attempt(
    'result',
    /* 重新验证当前授权来源，并要求仍是派发时的主体。 */ () => {
      checkedPermit(permit)
      const context = checkedAuthorization(permit.candidate, input)
      if (permit.principal_id !== context.principal_id) {
        reject('forbidden')
      }
    }
  )
}
