/** 两种 provider 共用的证据保留收窄；预算由各自工厂固定，公共 Gateway 不读取预算字段。 */
import type { ResponseEvidencePlan } from '../wire/evidence.js'
import { fail, LIMITS, uint } from '../wire/index.js'

export function responseRetention(maxBytes: number): (plan: ResponseEvidencePlan) => ResponseEvidencePlan {
  uint(maxBytes)
  if (!maxBytes || maxBytes > LIMITS.frame_bytes) {
    fail('transport_limit')
  }
  return (plan) =>
    plan.evidence.response_bytes <= maxBytes
      ? plan
      : {
          ...plan,
          content: {
            status: plan.content.status,
            expires_at: plan.content.expires_at,
            delivery: 'metadata_only'
          }
        }
}
