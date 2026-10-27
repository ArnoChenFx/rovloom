# MCP Streamable HTTP 接口

本文说明 Gateway 对 MCP 客户端暴露的 HTTP 接口：传输、边界限额、工具、结果格式和调用顺序。代码在 `src/mcp/`，工具参数的权威定义是 [`src/mcp/schema.ts`](../../src/mcp/schema.ts)。系统语义见 [DESIGN](../DESIGN.md#7-mcp-工具面)。

## 传输与会话

- 协议：MCP 2025-11-25，基于官方 TypeScript SDK 的 Streamable HTTP。不提供 stdio，也不兼容旧的 HTTP+SSE。
- 端点固定为 `/mcp`，监听网卡和端口由 `mcp.hostname` / `mcp.port` 决定（端口默认 9444）。公网访问由外部反向代理终止 TLS，无需公网 URL 配置；支持任意域名、端口以及保留或改写 Host。客户端直接填写代理的 HTTPS `/mcp` 地址。不接受 query、userinfo 或其它路径。
- 每个 MCP 会话独立拥有 Server 与 transport，所有会话共用同一业务服务。会话 ID 只用于路由，不是身份。
- 默认最多 64 个会话，空闲 15 分钟后回收。最多 256 个 HTTP 请求同时等待，超出返回 429。每个请求的 deadline 为 35 秒（宿主上限 60 秒）。
- 每个会话最多 16 个工具请求同时进行，超出返回 `gateway_error: busy`。
- 请求取消、HTTP 断开和会话 `DELETE` 只停止前端等待。它们不会调用 `runtime_call_cancel`，不表示原生取消、回滚、`not_dispatched` 或可以重发，持久的 `outcome_unknown` 锚点保留。
- 没有 event store，不承诺断线后重放事件。失败后的业务重试仍受原 `client_request_key` 约束。
- 客户端退出或 stdin EOF 不会停止 Gateway。

## 认证与访问控制

- 每个 HTTP 请求都要带 `Authorization: Bearer <令牌>`，并与会话绑定的主体精确匹配。令牌由 `rovloom token` 管理，见 [DESIGN](../DESIGN.md#5-认证)。
- 不从本机 UID、转发头、工具参数、`_meta` 或 `Mcp-Session-Id` 建立身份。MCP 身份不能获得管理员权限。
- `Host` 须与本次请求 URL 一致，但不限定部署域名。`Origin` 可以是浏览器看到的 HTTP/HTTPS 地址，不必等于代理内部地址；明确标记 cross-site / same-site 的浏览器请求仍拒绝，且不开放跨站 CORS。认证不依赖 `X-Forwarded-*` 等转发头。
- 管理 UI 和 API、设备 WSS 与 MCP 是三个独立的 listener，身份和权限互不通用。

## 请求边界

| 项 | 限制 |
|---|---|
| 请求体 | 1 MiB，在 JSON 解析之前检查并受 deadline 约束 |
| 请求头总量 | 16 KiB |
| 单个工具参数 | 64 KiB |
| 完整 JSON-RPC 响应（含文本副本与转义） | 64 KiB |
| 字符串请求 ID | 128 字节，协议关联最多 1024 项 |
| `tools/list` | 每页 5 项，使用 SDK 标准的 `nextCursor` |

- 严格拒绝重复 JSON 键、非法或截断的 UTF-8、过深或过多节点，以及批量 JSON-RPC。
- 所有工具的参数根都拒绝未知字段。
- 同一个请求 ID 在途时重复提交返回 409。旧请求的收尾、断开和晚到回复不会清除或取消同 ID 的新请求。
- SSE 响应起始只有一条刷新响应头的注释，没有额外的 MCP 通知。
- 诊断输出只包含固定代码，不含请求值、异常、私人路径或栈。stdout 不承载 MCP，stderr 只输出固定诊断码。

## 工具

共 11 个工具。不提供流、Host 特权捷径、provider 管理或 `luvus_*` 别名。

| 工具 | 参数 |
|---|---|
| `machines_list` | `cursor?`, `limit?`（1–100） |
| `machines_get` | `machine_id` 或 `name`（二选一） |
| `providers_list` | `machine_id`, `cursor?`, `limit?` |
| `providers_get` | `machine_id`, `provider_id` |
| `runtime_discover` | `target`, `expected_binding_revision`, `cursor?`, `limit?` |
| `runtime_describe` | `target`, `expected_binding_revision`, `method` |
| `runtime_call` | `target`, `expected_binding_revision`, `contract_ref`, `native_request {method, params?}`, `deadline`, `wait_ms?`, `validation?`, `client_request_key?` |
| `runtime_call_get` | `call_id`, `wait_ms?` |
| `runtime_call_cancel` | `call_id` |
| `runtime_result_read` | `result_id`, `cursor?`, `max_bytes?` |
| `runtime_response_discard` | `call_id` |

- **Target**：`{machine_id, provider_id, profile: "session", session}` 或 `{machine_id, provider_id, profile: "host"}`。host 形态不得带 `session`。
- 调用方不能提交 principal、admin、`discard_response`，也不能在 `native_request` 中填写 `id` 或 `auth`。
- 设备与 provider 的公开视图只含固定字段。设备：`machine_id`、`name`、`status`、`link`、`targets`。provider：`machine_id`、`provider_id`、`kind`、`binding_revision`、`enabled`、`readiness`。
- `targets` 列出调用方在该设备上当前获授权的完整 tuple，逐字段与 `runtime_*` 的 `target` 相同，因此可直接回传；`runtime_*` 的可见性检查按完整 tuple 相等判定，改动其中任一字段（含 `session`）都会得到 `not_found`。
- `link` 与 `readiness` 来自 Gateway 的真实传输观测，不再恒为 `unverified`：`link` 只有在同一取样中有可信在线证据时才为 `connected`；`readiness` 只有在观测的 `binding_revision` 与当前绑定一致且派发就绪时才为 `ready`。没有观测来源、观测过期或缺少该设备/provider 时，两者保持 `unverified`，不从持久状态推断。
- 所有列表、计数和描述按调用方的授权过滤。`runtime_discover` 与 `runtime_describe` 只描述能力，不授予执行权限。

### runtime_call

- `expected_binding_revision`、`contract_ref` 和 `deadline` 必填。`deadline` 是未来的 Unix 毫秒绝对时间，登记时须在 10 分钟之内。
- `wait_ms` 默认 0，上限 5000，只控制前端短等，与执行期限独立。
- `validation` 省略时由 Gateway 按 provider 与方法选择：
  - Herdr 使用 `strict`。
  - Luvus 的 `pane.list`、`agent.prompt`、`agent.send`、`agent.wait`、`agent.keys` 使用 `strict`。
  - Luvus 其余已审核方法（如 `workspace.list`）使用 `raw-contract`。
  - 显式给出与方法要求不符的模式，会在登记前以 `native_request_invalid` 拒绝。
- `client_request_key`（可选）在同一主体内去重，窗口为 `metadata_ttl`。Gateway 不生成也不更换 key。重发同一意图必须使用原 key。
- 超过 `wait_ms` 仍未完成时，返回 `call_id` 与当前状态。用 `runtime_call_get` 查询，超时不代表可以重新提交。

### 结果与取消

- 成功时返回 `structuredContent: {data: ...}`，并附带 JSON 文本副本。
- `runtime_call` 与 `runtime_call_get` 返回调用元数据和 `result` 句柄。元数据响应不标记原生 error。
- `runtime_result_read` 以页为单位交付原始响应字节，`encoding` 为 `utf8` 或 `base64`。原生 `error.code / message / data` 保持原文，不改成网关错误。每页带 `total_bytes`、`sha256`、`expires_at` 和 `eof`。
- `max_bytes` 默认 4096，上限 16384。结果按 UTF-8 或编码边界切页。
- `runtime_call_cancel` 的 `cancellation` 取 `waiting_stopped`、`bridge_stopped`、`native_confirmed`、`unsupported`、`outcome_unknown`，只报告实际能确认的程度。
- `runtime_response_discard` 是独立动作，要求验证归属、原方法当前的读取策略和专门的 `discard_response` 权限。

### 错误

- 网关拒绝返回 `isError: true` 与 `gateway_error: {code}`。`code` 取下列之一：`backend_unavailable`、`invalid_arguments`、`native_request_invalid`、`internal_error`、`unauthenticated`、`forbidden`、`unavailable`、`not_found`、`conflict`、`invalid_cursor`、`binding_revision_conflict`、`contract_unavailable`、`unsupported`、`confirmation_required`、`storage_exhausted`、`storage_degraded`、`content_unavailable`、`deadline_exceeded`、`busy`。
- 有效 token 可读取其设备范围内 provider 的全部已暴露目录，不再逐方法取 caller/local 授权交集。`runtime_describe not_found` 表示不在该授权目录，不能区分不存在、未审核和不可见的方法，也不能据此断言原生 schema 中没有它；不泄露隐藏方法的存在性。调用时的 `forbidden` 可表示设备范围或原生权限拒绝；MCP 不再存在额外的方法白名单。
- 新调用的 `contract_ref` 与当前批准契约不符时，授权后的登记预检返回 `gateway_error: {code: "contract_unavailable"}`，不建立 call、不占用请求 key、不发送 Wire 帧，也不关闭设备连接。重新 `runtime_discover/describe` 获取当前引用后才能提交新意图；不要将拒绝理解为原生执行失败。已存在的同 key、同请求仍查询原调用，不因契约变化而重新派发；同 key 换契约引用是不同请求，返回 `conflict`。
- `native_request_invalid` 在 Luvus 或 Herdr 的完整请求 schema 于登记预检阶段被拒时附带 `outcome: "not_dispatched"`：此时还没有建立 call 或派发锚点，坏请求不占用 key，不发送 Wire 帧，不关闭设备连接。已有 key 仍返回原调用的真实状态，旧的 unknown 不会倒退或重派。预检通过不授予执行权限，网关不返回参数或 schema 的错误正文。
- 响应超过 64 KiB 时，只返回 `response_too_large`、`truncated`、字节数、hash 和适用的 `call_id`，不制造句柄，也不再次执行。
- 未知工具或非法参数返回固定的 JSON-RPC 错误，不回显请求值、异常、路径或栈。

## 分页与游标

- 业务列表与结果的游标由服务生成，绑定调用方、查询、位置、当前授权和期限。服务实例用私有的 HMAC-SHA256 密钥签名，没有逐页的服务端记录，不占共享名额。
- 游标不能当作授权。每一页都重新验证当前身份与授权。过期、被篡改、跨调用方 / 结果 / 页大小、查询变化或服务重启后的游标返回 `invalid_cursor`。
- 结果游标的首个后继期限为当前时间加 30 秒与句柄实际期限中较早者。之后所有后继沿用该期限或更早的句柄期限，翻页和重试都不续期。
- 同一有效游标重复读取返回相同的页和相同的后继引用（包括 EOF 页）。不带游标的重新读取可以开始新的下载，但不会延长结果的有效期。

## 管理接口

设备、provider、健康和权限快照等管理读写由独立的管理 listener 提供（默认 `127.0.0.1:9445`），不经 MCP。管理员认证、Cookie / CSRF、确认流程见 [管理 UI](../GATEWAY-WEBUI.md)。MCP 不提供设备注册、改名、撤销和 provider 启停。

## 命令行

```sh
rovloom --help
rovloom config template gateway|connector
rovloom config check [--role gateway|connector] [--config ABS]
rovloom config check-runtime [--role gateway|connector] [--config ABS]
rovloom gateway [--issue-code] [--config ABS] [--non-interactive]
rovloom connector --join <ws://host:port#pairing-code> [--config ABS]
rovloom connector [--repair] [--config ABS] [--non-interactive]
rovloom token --help
rovloom admin --help
rovloom service --help
```

- 两个角色使用同一个可执行文件和版本，每个角色只有一份用户 JSON 配置，字段、默认值和平台限制见 [配置参考](../CONFIGURATION-zh.md)。省略 `--config` 时读取 `~/.config/rovloom/gateway.json` 或 `connector.json`。
- 配置文件缺失时，首次运行会生成默认文件（Linux 上文件权限 0600，目录 0700），已有文件不会被覆盖。`config check` 与 `config check-runtime` 只读，不创建文件。
- 首次运行用管理页或 `--issue-code` 生成一机一码，Connector 执行 `--join` 一次完成，无需终端问答。缺少配对状态时明确拒绝，返回 `configuration_required`，不等待 stdin。
- Connector 通过 `native.provider` 选择 `luvus`（默认）、`herdr` 或 `mixed`。
- `stdout` 只在 `config template` 时输出非秘密的 JSON。帮助、版本、检查结果和错误写 `stderr`。Gateway 运行期的 `stdout` 不承载 MCP 或身份材料。
- 退出码：0 成功或正常关闭，2 参数或配置错误，3 缺少后端，1 运行或关闭失败。收到 SIGINT 或 SIGTERM 时，Gateway 关闭本地资源后退出。
- 开机服务见 [SERVICE](../SERVICE.md)。

<a id="client-call-sequence"></a>

## 客户端调用顺序

面向 MCP 客户端实现者。安装与配对见 [快速开始](../QUICK-START-zh.md)。

1. 使用已签发的 Bearer 初始化 Streamable HTTP，并加载全部工具页。
2. 通过 `machines_list`、`providers_list` 和 `providers_get` 查看设备、provider、就绪状态和当前 `binding_revision`。
3. 使用初始化时显示或管理员提供的完整 Target：`machine_id`、`provider_id`、`profile`，session profile 还需要 `session`。provider 列表不提供 `profile` 与 `session`，不得猜测。
4. 把该 Target 与观察到的 revision（作为 `expected_binding_revision`）传给 `runtime_discover`，逐页跟随 `next_cursor`。用 `runtime_describe` 描述精确方法，保留返回的 `contract_ref` 和原生参数 schema。
5. 携带 Target、revision、`contract_ref` 和 `native_request: {method, params}`，只提交一次 `runtime_call`。`deadline` 是未来的 Unix 毫秒绝对时间，`wait_ms` 为 0–5000。
6. 保留 `call_id`，用 `runtime_call_get` 查询原调用。取得可用的 `result.result_id` 后，用 `runtime_result_read` 读取，跟随 `next_cursor` 到 `eof`，并按 `encoding` 解码。超时不代表可以重新提交。

读取窗口时，先调用 `workspace.list`，再用该 provider 描述的 tab、pane 列表方法。Luvus 的通用方法使用 `validation: "raw-contract"`，省略时由 Gateway 选择。不得复用其它 provider 的 ID、revision 或契约摘要。

对话前，先描述 `agent.list / get / explain / read`，再选择实际观察到的 Agent 和窗格。启动已安装的 Agent 时，Luvus 的 `agent.start` 接受 `pane`，Herdr 接受 `pane_id`，其余字段按各自的原生 schema 填写。Luvus 的 `agent.prompt` 使用 `target`、`text`、观察到的 `terminal_id` 和 `strict: true`。Herdr 使用 `target`、`text` 和可选的对象型 `wait`。按已描述的 `agent.get / wait / read` 读取真实回复，保持同一段原生会话。不得用任意可执行参数或环境变量绕过已禁用的终端执行。
