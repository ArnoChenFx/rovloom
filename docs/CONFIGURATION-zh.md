# Rovloom 配置参考

[English](CONFIGURATION.md) · **简体中文** · [快速开始](QUICK-START-zh.md)

每个角色只有**一份用户 JSON 文件**：`~/.config/rovloom/gateway.json` 或
`~/.config/rovloom/connector.json`。启动角色时自动创建缺失的文件；已有文件严格读取，永不重置。
下列字段除特别说明均为必填。默认值是新生成文件中的值，不是已有文件遗漏字段时的
隐式补值。全部示例均不含凭据。


## 显式初始化

```sh
rovloom config init connector --provider herdr
rovloom config init gateway --container
```

`--provider` 只适用于 Connector，可选 `luvus`、`herdr`、`herdr-core`、`mixed`（以及 `native.provider` 里列出的组合值）。`--container` 只适用于 Gateway，显式将 MCP、设备和管理监听设为 `0.0.0.0`；维护的 Compose 文件仍把 MCP / 管理端口只发布到宿主回环。MCP、管理页与管理 API 均无需公网 URL 配置即可使用反向代理。不带该参数时，Gateway 保持普通默认值（MCP 与设备通道通配，管理页回环）。`--config` 只选择配置文件，默认状态路径仍属于当前用户 home。

初始化不启动服务、不创建设备身份、不批准 native 访问，沿用角色首次启动的独占文件发布机制。已有文件不覆盖；显式 provider / 监听请求与已有内容冲突时返回 `config_exists`。已有部署应先核对配置和配对状态，编辑后用 `config check` 校验再重启。


## 完整最小配置

Gateway，通常为 `~/.config/rovloom/gateway.json`：

```json
{
  "schema_version": 1,
  "role": "gateway",
  "data": {"directory": "/home/your-user/.local/share/rovloom/gateway"},
  "mcp": {"hostname": "127.0.0.1", "port": 9444},
  "devices": {"hostname": "127.0.0.1", "port": 9443},
  "management": {"enabled": true, "port": 9445}
}
```

Connector，通常为 `~/.config/rovloom/connector.json`：

```json
{
  "schema_version": 1,
  "role": "connector",
  "data": {"directory": "/home/your-user/.local/share/rovloom/connector"},
  "gateway": {"url": ""},
  "allow_terminal_execution": true
}
```

保存示例时将 `/home/your-user` 替换为真实 home；程序生成的文件已经写入真实 home。
默认 Gateway 在没有身份时即可启动。Connector 的空地址是合法配置：本地终端会
询问地址，非 TTY 启动返回 `configuration_required`（2）。填写地址不等于已配对或已安装原生 provider。

## 全部用户参数

