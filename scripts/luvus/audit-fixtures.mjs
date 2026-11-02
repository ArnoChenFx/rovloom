// 离线审计原生 fixture 的完整性与语义，并从 schema 和采集证据生成方法覆盖账本。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { verifyNativeTrace } from './native-trace.mjs'

export const fixtureRoot = fileURLToPath(new URL('../../test/fixtures/luvus/0.14.3/linux/', import.meta.url))
// 从指定 fixture 目录同步读取并解析命名 JSON 文件。
export const readJson = (name, root = fixtureRoot) => JSON.parse(readFileSync(resolve(root, name), 'utf8'))
// 计算原始字节或文本的 SHA-256 十六进制摘要。
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// 仅使用 bundle 自带文档编译完整 schema 闭包，缺失引用时失败。
export function offlineSchemas(bundle) {
  // strict:false 仅关闭上游 schema 的风格警告；不改写 schema、不补默认值、不转换数据。
  // 不提供 loadSchema，编译只使用安装包的固定 documents 映射，缺失引用直接失败。
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  })
  for (const [url, schema] of Object.entries(bundle.documents)) {
    ajv.addSchema(schema, url)
  }
  for (const url of Object.keys(bundle.documents)) {
    assert(ajv.getSchema(url))
  }
  return ajv
}

// 验证清单、哈希及协议记录，重建原生证据后返回请求、响应和事件计数。
export function inspectFixtures(root = fixtureRoot) {
  const manifest = readJson('manifest.json', root)
  const required = [
    'assertions.json',
    'environment.json',
    'host-capabilities.json',
    'schema-bundle.json',
    'session-capabilities.json',
    'terminal-identity.json',
    'terminal-inventory.json',
    'transcript.json'
  ]
  assert.deepEqual(Object.keys(manifest.files).sort(), required.sort(), 'manifest must cover every required artifact')
  assert.deepEqual(
    readdirSync(root).sort(),
    [...required, 'manifest.json'].sort(),
    'unrelated or unmanifested fixture file'
  )
  for (const [name, info] of Object.entries(manifest.files)) {
    assert.equal(name, name.split('/').at(-1))
    assert(lstatSync(resolve(root, name)).isFile(), 'fixture must be a regular file')
    const bytes = readFileSync(resolve(root, name))
    assert.equal(sha256(bytes), info.sha256, name)
    assert.equal(bytes.length, info.bytes, name)
  }
  const bundle = readJson('schema-bundle.json', root)
  const transcript = readJson('transcript.json', root)
  const environment = readJson('environment.json', root)
  assert.equal(environment.native_collection_completed, true)
  assert(readJson('assertions.json', root).every(/* 采集断言必须全部报告成功。 */ (row) => row.passed))
  const ajv = offlineSchemas(bundle)
  const requests = new Map()
  const totals = {
    requests: 0,
    responses: 0,
    events: 0,
    intentional_invalid: 0,
    documents: Object.keys(bundle.documents).length
  }
  const invalid = new Set(['proxy-unknown-method', 'input-invalid'])
  // 用已编译的文档校验值，并在失败时附上消息标签和 schema 错误。
  const validate = (schema, value, label) => {
    const check = ajv.getSchema(schema.$id)
    assert(check(value), `${label}: ${JSON.stringify(check.errors)}`)
  }
  // 检查请求是否符合预期有效性，更新计数并保存请求以关联后续响应。
  function request(value) {
    if (invalid.has(value.id)) {
      const check = ajv.getSchema(value.action ? bundle.terminal.control_frame.$id : bundle.request.$id)
      assert.equal(check(value), false, value.id)
      totals.intentional_invalid++
    } else {
      validate(value.action ? bundle.terminal.control_frame : bundle.request, value, value.id)
      totals.requests++
    }
    requests.set(value.id, value)
  }
  // 分别验证事件和请求响应，并要求响应能关联到已捕获的请求。
  function response(value) {
    if (value.event) {
      validate(bundle.event, value, value.event)
      if (value.event.startsWith('terminal.')) {
        validate(bundle.terminal.event, value, value.event)
      }
      if (Object.hasOwn(bundle.event_catalog.properties, value.event)) {
        const check = ajv.compile({
          $ref: `${bundle.event_catalog.$id}#/properties/${value.event}`
        })
        assert(check(value.data), `${value.event}: ${JSON.stringify(check.errors)}`)
      } else {
        assert.equal(value.event, 'terminal.frame', '未知事件不得冒充已验证')
      }
      totals.events++
    } else {
      validate(bundle.response, value, value.id)
      const sent = requests.get(value.id)
      assert(sent, 'response must correlate to a captured request')
      if (sent.method?.startsWith('terminal.backend.') || sent.action) {
        validate(bundle.terminal.response, value, value.id)
      }
      totals.responses++
    }
  }
  for (const record of transcript) {
    if (record.kind === 'send') {
      request(JSON.parse(record.wire))
    }
    if (record.kind === 'receive') {
      response(JSON.parse(record.wire))
    }
    if (record.kind !== 'process' || record.argv.slice(-2).join(' ') !== 'uhp proxy') {
      continue
    }
    if (record.label !== 'proxy-malformed-json') {
      request(JSON.parse(record.stdin.split('\n')[0]))
    }
    if (record.stdout) {
      response(JSON.parse(record.stdout))
    }
  }
  const schemaRun = transcript.find(
    /* 定位安装版 schema 的原始导出记录以核对哈希。 */ (row) => row.label === 'installed-schema'
  )
  assert.equal(sha256(readFileSync(resolve(root, 'schema-bundle.json'))), schemaRun.raw_stdout_sha256)
  // 只检查交付的合成记录，不扫描用户目录；禁止向采集器传入原生认证字段。
  for (const request of requests.values()) {
    assert.equal(Object.hasOwn(request, 'auth'), false)
  }
  assert.equal(
    transcript.filter(/* 提取服务退出记录以确认最终退出码成功。 */ (row) => row.kind === 'server_exit').at(-1)
      .exit_code,
    0
  )
  verifyNativeTrace(transcript, environment, {
    host: readJson('host-capabilities.json', root),
    session: readJson('session-capabilities.json', root),
    identity: readJson('terminal-identity.json', root),
    inventory: readJson('terminal-inventory.json', root),
    stalePane: JSON.parse(readFileSync(new URL('../../test/fixtures/luvus/0.14.3/stale-pane.json', import.meta.url)))
  })
  return totals
}

