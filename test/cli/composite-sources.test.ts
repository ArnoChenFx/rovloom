// 仅验证资源装配和回滚；这些固定工厂探针没有可执行native后端，不能作为CLI业务成功证明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeProductionSources } from '../../src/cli/product-sources.js'
import { ProductionSourcesStartupError } from '../../src/cli/composite-sources.js'
import { ProviderUnavailableError } from '../../src/cli/provider-unavailable.js'
import { configTemplate } from '../../src/cli/config.js'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import type { ProductionCliSources, ProductionGatewayResources } from '../../src/cli/production.js'
import type { RuntimeCliGateway } from '../../src/cli/runtime.js'
import type { RuntimeProvider } from '../../src/connector/luvus/host/runtime-types.js'
import type { ProviderBinding, V2Target } from '../../src/wire/types.js'

const references = [
  { reference: 'luvus_ref', value: { kind: 'luvus' } },
  { reference: 'herdr_ref', value: { kind: 'herdr' } }
]

/** 创建只会拒绝native调用的装配描述；没有contract/source，也不会交给真实runtime启动。 */
function resource(kind: 'luvus' | 'herdr', events: string[]): ProductionGatewayResources {
  const target: V2Target = {
    machine_id: 'component_machine',
    provider_id: kind,
    profile: 'session',
    session: 'component'
  }
  const binding: ProviderBinding = {
    machine_id: target.machine_id,
    provider_id: target.provider_id,
    kind,
    config_ref: kind + '_ref',
    binding_revision: 1,
    enabled: true
  }
  const provider = {
    binding,
    target,
    max_response_bytes: 65536,
    ready: /** 资源探针从不声称native已就绪。 */ () => false,
    preflightRequest: /** 意外准入明确失败，不允许缺后端mock成功。 */ () => {
      throw new Error('component_native_unavailable')
    }
  }
  const release = /** 记录原owner释放顺序，不隐藏重复调用。 */ async () => {
    events.push(kind + ':release')
  }
  return kind === 'luvus'
    ? { providers: [provider as unknown as RuntimeProvider], release }
    : {
        kind: 'provider',
        providers: [provider],
        catalog: {
          kind: 'provider',
          resolve: /** 本探针没有安装目录，任何调用必须明确失败。 */ () => {
            throw new Error('component_catalog_unavailable')
          }
        },
        session: /** 本探针从不交付假的Wire/native会话。 */ () => {
          throw new Error('component_native_unavailable')
        },
        release
      }
}

/** 管理authority只供原签名传递，不建立管理员、cookie或设备身份。 */
function authority() {
  return createManagementSessionAuthority({
    principal: /** 空主体不会取得任何业务授权。 */ () => null,
    administrator: /** 未注入管理员来源。 */ () => null
  })
}

test(
  '混合Gateway保留原providers/preflight/session/catalog，唯一runtime建立后才绑定Luvus目录',
  /** 只检查端口同一性，不启动角色。 */ async () => {
    const config = configTemplate('gateway')
    if (config.role !== 'gateway') {
      assert.fail('gateway required')
    }
    const events: string[] = []
    const luvus = resource('luvus', events)
    const herdr = resource('herdr', events)
    const actual = authority()
    const sources: Record<'luvus' | 'herdr', ProductionCliSources> = {
      luvus: {
        gateway: /** 固定工厂只检查原参数，未提供native执行来源。 */ async function (input, refs, admin) {
          assert.equal(this, sources.luvus)
          assert.equal(input, config)
          assert.equal(admin, actual)
          assert.deepEqual(refs, references.slice(0, 1))
          events.push('luvus:prepare')
          return luvus
        }
      },
      herdr: {
        gateway: /** Herdr同样由原owner持有并按kind选取精确引用。 */ async function (input, refs, admin) {
          assert.equal(this, sources.herdr)
          assert.equal(input, config)
          assert.equal(admin, actual)
          assert.deepEqual(refs, references.slice(1))
          events.push('herdr:prepare')
          return herdr
        }
      }
    }
    try {
      const mixed = await routeProductionSources(sources).gateway!(config, references, actual)
      assert.equal(mixed.kind, 'mixed')
      if (mixed.kind !== 'mixed' || herdr.kind !== 'provider' || mixed.catalog?.kind !== 'mixed') {
        assert.fail('mixed resources required')
      }
      const catalog = mixed.catalog
      assert.equal(mixed.providers, luvus.providers)
      assert.equal(mixed.hosted[0]!.providers, herdr.providers)
      assert.equal(mixed.providers[0]!.preflightRequest, luvus.providers[0]!.preflightRequest)
      assert.equal(catalog.select(herdr.providers[0]!.target), herdr.catalog)
      assert.equal(catalog.select(luvus.providers[0]!.target), undefined)
      const nativeCatalog = { resolve: /** 这里只记录绑定原目录端口，不返回假的native来源。 */ () => undefined }
      mixed.started!({ catalog: nativeCatalog } as unknown as RuntimeCliGateway)
      // 原生 Luvus 目录经统一 provider 端口交付；公共门禁只消费该投影。
      const native = catalog.select(luvus.providers[0]!.target)
      assert.equal(native?.kind, 'provider')
      assert.equal(native?.resolve(luvus.providers[0]!.target, { id: 'alice' }), undefined)
      const closing = mixed.release()
      assert.equal(mixed.release(), closing)
      assert.throws(/** 关闭开始后目录选择必须明确拒绝。 */ () => catalog.select(herdr.providers[0]!.target), {
        code: 'backend_unavailable'
      })
      await closing
      assert.deepEqual(events, ['luvus:prepare', 'herdr:prepare', 'herdr:release', 'luvus:release'])
    } finally {
      actual.close()
    }
  }
)

