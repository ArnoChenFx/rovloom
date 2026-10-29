// 精确验证原生 JSON 与在线帧的字节预算、编译资源限制，以及引用闭包始终离线的边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { compileBundle, parseNativeJson } from '../../../../src/connector/luvus/contract/index.js'
import { bytes, G, identity, json, rejects, request, source, sourceFor, T, unwrap, validator } from './helpers.js'

// 覆盖样本中的在线通用与终端预算，并绑定真实能力视图。
function limitedView(limits: Record<string, number>, terminal: Record<string, number> = {}) {
  const caps = json('session-capabilities.json')
  caps.result.session = 'synthetic'
  caps.result.server_generation = G
  Object.assign(caps.result.limits, limits)
  Object.assign(caps.result.terminal.limits, terminal)
  return unwrap(validator.bindCapabilities(caps, source()))
}

// 计算 JSON 的 UTF-8 字节数并计入原生帧结束 LF。
const frameBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1

test(
  '原生字节入口与字符串入口一致拒绝 BOM，bundle 不产生编译 handle',
  /* 验证字节和字符串入口均拒绝 BOM，且编译不会产生契约句柄。 */ async () => {
    for (const value of [Buffer.from('\uFEFF{}'), '\uFEFF{}']) {
      rejects(parseNativeJson(value), 'invalid_json')
    }
    // 不重算摘要来掩盖 BOM；解析必须先拒绝，不能默默剥除再接受其它契约。
    const result = await compileBundle(Buffer.concat([Buffer.from('\uFEFF'), bytes]), { identity })
    rejects(result, 'schema_unavailable')
    if (!result.ok) {
      assert.equal(result.error.reason, 'invalid_json')
    }
  }
)

test(
  '原生 request 的在线帧预算包含 LF，精确上界可用、超一字节拒绝',
  /* 验证请求帧预算恰好包含 LF 时可用，减少一字节即拒绝。 */ () => {
    const input = { id: 'bytes', method: 'ping', params: { text: '汉😀\n' } }
    const size = frameBytes(input)
    assert.doesNotThrow(
      /* 在精确在线帧预算下构造请求，确认边界值不会抛错。 */ () => request(limitedView({ frame_bytes: size }), input)
    )
    rejects(validator.checkRequest(limitedView({ frame_bytes: size - 1 }), input), 'native_request_invalid')
  }
)

test(
  'bound response 按原 view 的在线较低帧预算校验，shape-only 不授予该证明',
  /* 验证绑定响应遵守来源能力预算，而形状校验不携带该绑定证明。 */ () => {
    const input = { id: 'bytes', method: 'ping', params: {} }
    for (const response of [
      { id: input.id, result: { text: '汉😀'.repeat(80) } },
      { id: input.id, error: { code: 'synthetic', message: 'synthetic', data: 'x'.repeat(800) } }
    ]) {
      const size = frameBytes(response)
      const exact = request(limitedView({ frame_bytes: size }), input)
      assert.deepEqual(unwrap(validator.checkResponse(exact, response, sourceFor(exact.binding))).response, response)
      const lower = request(limitedView({ frame_bytes: size - 1 }), input)
      rejects(validator.checkResponse(lower, response, sourceFor(lower.binding)), 'native_response_invalid')
      assert.equal(unwrap(validator.checkResponseShape(response)).bound, false)
    }
  }
)

test(
  '终端 request/response 独立预算不被通用 frame_bytes 放宽',
  /* 分别缩紧终端请求与响应预算，确认通用帧预算不能覆盖它们。 */ () => {
    const input = {
      id: 'terminal-bytes',
      method: 'terminal.backend.validate',
      params: { server_generation: G, terminal_id: T, pane_id: '3' }
    }
    const response = {
      id: input.id,
      result: { type: 'terminal_backend_validation', state: 'alive' }
    }
    const exact = request(
      limitedView({}, { request_bytes: frameBytes(input), response_bytes: frameBytes(response) }),
      input
    )
    unwrap(validator.checkResponse(exact, response, sourceFor(exact.binding)))
    rejects(
      validator.checkRequest(limitedView({}, { request_bytes: frameBytes(input) - 1 }), input),
      'native_request_invalid'
    )
    const lower = request(limitedView({}, { response_bytes: frameBytes(response) - 1 }), input)
    rejects(validator.checkResponse(lower, response, sourceFor(lower.binding)), 'native_response_invalid')
  }
)

