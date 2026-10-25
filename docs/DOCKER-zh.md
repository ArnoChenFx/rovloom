# Docker 部署

[English](DOCKER.md) · [快速开始](QUICK-START-zh.md)

Rovloom 的 Docker 方案运行 **Gateway**，包含管理页和 MCP 服务。Luvus/Herdr Connector 运行在原生程序所在的主机上（Linux x64、macOS 或 Windows x64）。

## 支持平台

官方镜像为 `ghcr.io/arnochenfx/rovloom`，公开，可匿名拉取。支持原生 Linux rootful Docker Engine 的 `linux/amd64` 与 `linux/arm64`。Compose 使用 bridge 网络并把 Gateway 的三个端口发布到宿主机。rootless Engine 与 Docker Desktop 不在 CI 验收范围内。

## 从零启动 Gateway

在 Linux 主机上安装 Docker Engine 与 Docker Compose v2。运行 Gateway 镜像不需要 Bun、Node、Luvus 或 Herdr。

在一个空目录保存维护的 Compose 文件并启动：

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

镜像内已设置 `ROVLOOM_CONTAINER=1`：首次启动时默认入口 `rovloom gateway` 自动生成的配置就是把三个监听绑到 `0.0.0.0` 并设置 `management.lan: true`，不再需要先跑 `config init gateway --container`（该命令仍可用，效果相同）。

默认镜像为 `ghcr.io/arnochenfx/rovloom:latest`。要固定版本，拉取前在 Compose 目录的 `.env` 写入 `ROVLOOM_VERSION=<版本>`。两个命名卷分别保存配置与数据，`docker compose down` 不会删除它们。首次启动自动生成 `/home/rovloom/.config/rovloom/gateway.json`，数据目录为 `/home/rovloom/.local/share/rovloom/gateway`。

默认本机入口：

| 用途 | 地址 | 首次启动状态 |
| --- | --- | --- |
| 管理页 | `http://127.0.0.1:9445/` | 空页面，尚无管理员 |
| MCP | `http://127.0.0.1:9444/mcp` | 未认证请求返回 401 |
| Connector 设备监听 | `127.0.0.1:9443` | 仍需配对 |

`healthy` 只说明 MCP 认证监听已响应，不表示设备已配对、管理员已存在或 Agent 已就绪。日志中的 `pairing_required` 表示等待配对。

`config init gateway --container` 把容器内部的三个监听设为 `0.0.0.0`，并默认设置
`management.lan: true`，允许管理页接受通过宿主机 IP 或 HTTP 代理传入的 Host；登录与同源校验仍然生效。
镜像内已设置 `ROVLOOM_CONTAINER=1`，默认入口首次自动生成的配置就是这个效果，无需额外子命令。
已有配置不会覆盖；旧配置的监听或管理页 LAN 设置不一致时返回 `config_exists`，请按下文的配置编辑步骤修改。
MCP 的 LAN / `public_url` 设置仍需按实际客户端地址单独配置。Compose 的发布范围是：

