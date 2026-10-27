// 核对可信 provider 与契约来源，并执行完整目标上的双端权限检查。
import type {
  AttemptBinding,
  AuthenticatedContext,
  ContractSource,
  NativePayloadValidator,
  ProviderAction,
  ProviderBinding,
  ProviderPolicies,
  V2Target
} from './types.js'
import { boundedJson, fail, fields, hash, id, object, oneOf, sha, text, uint } from './validation.js'
import { isReviewedHerdrSource } from '../connector/herdr/review.js'

// 按 host 或 session 形态严格校验完整 provider 目标。
export function validateTarget(value: unknown): asserts value is V2Target {
  const t = object(value)
  oneOf(t.profile, ['host', 'session'])
  fields(
    t,
    t.profile === 'host'
      ? ['machine_id', 'provider_id', 'profile']
      : ['machine_id', 'provider_id', 'profile', 'session']
  )
  id(t.machine_id)
  id(t.provider_id)
  if (t.profile === 'session') {
    text(t.session, 256)
  }
}

// 严格校验 provider 实例的类型、配置引用、绑定版本和启用状态。
export function validateProvider(value: unknown): asserts value is ProviderBinding {
  const b = object(value)
  fields(b, ['machine_id', 'provider_id', 'kind', 'config_ref', 'binding_revision', 'enabled'])
  id(b.machine_id)
  id(b.provider_id)
  text(b.config_ref, 256)
  uint(b.binding_revision, true)
  oneOf(b.kind, ['luvus', 'herdr'])
  if (typeof b.enabled !== 'boolean') {
    fail('invalid_provider_binding')
  }
}

// 校验契约来源字段及 provider、协议族与提取命令的一致性。
export function validateContractSource(value: unknown): asserts value is ContractSource {
  const c = object(value)
  fields(c, [
    'provider_kind',
    'protocol_family',
    'binary_version',
    'binary_sha256',
    'schema_sha256',
    'schema_origin',
    'schema_command',
    'server_version',
    'native_protocol_version',
    'runtime_generation',
    'adapter_revision',
    'classification_revision',
    'support_basis'
  ])
  oneOf(c.provider_kind, ['luvus', 'herdr'])
  oneOf(c.protocol_family, ['uhp', 'herdr-json'])
  oneOf(c.schema_origin, ['installed_cli'])
  oneOf(c.schema_command, ['luvus uhp schema', 'herdr api schema --json'])
  oneOf(c.support_basis, ['live_catalog', 'schema_and_version'])
  text(c.binary_version, 128)
  sha(c.binary_sha256)
  sha(c.schema_sha256)
  text(c.adapter_revision, 256)
  for (const k of ['server_version', 'native_protocol_version', 'runtime_generation', 'classification_revision']) {
    if (c[k] !== null) {
      text(c[k], 256)
    }
  }
  if (
    (c.provider_kind === 'luvus' && (c.protocol_family !== 'uhp' || c.schema_command !== 'luvus uhp schema')) ||
    (c.provider_kind === 'herdr' &&
      (c.protocol_family !== 'herdr-json' || c.schema_command !== 'herdr api schema --json'))
  ) {
    fail('contract_provider_mismatch')
  }
}

// 验证来源后对规范 JSON 求摘要，生成不可变契约引用。
export function contractRef(source: ContractSource): string {
  validateContractSource(source)
  return hash(boundedJson(source))
}

