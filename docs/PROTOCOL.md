# 协议总览

Rovloom 有三层接口，每层有一份细则。系统语义见 [DESIGN](DESIGN.md)。

```
AI 客户端 ──MCP Streamable HTTP──▶ Gateway ──Wire v2 (WS/WSS)──▶ Connector ──原生契约──▶ Luvus / Herdr
```

## 1. MCP（客户端 ↔ Gateway）

- 传输：Streamable HTTP，`http://<mcp.hostname>:<mcp.port>/mcp`。每个请求带 `Authorization: Bearer <令牌>`。令牌由 `rovloom token` 管理，热生效。
- 监听网卡由配置决定。远程访问可经 HTTPS 反向代理，无需公网 URL 配置，客户端仍须提供 Bearer。
- 不是 stdio MCP 服务器。客户端退出不影响 Gateway。
- MCP 原生调用的权限只由 token 设备范围与 Connector 终端执行开关决定，Herdr、Luvus、混合模式一致。移除 caller/local/gateway 策略、methods/actions、raw grant 和策略 revision；来源/binding、schema、幂等与期限仍需正确。
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

### 设备详情与原生版本

`machines_list` 仅增加 `platform` 一行摘要（如 `linux/x86_64`），没有已知上报时为 `null`。
`machines_get` 另返回 `last_seen_at`、`link_since`，以及可选的 `host`：

```json
{
  "host": {
    "os": {"family":"linux","distribution":"debian-12","kernel":"6.1.0-31-amd64"},
    "arch":"x86_64", "cpus":4, "memory_bytes":17179869184,
    "container":"docker", "agent_version":"0.6.7",
    "providers":[{"provider_id":"luvus","native_version":"0.14.3"}],
    "reported_at":1793039388447, "source":"connector_handshake"
  }
}
```

- 主机信息只由支持 `host_profile` 的 Connector 在认证后的连接握手阶段上报；旧版本不协商、不上报，`host` 整块省略。新 epoch 不沿用旧 epoch 的 host。未取得的 CPU、内存、内核或发行版为 `null`；容器无正向标记时为 `unknown`，不猜 `none`。
- `reported_at` 是 Gateway 收到该认证帧的 Unix 毫秒时间，`source` 固定为 `connector_handshake`。这不是实时探测，查询不会刷新时间。采集只用系统 API、`/etc/os-release` 与固定容器标记文件，不执行 shell，也不收集网络、环境、用户、路径或工具链。
- 新增可选 `cpu_quota`：双方协商 `host_cpu_quota`（minor ≥ 3，依赖 `host_profile`）后上报 Linux 当前进程可见 cgroup v1/v2 层级的最紧带宽配额，单位为可带小数的核数。`cpu.max = 50000 100000` 上报 `cpu_quota: 0.5`，同时保留 `cpus: 4`。必须同时读取 `cpu_quota_status`：`limited` 为完整可见层级的有限上界，`unlimited` 才表示已检查的可见层级未限额；`unknown` 表示无法核实。`partial` 保留已读的有限上界，但祖先链未查完，可能还有更紧限制，不能据此承诺可用容量。`unknown/unlimited` 数值均为 null，不能只凭 null 当作无限；旧连接省略这两个字段。它不是 CPU 亲和性、实时负载或保证可用的并行度，需要重新连接才更新。
- `cpus` 取自 Connector 运行时的 `os.cpus().length`，表示系统可见的逻辑 CPU 数量，不是物理核数、进程可用并行度或容器 CPU 配额。例如系统可见 4 个逻辑 CPU、`cpu.max = 50000 100000`（0.5 核配额）时仍上报 `cpus: 4`；不能据此判断进程能持续使用 4 核。系统未提供 CPU 列表时为 `null`。`memory_bytes` 是操作系统可见总量，不代表容器内存限额。v0.6.8 及之前的 Connector 曾上报可用并行度；需更新并重连 Connector 才能获得新语义，Gateway 不换算旧报告。
- host 只在建立认证连接时采集并上报；provider、系统或资源配置在长连接期间变化不会触发定时刷新，心跳和查询也不刷新它。需要新快照时应在适当窗口重连 Connector；不为刷新元数据而自动打断正在进行的调用。`host.providers` 只保留调用方当前可见的 provider；这些连接时版本不能代替原生结果 provenance，当前契约元数据应另查 `providers_get/list`。
- `last_seen_at` 是认证或有效收包的 Gateway 时间；`link_since` 是当前认证连接的起点，断线后为 `null`。无记录时为 `null`。主机和时间历史仅在当前 Gateway 进程中有界缓存（最多 4096 台），重启、恢复代次变化或淘汰后未知；不冒充持久在线历史。
- `providers_get` / `providers_list` 增加 `native_version`、`schema_status`（`validated` / `unavailable`）、`schema_sha256`。取自同一授权目录的已核验安装契约，缺失、过期、绑定不符或未知版本不猜默认值。`native_version` 是原生程序版本，不是 Rovloom 版本；它也不是按次 RPC 的实时进程探测。
- provider 级 `schema_status` 表示契约核验，不表示每个方法都有专用参数 schema，也不替代 `readiness`。方法级参数覆盖仍看 `runtime_describe.schema_status`。主机信息不混入 `runtime_discover/describe`，也不通过伪造 `runtime_call` 或新增工具提供。

## 2. Wire v2（Gateway ↔ Connector）

- 传输：Connector 主动出站的 WebSocket（`ws://` 或 `wss://`，路径 `/connector`），每条消息一个 UTF-8 JSON 信封。
- 版本：只有 major 2，当前 minor 3。minor 取双方交集。可选能力（`rpc`、`dispatch_refusal`、`provider_snapshot`、`terminal_execution_state`、`provider_fence`、`late_evidence`、`device_platform`、`host_profile`、`host_cpu_quota`）取双方广告的交集，未知的 required 能力被拒绝。
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