- `9443`（Connector 设备通道）发布到宿主机所有网卡，其它机器上的 Connector 才能连接。跨出可信网络时请前置 TLS 反向代理，并用宿主机防火墙收口。
- `9444`（MCP）与 `9445`（管理页）**只发布到宿主机回环**（`127.0.0.1`）。远程 MCP 客户端通过宿主机上转发到 `127.0.0.1:9444` 的反向代理访问，并设置 `mcp.public_url`（见[网络访问](CONFIGURATION-zh.md#网络访问)）。管理页可使用下文的 SSH 隧道。

如果要在可信局域网中直接用宿主机 IP 打开管理页，将 Compose 的管理端口映射改为例如
`"192.168.11.200:9445:9445"`（替换为你的宿主机局域网 IP），再运行 `docker compose up -d`。
随后访问 `http://192.168.11.200:9445/`。旧配置还需补上 `management.lan: true` 并重启 Gateway；
仅更新镜像不会修改已有配置。该入口为明文 HTTP，应通过宿主机防火墙限制到可信网络。

## 管理页登录与在线配对

Gateway 首次以后台方式启动时不会自动创建管理员。完成上面的配置初始化，并等待后台 Gateway 正常启动后，在同一个 Compose 目录运行：

```sh
docker compose run --rm gateway admin create
```

默认用户名是 `admin`，密码是命令在标准输出中打印的随机字符串，**只显示一次**，请妥善保存。
该命令通过镜像入口运行 CLI，使用同一组配置和数据卷；它不会启动第二个 Gateway，也不需要
`--service-ports`。官方镜像没有在 PATH 中安装 `rovloom` 命令，请按上述方式运行管理命令。

在 Docker 宿主机浏览器打开 `http://127.0.0.1:9445/`，用 `admin` 和刚生成的密码登录。
如果浏览器在另一台机器上，可在浏览器所在机器运行 SSH 隧道，再打开这个地址：

```sh
ssh -N -L 9445:127.0.0.1:9445 USER@DOCKER_HOST
```

将 `USER@DOCKER_HOST` 替换为可登录 Docker 宿主机的 SSH 用户和地址。默认 Compose 只向宿主机回环发布管理页端口。

检查已有管理员：

```sh
docker compose run --rm gateway admin list
```

已有可用密码时无需再次创建。密码丢失后重新运行 `admin create` 即可签发新密码；同名管理员的旧密码与
已有浏览器会话立即失效，Gateway 无需重启。管理员密码只用于管理页，不能当作 MCP Bearer。

登录后，在「配对设备」页生成一机一码并复制显示的加入命令，到 Connector 主机粘贴执行
`rovloom connector --join ws://<地址>#<码>`——一条命令，无问答无批准。完整步骤和 MCP Bearer 的
签发见[快速开始：启动与配对](QUICK-START-zh.md#3-启动与配对)。此方式下 Gateway 保持后台运行。

## 通过终端签发配对码

后台服务没有交互终端。在 Compose 目录的真实终端中用同一组卷运行一次前台命令即可打印加入命令：

```sh
docker compose run --rm --service-ports gateway gateway --issue-code
```

必须带 `--service-ports`：`docker compose run` 默认不发布 Compose 里的端口，不带的话打印的
地址从主机不可达。全新卷先执行上面的 init 命令。把打印的加入命令复制到 Connector 主机
（Linux x64、macOS 或 Windows x64）执行。不要让第二个 Gateway 使用同一份数据。

到达 `connector_ready` 后，先停止 Connector，再按 Ctrl-C 停止前台 Gateway。执行 `docker compose up -d`，然后重新启动主机 Connector。配置和配对保留在卷中。

加入更多设备或重新配对某台设备时，在管理页生成新配对码（或按上节用 `--issue-code` 打印一条），到目标主机执行显示的加入命令即可；后台 Gateway 全程不停，见[配对](CONFIGURATION-zh.md#配对)。

## 配置、停止与升级

镜像以 UID/GID `10001:10001` 运行，根文件系统只读。默认命名卷已按该身份初始化；自定义 bind mount 时，目录应属于该 UID，配置目录为 `0700`，配置文件为 `0600`。不要用 `chmod 777`。

导出生成的配置进行编辑：

```sh
docker compose cp gateway:/home/rovloom/.config/rovloom/gateway.json ./gateway.json
chmod 600 gateway.json
```

保留 `data`、`mcp`、`devices` 和 `management` 分组，字段见[配置参考](CONFIGURATION-zh.md)。编辑完成后，以容器用户替换配置并重启：

```sh
docker compose exec -T gateway sh -c \
  'umask 077; cat > /home/rovloom/.config/rovloom/gateway.json.next && mv /home/rovloom/.config/rovloom/gateway.json.next /home/rovloom/.config/rovloom/gateway.json' \
  < gateway.json
docker compose restart gateway
```

修改 MCP 端口时，同时在 `.env` 设置 `ROVLOOM_MCP_PORT`，让健康检查跟随；该变量不会修改监听端口。数据目录应保持在持久卷内。

```sh
docker compose stop       # SIGTERM，等待正常关闭
docker compose start      # 复用原配置和数据
docker compose down       # 删除容器和网络，保留命名卷
```

`docker compose down -v` 会删除卷，包括配置和数据。升级时先正常停止并备份卷，再执行 `docker compose pull && docker compose up -d`。`latest` 始终指向最新稳定版；`docker compose run --rm gateway --version` 报告实际镜像版本。

## Connector 运行位置

Connector 应运行在 Luvus/Herdr 所在的主机上（Linux x64、macOS 或 Windows x64）。它要核验原生 binary 与 schema、进程归属、私有文件权限、Unix socket 对端和实例生命周期；容器内的用户、PID 和路径与主机不同，挂载宿主 socket 无法保持这些保证。因此 Compose 不含 Connector，不挂载 `/var/run/docker.sock`，也不要求 `privileged`、主机 PID 或额外 capability。

## 镜像构建

镜像由容器工作流用官方 Bun 镜像（`oven/bun:1-slim`，跟随 Bun 1.x 更新，本次构建只解析一次并供构建层与运行层复用）从源码构建，在产品发行成功后推送到 GHCR。维护者见 [DISTRIBUTION](DISTRIBUTION.md)。
