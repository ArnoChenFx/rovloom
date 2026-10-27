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
| 发现与选择 | `session.snapshot`、`workspace.list/get`、`tab.list/get`、`pane.list/get/current` | 优先保存 `workspace_id`、`tab_id`、`terminal_id`。`pane.get` 的参数名是 `pane`；`pane.list` 不接收 pane selector，`session.snapshot` 返回 `pane_id` |
| 窗口管理 | `workspace.new/open/focus/rename/close`、`tab.new/focus/rename/close`、`pane.split/focus/rename/close` | 变更使用已发现的稳定 ID，不按标题或最近对象重选 |
| 状态与输出 | `pane.status/read`、`agent.list/get/explain/read/sessions/wait` | 原样使用 `status`、`authority`、`state_source`、`session` |
| 输出哨兵 | `wait.output` | 只读的字面子串等待，参数是 `pane`、`match` 和可选的秒数 `timeout_s` |
| Agent 操作 | `agent.start/prompt/send/keys/resume` | `agent.start` 的 `pane` 与 `anchor` 互斥。`prompt`、`send`、`keys` 可绑定 `terminal_id`。`resume` 只用于显式选择已有 session |

## Pane 身份与存活范围

所有已审核方法中的 `pane`（以及 `agent.start.anchor`）统一接受 `1`–`4294967295` 的十进制字符串，不接受数值类型、前导零或超出原生 `u32` 的值；超界 ID 在登记前拒绝。

Luvus 0.14.3 的数字 `pane` 是进程级递增分配的 ID，不是布局中的第几个位置。分屏、交换或移动不会对同一个存活 pane 重新编号，因此同一原生实例中可以跨调用复用。原生进程重启恢复 pane 时会重新分配，不能把重启后的相同数字视为原终端。

`pane.list` 当前没有返回 `terminal_id`，但选定 pane 后可用 `pane.get({pane})` 同时读取 `terminal_id`、`workspace_id` 和 `tab_id`；`agent.read` 也会返回终端身份。保存完整 provider target 和这些身份，不必仅因布局变化就重新猜 pane 编号。`terminal_id` 是终端生命周期身份，不是所有 pane 方法都接受的 selector；不能把它直接塞进 `pane` 字段。

| 查询 | pane 标识字段 | 终端 / 拓扑身份 |
|---|---|---|
| `session.snapshot` 终端行 | `pane_id` | 有 `terminal_id`；0.14.3 的 workspace/tab 只有嵌套位置，没有稳定 ID |
| `pane.list` 行 | `pane` | 有 `workspace_id/tab_id`，没有 `terminal_id` |
| `pane.get` 结果 | `pane` | 有 `terminal_id/workspace_id/tab_id` |

从 snapshot 行构造 `pane.get` 参数时用 `{"pane": row.pane_id}`，从 list 行则用 `{"pane": row.pane}`；请求键仍是 `pane`，不能直接改为 `pane_id`。Rovloom 保留原生字段名，不静默补齐或重命名。get 也不是 list 的严格超集：list 有 get 未提供的详细历史指标。

