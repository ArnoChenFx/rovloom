import { CompilerWorkerOwner, compilerDeadline, settleCompilerTask } from '../compiler-worker.js'
/** 管理 Herdr 有界异步编译任务，只接纳固定私有 Worker 的同任务 standalone 产物。 */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import ucs2length from 'ajv/dist/runtime/ucs2length.js'
import deepEqual from 'ajv/dist/runtime/equal.js'
import ajvPackage from 'ajv/package.json' with { type: 'json' }
import type { HerdrSchemas } from './readonly.js'
import {
  HERDR_AJV_OPTIONS,
  HERDR_AJV_VERSION,
  HERDR_CODE_LIMIT,
  HERDR_COMPILE_TIMEOUT,
  HERDR_COMPILER_VERSION,
  HERDR_FORMAT_CODE,
  HERDR_GENERATOR,
  HERDR_DIALECT,
  HERDR_INPUT_LIMIT,
  HERDR_ROOTS,
  HERDR_WORKER_FAILURES
} from './compiler-protocol.js'
import type { HerdrCompilerArtifact, HerdrCompilerPort } from './compiler-protocol.js'

const compiledSchemas = new WeakSet<HerdrSchemas>()
type Pending = {
  id: string
  until: number
  inputSha256: string
  inputIdentity: HerdrCompilerArtifact['identity']
  resolve: (value: HerdrSchemas) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  cancel: () => void
}

/** 故障仅保留固定原因，不能包含 schema、生成源码、路径或底层异常。 */
function fault(reason: string): Error {
  return new Error(`herdr_schema_${reason}`)
}

/** 计算已计量的原始输入或受控生成物摘要。 */
function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 私有协议严格要求普通对象和精确字段，不接受多余版本兼容字段。 */
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    names.some(/** 缺失字段不能由默认值补齐。 */ (name) => !Object.hasOwn(value, name))
  ) {
    throw fault('compiler_artifact_invalid')
  }
  return value as Record<string, unknown>
}

/** 生成物只能访问锁定 Ajv 的两个纯 helper，不能通过 require 读取文件或加载代码。 */
function runtimeHelper(name: string): Readonly<{ default: unknown }> {
  if (!['ajv/dist/runtime/ucs2length', 'ajv/dist/runtime/equal'].includes(name)) {
    throw fault('compiler_helper_forbidden')
  }
  const imported: unknown = name === 'ajv/dist/runtime/ucs2length' ? ucs2length : deepEqual
  const helper = typeof imported === 'function' ? imported : (imported as { default?: unknown })?.default
  if (typeof helper !== 'function') {
    throw fault('compiler_helper_forbidden')
  }
  return Object.freeze({ default: helper })
}

/** 身份字段逐项精确核对，不依赖序列化顺序。 */
function reviewedIdentity(value: unknown): boolean {
  const identity = fields(value, ['schema_sha256', 'protocol', 'schema_version', 'dialect'])
  return (
    typeof identity.schema_sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(identity.schema_sha256) &&
    Number.isSafeInteger(identity.protocol) &&
    (identity.protocol as number) >= 0 &&
    Number.isSafeInteger(identity.schema_version) &&
    (identity.schema_version as number) >= 1 &&
    identity.dialect === HERDR_DIALECT
  )
}

