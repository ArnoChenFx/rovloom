// 验证 Worker 编译、standalone 加载、任务代次撤销及故障关闭；只使用仓库样本和自有 Worker。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { SchemaCompiler } from '../../src/native-contract/compiler-host.js'
import { createCompilerWorker } from '../../src/native-contract/compiler-location.js'
import { ARTIFACT_VERSION, CODE_LIMIT } from '../../src/native-contract/compiler-protocol.js'
import type { CompilerArtifact, CompilerPort, CompileJob } from '../../src/native-contract/compiler-protocol.js'
import { hash } from '../../src/native-contract/json.js'
import { compileBundle, createNativeValidator } from '../../src/native-contract/index.js'
import type { Check } from '../../src/native-contract/index.js'
import { bytes, clone, identity, json, unwrap } from './helpers.js'

// 固定内部测试端口保存当前任务；生产 API 不提供该工厂或任意产物安装入口。
class TestPort implements CompilerPort {
  onmessage: CompilerPort['onmessage'] = null
  onerror: CompilerPort['onerror'] = null
  job?: CompileJob
  terminated = 0
  // 记录宿主发送的唯一任务供故障用例显式回复。
  postMessage(job: CompileJob): void {
    this.job = job
  }
  // 记录终止请求；故意仍允许测试发送迟到消息。
  terminate(): void {
    this.terminated++
  }
  // 测试端口没有物理线程，ref 不改变资源。
  ref(): void {}
  // 测试端口没有事件循环引用，unref 不改变资源。
  unref(): void {}
  // 测试手工控制生命周期，不自动发出 close。
  addEventListener(): void {}
  // 默认用当前任务身份发送消息，也允许故障用例覆盖外层字段。
  reply(result: unknown, extra: Record<string, unknown> = {}): void {
    this.onmessage?.({ data: { version: ARTIFACT_VERSION, job_id: this.job?.job_id, result, ...extra } })
  }
}

// 从真正的私有 Worker 取得一次固定样本产物，不在主线程调用 Ajv 编译。
async function specimen(): Promise<CompilerArtifact> {
  const worker = createCompilerWorker()
  try {
    return await new Promise(
      /* 限时接收完整编译结果并在所有路径清理测试 Worker。 */ (resolve, reject) => {
        const timer = setTimeout(
          /* 私有样本准备失败不能让测试悬挂。 */ () => reject(new Error('fixture compiler timeout')),
          4000
        )
        worker.onmessage = /* 取回纯数据产物，仅供内部故障注入测试。 */ (event) => {
          clearTimeout(timer)
          resolve(unwrap((event.data as { result: Check<CompilerArtifact> }).result))
        }
        worker.onerror = /* 测试失败只报告固定原因，不输出 schema 源码。 */ () => {
          clearTimeout(timer)
          reject(new Error('fixture compiler failed'))
        }
        worker.postMessage({ version: ARTIFACT_VERSION, job_id: randomUUID(), bytes, options: { identity } })
      }
    )
  } finally {
    worker.terminate()
  }
}
const artifact = await specimen()

test('安装产物同时核对保留 schema 的原字节，私有端口篡改输入不能注入描述元数据', async () => {
  const port = new TestPort()
  const compiler = new SchemaCompiler(() => port)
  try {
    const pending = compiler.compile(new Uint8Array(bytes), { identity })
    assert(port.job?.bytes instanceof Uint8Array)
    port.job.bytes[0] = 0
    port.reply({ ok: true, value: artifact })
    reason(await pending, 'compiler_artifact_invalid')
  } finally {
    compiler.close()
  }
})

// 编译故障必须返回安全的固定原因。
function reason(result: Check<unknown>, expected: string): void {
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'schema_unavailable')
    assert.equal(result.error.stage, 'compile')
    assert.equal(result.error.reason, expected)
    assert.deepEqual(Object.keys(result.error).sort(), ['code', 'origin', 'reason', 'stage'])
    assert(!JSON.stringify(result).includes('synthetic-private-schema'))
  }
}

