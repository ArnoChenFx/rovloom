// 管理有界 Bun 编译任务并加载本进程私有任务的 standalone 产物；不接收 caller 代码或路径。
import { randomUUID } from 'node:crypto'
import type { ValidateFunction } from 'ajv'
import ucs2length from 'ajv/dist/runtime/ucs2length.js'
import deepEqual from 'ajv/dist/runtime/equal.js'
import ajvPackage from 'ajv/package.json' with { type: 'json' }
import { attempt, equal, fail, hash, limits, object, snapshot } from './json.js'
import { contracts, UHP } from './internal.js'
import {
  AJV_OPTIONS,
  AJV_VERSION,
  ARTIFACT_VERSION,
  CODE_LIMIT,
  COMPILE_TIMEOUT_MS,
  GENERATOR_VERSION
} from './compiler-protocol.js'
import type { CompilerArtifact, CompilerPort } from './compiler-protocol.js'
import type { Check, CompiledContract, CompileOptions, ContractIdentity, Limits } from './types.js'

type Expected = {
  identity: ContractIdentity
  budget: Limits
  until: number
  inputSha256: string
  input: Uint8Array | string
}
type Pending = Expected & {
  id: string
  resolve: (result: Check<CompiledContract>) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  cancel: () => void
}

// 所有异步故障只返回固定原因，不包含 schema、代码、文件名或底层异常原文。
function failure(reason: string): Check<never> {
  return { ok: false, error: { origin: 'contract', code: 'schema_unavailable', stage: 'compile', reason } }
}

// 私有 IPC 和生成物使用精确字段集合，未知版本不进入兼容路径。
function fields(value: unknown, names: string[]): Record<string, unknown> {
  const obj = object(value, 'schema_unavailable')
  if (
    Object.keys(obj).length !== names.length ||
    names.some(/* 拒绝缺失字段。 */ (name) => !Object.hasOwn(obj, name))
  ) {
    fail('schema_unavailable', 'compile', 'compiler_artifact_invalid')
  }
  return obj
}

// 只允许已锁定 Ajv 的两个纯运行时 helper，不向生成物提供任意 require。
function runtimeHelper(name: string): Readonly<{ default: unknown }> {
  if (!['ajv/dist/runtime/ucs2length', 'ajv/dist/runtime/equal'].includes(name)) {
    fail('schema_unavailable', 'compile', 'compiler_helper_forbidden')
  }
  // Bun 源码加载与打包 CJS 的默认导出包装不同，仅解包这两个固定模块。
  const imported: unknown = name === 'ajv/dist/runtime/ucs2length' ? ucs2length : deepEqual
  const helper = typeof imported === 'function' ? imported : object(imported).default
  if (typeof helper !== 'function') {
    fail('schema_unavailable', 'compile', 'compiler_helper_forbidden')
  }
  return Object.freeze({ default: helper })
}