test(
  '执行必需的在线字节预算缺失或为零时不产生 capability handle',
  /* 逐项删除或清零执行帧必需预算，确认能力绑定立即拒绝。 */ async () => {
    for (const path of [
      ['limits', 'frame_bytes'],
      ['terminal', 'limits', 'request_bytes'],
      ['terminal', 'limits', 'response_bytes']
    ]) {
      for (const missing of [true, false]) {
        const caps = json('session-capabilities.json')
        caps.result.session = 'synthetic'
        caps.result.server_generation = G
        let parent = caps.result
        for (const key of path.slice(0, -1)) {
          parent = parent[key]
        }
        if (missing) {
          delete parent[path.at(-1)!]
        } else {
          parent[path.at(-1)!] = 0
        }
        rejects(validator.bindCapabilities(caps, source()), 'capability_invalid')
      }
    }
  }
)

const syntheticUri = 'https://luvus.dev/protocol/uhp/v1/schema/synthetic-resource.schema.json'
// 向样本加入合成 schema 并重算摘要，返回实际契约编译结果。
function compileSynthetic(schema: Record<string, unknown>) {
  const bundle = json('schema-bundle.json')
  bundle.documents[syntheticUri] = {
    $id: syntheticUri,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...schema
  }
  const encoded = JSON.stringify(bundle)
  return compileBundle(encoded, {
    identity: { ...identity, schema_sha256: createHash('sha256').update(encoded).digest('hex') }
  })
}

test(
  '结构嵌套叠加长引用链仍返回 schema 不可用，不耗尽 JS 调用栈',
  /* 构造深结构叠加长引用链，确认按引用预算拒绝且不会耗尽调用栈。 */ async () => {
    const defs: Record<string, unknown> = {}
    for (let i = 0; i < 900; i++) {
      let schema: Record<string, unknown> = i === 899 ? { type: 'string' } : { $ref: `#/$defs/r${i + 1}` }
      for (let depth = 0; depth < 40; depth++) {
        schema = { items: schema }
      }
      defs[`r${i}`] = schema
    }
    const result = await compileSynthetic({ $defs: defs, $ref: '#/$defs/r0' })
    rejects(result, 'schema_unavailable')
    if (!result.ok) {
      assert.equal(result.error.reason, 'reference_limit')
    }
  }
)

test(
  '引用闭包共享叶子不会误报环，最大 32 条引用可编译且第 33 条拒绝',
  /* 验证共享叶子不被误判为环，并精确覆盖 32 与 33 条引用的分界。 */ async () => {
    const defs: Record<string, unknown> = {}
    for (let i = 0; i < 32; i++) {
      defs[`r${i}`] = i === 31 ? { type: 'string' } : { items: { $ref: `#/$defs/r${i + 1}` } }
    }
    const schema = {
      $defs: defs,
      properties: { left: { $ref: '#/$defs/r0' }, right: { $ref: '#/$defs/r0' } }
    }
    unwrap(await compileSynthetic(schema))
    defs.r31 = { $ref: '#/$defs/leaf' }
    defs.leaf = { type: 'string' }
    const result = await compileSynthetic(schema)
    rejects(result, 'schema_unavailable')
    if (!result.ok) {
      assert.equal(result.error.reason, 'reference_limit')
    }
  }
)

test(
  '缺失文档/fragment 与引用环均离线拒绝，不抓取远端或本地路径',
  /* 用禁止联网的替身覆盖缺失文档、片段和引用环，确认编译始终离线。 */ async () => {
    const fetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = /* 记录任何意外网络解析并立即抛错，使测试能检测在线抓取。 */ (() => {
      requests++
      throw new Error('禁止网络 resolver')
    }) as typeof fetch
    try {
      for (const [ref, reason] of [
        ['https://untrusted.invalid/schema.json', 'missing_document'],
        ['file:///synthetic/not-a-real-file.json', 'missing_document'],
        ['#/$defs/missing', 'missing_fragment'],
        ['#', 'reference_cycle']
      ]) {
        const result = await compileSynthetic({ $ref: ref })
        rejects(result, 'schema_unavailable')
        if (!result.ok) {
          assert.equal(result.error.reason, reason)
        }
      }
      assert.equal(requests, 0)
    } finally {
      globalThis.fetch = fetch
    }
  }
)
