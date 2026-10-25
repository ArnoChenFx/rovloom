# 协议总览

Rovloom 有三层接口，每层有一份细则。系统语义见 [DESIGN](DESIGN.md)。

```
AI 客户端 ──MCP Streamable HTTP──▶ Gateway ──Wire v2 (WS/WSS)──▶ Connector ──原生契约──▶ Luvus / Herdr
```

## 1. MCP（客户端 ↔ Gateway）

- 传输：Streamable HTTP，`http://<mcp.hostname>:<mcp.port>/mcp`。每个请求带 `Authorization: Bearer <令牌>`。令牌由 `rovloom token` 管理，热生效。
- 默认只监听回环。远程访问经受信反向代理，见 `mcp.public_url`。
- 不是 stdio MCP 服务器。客户端退出不影响 Gateway。
- 共 11 个工具，参数形状见 `src/mcp/schema.ts`：

| 工具 | 作用 |
|---|---|
| `machines_list` / `machines_get` | 当前调用方可见的设备。分页与计数都经过授权。`link` 对活动设备取自 Gateway 的真实传输观测：有可信在线证据时为 `connected`，否则为 `unverified`（不推断 `offline`）；`pending` / `revoked` 恒为 `offline`。每条记录另带 `targets`——调用方在该设备上获授权的完整 tuple，可原样作为 `runtime_*` 的 `target` |
| `providers_list` / `providers_get` | 设备下已配置的 provider（kind、revision、readiness）。`readiness` 取自同一传输观测，且必须与当前 `binding_revision` 一致；禁用或无证据时分别为 `unavailable` / `unverified` |
| `runtime_discover` | 显式 Target 与 revision 下的有效能力及来源，不授予执行权限 |
| `runtime_describe` | 精确方法的原生参数、分类和限制 |
| `runtime_call` | 提交一次原生调用：显式 Target、revision、`contract_ref`、绝对 `deadline`、可选 `client_request_key`、`wait_ms` 短等 |
| `runtime_call_get` / `runtime_call_cancel` | 查询、取消 |
| `runtime_result_read` | 按句柄分页读结果，`max_bytes` 不超过 16 KiB，带摘要；本页字节是合法 UTF-8 时额外给出 `text`，与 base64 的 `chunk` 逐字节一致，页边界切开多字节字符或整页回复超字节预算时不提供 |
| `runtime_response_discard` | 丢弃已保存的响应正文 |

- 调用终态：`responded`、`not_dispatched`（确定未写出）、`outcome_unknown`（可能已执行，不会自动重发）。同一 `client_request_key` 加同一请求返回原调用，不同请求报 `conflict`。
- 细则：[MCP Streamable HTTP](protocol/MCP-HTTP.md)。

## 2. Wire v2（Gateway ↔ Connector）

- 传输：Connector 主动出站的 WebSocket（`ws://` 或 `wss://`，路径 `/connector`），每条消息一个 UTF-8 JSON 信封。
- 版本：只有 major 2。minor 取双方交集。可选能力（`rpc`、`dispatch_refusal`、`provider_snapshot`、`terminal_execution_state`、`provider_fence`、`late_evidence`）取双方广告的交集，未知的 required 能力被拒绝。
- 限额：单帧 1 MiB，JSON 深度 64，节点 10 万。超限的响应不截断，调用保持 `outcome_unknown`。
- 已认证帧都带 `machine_id`、`recovery_generation`、`connection_epoch`，逐项核对当前认证连接。心跳间隔 5 秒，20 秒无有效心跳判定断线。
- 细则：[Wire 协议](protocol/WIRE-PROTOCOL.md)、[通道](TRANSPORT.md)。

## 3. 原生契约（Connector ↔ Luvus / Herdr）

- 契约来自本机安装的程序（Luvus `uhp schema`，Herdr `api schema --json`）。Connector 在 Worker 中用锁定版本的 Ajv 完整编译，冷编译约 0.7 秒，期限 10 秒。不设版本白名单。
- 方法按静态表放行，表外方法一律拒绝。会输入终端或启动程序的方法还要求 `allow_terminal_execution` 开启，默认关，见 [配置参考](CONFIGURATION-zh.md)。
- Luvus 经本机 IPC（Unix socket 或 Windows 命名管道），Herdr 经其 API 管道。Linux 上附着时核对对端是已安装的同一个程序。
- 细则：[原生契约](protocol/NATIVE-CONTRACT.md)。

## 4. 配对（Gateway ↔ Connector 的专用 HTTP）

`POST /pairing` 是唯一的配对端点，挂在设备 listener 上、随 Gateway 常开：请求携带一机一码与实测原生安装清单，响应一次交付设备凭据（及首台设备的 MCP Bearer）；原生安装经编译核验后自动批准。已用/作废的码返回 409。命令见 [快速开始](QUICK-START-zh.md) 和 [运维指南](OPERATIONS.md)。
