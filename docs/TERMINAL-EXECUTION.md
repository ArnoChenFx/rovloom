# 终端执行

Connector 默认允许远程向终端写入输入，也允许远程指定要启动的命令。机器所有者可在 Connector 配置文件中把开关设为 `false` 关闭。本文说明开关的作用范围，以及终端输入的结果语义。

## 开关

在 Connector 用户文件（默认 `~/.config/rovloom/connector.json`）的根字段设置：

```json
{
  "allow_terminal_execution": true
}
```

- 省略或 `true` 表示开启。只有字面量 `false` 关闭。字符串、数字、`null` 和对象会被拒绝，既不开启也不关闭。
- 修改后重启 Connector。以系统服务运行时使用 `rovloom service restart --role connector`。
- 没有命令行参数，也没有 Gateway 侧开关。修改它不影响已有的 caller 与 local 授权、配对身份和已安装的 Agent。
- 升级不改变已有的显式设置：旧版本生成的 `connector.json` 已显式写出该值，沿用其中的选择；只有当初省略了该项的用户文件，升级后按默认变为开启。想保持关闭请显式写 `false`。

CLI 运行时以这份用户配置为准，覆盖 `managed/providers.json` 中安装快照里的同名值。
因此快照仍为 `false`、用户配置为 `true` 时，目录可以报告 `enabled`；实际原生写入门禁
使用同一份用户配置，不能只根据安装快照判断最终状态。
新配对的安装快照记录配对时的开关值；它不会随之后修改用户配置而自动更新。
用户配置缺少该字段时按默认值（开启）处理，不从旧快照恢复为关闭。

完整配置见 [配置参考](CONFIGURATION-zh.md)。

herdr-core 的输入/启动/宿主级能力共用同一个开关：`terminal.send`、`terminal.keys`、
`terminal.interrupt`、`terminal.put`、`terminal.kill`、`terminal.rm`、`terminal.keep`、
`terminal.label`、`terminal.run`、`machine.exec`、`file.read`、`file.write`、`file.edit`、
`doc.get`、`doc.set`、`server.restart`、`server.stop`，以及带 `lines>0` 的 `terminal.read`。
没有第二个开关：这些能力都不超过 `terminal.run`（它已经能在本机执行任意程序）。档位
（`observe`/`control`/`host`）只是目录里的标签，不是第二道开关：`control` 档的 `terminal.send`
确实能在 shell 里执行任意命令，所以它和 `host` 档受同一个开关管；开关一关全部关闭，不存在
“控制档绕过宿主档”的路径。目录里关闭时仍然列出它们，但 `available:false`；调用在 Gateway
登记前被拒（`forbidden`），在 Connector 写入前再核对一次（`not_dispatched` +
`terminal_execution_disabled`）。

开关由 Connector 在本机检查：先在发现阶段检查，再在实际写入原生 runtime 之前再检查一次。它是本机最终门禁，Gateway 隐藏工具不能代替它。

Gateway 会收到 Connector 报告的开关状态，在开关关闭或未知时从方法目录中隐藏直接终端写入。“未知”（尚未收到上报、断连或来源失效）始终按关闭处理，不受默认值影响。参数敏感的方法仍然可见，例如关闭时 `agent.send` 和 `agent.prompt` 的描述要求显式 `strict:true`。详见 [通道](TRANSPORT.md#终端执行开关观察)。

## 开关覆盖的操作

| 操作 | 关闭时 |
|---|---|
| Luvus `pane.run`、`pane.send_input`、`terminal.backend.create/control/type_literal/paste_text/submit_text/send_key` | 拒绝 |
| Luvus `module.action.invoke` | 拒绝，该方法会调用本地模块动作 |
| Luvus `agent.report`、`pane.report_session`、`pane.report_event` | 拒绝。这些报告会改变 runtime 对 Agent 的判断，不拒绝就能先把 shell 标为 Agent 再输入 |
| Luvus `agent.keys` | 一律拒绝。报告或 session 标记不能证明当前前台程序是 Agent |
| Luvus `agent.send`、`agent.prompt` | 只接受请求中显式带 `strict:true` 的文本。省略或 `false` 沿用宽松语义，需要开启开关 |
| Luvus `task.add`、`task.start` | 带非空 `gate` 或自定义 `agent` 命令时拒绝。不带这些的任务记录仍可用 |
| Luvus `task.done`、`task.retry` | 拒绝，它们可能执行已保存的 gate 或重启原运行 |
| Herdr `pane.send_text`、`pane.send_keys`、`pane.send_input`、`pane.link.activate` | 拒绝。链接可以调用本地处理器 |
| Agent 启动、workspace/tab/pane 创建、会话恢复 | 带非空 `command`、`args`、`env`、`resume_command`、`resume_argv` 时拒绝 |
| 严格 Agent 文本对话、读取、不带自定义启动参数的 `agent.start` | 不受开关影响，仍受 runtime 自身的检查和 caller/local 授权约束 |

具体的方法与参数判定见 [源码](../src/connector/terminal-execution.ts)。开启开关不会补齐缺失的授权或分类。例如，已有的 local 策略可能不含 `pane.run`，开启开关不会修改它。

严格文本对话保留 runtime 的目标检查和 prompt 就绪检查，请求参数不会被改写。Connector 不把这些检查或终端画面当作对当前前台身份的独立核验。开关也不隔离 Agent 自己的内部工具。

## 执行环境

- Connector 的发现、schema 获取和子进程使用固定的系统 `PATH`（可被 `native.agent_bin_dirs` 前置）和最小环境，不继承 Connector 进程的模型密钥、SSH 或其他凭据。`agent_bin_dirs` 的格式见 [配置参考](CONFIGURATION-zh.md)。
- 终端命令仍在目标 Luvus 或 Herdr 进程所属的 OS 账号和 shell 环境中执行。向已运行的终端输入时，工作目录和 `PATH` 由该终端的当前状态决定。
- 可写位置由该账号的实际 OS 权限决定。Rovloom 不提供文件系统沙箱，不提权，不安装 Agent，也不配置模型凭据。

## Luvus `pane.run`

`pane.run` 接受 `{pane, command}`，必须显式指定目标 pane，不接受 `cwd`、`env` 或 `argv`。命令写入该 pane，输出用 `pane.read` 读取。
它不是结构化进程执行接口：`{"type":"ok"}` 只确认输入提交，不包含命令 stdout、stderr 或退出码，不能据此判断命令完成。

## 结果语义

- 返回的 `native_response` 保留 runtime 的原值。
- Herdr 的 `ok` 和 Luvus 的 `queued`/`executed` 只表示输入操作成功，不表示 shell 命令已经结束。
- `pane.read` 和 `agent.read` 返回的是终端画面，可能经过渲染和截断，并保留 runtime 给出的截断信息。它不是无损的 stdout/stderr。
- Luvus RPC 结果中的外层 `exit_code` 属于固定的 CLI 代理。通过 IPC 调用时为 `null`，它不是终端内命令的退出码。
- 关闭 pane、超时和取消都不证明命令成功，也不回滚已执行的动作。
- 发送后没有收到结果的调用保持 `outcome_unknown`，不会自动重发。已提交派发记录的调用，之后关闭开关也不能清除记录重新执行。
