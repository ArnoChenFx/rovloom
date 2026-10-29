import type { GatewayCatalogSource } from '../../src/connector/luvus/catalog-provider.js'
// 为真实目录/Store接线建立人工在线状态与合成来源；不建立设备或原生会话，不替代生产证明。
import { StoreGatewayService } from '../../src/mcp/index.js'
import { contractRef, type ContractSource } from '../../src/wire/index.js'
import { compiled, json, source as nativeSource, G } from '../connector/luvus/contract/helpers.js'
import { storeFixture, target, syntheticCredential } from './store-fixture.js'
import { luvusCatalogProvider } from '../../src/connector/luvus/catalog-provider.js'

import { catalogMethods } from './fixture-values.js'

export { catalogMethods } from './fixture-values.js'

// 固定测试凭据只来自人工seed；真实Store建立当前epoch，但不代表#6独立身份桥或socket认证。
export function catalogFixture() {
  const f = storeFixture()
  const epoch = f.store.connect(target.machine_id, syntheticCredential)
  f.setCaller({ id: 'alice' })
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = target.session
  capabilities.result.server_generation = G
  // 来源摘要直接取本例真实编译句柄，避免为读取常量重复初始化另一套Wire测试校验器。
  const origin: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: compiled.identity.binary_sha256,
    schema_sha256: compiled.identity.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: G,
    adapter_revision: 'synthetic_adapter_1',
    classification_revision: 'review1',
    support_basis: 'live_catalog'
  }
  const initial = nativeSource()
  let source: GatewayCatalogSource | undefined = {
    supported_methods: catalogMethods,
    local_provider: f.store.provider(target.machine_id, target.provider_id)!,
    record: {
      wire: { source: origin, support_status: 'validated' },
      compiled,
      capabilities,
      capability_revision: 'caps1'
    },
    source: {
      ...initial,
      binding: {
        ...initial.binding,
        provider_id: target.provider_id,
        target: {
          machine_id: target.machine_id,
          profile: 'session',
          session: target.session!
        },
        binding_revision: 1,
        contract_source_ref: contractRef(origin),
        connection_epoch: epoch,
        recovery_generation: f.store.generation()
      }
    },
    expires_at: f.store.clock() + 30_000
  }
  let resolutions = 0
  // 与 CLI 相同：本机 Luvus 目录经 provider 目录端口交付，公共门禁在 MCP 层。
  const catalog = luvusCatalogProvider({
    store: f.store,
    provider: {
      resolve: /* 合成能力已显式绑定本例epoch/target；此回调不是生产原生身份提供者。 */ () => {
        resolutions++
        return source
      }
    }
  })
  const service = new StoreGatewayService({
    targets: f.targets,
    store: f.store,
    identities: f.identities,
    catalog
  })
  return {
    ...f,
    service,
    catalog,
    source: /* 只供测试读取合成registry，不允许MCP调用方注入。 */ () => source!,
    setSource: /* 替换当前受测来源以验证每次fresh校验，compiled opaque handle保持真实。 */ (
      next: GatewayCatalogSource | undefined
    ) => {
      source = next
    },
    resolutions: /* 统计是否在授权之前错误触及来源提供者。 */ () => resolutions
  }
}