| 字段 | 类型 / 必需性 | 生成默认值 / 作用 |
|---|---|---|
| `schema_version` | integer，必填 | 只能为 `1`。 |
| `role` | string，必填 | `gateway` 或 `connector`，须匹配命令。 |
| `data` | object，必填 | 仅含 `directory`。 |
| `data.directory` | 规范绝对路径 string，≤4096 字符，必填 | `<home>/.local/share/rovloom/<role>`；各角色独立私有数据。 |
| Gateway `mcp` | object，必填 | 含 `hostname`、`port`；Streamable HTTP `/mcp`。 |
| `mcp.hostname` | string，必填 | 接受 `127.0.0.1`、`::1`、`0.0.0.0`、`::`。仅决定监听网卡，不限定代理域名。MCP 接受 HTTP/HTTPS 代理地址、保留或改写 Host 的 `/mcp` 请求，每次仍需 Bearer。 |
| `mcp.port` | integer 1–65535，必填 | `9444`。 |
| Gateway `devices` | object，必填 | 含 `hostname`、`port`；WS `/connector`。 |
| `devices.hostname` | string，必填 | `127.0.0.1`，也接受 `::1`、`0.0.0.0`、`::`；通配绑定接受远程设备。 |
| `devices.port` | integer 1–65535，必填 | `9443`。 |
| Gateway `management` | object，必填 | 含 `enabled`、`hostname` 与 `port`；本地 HTTP 管理页。 |
| `management.enabled` | boolean，必填 | `true`；`false` 关闭该监听。启用不授予管理员身份。 |
| `management.port` | integer 1–65535，关闭时也必填 | `9445`。 |
| `management.hostname` | string，可选 | `127.0.0.1`，也接受 `0.0.0.0`。仅决定监听网卡，不限定反向代理域名。管理页支持 HTTP/HTTPS、保留或改写 Host 的代理，无需公网 URL 配置。登录、会话与 CSRF 校验仍生效。 |
| Connector `gateway` | object，必填 | 仅含 `url`。 |
| `gateway.url` | string，必填 | 初始化前为 `""`；其余为 ≤2048 字符的 WS/WSS origin，如 `ws://192.0.2.10:9443` 或 `wss://gateway.example`。不带凭据/查询/片段/路径，可带末尾 `/`；产品固定使用 `/connector`。 |
| Connector `allow_terminal_execution` | boolean，可选 | `true`；省略也开启。只有字面量 `false` 关闭直接终端输入及自定义启动/恢复命令；只想接受严格 Agent 文本对话和读取的设备请设为 `false`。旧版本生成的文件已显式写出该值，沿用其选择；只有当初省略了该项的文件会变为开启。修改这一份用户文件并重启 Connector，不改变安装设置或 token 设备范围。 |
| Connector `native` | object，可选 | 默认省略，只接受以下来源选择及安装目录字段。配对时记录设备绑定的原生实例与可执行文件，之后的修改在每次启动时读取（见表后说明）。 |
| `native.provider` | string enum，可选 | 省略时为 `luvus`；`herdr` 仅选 Herdr，`herdr-core` 使用 herdr-core（见 `native.herdr_core.mode`），`mixed` 选本平台支持的全部来源：Linux 上是 Luvus、Herdr 与 herdr-core，macOS/Windows 上是 Luvus 与 Herdr（herdr-core 仅 Linux）。两两组合写明：`luvus,herdr`、`luvus,herdr-core`、`herdr,herdr-core`。0.10 之前 `mixed` 只表示 Luvus + Herdr；新配对想要这一对就用 `luvus,herdr`。加入命令会准备本字段选中的全部来源；配对之后它只是对「已配对来源」的筛选，可随时修改后重启：没选中的不启动；选了但从未配对的来源会在下次启动时**自动追加**（用设备凭据 POST `/pairing/providers`，不需要配对码）：本机准备该来源、Gateway 登记、当次启动就用上。失败时打印 `native_provider_append_failed: <kind> <固定码>`，已配对的来源照常启动，下次启动再试。`mixed` 在 Linux 上也会触发追加（0.10 之前按 mixed 配对的老设备，只要 core 可达就会被追加 herdr-core；macOS/Windows 上 mixed 仍只有 Luvus + Herdr）。安全后果：追加之后，任何持有该设备范围令牌的调用方都能使用新来源，而 `allow_terminal_execution` 默认开启；持有设备凭据的人能追加 provider（但他本来就能冒充这台设备）。 |
| `native.runtime_bin_dirs` | 1–16 个互不重复的规范绝对目录 string 数组（每项≤4096字符），可选 | 查找所选 `luvus`/`herdr` 程序的位置。搜索顺序：数组内目录依序，其后是 Connector 启动时 `PATH` 中可用的条目，最后是 `/usr/bin:/bin`（Windows 无此项）。不同程序可装在不同目录。不接受 shell 展开或可执行 argv。 |
| `native.agent_bin_dirs` | 1–16 个互不重复的规范绝对目录 string 数组（每项≤4096字符），可选 | 查找 Agent 程序的目录。Agent PATH 在原生初始化时按同样顺序固化。Rovloom 不安装或认证 Agent。 |
| `native.herdr.mode` | `"attach"`（默认）或 `"managed"`，可选 | 仅 Herdr。`attach`：连接你已在运行的 Herdr，仅在没有实例时在你自己的配置目录里启动一个，实例消失后重新附着/重建。`managed`：Connector 私有、由它拥有的隔离实例。见[Herdr：附着或隔离](#herdr附着或隔离)。 |
| `native.luvus.mode` | `"attach"`（默认）或 `"managed"`，可选 | 仅 Luvus。`attach`：连接你自己的 `default` 会话，仅在没有运行的会话时在你自己的 `LUVUS_HOME` 里启动一个，消失后重新附着/重建。`managed`：Connector 私有的隔离实例（会话名 `rovloom`）。见[Luvus：附着或隔离](#luvus附着或隔离)。 |
| `native.luvus.state_root` | 规范绝对目录 string，可选 | 附着模式下你的 Luvus 状态目录（默认取 Connector 环境里的 `$LUVUS_HOME`，否则 `~/.luvus`）。不存在时以 0700 创建，且必须是私有目录。 |
| `native.herdr.config_home` | 规范绝对目录 string，可选 | 附着模式下你的 Herdr 使用的配置目录（默认 `$XDG_CONFIG_HOME`，否则 `~/.config`）。Connector 以服务运行、环境与你的终端不同时请显式设置。 |
| `native.herdr_core.session` | 会话名（`A-Za-z0-9._-`，1–64 字符，并受 core 套接字路径上限约束），可选 | 仅 herdr-core。默认 `default`。会话名会成为 Target 的一部分，并在配对时固定。 |
| `native.herdr_core.mode` | `attach` 或 `managed`，可选 | 默认 `attach`：Connector 只附着已用这个 `HC_SESSION` 运行的 core，不启动或停止 core。`managed`：Connector 自己用 `native.runtime_bin_dirs`（或 `PATH`）里的 `herdr-core serve` 拉起 core，并给它私有的 `XDG_RUNTIME_DIR`/`XDG_STATE_HOME`/`XDG_CONFIG_HOME`；绝不调用 `hc`、不下载或更新 core，Connector 退出后 core 与终端继续运行。 |
| `native.herdr_core.config_home` | 规范绝对路径，可选 | 仅 `managed`；`attach` 下给了会被拒绝。managed core 用它放 `templates/` 与 `config.toml`（默认是 Connector 状态目录下的私有空目录）。指向你自己准备的目录即可使用自己的模板。 |
| `native.runtime_bin_dirs` | 规范绝对路径数组，可选 | `managed` 下查找 `herdr-core` 的目录（省略时按 `PATH`）。rovloom 不下载、不更新、不安装 core。 |

herdr-core 不限制版本号和协议代次：能不能用由它自己发布的契约决定，契约里必须包含 rovloom 审核过的全部方法（CI 只测上游发布的最新版）；每次配对还会钉住当时的二进制摘要与契约哈希（所以升级 core 后需要用新的配对码重新配对：`rovloom connector --join …`）。`allow_terminal_execution` 约束所有往终端输入、启动程序、执行命令或读写文件/文档、操作 core 生命周期的方法（`terminal.send`、`terminal.keys`、`terminal.interrupt`、`terminal.put`、`terminal.kill`、`terminal.rm`、`terminal.keep`、`terminal.label`、`terminal.run`、`machine.exec`、`file.read`、`file.write`、`file.edit`、`doc.get`、`doc.set`、`server.restart`、`server.stop`，以及带 `lines>0` 的 `terminal.read`）。没有第二个开关：这些宿主级能力都不超过 `terminal.run`（它已经能在这台机器上执行任意程序）。Connector 另外把「自己经 `terminal.run` 启动的存活终端」限制在每个 Connector 进程 32 个（`HERDR_CORE_MAX_RUN_TERMINALS`）。

Gateway 已启用的监听端口必须不同。未知字段、旧扁平字段、runtime/ref 选择、TLS/CA
路径、schema 摘要、binary pin 和凭据值均拒绝。用户参数不含原生 root、账本、绑定或
身份摘要。配对之后 Connector 的 Gateway URL 必须与配对时一致，已保存的设备凭据
不会发往另一个 origin。`native` 不再与配对时逐字比较，启动直接用当前文件。决定设备
绑定哪个原生实例与可执行文件的设置（`native.luvus.mode` / `state_root`、
`native.herdr.mode` / `config_home`、`native.herdr_core.session` / `mode` /
`config_home`，以及 Luvus、Herdr 的 `runtime_bin_dirs` / `agent_bin_dirs`）取自配对时：
改了其中某项，启动会打印 `native_settings_kept: <字段名>` 并继续使用配对时的值，
用新码重新执行加入命令后才应用新值。省略某项与显式写默认值等价。

路径为规范绝对路径，不相对 JSON 文件解析，不展开 `~` 或环境变量。默认角色文件始终
按进程用户 home 选择，Windows 也如此。`--config` 接受绝对文件路径，仅覆盖该文件位置；
新生成的数据目录仍按用户 home 选择。

新建文件/目录在支持的平台请求 `0600`/`0700`；不自动修复已有权限或损坏文件。
用户 JSON 上限 16 KiB，不支持注释，拒绝非法编码和重复键。支持的系统见[平台可用性](#平台可用性)。

## 程序管理的数据与认证

用户只编辑角色文件。`data.directory` 是 Rovloom 保存数据库、设备凭据和原生状态的位置，
程序在启动和已批准的初始化中自行准备，无需手工创建 `runtime.json`、`refs/`、
provider JSON 或凭据文件。

保留整个数据目录，包括数据库附属文件。不要修改内部记录，也不要为重试不确定的
初始化而删除数据。Herdr 使用 `<data.directory>/hr/` 下的隔离目录。
首次 Luvus 设置要求 `data.directory` 路径加 `/n` 不超过 52 个 UTF-8 字节，
如有需要，请在配对前选择更短的目录。

没有 caller 状态的 Gateway 处于**待配对**状态：MCP 返回 401，管理页在创建管理员之前
只显示空壳。首次配对为已审核的 Target 创建一个本机 caller，Bearer 仅显示在
已核验的本地终端，并由 Rovloom 私密保留；请复制到 MCP 客户端的秘密存储。
默认有效期 30 天，用 `rovloom token` 管理。设备凭据、MCP Bearer 与管理员密码互不替代，
MCP Bearer 不能登录管理页。经 Gateway 终端完成首次配对时，终端会创建管理员 `admin`，
并在 MCP Bearer 旁边只显示一次它的密码；之后用 `rovloom admin` 管理。

也可以在**任何配对之前**创建第一位管理员（`rovloom admin create` 会初始化空的调用方
注册表），登录管理页后全程在页面完成首台设备的配对；见下文「配对」。在终端拒绝配对
提示时，Gateway 会保持未配对运行并提示这条网页引导路径。

### 管理页管理员

```text
rovloom admin create [--principal admin] [--ttl-days 30]
rovloom admin list
rovloom admin revoke [--principal admin]
```

管理页（默认 `http://127.0.0.1:9445/`）用 HTTP Basic 登录：用户名是管理员 ID（默认 `admin`），密码是
`create` 写到 stdout 的那一串，**只显示一次**（其余信息写 stderr）。Gateway 只在 `managed/management.json`
保存它的 SHA-256 摘要。创建、重新签发和撤销都**无需重启**：对已有 ID 重新 `create`（忘记密码时的做法）会替换密码，
并使旧密码已登录的浏览器会话立即失效；`revoke` 同样立即生效。管理员能查看并管理 Gateway 已知的全部设备和
provider，包括之后才配对的，但不能调用 MCP。`rovloom admin create` 在尚未完成首次配对的
Gateway 上也可运行：它会初始化登录流程所需的调用方注册表，因此管理页在第一台设备存在之前
就可用。Docker 里用 `docker compose run --rm gateway admin create`。

### Bearer 令牌管理

```text
rovloom token list
rovloom token create --principal worker --like owner [--ttl-days 30]
rovloom token renew  --principal owner [--ttl-days 30]
rovloom token rotate --principal owner [--ttl-days 30] [--grace-minutes 10]
rovloom token revoke --principal worker
rovloom token scope  --principal worker --devices m_ab12,m_cd34
rovloom token scope  --principal worker --all-devices true
rovloom token scope  --principal worker --no-devices true
```

令牌注册表（Gateway 状态目录下的 `managed/mcp-callers.json`）保存 SHA-256 摘要、新签发令牌的原文、主体身份、设备范围和固定到期；
Gateway 每次认证都重读它，因此创建、续期、轮换和吊销**无需重启**，吊销同时使已建立的 MCP 会话失效。
`create`/`rotate` 把新令牌原值只写到 stdout 一次（其余信息写 stderr）；新主体的设备范围克隆自 `--like`。
`rotate` 默认立即让旧令牌失效，`--grace-minutes` 给客户端一个有界的切换窗口。本机 `mcp-client.json`
属于同一主体时会同步更新。注册表损坏时拒绝全部认证，修复前一直如此。

### 设备可见范围

Herdr、Luvus 和混合模式共用两个权限开关：token 的设备范围，以及 Connector 的 `allow_terminal_execution`（直接终端输入、执行及自定义命令）。不再配置按方法、provider 或 read/dispatch/cancel 动作划分的授权。

新注册表为 `schema_version: 2`，调用方只保存身份、凭据、期限及可选的 `device_scope`：

```jsonc
{
  "principal": { "id": "worker" },
  "token_sha256": "…",
  "device_scope": { "mode": "selected", "machine_ids": ["m_ab12", "m_cd34"] },
  "issued_at": 1000,
  "expires_at": 86401000
}
```

- 不设范围即全部活跃设备，包含后来加入的设备。`selected` 接受 0–256 个去重稳定 ID；不接受设备名，空列表禁止所有设备。
- `token scope --devices ...`、`--no-devices true`、`--all-devices true` 热生效；`token create --like` 克隆范围，配对不修改已有范围。
- 枚举和描述隐藏范围外设备，返回 `not_found`；派发、取消及结果访问返回 `forbidden`。每次操作重读当前身份和范围，收窄范围不会停止已经派发的原生操作。
- 可见设备上的全部已暴露方法可调用，仍遵守 Connector 终端开关和实际原生可用性。参数、来源、binding、期限、幂等性属于正确性校验；调用和结果仍属于原主体。

旧 v1 注册表只读加载时不改盘。普通旧 caller 仅从其自己的 grants 提取 machine ID，迁为设备范围；已有显式范围优先。旧 Gateway scope 和配对主体保持全设备范围，不借 `local_policy` 扩权。下次写注册表时保存 v2，去掉旧 caller/local/gateway 策略、methods/actions/revision 和结果删除权限。管理专用身份不能认证 MCP，管理角色独立保留。

升级并重启 Gateway 和 Connector，原 token、配对凭据继续使用，无需重新配对或补方法授权。旧 Connector 的 policy/raw 字段仅兼容读取，不参与授权；新配对不再生成它们。升级前停止两端，备份完整私有数据目录和配置；回滚需恢复配套备份及二进制，旧版不兼容新注册表/配置格式。

### 配对

Connector 需要可达的 Gateway 地址和已完成的配对。配对是单码直连：管理页
（或 `rovloom gateway --issue-code`）生成一机一码并显示完整加入命令，Connector
机器执行 `rovloom connector --join ws://<地址>#<码>` 一次完成——没有申请、批准、
核对码或终端问答。命令写入 Gateway 地址、扫描本地原生安装、用码换取设备凭据
（Gateway 只存摘要）并直接启动；首台设备同时打印 MCP 地址与 Bearer。

- 一机一码：第一次成功兑换即消费该码；已用、作废或失败的码不能再次兑换，重新生成即可。
  未使用码的明文保存在 Gateway 私有状态目录，管理页可随时重显；终结时明文抹掉。
- 用新码再次执行加入命令会把本机作为新设备重新配对，旧的本地配对状态连同 managed
  原生根整体退役到 `state/retired/`（managed 实例数据保留可人工恢复）；凭据丢失或被
  吊销时走这条路即可。换成另一台 Gateway 的加入命令同样自动退役旧状态并直接配对过去，
  `rovloom connector --unpair` 则只做退役与地址清空、不立即配对。
- 设备凭据不过期，撤销或重新配对时失效；撤销后的设备只能作为新设备重新配对。

原生初始化自动批准：Gateway 编译核验设备提交的实测安装清单后发布 provider 与
caller 配置并热重载，全程不停机。原生初始化不会登录模型、创建 Agent 或证明模型回复。

`config check-runtime` 只检查已有 provider registry，不检查 caller 凭据、TLS 信任、
原生 binary 或模型连接。

## 网络访问

Gateway 在本机/可信网络使用普通 HTTP/WS，公网 TLS 由外部标准 HTTPS/WSS 反向代理
终止。Connector WSS 始终使用系统证书验证，没有自定义 CA 或跳过验证选项。

MCP、管理页与管理 API 均支持保留或改写 Host、外部 HTTPS / 内部 HTTP 的反向代理，
无需公网 URL、域名白名单或可信代理配置。**升级前必须删除旧配置中的 `mcp.public_url` 字段；
保留该字段会被作为未知配置拒绝，导致 `config check` 和 Gateway 启动报 `invalid_config`，不会忽略旧值。**
在 AI 客户端直接填写代理的 HTTPS `/mcp` 地址；Gateway 显示的本机地址仍供本机客户端使用。
代理保留 `/mcp`、`/admin/v1/…`、Authorization 与 MCP 会话头，MCP 的 SSE 响应不要缓冲。
管理 API 继续核验管理员 Cookie 和写操作 CSRF，MCP 每次请求仍核验当前 Bearer。

无代理的局域网客户端：把 `mcp.hostname` / `management.hostname` 设为通配地址。这些监听随后接受局域网 Host 的明文 HTTP——MCP 仍需 Bearer，
管理页保留 Cookie、CSRF 与同源检查，但两者都没有传输加密和网络层隔离。请用防火墙收口局域网，并在任何离开局域网的路径前加 TLS 反向代理。

## 原生安装

从官方 [Luvus](https://github.com/RizRiyz/luvus/releases/latest) 或
[Herdr](https://github.com/herdrdev/herdr/releases/latest) 发行版安装原生程序。兼容性按已安装版本的协议、
完整请求/响应 schema 和实际提供的方法判断；版本标签只用于诊断。缺少或不兼容的可选接口
仅使依赖它的操作不可用。

| 接入依据 | Luvus | Herdr |
|---|---|---|
| Schema 命令 | `luvus uhp schema` | `herdr api schema --json` |
| 协议依据 | UHP v1 信封及在线方法目录 | schema 中的协议和完整 JSON RPC 根 |

程序管理的状态与当前来源须在 binary 与 schema 摘要上一致。这些是接入检查，不是用户 JSON 字段。
Rovloom 不安装原生程序，也不准备模型访问。

## Herdr：附着或隔离

**attach（默认）。** 初始化时记录你真实的 `HOME` 与 XDG 目录（取自 Connector 的环境，或 `native.herdr.config_home`）。每次启动 Connector 会：

1. 在默认会话的端点上寻找 Herdr 服务端；只有证明对端就是你已安装的 `herdr` 才附着：同一用户、进程可执行文件与配置的二进制是同一文件、
   命令行为 `herdr server`（或 `--session <名> server`）；
2. 没有实例才在你的配置目录里以脱离方式启动 `herdr --session <名> server`——Connector 退出后它继续运行（工作区也保留）；
3. 持续监视该实例。实例消失时，Connector 关闭旧资源、带退避地重新附着或启动新实例，并结束当前连接，使下一次连接使用新实例。此刻在途的调用保持
   `outcome_unknown`，不会重发。

**不是**你已安装 `herdr` 的监听者既不会被附着也不会被替换。Connector 启动的服务端继承你的 shell 与 Git 配置，但不继承其它环境变量（SSH agent、API key 等），
Agent 凭据请配置在 Agent 自己的文件里。远程调用会操作你的**真实**工作区，Gateway 授权与 `allow_terminal_execution` 仍是仅有的围栏。

**managed。** 在 Connector 数据目录下（`<data.directory>/hr`）的私有实例，由 Connector 拥有并随之停止，不共享你普通 home 里的任何东西。

## Luvus：附着或隔离

**attach（默认）。** Gateway 配对目标是你的 `default` 会话（Gateway 提示里显示 `session: default`）。初始化时记录你真实的
`HOME` 与状态目录（`native.luvus.state_root`，否则 `$LUVUS_HOME`，否则 `~/.luvus`）。每次启动 Connector 会：

1. 用固定的 `luvus` 列出会话（`session list --json`，以私有 HOME 运行，不读取其它内容）；只有 `default` 正在运行**且**其 socket
   对端被证明就是你已安装的 `luvus` 才附着：同一用户、进程可执行文件与配置的二进制是同一文件、命令行为
   `luvus [--session default] server`；
2. 否则以脱离方式启动 `luvus --session default server`，使用你真实的 `HOME`、shell 和 `LUVUS_HOME`（不带 SSH agent、API key
   等变量），Connector 退出后它继续运行；
3. 持续监视该实例。消失时带退避地重新附着或启动新实例，并结束当前连接，使下一次连接使用新实例。此刻在途的调用保持
   `outcome_unknown`，不会重发。

该端点上**不是**你已安装 `luvus` 的 server 既不会被附着也不会被替换。远程调用会操作你的**真实**工作区，Gateway 授权与
`allow_terminal_execution` 仍是仅有的围栏。

**managed。** 在 Connector 数据目录下的私有实例（会话名 `rovloom`），由 Connector 拥有并随之停止。数据目录路径加 `/n` 须不超过
52 字节，不共享你普通 home 里的任何东西。

## 崩溃后重启

Connector 被强杀（`kill -9`、掉电）后会遗留 owner 记录、native 端点 socket 和 claim 账本锁。
下次启动时，只有在**能证明旧 owner 已不存在**时才会自行清理：记录的 owner 进程
已不存在（Linux，按 PID 与内核启动时间判断），且 native socket 上没有监听者。清理后向 stderr
输出 `herdr_crash_residue_cleared` 并正常启动。claim 账本及其派发记录不会被触碰，
可能已执行的调用不会被重发。若旧 owner 仍存活、仍有 native 进程在监听、记录无法读取或平台
不是 Linux，则拒绝启动（退出码 3），需先停掉仍存活的进程。

Luvus 的两把崩溃锁（claim 账本锁、root 拥有锁）同理，锁里记录持有进程。
只有该进程已不存在才会移除锁；拥有锁还要求该会话的 Luvus socket 上无人监听。
移除后向 stderr 输出 `luvus_crash_residue_cleared`。无法读取的锁和非 Linux 平台保持拒绝，需手工删锁。

## 程序与 Agent 安装目录

runtime（`luvus`/`herdr`）和 Agent（如 OpenCode）可以装在机器上任意合适的位置，不必
同一目录。默认通过 Connector 启动时的 `PATH` 加 `/usr/bin:/bin` 查找它们。Rovloom **不会**
使用登录 shell 的 PATH：搜索路径在首次原生初始化时一次性算出，固化到受保护的安装记录，
之后每次启动都会复核。

`PATH` 里只有部分条目可用：规范绝对路径、真实存在的目录（不是符号链接、文件或缺失路径），
属于 root 或 Connector 用户，且组/其它用户不可写；其余条目静默跳过。最多保留 16 个目录，
显式目录在前。若服务管理器给 Connector 的 `PATH` 很精简，请在**执行 `connector --join` 之前**于唯一
Connector 用户文件里显式列出目录：

```json
{
  "native": {
    "runtime_bin_dirs": ["/opt/herdr/bin", "/home/your-user/.local/bin"],
    "agent_bin_dirs": ["/home/your-user/.local/bin", "/home/your-user/.opencode/bin"]
  }
}
```

两个字段都是可选的规范绝对目录数组（不接受 `~`、变量、相对路径、`..`、末尾斜杠或 `a:b`
式 PATH 字符串，不允许重复）。显式目录按所写原样信任，所以应由机器所有者控制；靠前目录里的
同名程序优先。这是原生安装设置，不是可执行文件路径、MCP 参数或命令行选项。

Agent/模型访问配置位于 runtime 的私有 HOME/XDG。managed 模式下其 HOME 为
`<data.directory>/h`（Luvus）或 `<data.directory>/hr/h`（Herdr），不会复制普通 home 中的登录，
因此模型访问需由机器所有者在该环境中准备。纯文本对话可把 `allow_terminal_execution` 设为 `false`。
终端开关不会沙箱化 Agent 自身工具；仅有 `ready` 不证明模型已回复。

直接终端操作使用原生方法：Luvus `pane.run` 接受显式 `pane` 与 `command`，随后用
`pane.read` 读取输出。`ok` 仅确认 PTY 输入，不表示命令完成或退出码。
本地开关关闭或未知时，Gateway 目录隐藏直接输入。所有 token 都可调用当前暴露的 `pane.run`，不需要补方法授权。
详见[终端执行](TERMINAL-EXECUTION.md)。

## CLI 参考

`ROLE` 表示 `gateway` 或 `connector`，`ABS` 表示单独作为参数传入的规范绝对路径。
命令及选项名区分大小写，不支持 `--option=value`、组合短选项或额外参数。只有顶层帮助提供短选项。

### 帮助、版本与配置

| 命令 | 参数 / 选项 | 作用 |
|---|---|---|
| `rovloom`、`rovloom --help`、`rovloom -h`、`rovloom help` | 无 | 输出顶层帮助。 |
| `rovloom gateway --help`、`rovloom connector --help` | 仅 `--help` | 输出顶层帮助。 |
| `rovloom --version` | 无 | 输出产品版本，没有 `-v` 别名。 |
| `rovloom config template ROLE` | 必填 `ROLE` | 输出完整无秘密角色 JSON，不写文件。 |
| `rovloom config check [--role ROLE] [--config ABS]` | 均可选，顺序可交换 | 无选项时检查两份默认用户文件并分别报告；`--role` 单选角色，`--config` 覆盖路径。只读，不创建文件。 |
| `rovloom config check-runtime [--role ROLE] [--config ABS]` | 同 `check` | 额外检查已有程序管理 provider 状态；不加载凭据，不确认 Agent 就绪。 |

仅指定文件时按文件内声明的角色检查；同时指定 `--role` 时必须匹配。检查两份时一份错误不会跳过另一份，
任一失败则退出非零。

### 运行角色

| 命令 | 作用 |
|---|---|
| `rovloom gateway [--config ABS] [--non-interactive]` | 启动前台 Gateway。默认文件 `~/.config/rovloom/gateway.json`。 |
| `rovloom connector [--config ABS] [--non-interactive]` | 启动前台 Connector。默认文件 `~/.config/rovloom/connector.json`。 |
| `rovloom gateway --issue-code [--config ABS]` | 启动时打印一张一机一码及完整加入命令。 |
| `rovloom connector --join <ws://host:port#码> [--config ABS]` | 一条命令完成配对并启动；无任何问答。 |
| `rovloom connector --unpair [--config ABS]` | 把本地配对状态（含 managed 原生根）整体退役到 `state/retired/` 并清空 Gateway 地址；先停该 Connector。 |

显式 `--config` 优先，无效时不会回退。所选文件必须匹配角色。缺失文件会在所选位置生成，已有文件不会被覆盖。
Ctrl-C 停止前台角色，顶层没有 `start`、`stop` 或 `restart`。端口是 JSON 字段，不是命令行选项。

`--issue-code` 与 `--join` 不需要本地终端，可与 `--non-interactive` 合用。
`--non-interactive` 关闭本地交互引导，Windows 服务会自动传入。

### Service 命令

`rovloom service --help` 可离线使用。安装要求当前 Rovloom 单文件、正常系统服务授权、
既有非 root 账户及存在的工作目录。缺失的配置文件在首次正常启动时生成。
前提与平台限制见 [SERVICE](SERVICE.md)。

| 命令 | 必填参数 | 作用 |
|---|---|---|
| `rovloom service install` | `--role`、`--workdir`、`--user`；`--executable`、`--config` 可选 | 登记开机自动启动，**不会立即启动**。 |
| `rovloom service start` | `--role` | 立即启动已安装的角色。 |
| `rovloom service restart` | `--role` | 停止已安装实例，再启动。 |
| `rovloom service stop` | `--role` | 立即停止，保留下次开机自动启动。 |
| `rovloom service uninstall` | `--role` | 删除未来开机自动启动，**不会停止**正在运行的实例，也不删除数据。 |

Linux 示例：

```sh
rovloom service install --role gateway --workdir /home/rovloom --user rovloom
rovloom service start --role gateway
```

每个动作只选择一个角色，另一角色需单独操作。没有默认角色、`all`、`--now`、`--force`、`--purge` 或 `service status`。

| 选项 | 适用 | 含义 |
|---|---|---|
| `--role` | 所有动作 | `gateway` 或 `connector`。 |
| `--executable` | install，可选 | 绝对路径，≤4096 字符。默认并且必须等于当前单文件程序；Windows 须以 `.exe` 结尾。 |
| `--config` | install，可选 | 绝对路径，≤4096 字符。默认为当前用户的角色文件。安装时固定该路径，之后启动不再解析其他 home；通过 sudo 执行时请显式传入。 |
| `--workdir` | install，必填 | 绝对工作目录，≤4096 字符，不替代 `data.directory`。Linux 上不得以空白或反斜杠结尾。 |
| `--user` | install，必填 | Linux/macOS 上既有的非 root 账户；Windows 上既有用户名或 SID（S4U，不保存密码）。 |

start/restart 要求已有安装记录，重复 start 不会产生重复实例。Windows 的 stop/restart 可能直接终止任务。

成功时在 stderr 输出一行 JSON，含 `bootEnabled`、`controlRetained` 与 `readiness: "not_checked"`。
请通过前台进程及[快速开始](QUICK-START-zh.md)中的检查确认就绪状态。进程在运行本身不证明
MCP 或 Agent 就绪，HTTP 客户端断开也不会停止 Gateway。

### 平台可用性

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| 帮助、版本、模板、`config check` | 可用 | 可用 | 可用 |
| 角色文件创建、Gateway 启动、`config check-runtime` | 可用 | 可用 | 可用 |
| 首次配对审批（本地终端） | 可用（x64） | 可用（x64、arm64） | 可用（x64） |
| 原生 Connector | x64 | x64、arm64，仅 attach 模式 | x64，仅 attach 模式 |
| Service：Gateway | systemd | LaunchDaemon | 开机任务（S4U） |
| Service：Connector | x64 | x64、arm64，LaunchDaemon | x64，开机任务（S4U） |

macOS 和 Windows 上 Connector 附着你已在运行的 Herdr / Luvus，仅在没有实例时才启动一个；不支持 `managed` 模式。

### 输出与退出码

帮助、版本、检查结果和服务诊断写入 **stderr**，模板 JSON 写入 **stdout**。stdout 不是 MCP 传输。
任何选项都不接受 Bearer、TLS 或模型秘密，也不接受任意环境变量。

| 退出码 | 含义 |
|---|---|
| `0` | 成功、正常关闭，或服务动作幂等成功。 |
| `1` | 运行或关闭失败；服务动作失败（含 `permission_denied`，Rovloom 不会调用 sudo）。 |
| `2` | 参数或配置错误，含 `invalid_arguments`、`configuration_required`。 |
| `3` | 后端或运行时不可用、服务平台不支持，或因崩溃残留而拒绝启动。 |

求助时保留错误码，不要贴出真实配置、Bearer、管理员密码或配对码。


### 结果清理

读取并保存所需结果后，以 `call_id` 调用 `runtime_response_discard`，删除原文和句柄。只检查当前身份、设备范围及原主体归属，没有独立删除权限或 `token permissions` 命令。读到 EOF 不会删除或续期。

原生响应在入库时完成来源和结构校验，已保存结果在固定 TTL 内可在断连后读取，仍服从 Store 内容/句柄预算及设备生命周期。分页不再要求原 Wire 存活或重复验证 schema。生产运行时完成后释放执行上下文，持久结果不会各自占住一个读取上下文。