/** 只有当前 Worker 私有回复路径可调用安装；不暴露 caller 产物加载入口。 */
function install(value: unknown, pending: Pending): HerdrSchemas {
  const artifact = fields(value, [
    'version',
    'generator',
    'ajv',
    'identity',
    'roots',
    'code',
    'code_sha256',
    'options_sha256'
  ]) as unknown as HerdrCompilerArtifact
  if (
    typeof artifact.code !== 'string' ||
    artifact.code.length > HERDR_CODE_LIMIT ||
    Buffer.byteLength(artifact.code) > HERDR_CODE_LIMIT
  ) {
    throw fault('generated_code_limit')
  }
  if (
    artifact.version !== HERDR_COMPILER_VERSION ||
    artifact.generator !== HERDR_GENERATOR ||
    artifact.ajv !== HERDR_AJV_VERSION ||
    ajvPackage.version !== HERDR_AJV_VERSION ||
    !reviewedIdentity(artifact.identity) ||
    artifact.identity.schema_sha256 !== pending.inputSha256 ||
    !isDeepStrictEqual(artifact.identity, pending.inputIdentity) ||
    artifact.options_sha256 !== hash(JSON.stringify([HERDR_AJV_OPTIONS, HERDR_FORMAT_CODE])) ||
    artifact.code_sha256 !== hash(artifact.code) ||
    !Array.isArray(artifact.roots) ||
    artifact.roots.length !== HERDR_ROOTS.length ||
    artifact.roots.some(/** 所有原生完整根须按固定目录导出。 */ (root, i) => root !== HERDR_ROOTS[i])
  ) {
    throw fault('compiler_artifact_invalid')
  }
  const exports: Record<string, unknown> = Object.create(null)
  const module = { exports }
  // 不在主线程启动 Ajv；仅初始化已通过精确任务、固定身份及摘要核对的受控代码。
  new Function('module', 'exports', 'require', artifact.code)(module, exports, runtimeHelper)
  if (module.exports !== exports || Object.keys(exports).length !== HERDR_ROOTS.length) {
    throw fault('compiler_artifact_invalid')
  }
  const roots = HERDR_ROOTS.map(
    /** 固定安全导出名，避免 schema 路径进入 JS 标识符。 */ (_root, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(exports, `v${index}`)
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw fault('compiler_artifact_invalid')
      }
      return descriptor.value as (value: Parameters<HerdrSchemas['request']>[0]) => boolean
    }
  )
  const [request, success, error] = roots
  if (!request || !success || !error || performance.now() >= pending.until) {
    throw fault('compiler_timeout')
  }
  const schemas: HerdrSchemas = Object.freeze({
    schema_sha256: pending.inputSha256,
    protocol: artifact.identity.protocol,
    dialect: HERDR_DIALECT,
    request: /** 完整原生 request 根同步返回 boolean，不修改输入。 */ (value: Parameters<HerdrSchemas['request']>[0]) =>
      request(value) === true,
    response: /** success/error 分别使用原生完整根，不添加 UHP envelope。 */ (
      value: Parameters<HerdrSchemas['response']>[0]
    ) => success(value) === true || error(value) === true
  })
  compiledSchemas.add(schemas)
  return schemas
}

/** 仅本进程安装的对象有来源品牌；复制或同形手写函数不能恢复品牌。 */
export function isCompiledHerdrSchemas(value: HerdrSchemas): boolean {
  return compiledSchemas.has(value)
}

/** 一个服务最多单在途任务，无排队；取消、超时或协议故障后永久退役，不补建 Worker。 */
export class HerdrSchemaCompiler {
  #host: CompilerWorkerOwner<HerdrCompilerPort>
  #pending?: Pending
  #closed = false

