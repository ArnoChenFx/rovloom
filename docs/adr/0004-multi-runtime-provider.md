# ADR 0004：多 runtime provider 与 Herdr 适配边界

状态：采纳。

系统语义见 [DESIGN](../DESIGN.md)，精确的字段与编码见 [Wire 协议](../protocol/WIRE-PROTOCOL.md)。本 ADR 记录选择理由与外部研究依据。

## 一设备身份、一连接，多个 provider 绑定

一套 Connector 身份和一条出站连接代表一台设备，每个 binding 独立代表一个 Luvus 或 Herdr 实例。同机混合 runtime 或同一 kind 的多个实例，不必重复注册设备，也不会把原生安装实例误当作物理设备身份。runtime provider 与 model provider 的密钥和服务属于不同领域。

调用使用完整 Target 加独立的 binding revision。稳定 ID 便于关联历史，revision 防止升级、启停或配置变化后沿用旧的授权与执行上下文。kind、状态根或实例变化时使用新的 ID。仅凭设备广告、相同 hostname 或同名 session，不能建立或重绑实例。

代价是 registry、双端配置、授权、去重、契约、结果和历史都要按 provider 隔离，不能只给 Target 加一个可选字段。Store 只接受当前 schema，不兼容旧库，不猜测 provider 来源。

## 核心通用，原生保证分别表达

核心管理身份、策略、路由、预算和账本。adapter 管理本地来源、原生协议、能力与保证。MCP 工具是通用的 `runtime_*`，Wire 载荷是 `native_request` / `native_response`，各协议的原生字段和错误原样保留，Herdr 不被模拟成 UHP。

历史决策采用调用方与 Connector 本机策略对完整目标求交。当前实现已改为 token `device_scope` 与 Connector 终端执行开关：没有逐方法/provider/action grant；旧策略只兼容读取，迁移范围见 [配置参考](../CONFIGURATION-zh.md)。新增 provider 可被当前设备范围内的 token 使用。禁用 provider 与撤销整台设备是两个操作，故障与健康也分层。这样同名方法或终端 ID 不会混用，单个实例故障也不会误撤其它授权。代价是每个 provider 都要独立确认方法分类、传输和结果边界，不能继承 Luvus 的方法表。

event recovery、terminal fence、cancel 和 prompt completion 的保证强度逐方法说明。原生没有的 incarnation、序号、原子性或完成归属，不能由桥接字段制造。

## Wire 版本

provider、契约来源及其完整关联是执行安全所必需的字段，不能放在 optional 或 default 里，因此 Wire 使用 major 2。minor 只承载双方已协商的可选扩展，失败后不自动降级重发。Wire、MCP 和管理 API 各自独立版本化。

Wire 只有 v2 一套 decoder。缺少 provider 或可信 binding 时不得执行，也不会借旧 key 缺失重新派发。

## Herdr 研究与适配边界

研究基于官方 Herdr v0.9.5 源码 `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`，协议常量 22。这个 commit 锁定的是外部协议证据，不是 Rovloom 的开发基线，也不是已安装 binary 的契约。运行时仍须取得安装版的 schema、hash、实际版本和独立的 endpoint 来源。

| 官方源码与文档的观察 | 选择与边界 |
|---|---|
| JSON 请求与响应有自己的 id / method / params 和 schema | 独立解析与校验，保留原生 result / error，不套用 UHP 的根与错误类型 |
| ping 给出版本、协议和有限的 capabilities，不是逐方法的 live catalog | 支持依据为 `schema_and_version`。方法表只登记已核实的方法，不按 schema 枚举全部开放 |
| 没有等价的独立 Host、通用 cancel、通用的原子 terminal incarnation fence | 不模拟 Host。桥接取消与身份核对不声称原生停止或原子性，协议号不是实例 generation |
| 事件缺口须重建，snapshot 与事件没有共同序号 | 只承诺当前状态重建并明确缺口，不用缓存载荷重放覆盖 snapshot，也不伪造丢失的历史 |
| `recent` 等读取路径可能滚动或送入输入 | 被动只读必须按 method、params 和实现逐项核实，不能凭 read 名称或 schema 授予 observer |
| prompt wait 观察状态，但不能单凭状态把完成归属到本次提交 | 不宣称 turn 级完成。写入与终端需要单独研究 |

Rovloom 接入 Herdr 的 65 个普通 RPC（方法表见 `src/connector/herdr/methods.ts`），参数由安装 schema 的完整根校验，原生结果原样返回。其余原生方法不开放。普通读取也可能改变终端状态，终端输入和 Agent prompt 具有目标账号的执行权限。

Rovloom 不补造 UHP、native cancel、原子 fence、共同序号或 replay、per-turn receipt。原生 Agent 状态不等于本轮回答。

## 官方来源

固定引用是外部协议的出处。升级安装版本时必须重新核对，结论不扩展为未来版本的永久断言。

- [官方源码](https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01)、[socket API](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/docs/next/website/src/content/docs/socket-api.mdx)：安装 schema、JSON socket、订阅和状态重建。
- [请求枚举](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema.rs)、[响应类型](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/response.rs)、[ping 能力](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/server.rs)、[协议常量](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/protocol/wire.rs)：有限能力，以及缺少等价通用接口的依据。
- [pane 分派](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/panes.rs)、[terminal recent 实现](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/pane/terminal.rs)、[agent 自动化](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/docs/next/website/src/content/docs/agent-automation.mdx)：读取副作用、等待与完成归属需要独立验证。
