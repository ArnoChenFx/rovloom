/** 只用于旧注册表/配置输入回归；生产调用链不再持有这些策略类型。 */
import type { V2Target } from '../src/wire/types.js'
export type ProviderAction = 'dispatch' | 'read' | 'cancel'
export type ProviderGrant = { target: V2Target; actions: ProviderAction[]; methods?: string[] }
export type ProviderPolicy = { revision: string; grants: ProviderGrant[] }
export type ProviderPolicies = { caller: ProviderPolicy; local: ProviderPolicy }