test(
  '完整 Worker 编译不在宿主重新调用 Ajv，已接纳契约保持同步且不能复制',
  /* 在宿主封死 Ajv 编译入口，真实 Worker 仍生成完整可用的同步 validator。 */ async () => {
    const keys = ['compile', 'addSchema', 'getSchema'] as const
    const originals = keys.map(/* 保存宿主原始方法并在 finally 精确还原。 */ (key) => Ajv2020.prototype[key])
    let calls = 0
    for (const key of keys) {
      Ajv2020.prototype[key] = /* 任意主线程重编译都立即使测试失败。 */ (() => {
        calls++
        throw new Error('main compiler forbidden')
      }) as never
    }
    try {
      const compiled = unwrap(await compileBundle(bytes, { identity }))
      assert.equal(calls, 0)
      assert.equal(compiled.documents.length, 29)
      assert.equal(artifact.schemas.length, 92)
      const response = {
        id: 'standalone',
        error: { code: 'synthetic', message: 'synthetic', data: { nested: ['汉😀', false] } }
      }
      const result = createNativeValidator(compiled).checkResponseShape(response)
      assert(!(result instanceof Promise))
      assert.deepEqual(unwrap(result).response, response)
      assert.throws(/* JSON 复制对象不能恢复宿主 WeakMap 登记。 */ () => createNativeValidator(clone(compiled)))
    } finally {
      keys.forEach(
        /* 恢复主线程 Ajv 原始函数。 */ (key, i) => {
          Ajv2020.prototype[key] = originals[i] as never
        }
      )
    }
  }
)

test(
  '公共工厂在真实 Worker 拒绝空 bundle 后仍可编译有效 bundle',
  /* 原始空对象带匹配摘要，拒绝必须是普通编译错误，不能永久关闭全局工厂。 */ async () => {
    reason(await compileBundle('{}', { identity: { ...identity, schema_sha256: hash('{}') } }), 'invalid_schema')
    const compiled = unwrap(await compileBundle(bytes, { identity }))
    assert.equal(compiled.documents.length, 29)
    assert(createNativeValidator(compiled).checkResponseShape({ id: 'after-invalid-bundle', result: {} }).ok)
  }
)

const requestUri = 'https://luvus.dev/protocol/uhp/v1/request.schema.json'
const rejectedBundles: Array<[string, string, string | ((bundle: Record<string, any>) => void)]> = [
  ['空根', 'invalid_schema', 'null'],
  ['数组根', 'invalid_schema', '[]'],
  ['文档表形状', 'invalid_schema', '{"documents":null}'],
  [
    '文档根形状',
    'invalid_schema',
    /* 完整文档必须是合法 schema 对象。 */ (bundle) => {
      bundle.documents[requestUri] = null
    }
  ],
  [
    '方法目录形状',
    'invalid_schema',
    /* 同步修改原根及别名，避免副本冲突遮蔽形状错误。 */ (bundle) => {
      delete bundle.documents[requestUri].properties
      bundle.request = clone(bundle.documents[requestUri])
    }
  ],
  [
    '条件分支形状',
    'invalid_schema',
    /* 合法 JSON Schema 布尔分支仍不满足方法条件目录。 */ (bundle) => {
      bundle.documents[requestUri].allOf = [true]
      bundle.request = clone(bundle.documents[requestUri])
    }
  ],
  [
    '缺失引用',
    'missing_fragment',
    /* 离线引用失败属于输入拒绝，不属于 Worker 私有协议损坏。 */ (bundle) => {
      bundle.documents[requestUri].$ref = '#/$defs/nonexistent_review_fixture'
    }
  ],
  [
    '未知关键字',
    'unsupported_keyword',
    /* 未知 schema 语义保守拒绝，随后仍允许已审核 schema。 */ (bundle) => {
      bundle.documents[requestUri].synthetic_future_keyword = true
    }
  ],
  [
    'Ajv 根约束',
    'invalid_schema',
    /* 完整根的非法 required 由 Ajv 实际拒绝。 */ (bundle) => {
      bundle.documents[requestUri].required = 'synthetic-invalid'
      bundle.request = clone(bundle.documents[requestUri])
    }
  ]
]
for (const [name, expected, input] of rejectedBundles) {
  test(
    `真实 Worker 拒绝${name}后复用同一实例编译有效根`,
    /* 每项真实坏输入之后执行完整有效编译，不能用伪造错误消息代替可用性验证。 */ async () => {
      let starts = 0
      const compiler = new SchemaCompiler(
        /* 统计真实 Worker 创建次数，确认拒绝后复用而非自动重建。 */ () => {
          starts++
          return createCompilerWorker()
        }
      )
      try {
        const bundle = json('schema-bundle.json')
        if (typeof input === 'function') {
          input(bundle)
        }
        const encoded = typeof input === 'string' ? input : JSON.stringify(bundle)
        reason(await compiler.compile(encoded, { identity: { ...identity, schema_sha256: hash(encoded) } }), expected)
        const compiled = unwrap(await compiler.compile(bytes, { identity }))
        assert.equal(compiled.documents.length, 29)
        assert.equal(starts, 1)
      } finally {
        compiler.close()
      }
    }
  )
}

