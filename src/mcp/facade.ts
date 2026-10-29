// 将严格校验的 MCP 工具请求交给受信 caller 与统一业务服务，并限制公开结果和诊断。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import { canonical, digest } from '../contracts.js'
import { cliMessages, type CliLanguage } from '../cli/messages.js'
import { validateHostProfile } from '../wire/index.js'
import {
  isToolName,
  MAX_MCP_BYTES,
  parseToolArguments,
  PRODUCT_VERSION,
  toolDefinition,
  toolNames,
  TOOLS_PAGE_SIZE
} from './schema.js'
import {
  FacadeServiceError,
  NativeRequestNotDispatchedError,
  SERVICE_ERROR_CODES,
  type GatewayService,
  type McpContextProvider,
  type ToolName
} from './types.js'

export type DiagnosticCode = 'mcp_transport_error' | 'mcp_service_error' | 'mcp_shutdown_error'
export type FacadeOptions = {
  service: GatewayService
  context: McpContextProvider
  // 显示语言由唯一 CLI 入口解析后传入；省略时工具目录与说明按英文输出。
  language?: CliLanguage
  // 接收固定诊断码供宿主写入受控日志，不传递原始参数或异常。
  diagnostic?: (code: DiagnosticCode) => void
}

// 同时生成结构化结果与兼容 JSON 文本副本，保持两者内容一致。
function result(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  }
}

// 将稳定网关拒绝码包装为工具错误，不透传服务异常文本。
function failed(code: string, outcome?: 'not_dispatched', details?: unknown): CallToolResult {
  return result({ gateway_error: { code, ...(outcome ? { outcome } : {}), ...(details ? { details } : {}) } }, true)
}

// 仅投影公开字段，剔除服务误带的本机配置或凭据字段。
function pick(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap(
      /* 缺失字段不投影为 undefined：规范编码拒绝 undefined，会让整条回复失败。 */
      (key) => (data[key] === undefined ? [] : [[key, data[key]]])
    )
  )
}

// 按工具职责收窄公开视图，只投影允许字段。
function publicReply(name: ToolName, data: Record<string, unknown>): Record<string, unknown> {
  const machineKeys = ['machine_id', 'name', 'status', 'link', 'platform', 'targets']
  const providerKeys = [
    'machine_id',
    'provider_id',
    'kind',
    'binding_revision',
    'enabled',
    'readiness',
    'native_version',
    'schema_status',
    'schema_sha256'
  ]
  if (name === 'machines_get') {
    const output = pick(data, [...machineKeys, 'last_seen_at', 'link_since'])
    // host 是新的嵌套公开块：逐层白名单，误带路径、网络、环境等字段也不能穿过门面。
    try {
      if (data.host && typeof data.host === 'object') {
        const host = data.host as Record<string, unknown>
        const report = pick(host, [
          'os',
          'arch',
          'cpus',
          'cpu_quota',
          'cpu_quota_status',
          'memory_bytes',
          'container',
          'agent_version',
          'providers'
        ])
        report.os = pick(host.os as Record<string, unknown>, ['family', 'distribution', 'kernel'])
        const providers = new Set(Array.isArray(data.targets) ? data.targets.map((target) => target.provider_id) : [])
        report.providers = (host.providers as Record<string, unknown>[])
          .filter((provider) => providers.has(provider.provider_id))
          .map((provider) => pick(provider, ['provider_id', 'native_version']))
        validateHostProfile(report)
        if (
          host.source === 'connector_handshake' &&
          Number.isSafeInteger(host.reported_at) &&
          Number(host.reported_at) >= 0
        ) {
          output.host = { ...report, reported_at: host.reported_at, source: host.source }
        }
      }
    } catch {
      /* 缺失或非法的可选块不影响旧 Connector 的基础设备视图。 */
    }
    return output
  }
  if (name === 'providers_get') {
    return pick(data, providerKeys)
  }
  if (name === 'runtime_response_discard') {
    return pick(data, ['call_id', 'content_status'])
  }
  if (name === 'machines_list' || name === 'providers_list') {
    if (!Array.isArray(data.items) || data.items.length > 100) {
      throw new Error('invalid_page_reply')
    }
    if (data.next_cursor !== undefined && (typeof data.next_cursor !== 'string' || data.next_cursor.length > 1024)) {
      throw new Error('invalid_page_cursor')
    }
    const fields = name === 'machines_list' ? machineKeys : providerKeys
    return {
      items: data.items.map(/* 逐条收窄设备或 provider 展示记录，不输出额外配置字段。 */ (item) => pick(item, fields)),
      ...(data.next_cursor === undefined ? {} : { next_cursor: data.next_cursor })
    }
  }
  return data
}

// 计入文本副本和转义后的完整结果预算；超限只交付元数据，不重发或造句柄。
function boundedResult(name: ToolName, data: Record<string, unknown>, isError: boolean): CallToolResult {
  const encoded = canonical(data)
  const snapshot = JSON.parse(encoded) as Record<string, unknown>
  const reply = result({ data: snapshot }, isError)
  // 包括兼容 text 副本；预留 JSON-RPC envelope 和最大 128 字节的请求 ID。
  if (Buffer.byteLength(JSON.stringify(reply)) <= MAX_MCP_BYTES - 1024) {
    return reply
  }
  // 结果页的 text 只是 base64 正文的附加表示：先撤掉它再评估，正文页不能因附加表示被整页拒绝。
  if (name === 'runtime_result_read' && typeof snapshot.text === 'string') {
    delete snapshot.text
    const reduced = result({ data: snapshot }, isError)
    if (Buffer.byteLength(JSON.stringify(reduced)) <= MAX_MCP_BYTES - 1024) {
      return reduced
    }
  }
  const callId = snapshot.call_id
  return result(
    {
      gateway_error: { code: 'response_too_large' },
      delivery: {
        truncated: true,
        bytes: Buffer.byteLength(encoded),
        sha256: digest(encoded),
        ...(typeof callId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(callId) ? { call_id: callId } : {})
      }
    },
    true
  )
}

