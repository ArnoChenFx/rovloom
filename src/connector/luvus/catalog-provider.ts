/**
 * Luvus 目录端口：把已核验安装契约与在线能力投影成 provider 目录事实。
 * 这里保留 Luvus 自己的方法规则与参数提示；公共身份/分页门禁在 MCP 层。
 */
import { createLuvusCatalog, LuvusAdapterError } from './index.js'
import type { NativeContractRecord } from './backend.js'
import type { TrustedNativeContext } from './contract/index.js'
import type { Principal } from '../../router.js'
import type { ProviderCatalogProvider, ProviderCatalogSource } from '../../mcp/catalog.js'
import { FacadeServiceError } from '../../mcp/types.js'
import { boundedJson, contractRef, hash, LIMITS, WireError } from '../../wire/index.js'
import type { JsonObject, ProviderBinding, V2Target } from '../../wire/types.js'
import { luvusParameterHelp } from './parameter-help.js'

/** 宿主已认证 epoch 交付的 Luvus 目录来源；不从工具参数或 session listing 构造。 */
export type GatewayCatalogSource = Readonly<{
  record: NativeContractRecord
  source: TrustedNativeContext
  local_provider: ProviderBinding
  expires_at: number
  supported_methods?: readonly string[]
}>

export interface GatewayCatalogProvider {
  kind?: 'luvus'
  // 从受保护 registry 返回独立认证的在线能力与安装契约。
  resolve(target: V2Target, principal: Principal): GatewayCatalogSource | undefined
}

/**
 * 把本机 Luvus 目录来源包装成 provider 目录端口。方法清单与原生描述仍由 Luvus
 * 自己的 validator/schema 解释，公共门禁只消费这份投影。
 */
export function luvusCatalogProvider(options: {
  store: {
    clock(): number
    generation(): string
    assertConnection(identity: { machine_id: string; recovery_generation: string; connection_epoch: string }): void
  }
  provider: GatewayCatalogProvider
}): ProviderCatalogProvider {
  return Object.freeze({
    kind: 'provider',
    resolve(target: V2Target, principal: Principal): ProviderCatalogSource | undefined {
      try {
        return resolveView(target, principal)
      } catch (error) {
        if (error instanceof LuvusAdapterError || error instanceof WireError) {
          throw new FacadeServiceError('contract_unavailable')
        }
        throw error
      }
    }
  })

  /** 单次 resolve：先复核 Luvus 自己的来源事实，再投影方法清单与原生描述。 */
  function resolveView(target: V2Target, principal: Principal): ProviderCatalogSource | undefined {
    {
      const resolved = options.provider.resolve(target, principal)
      if (!resolved) {
        return undefined
      }
      const ref = contractRef(resolved.record.wire.source)
      assertLuvusSource(resolved, ref, target, options.store)
      // 摘要交给公共门禁，由它在同一查询内比较；不在这里跨查询保留状态。
      const digest = luvusCatalogDigest(resolved)
      // 目录视图的时钟与期限仍由 Luvus 自己的 catalog 复核，不续期原能力。
      const catalog = createLuvusCatalog(resolved.record.compiled, resolved.record.capabilities, resolved.source, {
        now: () => options.store.clock(),
        current: () => options.provider.resolve(target, principal)?.source ?? resolved.source,
        expires_at: resolved.expires_at
      })
      // 终端开关由公共目录门禁统一应用；这里只交付 provider 的原生方法与授权后集合。
      const methods: JsonObject[] = []
      let scanned = 0
      let cursor: string | undefined
      do {
        const page = catalog.list({ limit: 100, ...(cursor ? { cursor } : {}) })
        scanned += page.methods.length
        if (scanned > 256) {
          throw new FacadeServiceError('busy')
        }
        for (const method of page.methods) {
          if (resolved.supported_methods !== undefined && !resolved.supported_methods.includes(method.method)) {
            continue
          }
          methods.push(JSON.parse(boundedJson({ ...method, contract_ref: ref })) as JsonObject)
        }
        cursor = page.next_cursor ?? undefined
      } while (cursor)
      const names = methods.map((row) => row.method as string)
      return Object.freeze({
        target,
        local_provider: resolved.local_provider,
        contract_ref: ref,
        contract: resolved.record.wire,
        capability_revision: resolved.record.capability_revision,
        expires_at: resolved.expires_at,
        digest,
        methods: Object.freeze(methods),
        /** 精确方法必须位于当前授权集合；原生 read 标签不自动授予任何方法。 */
        describe(method: string): JsonObject {
          if (!names.includes(method)) {
            throw new FacadeServiceError('not_found')
          }
          try {
            const parameterHelp = luvusParameterHelp(method, names)
            return JSON.parse(
              boundedJson({
                ...catalog.describe(method),
                contract_ref: ref,
                ...(parameterHelp ? { parameter_help: parameterHelp } : {})
              })
            ) as JsonObject
          } catch (error) {
            if (error instanceof LuvusAdapterError || error instanceof WireError) {
              throw new FacadeServiceError('contract_unavailable')
            }
            throw error
          }
        }
      })
    }
  }
}

/**
 * Luvus 自己的来源一致性门禁：完整 binding、安装身份、能力修订、代次与当前 epoch
 * 必须同时成立。这些是 UHP 语义，公共目录门禁不解释它们。
 */
function assertLuvusSource(
  resolved: GatewayCatalogSource,
  ref: string,
  target: V2Target,
  store: {
    generation(): string
    assertConnection(identity: { machine_id: string; recovery_generation: string; connection_epoch: string }): void
  }
): void {
  const native = resolved.source.binding
  const origin = resolved.record.wire.source
  const nativeTarget = { ...native.target, provider_id: native.provider_id }
  if (
    resolved.source.authenticated !== true ||
    resolved.source.source_verified !== true ||
    native.kind !== 'luvus' ||
    boundedJson(nativeTarget) !== boundedJson(target) ||
    native.binding_revision !== resolved.local_provider.binding_revision ||
    native.contract_source_ref !== ref ||
    origin.provider_kind !== 'luvus' ||
    resolved.record.compiled.identity.binary_sha256 !== origin.binary_sha256 ||
    resolved.record.compiled.identity.schema_sha256 !== origin.schema_sha256 ||
    native.capability_revision !== resolved.record.capability_revision ||
    native.classification_revision !== origin.classification_revision ||
    native.server_generation !== origin.runtime_generation ||
    native.recovery_generation !== store.generation()
  ) {
    throw new FacadeServiceError('contract_unavailable')
  }
  store.assertConnection({
    machine_id: target.machine_id,
    recovery_generation: native.recovery_generation,
    connection_epoch: native.connection_epoch
  })
}

/** 目录快照摘要：只用于同一读取周期内发现来源变化，不建立执行许可。 */
export function luvusCatalogDigest(source: GatewayCatalogSource): string {
  return hash(
    boundedJson(
      {
        ref: contractRef(source.record.wire.source),
        capabilities: source.record.capabilities,
        capability_revision: source.record.capability_revision,
        compiled: source.record.compiled.identity,
        supported_methods: source.supported_methods ?? null,
        expires_at: source.expires_at
      },
      LIMITS.object_bytes
    )
  )
}