`workspace_id/tab_id` 随保存的拓扑对象恢复；`terminal_id` 仅在同一个 PTY 存活期间跨移动、客户端断开重连保持，PTY 重建就会变化。数字 workspace/tab 是位置坐标，会随拓扑变化，不能与数字 pane 的进程内 ID 混为一谈。原生字段一致性缺口跟踪在 [issue #291](https://github.com/ArnoChenFx/rovloom/issues/291)，不在 Rovloom 中改写原生正文。

身份变更、原生重启或 pane 消失时重新发现，不自动选择当前 pane 或同名 Agent。依据为固定版本的 [ID 分配](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/ids.rs)、[pane 查询与选择器](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/topology.rs)以及[重启恢复](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/mod.rs)。该范围不扩展为跨原生进程持久 ID 的保证。

## 输出哨兵等待

通过现有 `runtime_call` 调用 Luvus 原生 `wait.output`，仍使用发现得到的完整 target、binding revision 和 contract_ref。不是新增 MCP 工具，也不会向终端输入命令。

```json
{"method":"wait.output","params":{"pane":"2","match":"unique_marker_for_this_execution","timeout_s":35}}
```

- `pane` 为显式数字 pane ID 字符串；`match` 为 1–4096 UTF-8 字节、无 NUL 的字面子串，不是正则。Rovloom 在登记前拒绝错字段、错单位或越界参数。
- `timeout_s` 是 0–3600 的秒数，可为小数；建议显式填写，缺省由原生按最多一小时等待。外层 `deadline` 仍是绝对 Unix 毫秒，且服从 Rovloom 十分钟及本机更短上限，不能靠省略 timeout 绕过。
- 例如等待 35 秒时把 `deadline` 设为当前时间加 45–60 秒，`wait_ms:0` 取得 call_id 后查询同一调用；HTTP 短等结束不重提调用。它仍是一条阻塞 native RPC，会占执行槽，不是异步 job。
- 原生先检查已有 recent 输出，旧标记可能立即命中。需要区分执行时使用每次不同的标记；匹配不证明标记来自本轮命令，更不证明 exit code。不会自动插入 shell wrapper。
- 命中回包形如 `{"type":"wait","matched":true,"pane":"2"}`；未命中或 pane 关闭时可为 `{"type":"wait","matched":false}`。Rovloom 原样保留，`matched:false` 不是 Gateway 派发失败，也不代表命令已经停止。
- 只读等待不需要打开终端输入开关，但双方 dispatch/read ACL、原生权限和 raw 授权仍须允许 `wait.output`。原生 schema 对此方法是 generic，`runtime_describe` 提供明确标记来源的 `parameter_help`，不伪造完整原生参数 schema。

部署需要 Gateway 与 Connector 都支持此方法；已有 35 方法授权保持原范围，升级不会自动加入 `wait.output`。所有者须在 Gateway 当前 caller/local 策略、该 provider 的 `raw_grant.methods` 与 Connector 当前 caller/local 方法授权中明确加入它。新配对包含该只读方法；旧清单的配对重入与 caller 授权迁移保留原方法集合，不强制重配，也不扩大自定义子集。

原生语义依据：[0.14.3 wait.output 接口](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/ipc/api.rs)与[已有输出检查和等待器](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/agent_workflow.rs)。`pane.run` 的 stdout / exit code 派生执行能力继续在 [#292](https://github.com/ArnoChenFx/rovloom/issues/292) 跟踪，不包含在此等待接口中。

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

`runtime_describe` 保留原生安装契约的描述信息：

- `params_schema`：有明确方法条件分支且能准确提取时，返回原生参数 schema 及本地 `$defs` 引用闭包，保留枚举、组合条件、数字边界、`description` 和 `$comment`。当前 0.14.3 的审核普通方法中包括 `pane.list`、`agent.prompt/send/wait/keys`。
- `schema_annotations`：原生 request/response 文档根的 `$comment`、`description` 原文，附 `document_uri` 与 JSON Pointer。根注释属于整个文档，不应当作当前方法独有的约束。
- 安装 schema 只有通用参数时，`schema_status` 仍为 `generic_params_only`，不会补造原生 `params_schema`；无法准确投影的额外条件也保持缺失。执行校验始终使用完整原始 schema。

例如 `agent.prompt` 的原生根注释明确说明：等待模式须先观察到新的 working/blocked 转换，再匹配 `until`；`agent.wait` 则只是当前状态匹配器。快速回复或缺少正向状态证据时，前者可能一直未匹配，即使 Agent 实际已答完。MCP 可直接读到原生注释和下面的审核提示。

`runtime_describe` 对 `agent.start`、`agent.wait`、`agent.prompt`、`pane.run`、`wait.output` 附带
`parameter_help`：必填/可选字段、依赖规则和示例，来源标记为
`rovloom_reviewed_subset`。它是 Rovloom 已审核子集的调用指南，原来的
`schema_status` 仍表示安装版原生 schema 的覆盖情况。`runtime_discover` 不附带这些示例。

`agent.start` 必填 `name` 和 `kind`，两者均须匹配 `^[a-z][a-z0-9_-]{0,31}$`（小写 ASCII 字母开头，最长 32 字符）；格式错误会在登记前定位到 `/params/name` 或 `/params/kind`，规则为 `pattern`。`kind` 还须是原生已安装的 Agent，格式有效不证明该 Agent 可用。`pane` 是可选字段：提供时使用已有 pane，省略时由 Luvus 新建 pane；可用 `anchor` 指定分屏锚点，不能同时传 `pane` 和 `anchor`。启动回包中的 `pane` 是后续应使用的真实标识，`ready:true` 不代表一轮 prompt 已完成。

```json
{"method":"agent.start","params":{"name":"worker","kind":"pi"}}
{"method":"agent.start","params":{"name":"worker","kind":"pi","pane":"2"}}
```

上面分别演示新建 pane 和使用已有 pane，应按意图选一个调用；Rovloom 不替调用方补 pane，也不会为定位参数错误启动 Agent。该方法的原生 `schema_status` 仍为 `generic_params_only`，审核提示不冒充专用原生参数 schema。

两个 Agent 等待入口的参数不同：

```json
{"method":"agent.wait","params":{"pane":"2","status":"idle","timeout_s":35}}
{"method":"agent.prompt","params":{"target":"selected-agent","text":"Hello","strict":true,"wait":true,"until":["idle"],"timeout_s":120}}
```

- `agent.wait` 选 `pane`，`status` 与 `statuses` 二选一；多状态按“任意一个匹配”判断。它不使用 `wait` 开关。
- `agent.prompt` 仍选 Agent 的 `target`；指定 `until` 或 `timeout_s` 时必须同时指定 `wait:true`。
- `timeout_s` 是原生方法的秒数；`runtime_call.deadline` 是整个 Rovloom 调用的固定截止，须覆盖原生等待与 RPC 开销。不会根据参数自动延长已经登记的 deadline。
- Luvus RPC 默认最长等待 10 分钟，并受原调用 deadline、取消和撤权约束；发现 endpoint、读取 schema 的准备超时仍是 30 秒。本机已有的显式短超时继续生效。
- 登记前参数拒绝保留 `native_request_invalid` 与 `outcome:"not_dispatched"`。上述方法的常见错误附带 `gateway_error.details.issues`，例如 `/params/pane` 缺失、`/params/wait` 必须为 true，以及同一份固定调用指南；不回显用户值或原生错误文本。无法安全定位具体字段时，返回 `/params` 与 `invalid_value` 作为通用参数拒绝提示，不表示已经定位到某个字段。

- `pane.read` 接受 `pane` 和 `lines`。`agent.read` 接受 `target`、`lines` 和 `source`。`lines` 最大为 1000，只取末尾行。返回的 `text`、`content_revision`、`terminal_id` 来自 Luvus。
- `agent.prompt` 的 `until` 和 `timeout_s` 必须与 `wait:true` 一起使用。
- `submitted`、`queued` 和 `ready=true` 表示提交或识别就绪；`observed_state` 记录 prompt 等待中首次观察到的新 working/blocked 跃迁。这些都不证明 prompt 已被消费或模型已回复，需要继续读取真实状态和输出。
- 界面应同时展示 `status` 和 `authority`/`state_source`。缺少正面状态证据时按 unknown 处理，不能把 idle、queued 或 TUI 文本当作完成。
- 上游模型失败不会触发重发，也不会切换到收费模型。
- 两轮对话应保持相同的完整 Target、选定的 pane 或别名、`terminal_id` 和已知的 Agent `session`。验证第二轮时，检查回复是否记得第一轮的随机内容，不能用终端回显代替。
- Connector 的 `allow_terminal_execution` 默认关闭。此时文本 `agent.send` 和 `agent.prompt` 需要请求中显式带 `strict:true`，`agent.keys` 和自定义启动参数仍需要开启开关。该开关不隔离 Agent 自己的工具。详见 [终端执行](TERMINAL-EXECUTION.md)。

### 推荐两段式：提交后独立观察

1. 从 `agent.get` / `pane.get` 确认选定 Agent、pane、`terminal_id` 和 session，并读取一次输出作为基线。
2. 调用 `agent.prompt`，省略 `wait`、`until` 和 `timeout_s`，带上已观察的 `terminal_id` 与 `strict:true`。保留返回的提交证据和同一 `call_id`，不要因观察超时重发 prompt。
3. 用短调用轮询 `agent.read` / `pane.status`，核对终端与 session 仍相同。输出或 `content_revision` 变化只证明活动；状态为 `idle` 且 `state_source:"no_positive_state_evidence"` 时按未知处理。读到与本轮请求相关的真实 Agent 回复后再向用户交付结果，不能用终端输入回显替代。
4. 如果任务约定了可验证的输出标记，可调用上文的 `wait.output`，随后读取并核对内容。已有 recent 输出或本次 prompt 的输入回显都可能命中；不要把原样写在 prompt 中的标记当作回复完成证据。没有约定可验证标记时，继续有界轮询输出，不制造通用完成保证。

无等待提交示例（使用实际观察到的选择器）：

```json
{"method":"agent.prompt","params":{"target":"selected-agent","terminal_id":"observed_terminal_id","text":"13*7=?","strict":true}}
{"method":"agent.read","params":{"target":"selected-agent","lines":100,"source":"recent"}}
{"method":"pane.status","params":{"pane":"2"}}
```

外层 `wait_ms:0` 只结束 HTTP 短等，仍须查询原 `call_id` 得到提交回包。`agent.wait` 也可以立即匹配旧 idle，不能替代上述回复核对。观察期限到了且证据不足时报告“未确认”，允许稍后继续读取，不推断 Agent 没有回复或再次提交。

快速任务不要依赖 `agent.prompt wait:true` 捕捉短暂跃迁。可无等待提交，再对已解析的 pane 调用 `agent.wait`，最后读取同一 Agent 的回复：

```json
{"method":"agent.prompt","params":{"target":"selected-agent","terminal_id":"observed_terminal_id","text":"8*8=?","strict":true}}
{"method":"agent.wait","params":{"pane":"2","statuses":["done","idle"],"timeout_s":60}}
{"method":"agent.read","params":{"target":"selected-agent","lines":100,"source":"recent"}}
```

这里 `target` 与 `pane` 必须事先映射到同一对象；`agent.wait matched:true` 仍只证明当前状态匹配，可能是旧 idle/done。读回并核对本轮答案，缺少正向状态证据时不能仅凭状态宣称完成。

### 如何判读 prompt 等待超时

下面只解释原生字段组合，不新增或改写 `native_response.evidence`：

| 原生结果 | 可确认的事实 |
|---|---|
| `evidence:"timeout"`、`observed_state:null` | 等待期间未观察到所需的新 working/blocked 跃迁；不能推断没有回复 |
| `evidence:"timeout"`、`observed_state:"working"` 或 `"blocked"` | 已观察到跃迁，但截止前等待未匹配 `until`；不能推断执行失败 |
| `evidence:"state_transition"`、`matched:true` | 原生状态等待已匹配；仍需读取并核对本轮回复 |
| 旧响应缺少 `observed_state` | 信息不足，不能当成显式 `null` 分类 |

例如 `status:"idle", matched:false, evidence:"timeout", observed_state:null` 与 Agent 已经输出答案并不矛盾。该回包仍是正常收到的原生响应，Rovloom 调用可为 `responded`；它不同于 Gateway 派发失败或未获得回包。Rovloom 不凭当前 idle 改成 `matched:true`。原生 evidence 的改进跟踪在 [#301](https://github.com/ArnoChenFx/rovloom/issues/301)。

v0.6.8 的部署验收还确认：即使 `until:["done","idle"]` 且原生已回报 `status:"done"`，没有观测到新的 working/blocked 时仍可能返回 `matched:false, evidence:"timeout", observed_state:null`。长阻塞等待的通道修复和两段式可用，不表示这个原生一段式行为已经修复；需要 Luvus 原生层调整等待语义及响应 schema，Rovloom 保留原文。

v0.6.9 现场又报告 `until:["working"]`、`["done"]`、`["done","idle"]` 均等待 20 秒后返回 timeout/null/done。原生在提交时将当前状态记为等待基线；若已是 working，后续 working 采样不构成新的跃迁，直接变为 done 也不产生 working/blocked 跃迁。`observed_state` 不是当前状态镜像，因此 null 与当前 `status:done` 可以并存；不能仅凭 null 断定采样链路未连接。这一基线与跃迁条件需由 Luvus 原生改进，不是已修复的 Rovloom 功能。

## 验证

对真实 Luvus 的端到端验证见 [`e2e/README.md`](../e2e/README.md)。流程按 Quick Start 在真实终端配对后，经官方 MCP SDK 依次执行发现、描述、调用、查询和读取，并覆盖崩溃接管、进程被杀后重建、未知结果不重发和离线撤销。

升级长等待修复需要更新并重启 **Connector**，无需重新配对或换 token；Gateway 更新用于参数指南和字段诊断。

## 主机信息与 host 原生方法

设备固有信息由 machines_get 的可选 host 握手报告提供，machines_list 仅返回平台摘要；reported_at 与 source 必须一起读取。provider 的 native_version、schema_status 和 schema_sha256 由 providers_get / providers_list 提供，不混入原生方法目录。

Luvus 的 host.info / host.capabilities 已核对为只读、幂等、空参数对象的方法，并纳入静态分类。但它们属于独立 host profile / stdio_proxy，不在 session 能力中；当前托管 session 适配器仍明确拒绝 host 传输。独立原生路由在 [#303](https://github.com/ArnoChenFx/rovloom/issues/303) 跟踪。不要把“已审”当作“当前可通过 runtime_call 调用”，也不能为了调用而把 host 方法合成进 session 快照。
