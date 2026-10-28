# Rovloom 系统设计

本文描述 Rovloom 的产品边界、威胁模型、不变量和系统语义。接口与存储细节见 [协议总览](PROTOCOL.md)、[存储](STORAGE.md) 和 [通道](TRANSPORT.md)。

## 1. 产品

Rovloom 让 AI Agent 通过一个 MCP 入口，访问多台设备上的本地 **Luvus** 与 **Herdr** runtime。

- 一个 **Gateway**：MCP 入口、设备注册与认证、调用方授权、路由、调用账本、结果存储、管理 UI。
- 每台设备一个 **Connector**：主动出站连到 Gateway，承载若干 **provider**（一个 Luvus 或 Herdr 实例对应一个 provider）。
- runtime 留在各自机器上。Rovloom 不安装、不启动、不升级它们，不复制它们的 UI，也不提供独立的任意 shell RPC。

目标用户：一个管理员，几台自己的机器，一个主 Agent。不支持多租户、多活集群和公网 SaaS。

## 2. 威胁模型

| 在范围内 | 不在范围内 |
|---|---|
| 网络上的未授权方（没有 Bearer、没有设备凭据） | Gateway 或 Connector 所在主机已被攻陷 |
| 泄露或过期的 Bearer / 设备凭据 | 同机其它 OS 用户读取状态目录（交给 OS 文件权限） |
| 管理员配置错误导致的误暴露（默认只监听 loopback） | 整机回滚、备份篡改的自动检测 |
| 调用方越权访问 token 范围以外的设备 | 对 Agent 内部工具的沙箱（终端本身就是目标账号权限） |
| 断线、重启导致的重复执行 | exactly-once、跨机器事务 |

终端与 Agent prompt 具有目标账号的执行权限，不是沙箱。需要强隔离时使用专用账号或容器。

## 3. 不变量

实现必须保持以下 8 条。

1. **显式目标**：每次调用给出 `machine_id + provider_id (+ session)`。没有"当前机器"，不跨 provider 自动 failover。`machine_id` 由 Gateway 随机生成。`machine_id` 与 `provider_id` 稳定、不复用，名称只用于展示。
2. **设备身份**：一机一码（管理页或 `--issue-code` 生成，`--join` 一条命令兑换）换取设备凭据，Gateway 只存摘要。凭据不进 URL 和日志。公网上的设备通道应使用 WSS，Connector 的 WSS 连接强制校验证书与主机名。
3. **双端授权**：每个调用方、每个 Connector 本机策略都对完整 `Target + method + action` 授权，两端都允许才放行。新增设备或 provider 不继承已有授权。
4. **终端执行开关**：Connector 本地布尔配置 `allow_terminal_execution`，默认关。直接终端输入和自定义启动命令在最终写入前再检查一次。
5. **结果不确定性**：可能已送达的调用在断线、超时或崩溃后记为 `outcome_unknown`，不自动重发。只读方法由调用方显式重试。晚到的响应只补充原调用的证据，不重新执行。
6. **有界资源**：请求体、单帧、单页、并发、结果保留时长、总存储都有上限，超限明确拒绝。
7. **秘密不入日志**：凭据、prompt、原始输出和私人路径不写日志与审计。
8. **HTTP 基础加固**：严格 JSON 解析（拒绝重复键、过深对象、截断 UTF-8）、请求体大小限制、Origin/Host 校验、固定错误体、默认只监听 loopback。

## 4. 架构

```text
MCP Client ──HTTP (Bearer)──▶ Gateway ◀──WS/WSS (设备凭据)── Connector ── Provider (Luvus | Herdr)
                                 │                            本地终端开关
                              SQLite（单库、单 writer）
```

| 模块 | 职责 |
|---|---|
| `mcp/` | Streamable HTTP facade、工具定义与参数校验、只读与调用服务；`catalog.ts` 是两个 provider 共用的目录门禁（身份/设备范围、绑定、分页、元数据投影），方法清单与原生描述由各 provider 提供 |
| `runtime/` | Gateway 与 Connector 宿主：组合 Store、Router、传输、provider 会话与结果读取 |
| `store.ts`、`router.ts`、`storage/` | SQLite 账本（设备、provider、调用、结果、审计、备份）；Router 负责授权与准入 |
| `transport/` | 设备通道：握手、认证、心跳、派发、取消 |
| `wire/` | Gateway ↔ Connector 的单一 major JSON 信封 |
| `json/` | 与 provider 无关的有界 JSON 解析、冻结快照与结构比较 |
| `connector/luvus/` | Luvus（UHP）的全部实现：方法表、参数规则、契约编译/校验、原生/Wire 适配、来源与宿主接线 |
| `connector/` | 共享的发送账本、终端开关与两端 schema 落盘约定；Herdr（JSON socket）的本机 adapter |
| `wire/native.ts`、`wire/backend.ts` | Luvus 契约内核与 Wire 的接缝，以及 provider 中性的原生后端接口 |
| `admin/`、`webui/` | 独立 listener 的管理 API 与 Web UI |
| `cli/`、`service/` | 单一可执行文件、角色配置、开机服务 |