// 仅解析静态工具目录的已知页边界，不把业务游标当作授权。
function toolOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0
  }
  const offsets = toolNames()
    .map(/* 枚举静态目录位置，供构造合法分页边界。 */ (_, index) => index)
    .filter(/* 保留后续完整页的起点，拒绝任意偏移量。 */ (index) => index > 0 && index % TOOLS_PAGE_SIZE === 0)
  const offset = offsets.find(
    /* 精确匹配服务生成的目录游标，不接受宽松编码变体。 */ (index) =>
      cursor === Buffer.from(`rovloom-tools-v1:${index}`).toString('base64url')
  )
  if (offset === undefined) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor')
  }
  return offset
}

// 组装 SDK 工具门面；身份和业务门禁依赖受信服务，不创建执行后端。
export function createMcpFacade(options: FacadeOptions): Server {
  const language = options.language ?? 'en'
  const server = new Server(
    { name: 'rovloom', version: PRODUCT_VERSION },
    {
      capabilities: { tools: {} },
      instructions: cliMessages(language)['mcp.instructions']
    }
  )
  let initialized = false
  let inflight = 0
  const reported = new Set<DiagnosticCode>()
  const diagnostic = /* 每种固定诊断至多报告一次，防止错误流量造成无界日志。 */ (code: DiagnosticCode) => {
    if (!reported.has(code)) {
      reported.add(code)
      options.diagnostic?.(code)
    }
  }
  server.oninitialized = /* 只有 SDK 已收到初始化信息后才开放工具处理。 */ () => {
    initialized = server.getClientVersion() !== undefined
  }
  server.onclose = /* 连接关闭后阻止新工具执行，不改变已提交工作的远端状态。 */ () => {
    initialized = false
  }
  server.onerror = /* 将 SDK 异常收敛为固定传输诊断，隐藏原消息和私有路径。 */ () => diagnostic('mcp_transport_error')

  const requireInitialized = /* 在工具处理前检查初始化状态，拒绝跳过握手的请求。 */ () => {
    if (!initialized) {
      throw new McpError(ErrorCode.InvalidRequest, 'Initialization required')
    }
  }
  server.setRequestHandler(
    ListToolsRequestSchema,
    /* 返回静态工具目录的一页和后续游标，不查询或泄露业务资源。 */ (request) => {
      requireInitialized()
      const offset = toolOffset(request.params?.cursor)
      const names = toolNames()
      const next = offset + TOOLS_PAGE_SIZE
      return {
        tools: names.slice(offset, next).map((name) => toolDefinition(name, language)),
        ...(next < names.length ? { nextCursor: Buffer.from(`rovloom-tools-v1:${next}`).toString('base64url') } : {})
      }
    }
  )
  server.setRequestHandler(
    CallToolRequestSchema,
    /* 验证参数并重新解析 caller，只调用一次服务；取消信号仅控制前端等待。 */ async (request, extra) => {
      requireInitialized()
      const name = request.params.name
      if (!isToolName(name)) {
        throw new McpError(ErrorCode.InvalidParams, 'Unknown tool')
      }
      let args
      try {
        args = parseToolArguments(name, request.params.arguments ?? {})
      } catch {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid tool arguments')
      }
      if (inflight >= 16) {
        return failed('busy')
      }
      inflight++
      try {
        const binding = await options.context.resolve(extra.signal)
        if (
          !binding ||
          typeof binding.caller.principal_id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(binding.caller.principal_id)
        ) {
          return failed('unauthenticated')
        }
        if (binding.wait_signal.aborted || extra.signal.aborted || !initialized) {
          return failed('unavailable')
        }
        const context = Object.freeze({
          caller: Object.freeze({ principal_id: binding.caller.principal_id }),
          wait_signal: binding.wait_signal
        })
        const reply = await options.service.execute(name, args, context)
        const data = publicReply(name, reply.data as Record<string, unknown>)
        return boundedResult(name, data, reply.is_error === true)
      } catch (error) {
        if (error instanceof FacadeServiceError && SERVICE_ERROR_CODES.includes(error.code)) {
          return failed(
            error.code,
            error instanceof NativeRequestNotDispatchedError ? error.outcome : undefined,
            error instanceof NativeRequestNotDispatchedError && error.parameterDiagnostic
              ? {
                  issues: error.parameterDiagnostic.issues.map(({ path, rule }) => ({ path, rule })),
                  ...(error.parameterDiagnostic.parameter_help
                    ? { parameter_help: error.parameterDiagnostic.parameter_help }
                    : {})
                }
              : undefined
          )
        }
        // 不透传服务异常、路径、原参数或 SDK 诊断文本。
        diagnostic('mcp_service_error')
        return failed('internal_error')
      } finally {
        inflight--
      }
    }
  )
  return server
}
