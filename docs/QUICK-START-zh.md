# Rovloom 快速开始

[English](QUICK-START.md) · **简体中文** · [配置参考](CONFIGURATION-zh.md)

Rovloom 有两个角色：

- **Gateway**：AI 客户端访问的 MCP 入口。
- **Connector**：运行在每台装有 Herdr 或 Luvus 的机器上，主动连接 Gateway。

两个角色可以运行在同一台机器上。Gateway 支持 Linux、macOS 和 Windows；Connector 支持 Linux x64、macOS（x64、arm64）和 Windows x64；在 macOS 和 Windows 上附着你已在运行的 Herdr / Luvus。

## 1. 安装

**Linux / macOS**（x64 或 arm64）。Linux 支持 glibc 与 musl，安装器会自动选择对应资产。
musl 版另需 C++ 运行时（Alpine 上 `apk add libstdc++`），且不能用 Luvus managed 原生进程管理，
详见[分发说明](DISTRIBUTION.md)。无需 Bun、Node 或 root 权限：

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

**Windows PowerShell**（x64 或 arm64）：

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.ps1 | Invoke-Expression
$env:Path = "$env:LOCALAPPDATA\Rovloom\bin;$env:Path"
```

两个安装器都会按发行中的 `SHA256SUMS` 校验二进制，只安装程序
（`~/.local/bin/rovloom` 或 `%LOCALAPPDATA%\Rovloom\bin\rovloom.exe`），不创建配置或系统服务。
请把安装目录永久加入 PATH，然后检查：

```sh
rovloom --version
```

也可以从 [Release 页面](https://github.com/ArnoChenFx/rovloom/releases/latest)下载二进制；
安装器选项见[分发说明](DISTRIBUTION.md)。

**已经装了 Bun（1.4.4 及以上）？** Rovloom 发布在 npm 注册表上，可以全局安装，也可以不安装直接运行一次：

```sh
bun add -g rovloom
rovloom --version
bunx rovloom --version
```

需要锁定版本时，每个发行也附带同样的 npm 包 tarball 作为 Release 资产：

```sh
bun add -g https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz
bunx --package https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz rovloom --version
```

升级用 `bun update -g rovloom`（或用新发行的地址再执行一次 `bun add -g`）。这个包只能在 Bun 上运行，
`rovloom service install` 仍然需要上面的单文件二进制。

**Docker 运行 Gateway（Linux x64/arm64，Docker Compose v2）**——可选，无需在 Gateway 主机安装二进制：

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
```

9443、9444、9445 端口需要空闲（Compose 从 bridge 网络发布这三个端口）；镜像内已设置 `ROVLOOM_CONTAINER=1`，首次启动会自动生成容器监听配置（三个监听都绑 `0.0.0.0`）。卷、备份和升级见 [Docker 部署](DOCKER-zh.md)。

## 2. 准备 Connector 所在机器

Connector 自己不能管理任何东西：它必须经一个运行时才能到达会话，所以这台机器在配对前要先装好
**Herdr** 或 **Luvus**——两者之一必需。再安装你要使用的 Agent，并登录模型服务。Rovloom 不会安装这些程序。

| 平台 | Herdr | Luvus |
|---|---|---|
| Linux x64 / arm64 | `curl -fsSL https://herdr.dev/install.sh \| sh` | `curl -fsSL https://luvus.dev/install.sh \| sh` |
| macOS x64 / arm64 | 同 Linux 的命令，或 `brew install herdr` | 同 Linux 的命令，或 `brew install RizRiyz/luvus/luvus` |
| Windows x64 | `irm https://herdr.dev/install.ps1 \| iex` | `irm https://luvus.dev/install.ps1 \| iex` |