  /** 固定定位模块注入生产工厂；内部故障测试可单独控制自有端口。 */
  constructor(createWorker: () => HerdrCompilerPort) {
    this.#host = new CompilerWorkerOwner(
      createWorker,
      (worker, value) => this.#receive(worker, value),
      (reason) => this.#retire(reason)
    )
  }

  /** 整体期限覆盖输入复制、Worker 启动、编译、回复及宿主代码初始化。 */
  compile(bytes: Uint8Array | string, signal?: AbortSignal): Promise<HerdrSchemas> {
    const until = performance.now() + HERDR_COMPILE_TIMEOUT
    if (this.#closed) {
      return Promise.reject(fault('compiler_unavailable'))
    }
    if (this.#pending) {
      return Promise.reject(fault('compiler_busy'))
    }
    if (signal?.aborted) {
      return Promise.reject(fault('compiler_cancelled'))
    }
    if (
      !(typeof bytes === 'string' || bytes instanceof Uint8Array) ||
      (typeof bytes === 'string'
        ? bytes.length > HERDR_INPUT_LIMIT || Buffer.byteLength(bytes) > HERDR_INPUT_LIMIT
        : bytes.byteLength > HERDR_INPUT_LIMIT)
    ) {
      return Promise.reject(fault('schema_input_limit'))
    }
    const input = typeof bytes === 'string' ? bytes : new Uint8Array(bytes)
    const inputSha256 = hash(input)
    let inputIdentity: HerdrCompilerArtifact['identity']
    try {
      const document = JSON.parse(
        typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
      )
      inputIdentity = {
        schema_sha256: inputSha256,
        protocol: document.protocol,
        schema_version: document.schema_version,
        dialect: document.$schema
      }
    } catch {
      return Promise.reject(fault('schema_compile_failed'))
    }
    return new Promise(
      /** 安装前没有可观察 schema 对象，每个任务最多结算一次。 */ (resolve, reject) => {
        const lease = compilerDeadline(until, signal, (reason) => this.#retire(reason))
        this.#pending = { id: randomUUID(), until, inputSha256, inputIdentity, resolve, reject, ...lease }
        try {
          const worker = this.#host.open()
          if (signal?.aborted) {
            lease.cancel()
            return
          }
          worker.postMessage({ version: HERDR_COMPILER_VERSION, job_id: this.#pending.id, bytes: input })
        } catch {
          this.#retire('compiler_start_failed')
        }
      }
    )
  }

  /** 版本、任务与期限通过后才核对产物，并同步登记本进程品牌。 */
  #receive(worker: HerdrCompilerPort, value: unknown): void {
    const pending = this.#pending
    if (this.#closed || this.#host.current !== worker || !pending) {
      return
    }
    try {
      const reply = fields(value, ['version', 'job_id', 'result'])
      if (reply.version !== HERDR_COMPILER_VERSION || reply.job_id !== pending.id) {
        this.#retire('compiler_protocol_invalid')
        return
      }
      if (pending.signal?.aborted || performance.now() >= pending.until) {
        this.#retire(pending.signal?.aborted ? 'compiler_cancelled' : 'compiler_timeout')
        return
      }
      const result = fields(
        reply.result,
        (reply.result as { ok?: boolean })?.ok === true ? ['ok', 'value'] : ['ok', 'reason']
      )
      if (result.ok === false && typeof result.reason === 'string' && HERDR_WORKER_FAILURES.includes(result.reason)) {
        // 原生 schema 不可用只拒绝本任务；基础设施故障仍永久退役，绝不补建 Worker。
        if (
          [
            'schema_input_limit',
            'schema_digest_mismatch',
            'schema_identity_mismatch',
            'schema_root_unavailable',
            'schema_compile_failed',
            'generated_code_limit'
          ].includes(result.reason)
        ) {
          this.#settle(undefined, fault(result.reason))
        } else {
          this.#retire(result.reason)
        }
        return
      }
      if (result.ok !== true) {
        this.#retire('compiler_protocol_invalid')
        return
      }
      const schemas = install(result.value, pending)
      if (pending.signal?.aborted || performance.now() >= pending.until) {
        compiledSchemas.delete(schemas)
        this.#retire(pending.signal?.aborted ? 'compiler_cancelled' : 'compiler_timeout')
        return
      }
      this.#settle(schemas)
    } catch (error) {
      const reason =
        error instanceof Error && /^herdr_schema_[a-z_]{1,64}$/.test(error.message)
          ? error.message.slice('herdr_schema_'.length)
          : 'compiler_artifact_invalid'
      this.#retire(reason)
    }
  }

  /** 先清理定时器和监听；空闲编译 Worker 不维持宿主进程存活。 */
  #settle(schemas?: HerdrSchemas, error?: Error): void {
    const pending = this.#pending
    if (!pending) {
      return
    }
    this.#pending = undefined
    settleCompilerTask(pending, this.#host.current)
    if (schemas && !error) {
      pending.resolve(schemas)
    } else {
      pending.reject(error ?? fault('compiler_artifact_invalid'))
    }
  }

  /** 撤销服务代次并请求终止线程；不声称硬实时退出或硬 heap 隔离。 */
  #retire(reason: string): void {
    this.#closed = true
    this.#host.close()
    this.#settle(undefined, fault(reason))
  }

  /** 宿主正常退出时关闭自有编译资源；已接纳 schema 根仍可同步使用。 */
  close(): void {
    this.#retire('compiler_closed')
  }
}