三条认证边界相互独立：调用方 → Gateway、Connector → Gateway、Connector → 本地 runtime。MCP 身份、设备凭据与管理员凭据互不通用。

Luvus 与 Herdr 各自保留原生协议，Rovloom 不把 Herdr 改写成 UHP。Connector 只执行管理员在本机配置固定的 binary 与状态根。调用方不能提交 binary 路径、endpoint、环境或状态根。

### 4.1 Machine 与 Provider

- `Machine`：Gateway 生成的稳定 ID。每次成功认证分配新的 `connection_epoch`。
- `Provider binding`：`(machine_id, provider_id, kind, config_ref, binding_revision, enabled)`。`kind` 为 Luvus 或 Herdr，登记后不变。启停递增 `binding_revision`。实例换了（kind、状态根或实例身份变化）必须用新的 `provider_id`。
- `Target`：`(machine_id, provider_id, profile, session)`。调用同时带 `expected_binding_revision`，不匹配即拒绝。
- 断开设备、撤销设备、禁用 provider 是三种不同操作。断开只关闭当前连接。撤销持久拒绝新认证。禁用 provider 阻断该实例的派发，不影响设备与其它 provider。
- 单个 provider 失效不关闭整条连接，也不影响同设备其它 provider。

### 4.2 方法表与授权

每个 provider 内置一份静态方法表。Luvus 的表把方法分为 `read` 与 `write`，并带 scope（见 `src/connector/luvus/methods.ts`）。Herdr 的表登记 65 个方法（见 `src/connector/herdr/methods.ts`）。

- 表中没有的方法一律拒绝。`schema` 通过只代表参数合法，不代表允许调用。
- 流类方法、token 与 Host/server 管理方法不在表中。
- Herdr、Luvus 和混合模式只保留 token 设备范围与 Connector 终端执行开关。没有按方法、provider 或动作授权的策略快照，配对不写方法清单；结果读/删核对当前设备范围与原主体归属。
- 会输入终端或启动程序的方法，还要求 Connector 的终端开关开启。
- 兼容性按实际安装的 schema 和方法能力判断。版本号只用于诊断，不设版本白名单。

### 4.3 一次调用的生命周期

```text
runtime_call
  → [Gateway] 认证调用方 → 双端策略 → 方法表 → schema 校验 → 登记调用并持久化 dispatching → 经 WS 发 request
  → [Connector] 方向、绑定、策略、终端开关检查 → provider 执行 → response
  → [Gateway] 提交响应与结果（受 result_ttl）→ 返回
```

调用状态：

| 状态 | 含义 |
|---|---|
| `created` | 已登记，尚未派发 |
| `dispatching` | 派发记录已持久化，请求可能已写出 |
| `connector_accepted` | Connector 已接受请求，不代表原生完成 |
| `responded` | 响应已提交 |
| `not_dispatched` | 确定未写出 |
| `outcome_unknown` | 可能已送达，结果不确定。收到晚到响应后变为 `responded`，审计记为 `late_evidence` |

- 只有能证明未写出时才报告 `not_dispatched`。可能送达后断线、超时或崩溃保持 `outcome_unknown`。
- 同一 `call_id` 至多派发一次。重启、重连、超时和取消都不重放。
- `client_request_key`：同一调用方内，同 key 同请求返回原调用，同 key 不同请求报冲突。key 的有效期等于 `metadata_ttl`。
- 取消只报告实际能确认的程度：停止等待、停止桥接，不宣称原生回滚。
- `wait_ms` 到期只返回 `call_id`，执行期限独立。设备离线立即失败，重连不执行旧请求。

### 4.4 结果与流

- 结果原文保存在 Gateway，受 `result_ttl` 与单结果上限约束。响应必须放入单个 1 MiB Wire 帧，超限不分片，调用保持 `outcome_unknown`。
- 结果按游标分页读取，每页重新检查调用方权限。
- 不提供事件订阅和终端流。Luvus 与 Herdr 的事件语义不同，Rovloom 不承诺 replay。

## 5. 认证

| 对象 | 方式 |
|---|---|
| MCP 调用方 | Bearer 令牌，默认 30 天有效。`rovloom token create / list / renew / rotate / revoke` 管理，热生效；新令牌保留原文供管理员面板再次查看，认证仍核对摘要。面板可直接创建、查看、复制和删除令牌，默认有效期 365 天。每个令牌可另设可选的设备可见范围（`device_scope`，只收窄、缺省不收窄）：枚举面越界设备返回 `not_found`，执行面返回 `forbidden`，与缺少授权逐字一致；范围收窄不会停止已派发的 attempt。固定 `/mcp` 路径支持任意 HTTP/HTTPS 代理域名与端口，不将公网地址作为认证条件；每个请求仍核对当前 Bearer，转发头不提供身份 |
| 设备 | 一机一码（不过期，用掉/作废即终结，并发兑换只有一次成功）经 `POST /pairing` 单端点兑换设备凭据并自动批准原生安装。凭据不过期，撤销或重新配对时失效。重复连接默认拒绝。凭据丢失或泄漏时用新码重新执行 join，本机作为新设备重新配对。撤销后的设备只能作为新设备重新配对 |
| 管理员 | 独立 listener（默认 `127.0.0.1:9445`）、独立的管理员口令（`rovloom admin`）与 CSRF。高影响操作（改名、断开、撤销、禁用 provider）要求管理员在页面上两步确认。MCP 不提供任何管理工具 |

