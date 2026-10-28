import type { CompilerWorkerPort } from '../../compiler-worker.js'
// 定义宿主与私有编译 Worker 的准确协议、固定生成选项和有界产物，不承载执行许可。
import type { Options } from 'ajv'
import type { CompileOptions, ContractIdentity, Limits } from './types.js'

export const ARTIFACT_VERSION = 1
export const GENERATOR_VERSION = 'luvus-standalone-1'
export const AJV_VERSION = '8.20.0'
export const CODE_LIMIT = 8 * 1024 * 1024
// 未知 schema 冷编译约 0.7 秒（本机实测），慢机器按数倍留余量。
export const COMPILE_TIMEOUT_MS = 10_000
export const AJV_OPTIONS: Options = Object.freeze({
  strict: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  inlineRefs: false,
  code: Object.freeze({ source: true, esm: false })
})

export type CompilerArtifact = {
  version: number
  generator: string
  ajv: string
  identity: ContractIdentity
  limits: Limits
  documents: string[]
  request_methods: string[]
  branches: Array<[string, string[]]>
  schemas: Array<[string, string]>
  code: string
  code_sha256: string
  options_sha256: string
}
export type CompileJob = {
  version: number
  job_id: string
  bytes: Uint8Array | string
  options: CompileOptions
}

export type CompilerPort = CompilerWorkerPort & {
  postMessage(message: CompileJob): void
}
