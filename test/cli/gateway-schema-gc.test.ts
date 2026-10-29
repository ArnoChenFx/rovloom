/** 真实私有文件与假时钟验证后台回收；不读取用户目录或依赖实际等待七天。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { GatewaySchemaGc, SCHEMA_GC_GRACE, SCHEMA_GC_INTERVAL } from '../../src/cli/gateway-schema-gc.js'
import type { ManagedProviderEntry } from '../../src/cli/runtime-config.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import { readSetupJson, writeSetupJson } from '../../src/cli/setup-files.js'
import { setupTarget } from '../../src/cli/setup-targets.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/connector/luvus/host/native-source.js'
import { publishSchema, schemaReference } from '../../src/connector/schema-store.js'
import { hash } from '../../src/wire/index.js'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-schema-gc-'))
  mkdirSync(join(directory, 'managed'), { mode: 0o700 })
  const config = { ...configTemplate('gateway'), state_dir: directory } as GatewayConfig
  const journal = runtimeReference(directory, 'schema-gc')
  let now = Date.now()
  let busy = false
  let retained: readonly ManagedProviderEntry[] = []
  let failures = 0
  const options = {
    now: () => now,
    busy: () => busy,
    retained: () => retained,
    deferred: () => failures++
  }
  const instances: GatewaySchemaGc[] = []
  const create = () => {
    const gc = new GatewaySchemaGc(config, options)
    instances.push(gc)
    return gc
  }
  const gc = create()
  return {
    directory,
    config,
    journal,
    gc,
    create,
    get now() {
      return now
    },
    set now(value: number) {
      now = value
    },
    set busy(value: boolean) {
      busy = value
    },
    set retained(value: readonly ManagedProviderEntry[]) {
      retained = value
    },
    get failures() {
      return failures
    },
    registry(entries: readonly ManagedProviderEntry[]) {
      const path = runtimeReference(directory, 'providers')
      writeSetupJson(path, { schema_version: 1, role: 'gateway', providers: entries }, existsSync(path), 1_048_576)
    },
    schema(text = '{"schema":"fixture"}') {
      const bytes = Buffer.from(text)
      const path = schemaReference(directory, hash(bytes))
      publishSchema(path, bytes)
      return { path, digest: hash(bytes), bytes }
    },
    hours(count: number, active = gc) {
      for (let hour = 0; hour < count; hour++) {
        now += SCHEMA_GC_INTERVAL
        assert.equal(active.sweep(), true)
      }
    },
    close() {
      for (const active of instances) {
        active.close()
      }
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function provider(
  reference: string,
  kind: 'luvus' | 'herdr',
  schema: { path: string; digest: string }
): ManagedProviderEntry {
  const target = setupTarget('machine_' + reference, kind)
  return {
    reference,
    value:
      kind === 'herdr'
        ? {
            kind,
            config: {
              version: 1,
              target,
              binding_revision: 1,
              config_ref: reference,
              expected_source: { ...fixedHerdrSource(), schema_sha256: schema.digest },
              schema_ref: schema.path
            }
          }
        : {
            kind,
            authentication: 'remote_connector',
            target,
            binding: {
              machine_id: target.machine_id,
              provider_id: target.provider_id,
              kind,
              config_ref: reference,
              binding_revision: 1,
              enabled: false
            },
            contract: {
              binary_version: 'synthetic',
              binary_sha256: 'f'.repeat(64),
              schema_sha256: schema.digest,
              adapter_revision: MANAGED_LUVUS_REVISION,
              classification_revision: MANAGED_LUVUS_CLASSIFICATION,
              schema_ref: schema.path
            }
          }
  }
}

test('同 digest 的多个 provider/设备共享文件；最后引用移除七天后自动回收，禁用仍保留', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    const luvus = provider('luvus_a', 'luvus', schema)
    const herdr = provider('herdr_b', 'herdr', schema)
    f.registry([luvus, herdr])
    assert.equal(f.gc.sweep(), true)
    f.hours(168)
    assert(existsSync(schema.path))
    f.registry([luvus])
    f.hours(168)
    assert(existsSync(schema.path))
    f.registry([])
    assert.equal(f.gc.sweep(), true)
    f.hours(167)
    assert(existsSync(schema.path))
    f.hours(1)
    assert.equal(existsSync(schema.path), false)
  } finally {
    f.close()
  }
})

test('失败配对遗留文件自动回收；重新引用会取消候选并重新计算宽限期', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    assert.equal(f.gc.sweep(), true)
    f.hours(167)
    f.registry([provider('repinned', 'herdr', schema)])
    f.hours(1)
    assert(existsSync(schema.path))
    f.registry([])
    assert.equal(f.gc.sweep(), true)
    f.hours(167)
    assert(existsSync(schema.path))
    f.hours(1)
    assert.equal(existsSync(schema.path), false)
  } finally {
    f.close()
  }
})

test('短暂重启继承持久候选；长时间未检查、前跳及回拨均重新观察', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    assert.equal(f.gc.sweep(), true)
    f.hours(167)
    f.gc.close()
    const reopened = f.create()
    f.hours(1, reopened)
    assert.equal(existsSync(schema.path), false)
    const second = f.schema('{"schema":"second"}')
    assert.equal(reopened.sweep(), true)
    f.now += SCHEMA_GC_GRACE
    assert.equal(reopened.sweep(), true)
    assert(existsSync(second.path))
    f.hours(167, reopened)
    f.now -= SCHEMA_GC_GRACE
    assert.equal(reopened.sweep(), true)
    f.hours(167, reopened)
    assert(existsSync(second.path))
    f.hours(1, reopened)
    assert.equal(existsSync(second.path), false)
  } finally {
    f.close()
  }
})

test('配对发布期间暂停整个回收，已有启动时引用与磁盘新引用取并集', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    assert.equal(f.gc.sweep(), true)
    f.hours(167)
    f.busy = true
    f.now += SCHEMA_GC_INTERVAL
    const before = readFileSync(f.journal)
    assert.equal(f.gc.sweep(), false)
    assert.deepEqual(readFileSync(f.journal), before)
    assert(existsSync(schema.path))
    f.retained = [provider('loaded', 'herdr', schema)]
    f.busy = false
    assert.equal(f.gc.sweep(), true)
    assert(existsSync(schema.path))
    f.retained = []
    f.registry([provider('published', 'luvus', schema)])
    f.hours(168)
    assert(existsSync(schema.path))
    assert.equal(f.failures, 0)
  } finally {
    f.close()
  }
})

test('未知/损坏 registry、进度和迁移状态阻止删除并仅报告一次固定失败', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    assert.equal(f.gc.sweep(), true)
    f.hours(167)
    const providers = runtimeReference(f.directory, 'providers')
    f.registry([{ reference: 'unknown', value: { kind: 'unknown' } }])
    f.now += SCHEMA_GC_INTERVAL
    assert.equal(f.gc.sweep(), false)
    assert.equal(f.gc.sweep(), false)
    assert.equal(f.failures, 1)
    writeFileSync(providers, '{"schema_version":1,"schema_version":1}')
    assert.equal(f.gc.sweep(), false)
    assert(existsSync(schema.path))
    f.registry([provider('restored', 'herdr', schema)])
    assert.equal(f.gc.sweep(), true)
    writeFileSync(
      f.journal,
      JSON.stringify({ version: 1, checked_at: f.now, candidates: [{ file: '../outside', unreferenced_at: 0 }] })
    )
    assert.equal(f.gc.sweep(), false)
    assert.equal(f.failures, 2)
    writeFileSync(f.journal, JSON.stringify({ version: 1, checked_at: f.now, candidates: [] }))
    writeSetupJson(runtimeReference(f.directory, 'retirement'), { batch: 'synthetic' })
    assert.equal(f.gc.sweep(), false)
    assert(existsSync(schema.path))
  } finally {
    f.close()
  }
})

test('只清理本目录普通内容寻址文件，保留旧布局、retired、未知文件和所有链接', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    const old = join(f.directory, 'managed', 'herdr-schema_legacy.json')
    const unknown = join(f.directory, 'managed', 'user.json')
    const retired = join(f.directory, 'retired', 'synthetic')
    mkdirSync(retired, { recursive: true })
    writeFileSync(join(retired, basename(schema.path)), schema.bytes)
    writeFileSync(old, schema.bytes)
    writeFileSync(unknown, schema.bytes)
    const linked = f.schema('{"schema":"hardlink"}')
    linkSync(linked.path, join(f.directory, 'linked.json'))
    const soft = schemaReference(f.directory, 'a'.repeat(64))
    if (process.platform !== 'win32') {
      symlinkSync(schema.path, soft)
    }
    assert.equal(f.gc.sweep(), true)
    f.hours(168)
    assert.equal(existsSync(schema.path), false)
    assert(existsSync(old))
    assert(existsSync(unknown))
    assert(existsSync(linked.path))
    assert(existsSync(join(retired, basename(schema.path))))
  } finally {
    f.close()
  }
})

test('摘要冲突不被自动删除；修复后重试，已关闭的维护任务不再访问目录', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    assert.equal(f.gc.sweep(), true)
    f.hours(167)
    writeFileSync(schema.path, '{"tampered":true}')
    f.now += SCHEMA_GC_INTERVAL
    assert.equal(f.gc.sweep(), false)
    assert(existsSync(schema.path))
    writeFileSync(schema.path, schema.bytes)
    assert.equal(f.gc.sweep(), true)
    assert.equal(existsSync(schema.path), false)
    f.gc.close()
    rmSync(join(f.directory, 'managed'), { recursive: true })
    assert.equal(f.gc.sweep(), false)
  } finally {
    f.close()
  }
})

test('每轮最多回收 32 个文件，积压候选自动在后续轮次继续', () => {
  const f = fixture()
  try {
    const schemas = Array.from({ length: 35 }, (_, index) => f.schema(JSON.stringify({ index })))
    assert.equal(f.gc.sweep(), true)
    f.hours(168)
    assert.equal(schemas.filter((schema) => existsSync(schema.path)).length, 3)
    f.hours(1)
    assert(schemas.every((schema) => !existsSync(schema.path)))
  } finally {
    f.close()
  }
})

test('单轮回收字节不超过 16 MiB，大文件积压在下一轮继续', () => {
  const f = fixture()
  try {
    const first = f.schema('a'.repeat(9 * 1024 * 1024))
    const second = f.schema('b'.repeat(9 * 1024 * 1024))
    assert.equal(f.gc.sweep(), true)
    f.hours(168)
    assert.equal([first, second].filter((schema) => existsSync(schema.path)).length, 1)
    f.hours(1)
    assert.equal(existsSync(first.path), false)
    assert.equal(existsSync(second.path), false)
  } finally {
    f.close()
  }
})

test('旧 Herdr schema_path 和 Luvus 内嵌配置仍保留同摘要文件', () => {
  const f = fixture()
  try {
    const schema = f.schema()
    const herdr = provider('legacy_herdr', 'herdr', schema)
    const config = (herdr.value as { config: { schema_ref?: string; schema_path?: string } }).config
    config.schema_path = config.schema_ref
    delete config.schema_ref
    const luvus = provider('legacy_luvus', 'luvus', schema)
    const contract = (luvus.value as { contract: { schema_ref?: string; schema_bundle?: string } }).contract
    delete contract.schema_ref
    contract.schema_bundle = schema.bytes.toString('utf8')
    f.registry([herdr, luvus])
    assert.equal(f.gc.sweep(), true)
    f.hours(168)
    assert(existsSync(schema.path))
  } finally {
    f.close()
  }
})

test('后台每小时自动扫描并在关闭后停止，空目录不产生进度文件', () => {
  const f = fixture()
  const original = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  let callback: (() => void) | undefined
  let cleared = false
  let unreferenced = false
  const timer = {
    unref: () => {
      unreferenced = true
    }
  } as unknown as NodeJS.Timeout
  // 同步捕获真实调度入口；不改变文件回收或时间判断，不让 mock 跨异步回合泄漏。
  globalThis.setInterval = ((run: () => void, interval: number) => {
    assert.equal(interval, SCHEMA_GC_INTERVAL)
    callback = run
    return timer
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: NodeJS.Timeout) => {
    assert.equal(handle, timer)
    cleared = true
  }) as typeof clearInterval
  try {
    f.gc.start()
    assert.equal(existsSync(f.journal), false)
    assert.equal(unreferenced, true)
    const schema = f.schema()
    callback!()
    assert.deepEqual((readSetupJson(f.journal) as { candidates: unknown[] }).candidates, [
      { file: basename(schema.path), unreferenced_at: f.now }
    ])
    for (let hour = 0; hour < 168; hour++) {
      f.now += SCHEMA_GC_INTERVAL
      callback!()
    }
    assert.equal(existsSync(schema.path), false)
    f.gc.close()
    assert.equal(cleared, true)
    rmSync(join(f.directory, 'managed'), { recursive: true })
    callback!()
  } finally {
    globalThis.setInterval = original
    globalThis.clearInterval = originalClear
    f.close()
  }
})
