/** 从安装契约和受信任在线能力构造有期限的方法目录，约束来源绑定与分页游标。 */
import { createNativeValidator } from '../../native-contract/index.js'
import type { CompiledContract, TrustedNativeContext } from '../../native-contract/index.js'
import { boundedJson, hash } from '../../wire/index.js'
import { LuvusAdapterError } from './types.js'
import { describeLuvusSchema } from '../../native-contract/description.js'

// 安装 schema 与在线能力是独立输入；不把 CLI session list 当成 capabilities。
// 宿主负责经认证获得 capabilities、发布 contract registry，并维护当前完整 binding。
/** 将安装契约与独立认证的在线能力组合为有期限的目录；调用方 ACL 过滤仍由宿主负责。 */
export function createLuvusCatalog(
  compiled: CompiledContract,
  capabilities: unknown,
  source: TrustedNativeContext,
  freshness: {
    /* 提供用于目录有效期检查的非负单调宿主时间。 */ now(): number
    /* 提供当前完整来源绑定，用于发现 generation、策略或安装身份变化。 */ current(): TrustedNativeContext
    expires_at: number
  }
) {
  const validator = createNativeValidator(compiled)
  const bound = validator.bindCapabilities(capabilities, source)
  if (!bound.ok) {
    throw new LuvusAdapterError(bound.error.code)
  }
  const view = bound.value
  const stamp = boundedJson(source)
  const expires = freshness.expires_at
  let lastNow = -1
  if (!Number.isSafeInteger(expires) || expires <= 0) {
    throw new LuvusAdapterError('invalid_catalog_expiry')
  }
  /** 在每次目录读取前核对时钟、有效期和完整来源绑定；失效后拒绝返回内容。 */
  function fresh() {
    const now = freshness.now()
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now < lastNow ||
      now >= expires ||
      boundedJson(freshness.current()) !== stamp
    ) {
      throw new LuvusAdapterError('capability_stale')
    }
    lastNow = now
  }
  return Object.freeze({
    /** 按方法名查询并有界分页，游标绑定能力来源、查询和有效期。 */
    list(options: { query?: string; limit?: number; cursor?: string } = {}) {
      fresh()
      const query = options.query ?? ''
      const limit = options.limit ?? 25
      if (query.length > 128 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new LuvusAdapterError('invalid_catalog_page')
      }
      const scope = hash(boundedJson([view.binding, query, expires]))
      const offset = options.cursor === undefined ? 0 : Number(options.cursor.split(':')[1])
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (options.cursor !== undefined && options.cursor !== scope + ':' + offset)
      ) {
        throw new LuvusAdapterError('invalid_catalog_cursor')
      }
      const methods = view.methods.filter(
        /* 按大小写无关的子串规则筛选当前能力视图中的方法名。 */ (method) =>
          method.method.toLowerCase().includes(query.toLowerCase())
      )
      if (offset > methods.length) {
        throw new LuvusAdapterError('invalid_catalog_cursor')
      }
      const page = methods.slice(offset, offset + limit)
      return Object.freeze({
        methods: Object.freeze(page),
        next_cursor: offset + limit < methods.length ? scope + ':' + (offset + limit) : null
      })
    },
    /** 在新鲜度检查通过后返回指定方法的原生描述，缺失或不支持时保留 validator 错误码。 */
    describe(method: string) {
      fresh()
      const result = validator.describe(view, method)
      if (!result.ok) {
        throw new LuvusAdapterError(result.error.code)
      }
      let details: ReturnType<typeof describeLuvusSchema>
      try {
        details = describeLuvusSchema(compiled, result.value)
      } catch {
        throw new LuvusAdapterError('native_schema_description_unavailable')
      }
      fresh()
      return { ...result.value, ...details }
    }
  })
}
