import type { CompilerWorkerPort } from '../compiler-worker.js'
/** Herdr 实际安装 schema 的私有编译协议、生成选项及预算，不携带原生执行许可。 */
import type { Options } from 'ajv'
import { HERDR_READONLY_REVIEW as review } from './review.js'

export const HERDR_COMPILER_VERSION = 1
export const HERDR_GENERATOR = 'herdr-standalone-1'
export const HERDR_AJV_VERSION = '8.20.0'
export const HERDR_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
export const HERDR_SCHEMA_ID = 'urn:rovloom:herdr:schema'
export const HERDR_INPUT_LIMIT = 512 * 1024
export const HERDR_CODE_LIMIT = 8 * 1024 * 1024
export const HERDR_COMPILE_TIMEOUT = 10_000
export const HERDR_WORKER_FAILURES: readonly string[] = Object.freeze([
  'schema_input_limit',
  'schema_digest_mismatch',
  'compiler_version_mismatch',
  'schema_identity_mismatch',
  'schema_root_unavailable',
  'generated_code_limit',
  'schema_compile_failed',
  'compiler_protocol_invalid'
])
export const HERDR_ROOTS = Object.freeze(['request', 'success_response', 'error_response'] as const)
export const HERDR_IDENTITY = Object.freeze({
  binary_sha256: review.binary_sha256,
  schema_sha256: review.schema_sha256,
  version: review.version,
  protocol: review.protocol,
  schema_version: 1,
  dialect: HERDR_DIALECT
})
export const HERDR_AJV_OPTIONS: Options = Object.freeze({
  strict: true,
  strictRequired: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  inlineRefs: false,
  code: Object.freeze({ source: true, esm: false })
})
// 数值格式与原生类型边界一致；超出 JavaScript 精确整数范围的 uint64/uint 保守拒绝。
export const HERDR_FORMAT_CODE = `({
  uint: {validate: v => Number.isSafeInteger(v) && v >= 0},
  uint64: {validate: v => Number.isSafeInteger(v) && v >= 0},
  uint32: {validate: v => Number.isSafeInteger(v) && v >= 0 && v <= 4294967295},
  uint16: {validate: v => Number.isSafeInteger(v) && v >= 0 && v <= 65535},
  int32: {validate: v => Number.isSafeInteger(v) && v >= -2147483648 && v <= 2147483647},
  float: {validate: Number.isFinite}
})`

export type HerdrCompilerArtifact = {
  version: number
  generator: string
  ajv: string
  identity: {
    schema_sha256: string
    protocol: number
    schema_version: number
    dialect: typeof HERDR_DIALECT
  }
  roots: string[]
  code: string
  code_sha256: string
  options_sha256: string
}
export type HerdrCompileJob = { version: number; job_id: string; bytes: Uint8Array | string }
export type HerdrCompileResult = { ok: true; value: HerdrCompilerArtifact } | { ok: false; reason: string }
export type HerdrCompilerPort = CompilerWorkerPort & {
  postMessage(message: HerdrCompileJob): void
}
