// 将已认证 HTTP/stdio 请求隔离到独立异步作用域，逐操作复验身份并在请求结束后撤销作用域。
import { AsyncLocalStorage } from 'node:async_hooks'
import { GatewayError } from '../contracts.js'
import type { Principal } from '../router.js'
import type { GatewayIdentitySource, CallerIdentity } from '../mcp/management.js'
import { boundedJson, id } from '../wire/index.js'
import type { AuthenticatedRuntimeOperation, TrustedRequestScope } from './types.js'

/** 不把整个 principal 快照当长期权限；每次读取都回到同一可信身份来源。 */
export function createTrustedRequestScope(identities: GatewayIdentitySource): TrustedRequestScope & { close(): void } {
  const scope = new AsyncLocalStorage<{ caller: CallerIdentity; active: boolean }>()
  let closed = false
  /** 拒绝失效、切换或非法身份，并复制当前策略以免回调持有可变权限。 */
  function resolve(caller: CallerIdentity): Principal {
    if (closed) {
      throw new GatewayError('unauthenticated')
    }
    id(caller.principal_id)
    const current = identities.principal(caller)
    if (!current || current.id !== caller.principal_id) {
      throw new GatewayError('unauthenticated')
    }
    const copy = JSON.parse(
      boundedJson({ id: current.id, ...(current.device_scope ? { device_scope: current.device_scope } : {}) })
    ) as Principal
    if (closed) {
      throw new GatewayError('unauthenticated')
    }
    return copy
  }
  return {
    /** 认证 adapter 仅交付它已核实的身份引用，参数与 header 解析不属于此端口。 */
    async runAuthenticated<T>(caller: CallerIdentity, operation: AuthenticatedRuntimeOperation<T>): Promise<T> {
      if (closed) {
        throw new GatewayError('runtime_closed')
      }
      const trusted = Object.freeze({ principal_id: caller.principal_id })
      resolve(trusted)
      if (closed) {
        throw new GatewayError('runtime_closed')
      }
      const context = { caller: trusted, active: true }
      return scope.run(
        context,
        /** 请求结束立即使逃逸异步任务失去权限，连接中断本身不取消已登记执行。 */
        async () => {
          try {
            return await operation()
          } finally {
            context.active = false
          }
        }
      )
    },
    /** 只允许当前仍活跃请求取身份，不缓存最近成功 caller 或管理员。 */
    principal() {
      const current = scope.getStore()
      if (closed || !current?.active) {
        throw new GatewayError('unauthenticated')
      }
      const principal = resolve(current.caller)
      if (closed || !current.active || scope.getStore() !== current) {
        throw new GatewayError('unauthenticated')
      }
      return principal
    },
    /** 关闭时撤销全部作用域，迟到回调无法取回旧身份。 */
    close() {
      closed = true
      scope.disable()
    }
  }
}