// 在准确内部任务通过版本、来源和摘要核对后解析生成代码；此函数不作为公共加载入口导出。
function install(value: unknown, expected: Expected): CompiledContract {
  const artifact = fields(value, [
    'version',
    'generator',
    'ajv',
    'identity',
    'limits',
    'documents',
    'request_methods',
    'branches',
    'schemas',
    'code',
    'code_sha256',
    'options_sha256'
  ]) as unknown as CompilerArtifact
  if (
    typeof artifact.code !== 'string' ||
    artifact.code.length > CODE_LIMIT ||
    Buffer.byteLength(artifact.code) > CODE_LIMIT
  ) {
    fail('schema_unavailable', 'compile', 'generated_code_limit')
  }
  const { code, ...rawMetadata } = artifact
  const schemaSource =
    typeof expected.input === 'string' ? expected.input : Buffer.from(expected.input).toString('utf8')
  const metadata = snapshot(rawMetadata) as unknown as Omit<CompilerArtifact, 'code'>
  if (
    metadata.version !== ARTIFACT_VERSION ||
    metadata.generator !== GENERATOR_VERSION ||
    metadata.ajv !== AJV_VERSION ||
    ajvPackage.version !== AJV_VERSION ||
    metadata.options_sha256 !== hash(JSON.stringify(AJV_OPTIONS)) ||
    metadata.code_sha256 !== hash(code) ||
    metadata.identity?.schema_sha256 !== expected.inputSha256 ||
    hash(schemaSource) !== expected.inputSha256 ||
    !equal(metadata.identity, expected.identity) ||
    !equal(metadata.limits, expected.budget)
  ) {
    fail('schema_unavailable', 'compile', 'compiler_artifact_invalid')
  }
  if (
    !Array.isArray(metadata.documents) ||
    !metadata.documents.length ||
    metadata.documents.length > expected.budget.documents ||
    metadata.documents.some(/* 文档必须来自原 UHP 索引。 */ (uri) => typeof uri !== 'string' || !uri.startsWith(UHP)) ||
    new Set(metadata.documents).size !== metadata.documents.length ||
    !Array.isArray(metadata.request_methods) ||
    metadata.request_methods.some(/* 方法清单只含字符串。 */ (name) => typeof name !== 'string') ||
    new Set(metadata.request_methods).size !== metadata.request_methods.length ||
    !Array.isArray(metadata.branches) ||
    metadata.branches.length !== metadata.request_methods.length ||
    metadata.branches.some(
      /* 分支必须与原方法顺序及路径清单对应。 */ (entry, i) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        entry[0] !== metadata.request_methods[i] ||
        !Array.isArray(entry[1]) ||
        entry[1].some(/* 分支路径为纯字符串。 */ (path) => typeof path !== 'string')
    ) ||
    !Array.isArray(metadata.schemas) ||
    metadata.schemas.length < metadata.documents.length ||
    metadata.schemas.some(
      /* 导出使用固定安全名字，不把 schema URI 当 JavaScript 标识符。 */ (entry, i) =>
        !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[1] !== 'v' + i
    ) ||
    new Set(metadata.schemas.map(/* 校验入口不能重复。 */ ([key]) => key)).size !== metadata.schemas.length ||
    metadata.documents.some(
      /* 完整根文档必须各有导出，不能只加载裁剪片段。 */ (uri) =>
        !metadata.schemas.some(/* 匹配该文档的唯一导出。 */ ([key]) => key === uri)
    )
  ) {
    fail('schema_unavailable', 'compile', 'compiler_artifact_invalid')
  }
  const exports: Record<string, unknown> = Object.create(null)
  const module = { exports }
  // 只解析受控任务生成的 CJS；不初始化 Ajv、不做主线程 schema 重编译，也不建立 ESM 全局模块缓存。
  const initialize = new Function('module', 'exports', 'require', code)
  initialize(module, exports, runtimeHelper)
  if (module.exports !== exports || Object.keys(exports).length !== metadata.schemas.length) {
    fail('schema_unavailable', 'compile', 'compiler_artifact_invalid')
  }
  const validators = new Map<string, ValidateFunction>()
  for (const [key, name] of metadata.schemas) {
    const descriptor = Object.getOwnPropertyDescriptor(exports, name)
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      fail('schema_unavailable', 'compile', 'compiler_artifact_invalid')
    }
    validators.set(key, descriptor.value as ValidateFunction)
  }
  if (performance.now() >= expected.until) {
    fail('schema_unavailable', 'compile', 'compiler_timeout')
  }
  const compiled: CompiledContract = Object.freeze({
    identity: Object.freeze({ ...metadata.identity }),
    documents: Object.freeze([...metadata.documents])
  })
  contracts.set(compiled, {
    limits: metadata.limits,
    validators,
    schemaSource,
    requestMethods: Object.freeze([...metadata.request_methods]),
    branches: new Map(
      metadata.branches.map(/* 冻结宿主的方法分支元数据。 */ ([name, paths]) => [name, Object.freeze([...paths])])
    )
  })
  return compiled
}

// 一个宿主服务最多一个在途任务；超时/取消/Worker 故障后永久退役该服务，不自动补建或恢复旧代次。
export class SchemaCompiler {
  #worker: CompilerPort | undefined
  #pending: Pending | undefined
  #closed = false

  // 由受信模块固定 Worker 工厂；不在公共编译 API 接收代码或文件路径。
  constructor(
    private readonly createWorker: () => CompilerPort,
    private readonly timeoutMs = COMPILE_TIMEOUT_MS
  ) {}

