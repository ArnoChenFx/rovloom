# Rovloom 快速开始

[English](QUICK-START.md) · **简体中文** · [配置参考](CONFIGURATION-zh.md)

Rovloom 有两个角色：

- **Gateway**：AI 客户端访问的 MCP 入口。
- **Connector**：运行在每台装有 Herdr 或 Luvus 的机器上，主动连接 Gateway。

两个角色可以运行在同一台机器上。Gateway 支持 Linux、macOS 和 Windows；Connector 支持 Linux x64、macOS（x64、arm64）和 Windows x64；在 macOS 和 Windows 上附着你已在运行的 Herdr / Luvus。

## 1. 安装

**Linux / macOS**（x64 或 arm64；Linux 需要 glibc）。无需 Bun、Node 或 root 权限：

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

**已经装了 Bun（1.4.3 及以上）？** Rovloom 发布在 npm 注册表上，可以全局安装，也可以不安装直接运行一次：

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
docker compose run --rm gateway config init gateway --container
```

9443、9444、9445 端口需要空闲（Compose 从 bridge 网络发布这三个端口），`config init gateway --container` 会在首次配置时准备容器监听。卷、备份和升级见 [Docker 部署](DOCKER-zh.md)。

## 2. 准备 Connector 所在机器

安装 [Herdr](https://github.com/herdrdev/herdr/releases/latest) 和/或
[Luvus](https://github.com/RizRiyz/luvus/releases/latest)，以及你要使用的 Agent，并登录模型服务。
Rovloom 不会安装这些程序。

Connector **附着到你已在运行的会话**，因此远程调用操作的是你真实的工作区和 Agent 登录；
只有没有运行实例时，才会在你自己的配置目录里启动一个。
程序通过 `PATH`（加上 `/usr/bin:/bin`）查找；其它位置见[安装目录](CONFIGURATION-zh.md#程序与-agent-安装目录)。

默认使用 Luvus。首次配对前，用以下命令选择 Herdr（两者都用则填 `mixed`）：

```sh
rovloom config init connector --provider herdr
```

只生成配置，不启动 Connector 或询问地址。已有配置不会覆盖；如果已选择其它 provider，命令返回 `config_exists`，请先核对再修改。

## 3. 启动与配对

首次配对可以选择下面任意一种方式。两种方式都需要在 Connector 所在机器的真实终端中
确认 Gateway 地址与本地 Herdr/Luvus 安装。默认地址适用于同机部署；跨机器时先配置
下文的[局域网访问](#局域网访问)。

### 方式一：纯 CLI 启动与配对

打开两个真实的本地终端并保持打开：

| Gateway 所在机器 | Connector 所在机器 |
|---|---|
| `rovloom gateway` | `rovloom connector` |

Docker Gateway：在 Compose 目录运行 `docker compose run --rm --service-ports gateway` 代替（先用 `docker compose stop gateway` 停掉正在运行的 Gateway）。

1. **Gateway 终端**：批准配对，得到一次性码（5 分钟有效）。
2. **Connector 终端**：输入 Gateway 地址（同一台机器用 `ws://127.0.0.1:9443`）和该码，并确认信任此 Gateway。
3. **Connector 终端**：批准发现 Herdr/Luvus 安装。
4. **Gateway 终端**：批准显示的安装及其工作区/Agent 访问。
5. 保存 Gateway 打印的 **MCP 地址和 Bearer**（以及只显示一次的管理员密码）。等待 `connector_ready`。

配对完成后，两个进程可以继续运行，接着按第 4 节配置 MCP 客户端。Docker 用户如果要
切换到后台运行，先用 Ctrl-C 停止前台 Gateway，再运行 `docker compose up -d`；
Connector 保持运行，配对状态保存在卷中。

### 方式二：基于管理页启动与配对

**在 Gateway 机器上：** 首次初始化配置，再跳过终端配对问答直接启动：

```sh
rovloom config init gateway
rovloom gateway --non-interactive
```

已有 Gateway 配置时跳过 `config init`，不要覆盖原文件。
最后一条命令保持前台运行；`--non-interactive` 只关闭 Gateway 的本地问答，管理页照常可用。
首次启动会建立状态目录。在 **Gateway 机器的另一个终端**中创建管理员：

```sh
rovloom admin create
```

保存打印的密码，用户名默认是 `admin`。已有可用管理员时跳过这条命令；再次 `create`
会重新签发同名管理员的密码，并使旧密码与已有浏览器会话失效。

Docker Gateway 已按第 1 节初始化后，改用：

```sh
docker compose up -d
docker compose run --rm gateway admin create
```

