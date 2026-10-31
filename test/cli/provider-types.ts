// 在正式类型检查中固定Gateway中性providers/session分支，避免Herdr被迫补造Luvus字段。
import type { ProviderGatewayRuntimeOptions } from '../../src/runtime/types.js'
import type { ProductionGatewayResources, RuntimeCliGatewayResources } from '../../src/cli/index.js'

// 仅用于编译检查，不启动角色、构造来源或创建测试成功后端。
export function neutralGatewayTypeChecks(
  provider: ProviderGatewayRuntimeOptions['providers'][number],
  session: NonNullable<ProviderGatewayRuntimeOptions['session']>,
  options: Omit<ProviderGatewayRuntimeOptions, 'providers' | 'session'>
) {
  const production: ProductionGatewayResources = {
    kind: 'provider',
    providers: [provider],
    session,
    release: /* 类型fixture不拥有实际资源。 */ async () => {}
  }
  const runtime: RuntimeCliGatewayResources = {
    kind: 'provider',
    options: { ...options, providers: [provider], session },
    authentication: { authenticate: /* 类型fixture不会处理请求，不授予任何身份。 */ () => null }
  }
  // @ts-expect-error 中性分支缺 session 与 ports 不能被当作可启动资源。
  const missing: ProductionGatewayResources = { kind: 'provider', providers: [provider], release: production.release }
  // @ts-expect-error 没有Luvus contract/source/authority时只能选择中性分支。
  const legacy: ProductionGatewayResources = {
    providers: [provider],
    release: production.release
  }
  return { production, runtime, missing, legacy }
}