  // 输入先复制并计量，计时覆盖 Worker 启动、生成、消息与主线程代码初始化；不承诺硬实时物理退出。
  compile(bytes: Uint8Array | string, options: CompileOptions, signal?: AbortSignal): Promise<Check<CompiledContract>> {
    const until = performance.now() + this.timeoutMs
    if (this.#closed) {
      return Promise.resolve(failure('compiler_unavailable'))
    }
    if (this.#pending) {
      return Promise.resolve(failure('compiler_busy'))
    }
    if (signal?.aborted) {
      return Promise.resolve(failure('compiler_cancelled'))
    }
    const prepared = attempt(
      'compile',
      /* 冻结设置并复制原字节；不解析 schema 或加载 caller 产物。 */ () => {
        const settings = object(snapshot(options)) as unknown as CompileOptions
        const budget = limits(settings.limits)
        const identity = settings.identity
        if (
          !identity ||
          !/^[a-f0-9]{64}$/.test(identity.binary_sha256) ||
          !/^[a-f0-9]{64}$/.test(identity.schema_sha256) ||
          typeof identity.revision !== 'string' ||
          !identity.revision.length ||
          identity.revision.length > 128
        ) {
          fail('schema_unavailable', 'compile', 'invalid_identity')
        }
        if (
          !(typeof bytes === 'string' || bytes instanceof Uint8Array) ||
          (typeof bytes === 'string'
            ? bytes.length > budget.bundle_bytes || Buffer.byteLength(bytes) > budget.bundle_bytes
            : bytes.byteLength > budget.bundle_bytes)
        ) {
          fail('schema_unavailable', 'compile', 'bundle_limit')
        }
        const input = typeof bytes === 'string' ? bytes : new Uint8Array(bytes)
        return { settings, budget, identity, input, inputSha256: hash(input) }
      }
    )
    if (!prepared.ok) {
      return Promise.resolve(prepared)
    }
    return new Promise(
      /* 每个任务只结算一次，取消和迟到消息按原 Worker 实例隔离。 */ (resolve) => {
        const id = randomUUID()
        const cancel = /* 取消后整个编译服务退役，旧回复不能登记任何宿主句柄。 */ () =>
          this.#retire('compiler_cancelled')
        const timer = setTimeout(
          /* 期限到达请求终止，未完成生成物不进入 registry。 */ () => this.#retire('compiler_timeout'),
          Math.max(0, until - performance.now())
        )
        this.#pending = {
          id,
          resolve,
          timer,
          cancel,
          signal,
          until,
          identity: prepared.value.identity,
          budget: prepared.value.budget,
          inputSha256: prepared.value.inputSha256,
          input: prepared.value.input
        }
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          if (!this.#worker) {
            const worker = this.createWorker()
            this.#worker = worker
            worker.onmessage = /* 只消费本服务当前任务的精确回复，退役实例的消息全部丢弃。 */ (event) =>
              this.#receive(worker, event.data)
            worker.onerror = /* 屏蔽异常原文并让本服务失败关闭。 */ (event) => {
              event.preventDefault?.()
              this.#retire('compiler_failed')
            }
            worker.addEventListener(
              'close',
              /* 不把 close 当作所有线程/内存已回收的证明。 */ () => {
                if (this.#worker === worker && !this.#closed) {
                  this.#retire('compiler_closed')
                }
              }
            )
          }
          this.#worker.ref()
          if (signal?.aborted) {
            cancel()
            return
          }
          this.#worker.postMessage({
            version: ARTIFACT_VERSION,
            job_id: id,
            bytes: prepared.value.input,
            options: prepared.value.settings
          })
        } catch {
          this.#retire('compiler_start_failed')
        }
      }
    )
  }

  // 任何异步成功都先核对身份，再在同步安装完成后一次性发布真实句柄。
  #receive(worker: CompilerPort, value: unknown): void {
    const pending = this.#pending
    if (this.#closed || this.#worker !== worker || !pending) {
      return
    }
    try {
      const reply = fields(value, ['version', 'job_id', 'result'])
      if (reply.version !== ARTIFACT_VERSION || reply.job_id !== pending.id) {
        this.#retire('compiler_protocol_invalid')
        return
      }
      if (pending.signal?.aborted || performance.now() >= pending.until) {
        this.#retire(pending.signal?.aborted ? 'compiler_cancelled' : 'compiler_timeout')
        return
      }
      const result = fields(
        reply.result,
        (reply.result as Check<unknown>)?.ok === true ? ['ok', 'value'] : ['ok', 'error']
      ) as unknown as Check<unknown>
      if (result?.ok === false) {
        const error = fields(result.error, ['origin', 'code', 'stage', 'reason'])
        if (
          error.origin !== 'contract' ||
          error.code !== 'schema_unavailable' ||
          error.stage !== 'compile' ||
          typeof error.reason !== 'string' ||
          !/^[a-z_]{1,64}$/.test(error.reason)
        ) {
          this.#retire('compiler_protocol_invalid')
          return
        }
        if (error.reason === 'compiler_protocol_invalid') {
          this.#retire(error.reason)
          return
        }
        this.#settle(failure(error.reason))
        return
      }
      if (result?.ok !== true) {
        this.#retire('compiler_protocol_invalid')
        return
      }
      const installed = attempt('compile', /* 产物安装只有此私有回复路径可达。 */ () => install(result.value, pending))
      if (!installed.ok) {
        this.#retire(installed.error.reason ?? 'compiler_artifact_invalid')
        return
      }
      if (pending.signal?.aborted || performance.now() >= pending.until) {
        contracts.delete(installed.value)
        this.#retire(pending.signal?.aborted ? 'compiler_cancelled' : 'compiler_timeout')
        return
      }
      this.#settle(installed)
    } catch {
      this.#retire('compiler_artifact_invalid')
    }
  }

  // 解绑监听与定时器后才结算，成功后的空闲 Worker 不保持角色进程存活。
  #settle(result: Check<CompiledContract>): void {
    const pending = this.#pending
    if (!pending) {
      return
    }
    this.#pending = undefined
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.cancel)
    try {
      this.#worker?.unref()
    } catch {
      /* 清理失败不阻止当前任务结算。 */
    }
    pending.resolve(result)
  }

  // 关闭是同步拒绝与代次撤销；terminate 仅为终止请求，不能充当硬堆或硬实时保证。
  #retire(reason: string): void {
    this.#closed = true
    const worker = this.#worker
    this.#worker = undefined
    try {
      worker?.terminate()
    } catch {
      /* 已撤销代次，终止请求失败也不再接纳回复。 */
    } finally {
      this.#settle(failure(reason))
    }
  }

  // 属于角色宿主的关闭入口；已接受的 standalone 契约不依赖编译 Worker 继续存活。
  close(): void {
    this.#retire('compiler_closed')
  }
}