test(
  '第二owner启动失败逆序回收已交付资源，清理失败保留同一shutdown与原错误',
  /** 固定失败探针不创建子进程或会话。 */ async () => {
    const config = configTemplate('gateway')
    if (config.role !== 'gateway') {
      assert.fail('gateway required')
    }
    const actual = authority()
    const startup = new Error('component_startup_failure')
    const cleanup = new Error('component_cleanup_failure')
    let releases = 0
    const base = resource('luvus', [])
    try {
      for (const failCleanup of [false, true]) {
        await assert.rejects(
          routeProductionSources({
            luvus: {
              gateway: /** 首个资源已取得，但没有启动真实runtime。 */ async () => ({
                ...base,
                release: /** 保留原释放失败，不能标作成功。 */ async () => {
                  releases++
                  if (failCleanup) {
                    throw cleanup
                  }
                }
              })
            },
            herdr: {
              gateway: /** 第二工厂固定失败，不能重新调用或改用stub。 */ async () => {
                throw startup
              }
            }
          }).gateway!(config, references, actual),
          /** 只在清理失败时要求保留未确认owner的关闭入口。 */ (error: unknown) => {
            if (!failCleanup) {
              assert.equal(error, startup)
              return true
            }
            assert(error instanceof ProductionSourcesStartupError)
            assert.equal(error.startupError, startup)
            assert.equal(error.code, 'backend_unavailable')
            assert.equal(error.message, 'Rovloom command failed')
            const same = error.shutdown.release()
            assert.equal(error.shutdown.release(), same)
            void same.catch(/** 原共享失败已验证，消费本地观察者拒绝。 */ () => {})
            return true
          }
        )
      }
      assert.equal(releases, 2)
    } finally {
      actual.close()
    }
  }
)

test(
  '混合Connector仅对明确的无资源不可用声明保留健康owner，未知启动错误仍回滚',
  /** 工厂是拒绝执行的装配探针；实际认证与来源撤回另由 loopback 集成回归验证。 */ async () => {
    const config = configTemplate('connector')
    if (config.role !== 'connector') {
      assert.fail('connector required')
    }
    const herdr = resource('herdr', []).providers[0]!
    for (const known of [true, false]) {
      let releases = 0
      let sessions = 0
      const failure = known ? new ProviderUnavailableError(herdr) : new Error('component_unknown_startup')
      const routed = routeProductionSources({
        luvus: {
          connector: /** 原真实工厂接缝探针；此测试不会建立假native session。 */ async () => ({
            provider_snapshot: true,
            session: /** 未认证不得构造来源或执行后端。 */ () => {
              sessions++
              throw new Error('component_native_unavailable')
            },
            release: /** 只记录本次已取得原owner的释放。 */ async () => {
              releases++
            }
          })
        },
        herdr: {
          connector: /** 没有取得任何 child/owner/writer，固定不可用声明不冒充成功资源。 */ async () => {
            throw failure
          }
        }
      })
      if (known) {
        const mixed = await routed.connector!(config, references)
        assert.equal(mixed.kind, 'provider')
        assert.equal(releases, 0)
        await mixed.release()
      } else {
        await assert.rejects(
          routed.connector!(config, references),
          /** 原未知错误不能被改判为已安全隔离。 */ (error: unknown) => error === failure
        )
      }
      assert.equal(releases, 1)
      assert.equal(sessions, 0)
    }
  }
)

test(
  '未知kind、重复引用及缺工厂都在取得任何混合owner之前拒绝',
  /** 只使用会抛错误的factory探针。 */ async () => {
    const config = configTemplate('connector')
    if (config.role !== 'connector') {
      assert.fail('connector required')
    }
    let calls = 0
    const probe: ProductionCliSources = {
      connector: /** 被调用即说明预检越过边界，故意失败。 */ async () => {
        calls++
        throw new Error('unexpected_factory')
      }
    }
    const routed = routeProductionSources({ luvus: probe, herdr: probe })
    for (const refs of [
      [...references, { reference: 'unknown_ref', value: { kind: 'unknown' } }],
      [references[0]!, { ...references[1]!, reference: 'luvus_ref' }]
    ]) {
      await assert.rejects(routed.connector!(config, refs), { code: 'invalid_config' })
    }
    await assert.rejects(routeProductionSources({ luvus: probe }).connector!(config, references), {
      code: 'backend_unavailable'
    })
    assert.equal(calls, 0)
  }
)