// 从可信注册表解析启用的 provider，并核对绑定版本、契约和实际支持状态。
export function providerFor(binding: AttemptBinding, ctx: AuthenticatedContext): ProviderBinding {
  // 消息中的 kind/revision 只参与核对；实例及契约必须从受信 registry 独立解析。
  const b = ctx.resolveProvider?.(binding.target)
  if (!b) {
    fail('provider_binding_unavailable')
  }
  validateProvider(b)
  if (b.machine_id !== binding.machine_id || b.provider_id !== binding.target.provider_id) {
    fail('provider_binding_mismatch')
  }
  if (!b.enabled) {
    fail('provider_disabled')
  }
  if (b.kind !== binding.provider_kind || b.binding_revision !== binding.binding_revision) {
    fail('provider_binding_mismatch')
  }
  if (b.kind === 'herdr' && binding.target.profile === 'host') {
    fail('unsupported_profile')
  }
  const c = ctx.resolveContract?.(binding.contract_ref)
  if (!c) {
    fail('contract_unavailable')
  }
  fields(object(c), ['source', 'support_status'])
  validateContractSource(c.source)
  oneOf(c.support_status, ['candidate', 'validated'])
  if (contractRef(c.source) !== binding.contract_ref || c.source.provider_kind !== b.kind) {
    fail('contract_binding_mismatch')
  }
  // candidate 永不派发；Herdr 只接纳固定评审来源，方法/参数和真实来源仍由其 adapter 检查。
  if (c.support_status !== 'validated' || (b.kind === 'herdr' && !isReviewedHerdrSource(c.source))) {
    fail('provider_support_candidate')
  }
  if (c.source.classification_revision === null || (b.kind === 'luvus' && c.source.support_basis !== 'live_catalog')) {
    fail('contract_unavailable')
  }
  return b
}

// 按可信 provider 类型取得已安装的原生载荷校验器。
export function validatorFor(binding: AttemptBinding, ctx: AuthenticatedContext): NativePayloadValidator {
  const provider = providerFor(binding, ctx)
  const validator = ctx.validators?.[provider.kind]
  if (!validator) {
    fail('native_validator_unavailable')
  }
  return validator
}

// 校验双端策略及每条完整目标授权，限制条目规模并拒绝重复权限。
export function validatePolicies(policies: ProviderPolicies): void {
  const pair = object(policies)
  fields(pair, ['caller', 'local'])
  for (const side of [policies.caller, policies.local]) {
    fields(object(side), ['revision', 'grants'])
    id(side.revision)
    if (!Array.isArray(side.grants) || side.grants.length > 4096) {
      fail('invalid_provider_policy')
    }
    for (const grant of side.grants) {
      fields(object(grant), ['target', 'methods', 'actions'])
      validateTarget(grant.target)
      if (
        !Array.isArray(grant.methods) ||
        grant.methods.length > 256 ||
        !Array.isArray(grant.actions) ||
        grant.actions.length > 4 ||
        new Set(grant.methods).size !== grant.methods.length ||
        new Set(grant.actions).size !== grant.actions.length
      ) {
        fail('invalid_provider_policy')
      }
      grant.methods.forEach(/* 校验授权条目中的方法名称及字节长度。 */ (m) => text(m, 256))
      grant.actions.forEach(
        /* 限制授权动作仅使用协议允许的三种操作。 */ (a) => oneOf(a, ['dispatch', 'read', 'cancel'])
      )
    }
  }
}

// 要求调用方和本地策略各有一条完整匹配的授权；缺策略时返回 false。
export function providerScopeAllowed(
  binding: Pick<AttemptBinding, 'target'>,
  method: string,
  action: ProviderAction,
  policies?: ProviderPolicies
): boolean {
  if (!policies) {
    return false
  }
  validatePolicies(policies)
  const target = boundedJson(binding.target)
  // 每一端都须有一条完整匹配的 grant；不能拼接不同目标或不同 grant 的权限。
  return [policies.caller, policies.local].every(
    /* 检查这一端是否存在完整覆盖目标、方法和动作的授权。 */ (side) =>
      side.grants.some(
        /* 匹配单条授权的完整目标、方法和动作，避免跨条目拼接权限。 */ (g) =>
          boundedJson(g.target) === target &&
          (g.methods.includes('*') || g.methods.includes(method)) &&
          g.actions.includes(action)
      )
  )
}

// 校验 provider 当前可用性，并拒绝双端策略未共同允许的操作。
export function assertProviderAccess(
  binding: AttemptBinding,
  method: string,
  action: ProviderAction,
  ctx: AuthenticatedContext
): void {
  providerFor(binding, ctx)
  if (!providerScopeAllowed(binding, method, action, ctx.policies)) {
    fail('provider_scope_forbidden')
  }
}