两个项目都按操作系统与架构分别发布构建，并在各自 Release 页列出全部压缩包
（[Herdr](https://github.com/herdrdev/herdr/releases/latest)、
[Luvus](https://github.com/RizRiyz/luvus/releases/latest)）；脚本或 Homebrew 不可用时用这个方式安装。
Windows arm64 上 Herdr 安装脚本会退回用模拟运行 x64 构建，Luvus 的预编译二进制只有 x64——与 Connector 的限制相同。

两个安装脚本都把二进制放到 `PATH` 上的目录——Herdr 放 `~/.local/bin`，Luvus 在可写时放 `/usr/local/bin`、
否则放 `~/.local/bin`——并会打印所用目录。程序通过 Connector 启动时的 `PATH`（加上 `/usr/bin:/bin`）查找，
所以脚本提示你扩展 `PATH` 时，也要让 Connector 看到同一个目录，或把它写进 `native.runtime_bin_dirs`——
见[安装目录](CONFIGURATION-zh.md#程序与-agent-安装目录)。
配对前 `herdr --version` 或 `luvus --version` 应当有输出；所选运行时缺失时，配对会以 `configuration_required` 中止。

Connector **附着到你已在运行的会话**，因此远程调用操作的是你真实的工作区和 Agent 登录；
只有没有运行实例时，才会在你自己的配置目录里启动一个。

默认使用 Luvus。首次配对前，用以下命令选择 Herdr（`mixed` 表示两个都用，需要两者都已安装）：

```sh
rovloom config init connector --provider herdr
```

只生成配置，不启动 Connector 或询问地址。已有配置不会覆盖；如果已选择其它 provider，命令返回 `config_exists`，请先核对再修改。

## 2b. herdr-core（仅 Linux，core 0.1.14）

herdr-core 是第三种 runtime：core 自己的智能体管理 API（unix socket），不是 Herdr TUI。只支持
Linux，固定 **0.1.14** —— 握手拒绝其它版本，二进制摘要会在配对时记录。

从官方发布清单安装，自己核对压缩包（不要 `curl | sh`）：

```sh
curl -fsS https://releases.herdr.dev/core/0.1.14/manifest.json -o manifest.json
python3 -c 'import json;t=json.load(open("manifest.json"))["targets"]["linux-x86_64"];print(t["url"]);print(t["sha256"])'
# 下载打印出来的地址，然后：
echo "<清单里的 sha256>  herdr-core.tar.gz" | sha256sum --check
tar -xzf herdr-core.tar.gz -C ~/.local/bin
```

然后要么自己启动 core（`HC_SESSION=default herdr-core serve`，或 `hc run --bg ...`）并选 `attach`，
要么让 Connector 拉起私有实例：

```json
{
  "native": {
    "provider": "herdr-core",
    "herdr_core": { "session": "default", "mode": "managed" }
  }
}
```

`mode: "managed"` 用 `native.runtime_bin_dirs`（或 `PATH`）里的 `herdr-core serve` 启动，并给它私有的
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME`/`XDG_CONFIG_HOME`；rovloom 不调用 `hc`、不下载或更新 core，Connector
退出后 core 与终端继续运行。模板在 `<config_home>/herdr-core/templates/*.md`；managed 默认的 config home
是私有空目录，用自己的模板就把 `native.herdr_core.config_home` 指向准备好的目录。core 启动的终端继承它的环境：
`PATH` 是 `/usr/bin:/bin`，前面按顺序加上 `native.agent_bin_dirs`（与 Luvus、Herdr 同一规则，把它设成 agent 所在目录），
`HOME` 保持真实家目录，`XDG_*` 是私有目录。

配对照常（`rovloom connector --join …`）。MCP 客户端能做的事：

- 读取：`server.status`、`templates.list`、`terminal.get`、`terminal.list`、`terminal.read`
  （`lines` 最多 1000）、`terminal.wait`；
- 输入与生命周期（需要 `allow_terminal_execution`）：`terminal.send`、`terminal.keys`、
  `terminal.interrupt`、`terminal.put`、`terminal.kill`、`terminal.rm`、`terminal.keep`、
  `terminal.label`；
- 启动（需要 `allow_terminal_execution`）：`terminal.run`（程序或模板）与 `templates.list`；
- 其余保持关闭：`machine.*`、`file.*`、`doc.set`、`server.stop/restart`、`terminal.attach`。

要跟踪状态变化而不停 `terminal.list`，用长轮询 `terminal.events`：返回当前快照 + `after_seq`
之后至多 `limit` 条事件（默认 64 条，最多等 30 秒）。把返回的 `next_after_seq` 带回去。
`rebuilt`、`truncated`、`dropped` 是对**你这个 `after_seq`** 的回答，不会黏住：`rebuilt:true` 表示你的水位对不上了
（比 core 当前水位还大，例如 core 重启后；或早于 feed 当前快照的起点），请用返回的 `terminals` 重建状态；
`truncated:true` 且 `dropped:n` 表示本地缓冲已经挤掉了你还没读的 `n` 条事件。已消失终端的 `finished`、
`removed`、`lost` 事件也会送达，不按快照过滤。已知局限：core 重启后 `core.id` 不变、`seq` 从 0 重来，
一个恰好落在新范围内的旧水位无法分辨；请持续轮询，并把 `seq` 变小当作重启的信号。它是观察档，
不需要 `allow_terminal_execution`。

模板启动长这样（`argv[0]` 是模板名；`template: true` 让 rovloom 先用 `templates.list` 核对）：

```json
{ "method": "terminal.run", "params": { "argv": ["reviewer", "Review src/x.rs"], "template": true, "name": "review" } }
```

之后按轮对话：`terminal.send` 带 `wait: true` 和显式 `timeout`（≤60 秒）发一条并等这一轮结束，
`terminal.read` 带 `lines` 读回复。一轮结束后智能体是 `done` 而不是 `idle`，所以 `if: "idle"`
不能当「可以发下一条」的条件。`status_mismatch` 这类 core 明确拒绝会以 `not_dispatched` + `reason`
返回，表示什么都没输入。

## 3. 启动与配对

配对只需一条命令：启动 Gateway，生成一张一机一码，把显示的加入命令复制到 Connector
机器执行——没有问答、批准或核对码。

**Gateway 机器上：**

```sh
rovloom gateway
```

Docker Gateway：按第 1 节初始化后 `docker compose up -d`。也可以用 `--non-interactive`
无人值守运行，管理页照常可用。

通过管理页配对（推荐）时，在 Gateway 机器的另一个终端创建管理员并保存密码
（用户名默认 `admin`）：

```sh
rovloom admin create
```

Docker 使用 `docker compose run --rm gateway admin create`。再次 `create` 会重新签发
同名管理员的密码，旧密码与已登录浏览器会话立即失效。

**生成配对码**，两种方式任选：

- 管理页：浏览器打开 `http://127.0.0.1:9445/` 登录，进入**配对设备**点击**生成配对码**，
  立即显示完整加入命令和复制按钮；未使用的码可随时在列表中作废。
- 终端：`rovloom gateway --issue-code`，启动时打印一条加入命令。

**Connector 机器上**，粘贴执行加入命令：

```sh
rovloom connector --join ws://127.0.0.1:9443#机器.码ID.秘密
```

配对到此完成：Connector 写入 Gateway 地址、扫描本地 Herdr/Luvus 安装、一次请求用码
换取设备凭据并直接启动运行。首台设备会额外打印一次 MCP 地址和 Bearer。几秒后设备
出现在管理页中；Gateway 运行中自动加载新配置。

配对响应丢失时，可及时重试同一加入命令。Gateway 在同一进程中最多缓存最近 10 分钟的
交付结果，自动加载新配置不会清除；真正重启 Gateway 后需生成新码。

一机一码：第一次成功兑换即消费该码，已用/作废/失败的码不能再次兑换——重新生成即可。
用新码再次执行加入命令会把本机作为新设备重新配对；换成另一台 Gateway 的加入命令则直接
把旧状态退役（保存在 `state/retired/`）并配对过去，无需手工清理。被 Gateway 吊销后的恢复
路径相同：生成新码，重跑加入命令。需要彻底干净的起点时运行 `rovloom connector --unpair`：
本地配对状态整体退役、Gateway 地址清空，之后可与任意 Gateway 从零配对。

**获取 MCP Bearer：** 首台设备由加入命令打印一次。之后在面板打开**连接 MCP**，填写
名称、选择有效期，点击**创建 Token**。Token 会保留在列表中，随时可以**显示、复制、
删除**，刷新网页或重启 Gateway 后仍然可查看。面板新建的 Token 可以访问当前和之后
配对的设备。旧版只保存摘要且没有原文副本的 Token 需要重新签发。管理员密码与 MCP
Bearer 是独立的凭据。

在 AI 客户端填写 MCP 地址，并将 `Authorization` 设置为 `Bearer <TOKEN>`。
远程访问时，将回环地址换成可访问的 Gateway 地址，并按下节开启 MCP 局域网访问。

**设备**详情页可以删除设备并断开连接。删除设备会清理其运行配置、配对记录和调用内容，
再次连接需要重新配对。

仍可使用 CLI：`rovloom token list` 和
`rovloom token create --principal my_client --like EXISTING_CALLER_ID`。
Docker 使用 `docker compose run --rm gateway token ...`。
为支持以后查看，新 Token 原文会保存在 Gateway 的私有状态目录，备份时请将其作为凭据保存。

### 局域网访问

监听 hostname 是唯一开关：`0.0.0.0` 即接受任意 Host 的明文 HTTP 访问，`127.0.0.1` 只接受回环寻址；没有单独的 `lan` 字段。Docker 镜像内已设置 `ROVLOOM_CONTAINER=1`，首次生成的配置默认把三个监听都绑到 `0.0.0.0`；
宿主机 IP 能否访问仍取决于 Compose 的端口映射。端口映射示例见 [Docker 部署](DOCKER-zh.md)。
npm 安装的二进制默认 MCP 与设备通道为 `0.0.0.0`、管理页为 `127.0.0.1`；要在局域网打开管理页，首次启动后编辑
`~/.config/rovloom/gateway.json`，保留其余字段，按需修改以下监听分组；已有配置直接编辑：

```json
{
  "devices": {"hostname": "0.0.0.0", "port": 9443},
  "mcp": {"hostname": "0.0.0.0", "port": 9444},
  "management": {"enabled": true, "hostname": "0.0.0.0", "port": 9445}
}
```

这是配置片段，不要用它覆盖包含 `schema_version`、`role` 和 `data` 的完整文件。
重启 Gateway 后，Connector 使用 `ws://Gateway机器IP:9443`，浏览器打开
`http://Gateway机器IP:9445/`，MCP 客户端使用 `http://Gateway机器IP:9444/mcp`。
只需远程 Connector 时，仅修改 `devices` 分组；其余两个监听可以继续保持回环。

LAN 选项是明文 HTTP/WS，只应在可信网络使用，并通过防火墙限制访问；公网在前面加
HTTPS/WSS 反向代理。Docker 部署还需核对容器配置与 Compose 端口映射，默认 MCP 和管理页
仅发布到宿主机回环；见 [Docker 部署](DOCKER-zh.md) 与[网络访问](CONFIGURATION-zh.md#网络访问)。

## 4. 连接 MCP 客户端

在 AI 客户端添加一个 **Streamable HTTP** 服务：

| 设置 | 值 |
|---|---|
| URL | `http://127.0.0.1:9444/mcp`（默认） |
| Authorization 头 | `Bearer <第 3 节中保存的令牌>` |

纯 CLI 配对使用 Gateway 打印的 Bearer；管理页配对使用上面 `token create` 签发的令牌。
配对码、管理员密码都不是 Bearer。Bearer 默认 30 天过期，用 `rovloom token renew` 或
`rovloom token rotate` 续期。远程客户端使用局域网地址、代理或隧道访问 MCP 监听。
Rovloom 不是 stdio MCP 服务。

然后让客户端列出这台机器的工作区和 Agent，并向某个 Agent 发一条短消息。
断线后结果不确定的调用会标为未知，不会自动重发。工具细节见 [MCP 参考](protocol/MCP-HTTP.md)。

管理页地址是 `http://127.0.0.1:9445/`，用户名默认 `admin`，密码为 CLI 配对或
`rovloom admin create` 时打印的密码。页面显示每台设备的连接状态，可新建配对申请、
重命名、断开或撤销设备，以及停用 provider。具体操作见[管理页说明](GATEWAY-WEBUI.md)。

## 5. 日常操作

| 任务 | 做法 |
|---|---|
| 再次启动 | Gateway 机器运行 `rovloom gateway --non-interactive`，Connector 机器运行 `rovloom connector --non-interactive`；已保存的配对状态会复用。Docker Gateway 使用 `docker compose up -d`。 |
| 加入更多设备 | Gateway 保持运行，在管理页生成新配对码（或 `rovloom gateway --issue-code`），新设备执行显示的加入命令。面板创建的完整 Gateway token（及其克隆）跟随已配对目标，`device_scope` 继续收窄范围。旧普通 token 及其克隆保留原目标与动作边界；新增方法不需要重新克隆或补方法清单。 |
| 凭据丢失或泄漏 | 在管理页删除该设备并生成新配对码，在该机器上重新执行加入命令即可；本地配对状态自动退役，设备以新身份重新配对。进行中的调用结果变为未知。 |
| 换到另一台 Gateway | 先停该 Connector，机器上直接执行新 Gateway 的加入命令（旧状态自动退役）；或先 `rovloom connector --unpair` 得到干净起点。 |
| 开机自启 | `rovloom service install --role gateway`（或 `connector`），见[开机服务](SERVICE.md)。 |
| 校验配置 | `rovloom config check --role gateway`（或 `connector`）。 |
| 令牌、备份、升级 | [运维指南](OPERATIONS.md) |

每个角色只有一份配置文件，首次运行时创建且不会被重置：
`~/.config/rovloom/gateway.json` 与 `~/.config/rovloom/connector.json`。
全部参数见[配置参考](CONFIGURATION-zh.md)。

## 排错

| 现象 | 处理 |
|---|---|
| `configuration_required` / `pairing_required` | 完成终端里的提示和批准，或从管理页完成配对（见[配对](CONFIGURATION-zh.md#配对)）；仅保存 Gateway 地址不会配对设备。 |
| 执行加入命令后立刻 `configuration_required` | 所选运行时不在 Connector 的查找路径里。按第 2 节装好 Herdr 或 Luvus，确认 `herdr --version` / `luvus --version` 有输出，再用新的配对码重新执行加入命令。 |
| 无法连接 / 地址被占用 | 检查端口、Gateway 监听地址和网络可达性。 |
| HTTP 401 | 检查 `/mcp` 地址、Bearer 及其有效期。 |
| `native_state_path_too_long` | 配对前换一个更短的 `data.directory`（Unix socket 路径长度限制）。 |
| `invalid_device_credential` | 生成新配对码并重新执行加入命令，本机即作为新设备重新配对。 |
| Agent 没有回复 | 检查 Agent 的安装目录和模型登录；Connector 就绪不代表模型已回复。 |
| 安装或退出被中断且结果不确定 | 保留现有数据并联系管理员；不要删除后重新注册。 |

求助时请保留错误码，并保管好 Bearer。
