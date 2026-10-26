# Luvus 窗口与 Agent 操作

本文说明经 Rovloom 操作 Luvus 的 workspace、tab、pane 和 Agent 时的方法、选择器和状态语义。方法清单对应 Luvus 0.14.3，权威定义见 [luvus-operations.ts](../src/runtime/luvus-operations.ts)。Luvus 的接入方式（附着或隔离）见 [配置参考](CONFIGURATION-zh.md#luvus附着或隔离)。

## 接入

- Connector 在设备本机访问 Luvus。Gateway 所在机器不需要安装 Luvus。
- Connector 对真实实例测得版本、schema 和能力，在每个认证连接上通过 `provider_snapshot` 交付给 Gateway。Gateway 校验后才把该连接上的 Luvus provider 标为 ready。
- 实例、契约或能力变化时，Connector 关闭连接。断线、撤权、重绑或关闭后，Gateway 不再使用旧的来源，需要新连接重新交付。
- 原有的调用、结果句柄和未确认的响应不会迁移到新连接，也不会自动重发。
- 通用的 `raw-contract` 参数契约由已审核的方法子集限制，不等于完整的参数 schema。

### Caller 与 raw 授权

配对生成的 Gateway raw 授权绑定 `caller_policy_revision` 和精确方法集合。
使用同一已批准策略的 gateway 范围 token 可以调用这些方法；实际 raw grant 每次按
真实 caller 签发，并绑定当前连接、契约、目标和本次调用的固定 deadline。
撤权、方法范围和 caller/local 双端策略检查继续生效。手动配置的
`raw_grant.principal_id` 仍只允许该主体；它与 `caller_policy_revision` 互斥。

旧单码配对的完整标准授权在 Gateway 启动时迁移内存副本，无需重新配对、更换 token
或修改 Connector。自定义主体、方法子集、会话、修订和 binding 不自动扩大范围。
先升级 Gateway；新 Connector 的策略格式清单需要新版 Gateway 接纳。

Gateway 在编码阶段拒绝请求时，尚未写入设备通道；调用账本记录
`not_dispatched` 和 Gateway 的 `dispatch_refused` 审计（含固定错误码），释放该次调用的
资源并保留共享连接。开始发送后的失败仍保留 `outcome_unknown`，不会自动重发。

## 方法

Luvus 没有 `window.*` 方法。窗口选择沿 Luvus 自己的 workspace、tab、pane 层级进行。

| 需求 | 方法 | 说明 |
|---|---|---|
| 发现与选择 | `session.snapshot`、`workspace.list/get`、`tab.list/get`、`pane.list/get/current` | 优先保存 `workspace_id`、`tab_id`、`terminal_id`。`pane.list/get` 的参数名是 `pane`，`session.snapshot` 的是 `pane_id` |
| 窗口管理 | `workspace.new/open/focus/rename/close`、`tab.new/focus/rename/close`、`pane.split/focus/rename/close` | 变更使用已发现的稳定 ID，不按标题或最近对象重选 |
| 状态与输出 | `pane.status/read`、`agent.list/get/explain/read/sessions/wait` | 原样使用 `status`、`authority`、`state_source`、`session` |
| Agent 操作 | `agent.start/prompt/send/keys/resume` | `agent.start` 的 `pane` 与 `anchor` 互斥。`prompt`、`send`、`keys` 可绑定 `terminal_id`。`resume` 只用于显式选择已有 session |

## 位置坐标

Luvus 在不同方法里使用不同的位置坐标。Rovloom 原样返回，不统一换算。

| 返回位置 | 坐标 | 后续选择 |
|---|---|---|
| `session.snapshot` 的 workspace 和 tab 的 `index` | 一基 number，行内不含稳定 ID | 其中 `kind:"terminal"` 的 `pane_id` 是 string，可作为 `pane.get` 的 `pane`，由结果取得 `workspace_id` 和 `tab_id`。`kind:"view"` 的占位 ID 不走此路径 |
| `workspace.list/get`、`pane.list/get` 和 Agent 行里的 `workspace` | 零基十进制 string | 使用同一行的 `workspace_id`。不要把 snapshot 的一基 `index` 直接传给 `workspace` |
| `tab.list/get`、`pane.list/get` 里的 `tab` | 一基十进制 string，`tab.list` 只列当前 workspace | 使用 `tab_id` |

写入前应从最新的 `list` 或 `get` 取得稳定 ID，不要用旧位置、标题或占位 ID 猜测同一个对象。位置参数可以是 number 或十进制 string，原样转发，不自动换算、focus 或重试。

## 选择器规则

- workspace 的 `get/focus/rename/close` 接受互斥的 `workspace_id` 或 `workspace`。
- `tab.get` 有两组互斥选择器：`workspace_id` 或 `workspace`，以及 `tab_id` 或 `tab`，可以读取其他 workspace 的 tab。
- tab 的 `focus/rename/close` 只在当前 workspace 内解析 `tab_id` 或 `tab`，不接受 workspace 选择器。当前 workspace 不含该 tab 时返回 `not_found`，不会隐式切换后重放。跨 workspace 写 tab 时，先由用户选定 workspace，再重新读取状态。
- `tab.list` 和 `tab.new` 不接受 workspace 选择器。
- `workspace.new` 和 `tab.new` 只接受可选的 `if_revision`，不接受 `cwd`。指定路径使用 `workspace.open({path, focus?, if_revision?})`，`focus` 默认为 `true`。
- 新建或 `open` 返回的位置不是稳定 ID，需要再次 `get` 或 `list` 获取。

示例：

```json
[
  {"method":"workspace.get","params":{"workspace_id":"observed_workspace_id"}},
  {"method":"workspace.rename","params":{"workspace_id":"observed_workspace_id","name":"project"}},
  {"method":"tab.get","params":{"workspace_id":"observed_workspace_id","tab_id":"observed_tab_id"}},
  {"method":"tab.rename","params":{"tab_id":"observed_tab_id","name":"agent","if_revision":43}}
]
```

## 可选的全局修订检查

窗口和 tab 的变更方法可带 `if_revision`（非负安全整数），读取方法不接受。它比较的是整个 session 的事件序号，不是某个 workspace 或 tab 的版本。

- 事件序号不等于传入值时，方法返回 `revision_conflict`。
- 每个发布的事件都会推进序号，包括 PTY 就绪、输出和状态变化，所以紧前一次 `get` 读到的序号不保证下一个请求仍然匹配。
- 按稳定 ID 变更对象时可以省略它。只有要求"自观察之后没有发生任何事件"时才传入。
- 显式检查失败时，把冲突展示给用户并重新读取状态。不要去掉条件、自动换用新的 revision，或重发原变更。

## 读取、等待与对话

- `pane.read` 接受 `pane` 和 `lines`。`agent.read` 接受 `target`、`lines` 和 `source`。`lines` 最大为 1000，只取末尾行。返回的 `text`、`content_revision`、`terminal_id` 来自 Luvus。
- `agent.prompt` 的 `until` 和 `timeout_s` 必须与 `wait:true` 一起使用。
- `submitted`、`queued`、`ready=true` 和 `observed_state` 只表示输入已提交或识别就绪，不表示 prompt 已被消费或模型已回复。需要继续读取真实状态和输出。
- 界面应同时展示 `status` 和 `authority`/`state_source`。缺少正面状态证据时按 unknown 处理，不能把 idle、queued 或 TUI 文本当作完成。
- 上游模型失败不会触发重发，也不会切换到收费模型。
- 两轮对话应保持相同的完整 Target、选定的 pane 或别名、`terminal_id` 和已知的 Agent `session`。验证第二轮时，检查回复是否记得第一轮的随机内容，不能用终端回显代替。
- Connector 的 `allow_terminal_execution` 默认关闭。此时文本 `agent.send` 和 `agent.prompt` 需要请求中显式带 `strict:true`，`agent.keys` 和自定义启动参数仍需要开启开关。该开关不隔离 Agent 自己的工具。详见 [终端执行](TERMINAL-EXECUTION.md)。

## 验证

对真实 Luvus 的端到端验证见 [`e2e/README.md`](../e2e/README.md)。流程按 Quick Start 在真实终端配对后，经官方 MCP SDK 依次执行发现、描述、调用、查询和读取，并覆盖崩溃接管、进程被杀后重建、未知结果不重发和离线撤销。