test(
  '非规范 Worker 错误仍作为私有协议损坏永久退役',
  /* 仅生产端投影已知 schema 拒绝，宿主不放宽阶段、命名空间、字段或 reason 协议。 */ async () => {
    const error = { origin: 'contract', code: 'schema_unavailable', stage: 'compile', reason: 'invalid_schema' }
    const { reason: omitted, ...missingReason } = error
    assert.equal(omitted, 'invalid_schema')
    for (const [changed, expected] of [
      [{ ...error, origin: 'authorization' }, 'compiler_protocol_invalid'],
      [{ ...error, code: 'invalid_context' }, 'compiler_protocol_invalid'],
      [{ ...error, stage: 'validation' }, 'compiler_protocol_invalid'],
      [missingReason, 'compiler_artifact_invalid'],
      [{ ...error, future: true }, 'compiler_artifact_invalid']
    ] as const) {
      const port = new TestPort()
      const compiler = new SchemaCompiler(/* 每种损坏错误仅属于自己的内部测试服务。 */ () => port)
      const pending = compiler.compile(bytes, { identity })
      port.reply({ ok: false, error: changed })
      reason(await pending, expected)
      reason(await compiler.compile(bytes, { identity }), 'compiler_unavailable')
      assert.equal(port.terminated, 1)
    }
  }
)

test(
  '单在途任务不排队，取消永久撤销代次并丢弃迟到产物',
  /* 测试端口在终止后仍故意发送有效产物，不能重新登记或恢复编译服务。 */ async () => {
    const port = new TestPort()
    const compiler = new SchemaCompiler(/* 仅创建这个自有测试端口。 */ () => port)
    const controller = new AbortController()
    const pending = compiler.compile(bytes, { identity }, controller.signal)
    reason(await compiler.compile(bytes, { identity }), 'compiler_busy')
    controller.abort()
    reason(await pending, 'compiler_cancelled')
    port.reply({ ok: true, value: artifact })
    reason(await compiler.compile(bytes, { identity }), 'compiler_unavailable')
    assert.equal(port.terminated, 1)
  }
)

test(
  '预先取消不启动 Worker，正常拒绝 schema 后仍可接纳后续任务',
  /* 输入取消没有资源副作用；普通 schema 失败不等于编译宿主故障。 */ async () => {
    const port = new TestPort()
    let starts = 0
    const compiler = new SchemaCompiler(
      /* 统计唯一 Worker 创建次数。 */ () => {
        starts++
        return port
      }
    )
    const controller = new AbortController()
    controller.abort()
    reason(await compiler.compile(bytes, { identity }, controller.signal), 'compiler_cancelled')
    assert.equal(starts, 0)
    const bad = compiler.compile(bytes, { identity })
    port.reply({
      ok: false,
      error: { origin: 'contract', code: 'schema_unavailable', stage: 'compile', reason: 'invalid_schema' }
    })
    reason(await bad, 'invalid_schema')
    const good = compiler.compile(bytes, { identity })
    port.reply({ ok: true, value: artifact })
    const compiled = unwrap(await good)
    compiler.close()
    assert(createNativeValidator(compiled).checkResponseShape({ id: 'after-close', result: {} }).ok)
    assert.equal(starts, 1)
  }
)