## 6. 持久化与默认限额

单个 SQLite 库，单 writer。大对象存文件，库里记录摘要与引用。新目录与文件请求 0700 和 0600，不改写已有路径的权限。v9 库在启动时单事务升级到 v10，升级前在 `<state>.backups` 留整库副本；高于当前版本或比 v9 更旧的版本仍在任何写入前拒绝启动。

| 项 | 默认 |
|---|---|
| MCP 请求体 | 1 MiB |
| MCP 单个响应 | 64 KiB |
| 结果页 `max_bytes` | 默认 4096，上限 16384 |
| Wire 单帧与单个原生响应 | 1 MiB |
| 在途调用 | Gateway 128，Connector 同时执行 8 |
| 调用期限 | 调用方给出绝对 `deadline`，登记时须在 10 分钟之内 |
| `wait_ms` | 0–5000 毫秒 |
| `result_ttl`（结果原文与句柄） | 1 小时 |
| `metadata_ttl`（调用元数据、key 去重窗口、审计） | 30 天 |
| `content_bytes`（结果原文总量） | 128 MiB |
| `storage_total_bytes` | 512 MiB，其中 64 MiB 为安全预留，不用于普通准入 |

期限在首次登记时固定，读取、重试、晚到都不会刷新。时钟回退时拒绝相关操作，不延长已有期限。磁盘或 I/O 写失败时进入 `storage_degraded`：停止新派发与配对，不报告未提交的变更已生效，可能已送达的调用保持 `outcome_unknown`。

**备份与恢复**：备份快照不含结果原文与设备凭据。从快照恢复后，所有设备回到待配对状态，所有 provider 禁用并升版，调用方策略由快照之外的配置提供。快照之前未完成的调用记为 `outcome_unknown`，不重放。系统不检测整机回滚。步骤见 [存储](STORAGE.md)。

## 7. MCP 工具面

共 11 个工具：

| 工具 | 职责 |
|---|---|
| `machines_list` / `machines_get` | 查询可见设备，含 `link` 与该调用方获授权的完整 `targets`（可直接作为 `runtime_*` 的 Target） |
| `providers_list` / `providers_get` | 查询可见 provider、kind、binding revision、readiness（后两者来自真实传输观测） |
| `runtime_discover` | 某个 Target 的有效能力与来源，不授予执行权限 |
| `runtime_describe` | 精确方法的原生参数、分类和限制 |
| `runtime_call` | 发起调用，可短等或返回 `call_id` |
| `runtime_call_get` / `runtime_call_cancel` | 读取状态与证据 / 请求停止等待 |
| `runtime_result_read` | 分页读取结果 |
| `runtime_response_discard` | 丢弃已保存的响应正文 |

设备注册、改名、撤销以及 provider 启停只在管理 UI 与 CLI，不经 MCP。调用方只提交 `method / params`，不能提交原生 request id 或认证字段。所有列表与计数按调用方策略过滤。参数与返回见 [MCP Streamable HTTP](protocol/MCP-HTTP.md)。

## 8. 可观测性

管理页分层显示状态：连接、认证、最近心跳、provider 的 enabled 与 readiness。每层按自己的观测时间过期，没有证据的层显示为未核实，不从持久化状态推断。单个 provider 的故障不等于设备离线。

## 9. 工程约定

- 语言 TypeScript，开发和发行使用 **Bun**。`package.json` 只声明最低版本（`engines.bun`）与依赖范围，提交 `bun.lock`。CI 只跑最新稳定版 Bun。选择依据见 [ADR 0003](adr/0003-bun-toolchain.md)。
- 质量门禁：`lint`、`format:check`、`typecheck`、`test`、`build`、`smoke`。需要真实机器或第三方 runtime 的验证放在端到端验收（[e2e](../e2e/README.md)），不进单元测试门禁。
- 注释写给读者：模块职责、公共接口、不明显的约束和安全决策需要注释，不要求每个函数都有。

## 10. 参考

- Luvus：[UHP](https://luvus.dev/docs/uhp/getting-started/)、[方法](https://luvus.dev/docs/uhp/methods/)、[契约](https://luvus.dev/docs/uhp/conformance/)、[终端](https://luvus.dev/docs/uhp/terminal/)。固定输入见 [开发指引](DEVELOPMENT.md#固定输入与维护用途)。
- MCP：[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)；[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
- Herdr：研究边界见 [ADR 0004](adr/0004-multi-runtime-provider.md)。