// 合并 schema 与实时方法目录，记录各方法的传输、证据及尚未启用的原因。
export function coverage(root = fixtureRoot) {
  const bundle = readJson('schema-bundle.json', root)
  const session = readJson('session-capabilities.json', root).result
  const host = readJson('host-capabilities.json', root).result
  const transcript = readJson('transcript.json', root)
  const nativeCalls = new Map()
  const nativeResponses = new Map()
  for (const row of transcript) {
    if (row.kind === 'receive') {
      const value = JSON.parse(row.wire)
      if (value.id) {
        nativeResponses.set(value.id, value)
      }
    }
    let request
    if (row.kind === 'send') {
      request = JSON.parse(row.wire)
    }
    if (
      row.kind === 'process' &&
      row.argv.slice(-2).join(' ') === 'uhp proxy' &&
      row.label !== 'proxy-malformed-json'
    ) {
      request = JSON.parse(row.stdin.split('\n')[0])
      if (row.stdout) {
        nativeResponses.set(request.id, JSON.parse(row.stdout))
      }
    }
    if (request?.method) {
      nativeCalls.set(request.id, request.method)
    }
  }
  const schemaMethods = bundle.request.properties.method.enum
  const liveMethods = [...session.methods, ...host.methods]
  const methods = [...new Set([...schemaMethods, ...liveMethods])].sort()
  const streamMethods = new Set([
    'events.subscribe',
    'terminal.backend.events.subscribe',
    'terminal.backend.observe',
    'terminal.backend.control'
  ])
  const rows = methods.map(
    /* 汇总单个方法的 profile、schema 分支、原生证据和阻塞原因。 */ (method) => {
      const inSession = session.methods.includes(method)
      const inHost = host.methods.includes(method)
      const profile = inSession
        ? 'session'
        : inHost
          ? 'host'
          : method.startsWith('machine.')
            ? 'access_machines'
            : 'unknown'
      const contract = (inSession ? session : host).method_contracts.find(
        /* 从方法所属 profile 的目录中匹配原生契约。 */ (row) => row.method === method
      )
      const branches = (bundle.request.allOf ?? []).flatMap(
        /* 提取约束当前方法参数的条件分支引用。 */ (branch, index) => {
          const condition = branch.if?.properties?.method
          return condition?.const === method || condition?.enum?.includes(method) ? [`#/allOf/${index}`] : []
        }
      )
      const evidence = [...nativeCalls.entries()]
        .filter(/* 仅保留当前方法的采集调用。 */ ([, m]) => method === m)
        .map(
          /* 按请求编号区分原生错误、成功结果和无响应。 */ ([id]) => ({
            id,
            outcome: nativeResponses.get(id)?.error
              ? 'native_error'
              : nativeResponses.has(id)
                ? 'native_result'
                : 'no_response'
          })
        )
      let reason = 'adapter_not_implemented'
      if (profile === 'access_machines') {
        reason = 'profile_not_exposed'
      } else if (profile === 'unknown') {
        reason = 'unknown_profile_fail_closed'
      } else if (!schemaMethods.includes(method)) {
        reason = 'schema_unavailable'
      } else if (!contract) {
        reason = 'permission_unclassified_fail_closed'
      } else if (method.startsWith('uhp.token.')) {
        reason = 'credential_custody_not_implemented'
      } else if (contract.scope === 'admin') {
        reason = 'admin_disabled_pending_explicit_authorization'
      } else if (!branches.length) {
        reason = 'parameter_schema_incomplete'
      }
      return {
        method,
        profile,
        transport:
          profile === 'host'
            ? 'host_stdio_proxy'
            : streamMethods.has(method)
              ? 'persistent_local_stream'
              : profile === 'session'
                ? 'single_request_rpc'
                : 'not_exposed',
        schema: schemaMethods.includes(method)
          ? {
              document: bundle.request.$id,
              branches,
              parameter_detail: branches.length ? 'conditional_branch' : 'generic_params_only'
            }
          : null,
        native_contract: contract ?? null,
        gateway_permission: 'not_enabled',
        gateway_status: 'not_implemented',
        reason,
        native_evidence: evidence
      }
    }
  )
  return {
    format: 1,
    binary: '0.14.3',
    protocol: bundle.protocol,
    counts: {
      union: methods.length,
      session: session.methods.length,
      host: host.methods.length,
      schema: schemaMethods.length,
      access_machines: rows.filter(/* 统计未暴露的机器访问 profile 方法。 */ (r) => r.profile === 'access_machines')
        .length,
      stream: rows.filter(/* 统计需要持久本地流的方法。 */ (r) => r.transport === 'persistent_local_stream').length
    },
    methods: rows
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const totals = inspectFixtures()
  const ledger = coverage()
  if (process.argv.includes('--write')) {
    writeFileSync(
      new URL('../../test/fixtures/native-contract/coverage.json', import.meta.url),
      JSON.stringify(ledger, null, 2) + '\n'
    )
  } else {
    assert.deepEqual(
      JSON.parse(readFileSync(new URL('../../test/fixtures/native-contract/coverage.json', import.meta.url))),
      ledger
    )
  }
  console.log(JSON.stringify({ native_fixture_validation: totals, coverage: ledger.counts }, null, 2))
}