如果已经通过 `rovloom gateway` 启动，也可以在配对提示回答 `n`，Gateway 会保持运行；
在另一个终端创建管理员后继续以下步骤。

1. 浏览器打开 `http://127.0.0.1:9445/` 并登录。远程访问使用下文配置的 Gateway IP 或 SSH 隧道。
2. 在配对区填写设备名，保留默认策略 `rovloom_setup_v1`，新建申请并复制申请编号。
   已有自定义策略列表时，选择其中允许的引用。
3. 在准备好 Herdr/Luvus 的 **Connector 机器**上运行：

   ```sh
   rovloom connector --claim
   ```

   按提示输入 Gateway 地址（同机为 `ws://127.0.0.1:9443`，局域网为 `ws://Gateway机器IP:9443`）、
   配对申请编号，并确认信任该 Gateway。
4. 核对 Connector 终端与网页显示的核对码一致，在网页复核并批准该认领。
5. 在 Connector 终端确认本地安装授权，等待页面显示原生激活完成、设备就绪。
   Gateway 在运行中加载新配置，不需要在 Gateway 终端批准安装。

**获取 MCP Bearer：** 在面板打开**连接 MCP**，填写名称、选择有效期，点击**创建 Token**。
Token 会保留在列表中，随时可以**显示、复制、删除**，刷新网页或重启 Gateway 后仍然可查看。
面板新建的 Token 可以访问当前和之后配对的设备。旧版只保存摘要且没有原文副本的 Token
需要重新签发。管理员密码与 MCP Bearer 是独立的凭据。

在 AI 客户端填写 MCP 地址，并将 `Authorization` 设置为 `Bearer <TOKEN>`。
远程访问时，将回环地址换成可访问的 Gateway 地址，并按下节开启 MCP 局域网访问。

**设备**详情页可以删除设备并断开连接。**配对设备**页面会列出已保存的配对记录，也可以删除。
删除未完成的配对会终止该次配对；删除已完成的配对记录会保留设备。
删除设备会清理其运行配置、配对记录和调用内容，再次连接需要重新配对。

仍可使用 CLI：`rovloom token list` 和
`rovloom token create --principal my_client --like EXISTING_CALLER_ID`。
Docker 使用 `docker compose run --rm gateway token ...`。
为支持以后查看，新 Token 原文会保存在 Gateway 的私有状态目录，备份时请将其作为凭据保存。

### 局域网访问

普通 CLI 初始化默认三个监听都只允许回环访问。同机部署可跳过本节。
Docker 使用 `config init gateway --container` 时，管理页已默认启用 `management.lan`；
宿主机 IP 能否访问仍取决于 Compose 的端口映射。旧配置迁移及端口映射示例见 [Docker 部署](DOCKER-zh.md)。
首次在 Gateway 机器上执行 `rovloom config init gateway` 后，编辑
`~/.config/rovloom/gateway.json`，保留其余字段，按需修改以下监听分组；已有配置直接编辑：

```json
{
  "devices": {"hostname": "0.0.0.0", "port": 9443},
  "mcp": {"hostname": "0.0.0.0", "port": 9444, "lan": true},
  "management": {"enabled": true, "hostname": "0.0.0.0", "port": 9445, "lan": true}
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
| 加入更多设备 | Gateway 保持运行，在管理页新建申请，新设备运行 `rovloom connector --claim`。采用终端引导的部署也可停止 Gateway 后运行 `rovloom gateway --add-device`。原始 MCP caller 的授权会扩展到新设备；用 `rovloom token create --like` 克隆的令牌需要重新克隆。 |
| 凭据丢失或泄漏 | 停止该 Connector，运行 `rovloom gateway --repair-device`，再在该设备上运行 `rovloom connector --repair`。原生设置与授权保留，进行中的调用结果变为未知。 |
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
| 无法连接 / 地址被占用 | 检查端口、Gateway 监听地址和网络可达性。 |
| HTTP 401 | 检查 `/mcp` 地址、Bearer 及其有效期。 |
| `native_state_path_too_long` | 配对前换一个更短的 `data.directory`（Unix socket 路径长度限制）。 |
| `invalid_device_credential` | 用 `--repair-device` / `--repair` 重新配对同一台设备。已撤销的设备不能重新配对。 |
| Agent 没有回复 | 检查 Agent 的安装目录和模型登录；Connector 就绪不代表模型已回复。 |
| 安装或退出被中断且结果不确定 | 保留现有数据并联系管理员；不要删除后重新注册。 |

求助时请保留错误码，并保管好 Bearer。
