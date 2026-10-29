// 管理HTTP沿用原handler的认证、CSRF和预算；只在实际service委托处进入PR71管理作用域。
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagementListenerHandler } from '../admin/index.js'
import type { ManagementSessionAuthority } from '../runtime/management-session.js'
import type {
  AdminContext,
  GatewayManagementService,
  ManagementArguments,
  ManagementOperation
} from '../mcp/management.js'

// 外层只保存Request来源，不做额外认证或等待；原handler准入后才调用受控service代理。
export function scopeManagementService(
  service: GatewayManagementService,
  authority: ManagementSessionAuthority,
  cookieName: string
) {
  const requests = new AsyncLocalStorage<{ request: Request; active: boolean }>()
  let stopped = false
  const scoped: GatewayManagementService = {
    // 原handler完成准入后，仅以其实际信号和认证上下文调用一次真实管理服务。
    async execute<K extends ManagementOperation>(name: K, args: ManagementArguments[K], context: AdminContext) {
      const request = requests.getStore()
      if (stopped || !request?.active || context.wait_signal.aborted) {
        throw new Error('management_scope_unavailable')
      }
      const entry = request.request.headers
        .get('cookie')
        ?.split(';')
        .find(
          /* 正式PR69适配器此前已验证唯一cookie、编码、Origin和当前会话；不解析另一认证来源。 */ (part) =>
            part.slice(0, part.indexOf('=')).trim() === cookieName
        )
      const raw = entry?.slice(entry.indexOf('=') + 1).trim()
      if (!raw) {
        throw new Error('management_scope_unavailable')
      }
      return authority.runAuthenticated(
        raw,
        context.wait_signal,
        /* 逐操作绑定正式handler给出的同一caller/session；不重放后置撤权前可能已提交的写入。 */ () => {
          const current = authority.current()
          if (
            stopped ||
            !request.active ||
            current.principal.id !== context.caller.principal_id ||
            current.session.management_session_ref !== context.management_session_ref
          ) {
            throw new Error('management_scope_unavailable')
          }
          return service.execute(name, args, context)
        }
      )
    }
  }
  return {
    service: scoped,
    handler: /* 包装生命周期而不改变原fetch的路径、限流、deadline或pending计数。 */ (
      handler: ManagementListenerHandler
    ): ManagementListenerHandler => ({
      stop: /* 先封锁代理并关闭原handler，原controller负责取消所有实际管理等待。 */ () => {
        stopped = true
        handler.stop()
        requests.disable()
      },
      fetch: /* HTTP返回后撤去来源，逃逸的异步工作不能重复使用请求上下文。 */ (request) => {
        const scope = { request, active: true }
        return requests.run(
          scope,
          /* 原handler中的预算等待仍全部由其自身管理。 */ async () => {
            try {
              return await handler.fetch(request)
            } finally {
              scope.active = false
            }
          }
        )
      }
    })
  }
}