const corruptions: Array<[string, (value: CompilerArtifact) => void]> = [
  [
    'compiler_artifact_invalid',
    /* 未知版本不推断向前兼容。 */ (a) => {
      a.version++
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 生成器必须是当前固定版本。 */ (a) => {
      a.generator = 'future'
    }
  ],
  [
    'compiler_artifact_invalid',
    /* Ajv 版本不能由消息自选。 */ (a) => {
      a.ajv = 'future'
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 完整安装身份逐项绑定。 */ (a) => {
      a.identity = { ...a.identity, revision: a.identity.revision + '-other' }
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 原字节摘要不能换成另一份 schema。 */ (a) => {
      a.identity = { ...a.identity, schema_sha256: 'b'.repeat(64) }
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 固定生成选项摘要不能替换。 */ (a) => {
      a.options_sha256 = 'b'.repeat(64)
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 生成源码摘要必须匹配。 */ (a) => {
      a.code_sha256 = 'b'.repeat(64)
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 所有完整文档必须有同步校验入口。 */ (a) => {
      a.schemas.shift()
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 私有产物也拒绝额外未知字段。 */ (a) => {
      Object.assign(a, { future: true })
    }
  ],
  [
    'generated_code_limit',
    /* 在源码解析前拒绝超过字节上限的代码。 */ (a) => {
      a.code = ' '.repeat(CODE_LIMIT + 1)
    }
  ],
  [
    'compiler_helper_forbidden',
    /* 不给生成代码任意 Node 或文件访问 require。 */ (a) => {
      a.code = 'require("node:fs")'
      a.code_sha256 = hash(a.code)
    }
  ],
  [
    'compiler_artifact_invalid',
    /* 代码导出个数和函数形态都必须符合完整目录。 */ (a) => {
      a.code = 'exports.v0 = {}'
      a.code_sha256 = hash(a.code)
    }
  ]
]
for (const [index, [expected, corrupt]] of corruptions.entries()) {
  test(
    `私有 standalone 产物拒绝 ${expected} / ${index}`,
    /* 每个变体通过内部自有测试端口注入，公共 API 不接受这些代码或路径。 */ async () => {
      const port = new TestPort()
      const compiler = new SchemaCompiler(/* 本变体只拥有自己的测试端口。 */ () => port)
      const pending = compiler.compile(bytes, { identity })
      const changed = clone(artifact)
      corrupt(changed)
      port.reply({ ok: true, value: changed })
      reason(await pending, expected)
      reason(await compiler.compile(bytes, { identity }), 'compiler_unavailable')
      assert.equal(port.terminated, 1)
    }
  )
}

test(
  '错误消息版本、任务身份和额外字段拒绝并撤销服务',
  /* IPC 没有未知版本兼容或跨任务复用；错误原文不会成为诊断。 */ async () => {
    for (const extra of [{ version: 2 }, { job_id: randomUUID() }, { future: 'synthetic-private-schema' }]) {
      const port = new TestPort()
      const compiler = new SchemaCompiler(/* 每项消息独立构造内部故障端口。 */ () => port)
      const pending = compiler.compile(bytes, { identity })
      port.reply({ ok: true, value: artifact }, extra)
      const result = await pending
      assert(!result.ok)
      assert(!JSON.stringify(result).includes('synthetic-private-schema'))
      reason(await compiler.compile(bytes, { identity }), 'compiler_unavailable')
    }
  }
)

test(
  '真实 Worker 明确拒绝未知任务版本和额外字段',
  /* 私有 Worker 对可关联的未知协议任务回复固定拒绝，不静默等待超时或尝试兼容。 */ async () => {
    const worker = createCompilerWorker()
    try {
      for (const extra of [{ version: 2 }, { future: true }]) {
        const job = { version: ARTIFACT_VERSION, job_id: randomUUID(), bytes, options: { identity }, ...extra }
        const result = await new Promise<Check<unknown>>(
          /* 只接收本次自有任务的回复并限制测试等待时间。 */ (resolve, reject) => {
            const timer = setTimeout(
              /* 未知版本必须主动拒绝，超时视为失败。 */ () => reject(new Error('protocol reply timeout')),
              2000
            )
            worker.onmessage = /* 验证返回的准确版本和原任务身份。 */ (event) => {
              clearTimeout(timer)
              const reply = event.data as { version: number; job_id: string; result: Check<unknown> }
              assert.equal(reply.version, ARTIFACT_VERSION)
              assert.equal(reply.job_id, job.job_id)
              resolve(reply.result)
            }
            worker.postMessage(job)
          }
        )
        reason(result, 'compiler_protocol_invalid')
      }
    } finally {
      worker.terminate()
    }
  }
)

test(
  '宿主初始化超期拒绝句柄，不声称可以抢占主线程',
  /* 固定有限测试代码延长初始化，验证加载成本计入期限且超期服务不可恢复。 */ async () => {
    const port = new TestPort()
    const compiler = new SchemaCompiler(/* 仅供此内部故障用例使用的自有端口。 */ () => port, 300)
    const pending = compiler.compile(bytes, { identity })
    const changed = clone(artifact)
    changed.code = 'const loadUntil = Date.now() + 400; while (Date.now() < loadUntil) {}\n' + changed.code
    changed.code_sha256 = hash(changed.code)
    port.reply({ ok: true, value: changed })
    reason(await pending, 'compiler_timeout')
    reason(await compiler.compile(bytes, { identity }), 'compiler_unavailable')
  }
)

test(
  '真实忙 Worker 在编译期限失败关闭，不接纳结果或自动补建',
  /* 无限循环只在自有 Worker 中运行，期限只证明宿主撤销而非硬实时退出或硬堆隔离。 */ async () => {
    const RuntimeWorker = Worker as unknown as new (url: string, options: { smol: boolean }) => CompilerPort
    let starts = 0
    const compiler = new SchemaCompiler(
      /* 启动固定测试忙循环入口，不接触真实安装或凭据。 */ () => {
        starts++
        return new RuntimeWorker(new URL('./compiler-busy-fixture.ts', import.meta.url).href, { smol: true })
      },
      300
    )
    const started = performance.now()
    reason(await compiler.compile(bytes, { identity }), 'compiler_timeout')
    assert(performance.now() - started >= 250)
    reason(await compiler.compile(bytes, { identity }), 'compiler_unavailable')
    assert.equal(starts, 1)
  }
)
