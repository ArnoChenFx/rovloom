// 校验 Wire 版本广告，协商已知能力交集及能力依赖。
import { fields, object, uint, fail, id } from './validation.js'
import type { Capability, Negotiated, VersionOffer } from './types.js'

export const WIRE_MAJOR = 2
export const WIRE_MINOR = 2
// 2.x 中的可选能力仍须双方明确广告；较高 minor 不能隐式启用它们。
const CAPABILITIES: Readonly<Record<Capability, number>> = Object.freeze({
  rpc: 0,
  provider_fence: 0,
  dispatch_refusal: 0,
  provider_snapshot: 0,
  terminal_execution_state: 0,
  late_evidence: 0,
  // 设备平台在 welcome 后单独上报；老 Gateway 协商不到它，握手行为不变。
  device_platform: 1,
  host_profile: 2
})

// 校验版本广告，要求能力列表无重复且必需能力均已广告。
export function validateOffer(value: unknown): asserts value is VersionOffer {
  const v = object(value)
  fields(v, ['major', 'minor', 'capabilities', 'required'])
  uint(v.major, true)
  uint(v.minor)
  for (const list of [v.capabilities, v.required]) {
    if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length) {
      fail('invalid_capabilities')
    }
    list.forEach(id)
  }
  if (
    (v.required as string[]).some(
      /* 查找未包含在广告能力列表中的必需能力。 */ (c) => !(v.capabilities as string[]).includes(c)
    )
  ) {
    fail('invalid_capabilities')
  }
}

// 选取双方支持的版本与已知能力交集，拒绝无法满足的必需能力。
export function negotiate(local: VersionOffer, remote: VersionOffer): Negotiated {
  validateOffer(local)
  validateOffer(remote)
  if (local.major !== WIRE_MAJOR || remote.major !== local.major) {
    fail('protocol_major_unsupported')
  }
  // 只启用本实现认识且双方都广告的能力；未知可选项不进入协商结果。
  const minor = Math.min(local.minor, remote.minor, WIRE_MINOR)
  const capabilities = (Object.keys(CAPABILITIES) as Capability[])
    .filter(
      /* 保留当前次版本支持且双方均已广告的能力。 */ (c) =>
        CAPABILITIES[c] <= minor && local.capabilities.includes(c) && remote.capabilities.includes(c)
    )
    .sort()
  if (
    [...local.required, ...remote.required].some(
      /* 检测任一必需能力是否未进入协商交集。 */ (c) => !capabilities.includes(c as Capability)
    )
  ) {
    fail('required_capability_unsupported')
  }
  const result = { major: WIRE_MAJOR, minor, capabilities }
  validateNegotiated(result)
  return result
}

// 校验选定版本、已知能力和依赖；提供广告时再核对其允许范围。
export function validateNegotiated(value: unknown, offer?: VersionOffer): asserts value is Negotiated {
  const v = object(value)
  fields(v, ['major', 'minor', 'capabilities'])
  uint(v.major, true)
  uint(v.minor)
  if (v.major !== WIRE_MAJOR || (v.minor as number) > WIRE_MINOR) {
    fail('protocol_version_unsupported')
  }
  if (
    !Array.isArray(v.capabilities) ||
    v.capabilities.length > 64 ||
    new Set(v.capabilities).size !== v.capabilities.length ||
    v.capabilities.some(/* 检测能力列表中不为字符串的元素。 */ (c) => typeof c !== 'string')
  ) {
    fail('invalid_capabilities')
  }
  if (
    v.capabilities.some(
      /* 检测未知能力或当前次版本尚不支持的能力。 */ (c) =>
        !Object.hasOwn(CAPABILITIES, c) || CAPABILITIES[c as Capability] > (v.minor as number)
    )
  ) {
    fail('unsupported_capability')
  }
  if (offer) {
    validateOffer(offer)
    if (
      offer.major !== v.major ||
      (v.minor as number) > offer.minor ||
      v.capabilities.some(/* 检测选定结果中未由原广告提供的能力。 */ (c) => !offer.capabilities.includes(c)) ||
      offer.required.some(
        /* 检测原广告中的必需能力是否被协商结果遗漏。 */ (c) => !(v.capabilities as string[]).includes(c)
      )
    ) {
      fail('invalid_negotiation')
    }
  }
  if (v.capabilities.includes('provider_snapshot') && !v.capabilities.includes('rpc')) {
    fail('invalid_capabilities')
  }
  if (v.capabilities.includes('terminal_execution_state') && !v.capabilities.includes('rpc')) {
    fail('invalid_capabilities')
  }
  if (v.capabilities.includes('provider_fence') && !v.capabilities.includes('rpc')) {
    fail('invalid_capabilities')
  }
  if (v.capabilities.includes('dispatch_refusal') && !v.capabilities.includes('rpc')) {
    fail('invalid_capabilities')
  }
}
