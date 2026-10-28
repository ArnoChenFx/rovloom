# 运维指南

面向部署者：按场景列出日常操作，细节见各专项文档。系统语义见 [DESIGN](DESIGN.md)。

## 1. 角色与端口

| 角色 | 默认监听 | 说明 |
|---|---|---|
| Gateway · MCP | `127.0.0.1:9444`（`/mcp`） | 远程客户端经 HTTPS 反向代理 / 隧道，无需公网地址配置 |
| Gateway · 设备通道 | `127.0.0.1:9443`（WS `/connector`） | 要接受别的机器的 Connector 就改 `devices.hostname`（`0.0.0.0` / `::`），公网用 WSS 代理 |
| Gateway · 管理页 | `127.0.0.1:9445` | 固定回环，HTTP Basic 登录（见 §4） |
| Connector | 无监听 | 只主动出站连 Gateway；Luvus / Herdr 留在本机 |

每个角色只有一份用户配置：`~/.config/rovloom/gateway.json` / `connector.json`（Windows 同样用用户 home）。参数全集见[配置参考](CONFIGURATION.md)。程序自己的数据在 `data.directory`（默认 `~/.local/share/rovloom/<role>`），**整个目录一起保留**，不要手改里面的文件。

> 加入更多设备：Gateway 保持运行，在管理页生成新配对码（或 `rovloom gateway --issue-code`），新机器执行显示的加入命令（见[快速开始](QUICK-START-zh.md)）。现有 MCP Bearer 自动覆盖新设备；不设 device_scope 的其他 token 同样可见新设备；selected 范围须由操作员显式更新。

### 升级与回滚

Gateway 与 Connector 一同升级。升级前停止两端进程，离线备份两端完整 `data.directory` 与配置，保留私有文件权限；脱敏数据库快照不能代替包含配对及 token 的完整备份。

两端升级并重启后沿用原 token 和设备凭据，不用重新配对，也不用补充方法授权。Herdr、Luvus 和混合模式均只保留 token 设备范围和 Connector 终端执行开关。旧普通 caller 从自己的 grants 提取设备范围，显式 device_scope 优先；不从 local_policy 借用设备。新注册表写入 v2，去掉旧策略、methods/actions、revision 和单独的结果删除权限；旧 Connector policy/raw 字段仅兼容读取，不参与授权。

回滚须停止两端，并恢复同一升级前完整备份及对应二进制。旧版不兼容新注册表与无策略配置，不能只换回镜像；恢复备份也会撤去备份后的配对、token 与调用状态。

## 2. 安装与升级

安装说明见[快速开始](QUICK-START-zh.md)。升级务必覆盖 Gateway 与所有 Connector；只更新 Gateway 不能移除旧 Connector 自己的策略门禁。

`state/retired/` 当前没有自动清理策略。它包含原配对凭据和 managed 原生根、HOME、
工作目录，可能保存实际工作数据，不能仅按 schema 缓存计算容量或直接轮转删除。
运维时单独监控该目录容量；确认旧工作数据与恢复资料已备份且不再需要后，由所有者
按退役批次清理。清理退役目录不会撤销 Gateway 侧旧设备，应在设备管理里单独撤销。

- 安装：`install.sh` / `install.ps1` 只安装单文件二进制并核对 `SHA256SUMS`，不建配置、不起服务（[快速开始](QUICK-START-zh.md)）。Docker 只用于 Linux Gateway（[Docker 部署](DOCKER-zh.md)）。
- 升级：先正常停 Connector 再停 Gateway，替换二进制（重新运行安装脚本，或 `docker compose pull && docker compose up -d`），再按原样启动。配置与数据沿用。脚本只安装官方 latest 稳定版；预发布版本从 Release 页面手动下载。
- **反向代理配置变更：升级前删除 Gateway 配置中的 `mcp.public_url`。保留该字段会导致 `config check` 和 Gateway 启动报 `invalid_config`，不会继续兼容或忽略旧值。** AI 客户端仍直接填写代理的 HTTPS `/mcp` 地址。
- 没有自更新。启动时 v9 库会自动升级到 v10：先在真实状态目录同级的 `<state>.backups` 里写一份整库迁移前副本（按原备份期限与两份上限过期），再在单个事务内加列并推进版本，失败整体回滚并保持 v9。高于当前版本的库仍拒绝启动（`unsupported_database_version`）并保持库文件字节不变；比 v9 更旧的库（v1-v8）不在迁移范围内，同样拒绝。详见[存储与数据保留](STORAGE.md#数据库与文件)。

## 3. 开机服务

`rovloom service install|start|stop|restart|uninstall --role gateway|connector`：Linux systemd、macOS LaunchDaemon、Windows 用户开机任务（S4U）。Connector 服务支持 Linux x64、macOS（x64、arm64）与 Windows x64，只在配对之后使用，因为首次配对需要真实终端。服务定义本身**不会**自动重拉退出的进程。详见 [SERVICE](SERVICE.md)。

## 4. 凭据

| 要做的事 | 命令 | 备注 |
|---|---|---|
| 查看 / 创建 / 续期 / 轮换 / 吊销 MCP 令牌 | `rovloom token list\|create\|renew\|rotate\|revoke` | 原值只在 create / rotate 时在 stdout 显示一次；热生效，无需重启 |
| 收窄 / 放开令牌的设备可见范围 | `rovloom token scope --principal ID --devices m_x,m_y` / `--all-devices true`，或管理页令牌卡片 | 空列表禁用全部设备（`--no-devices true`），清除须显式 `--all-devices true`；热生效；不推进策略修订（已派发的调用不会停） |
| 管理页管理员 | `rovloom admin create\|list\|revoke` | 首次配对完成时已自动创建 `admin`；丢了口令就再 create；热生效 |
| 加入更多设备 | 管理页生成配对码；新机器：`rovloom connector --join <命令>` | 无需终端问答，不停机 |
| 设备凭据丢失 / 泄漏 | 生成新配对码，该机器重新执行 join 命令 | 本机作为新设备重新配对，本地旧状态自动退役到 `state/retired/` |
| 换 Gateway / 干净重置 | Connector：`rovloom connector --unpair`，再用新加入命令 `--join` | 直接执行另一台 Gateway 的加入命令也会自动退役旧状态；managed 实例数据保留在 retired 目录 |
| 撤销设备 | 管理页 → 撤销 | 撤销后不能重新配对，需作为新设备重新首次配对 |

## 5. 备份与恢复

数据库快照只含脱敏的设备记录、调用状态与审计，**不含任何可用凭据**。从快照恢复后，每台设备都回到待配对状态：逐台生成新配对码并重新执行 join 命令，provider 随自动批准的安装清单重新发布。旧的调用与授权不会重新派发。因此快照的价值在于保留审计与调用历史，而不是快速回滚。步骤见 [存储](STORAGE.md#备份与恢复)。

Docker 部署的备份就是备份卷：`docker compose down` 保留卷，`down -v` 删除。

### 离线检查、快照与解除降级

```sh
rovloom doctor --role gateway --json
rovloom doctor --role connector --json
rovloom storage check --role gateway --json
rovloom storage backup --role gateway --output /path/to/gateway.backups/snapshot.db --json
rovloom storage resume --role gateway --json
```

自定义配置追加 `--config /absolute/path/gateway.json`。Gateway 检查和写操作都须先停止该 Gateway；命令与进程共用同一写锁，不创建缺失数据库，不启动 listener 或 native。`doctor` / `storage check` 打开只读事务，报告 schema、完整性、模式、配额、目录用量和可用磁盘字节，不写业务状态。Connector doctor 仅核对配置、managed provider 数量及凭据文件是否存在，不验证凭据内容或声明 native 就绪。

`storage backup` **复用 Store 的脱敏快照**，不含调用原文、结果、有效设备凭据或 MCP token，恢复仍需重新配对。快照目录固定为实际 Gateway 状态目录加 `.backups` 的同级普通目录，例如数据目录 `/data/gateway` 对应 `/data/gateway.backups`；首次备份前显式创建该目录并保持其挂载，目录本身不能是软链接。不允许覆盖已有文件、写到任意其它目录或经目录别名绕过分离规则。默认最多两份、保留七天，由正常 Gateway 和离线命令共用的原账本维护清理；备份命令会先收敛已到期的登记，避免过期记录占住两份配额；若要长期留档，在完成后另存一份不受账本自动清理的私有副本。完整状态回滚备份须在服务停止后另行复制整个数据目录与角色配置；脱敏快照不能替代它。

磁盘满或写入失败后：停止服务 → 保留完整状态 → 释放磁盘空间 → `storage check` → 显式运行 `storage resume` → 再检查模式并启动。resume 经原 Store 的完整性、当前单调时钟、准入预留、预算、一次性管理确认及审计事务；任何检查失败都不宣称恢复成功。命令本身是本机操作员对这一动作和当前恢复代次的批准，不创建远程管理权限。写操作打开 Store 会收敛旧连接和在途状态，未确定调用仍为 unknown，不重派。

若恢复中断，先重新检查：仍降级时再次显式 resume；已 active 时直接按原配置启动，不删除哨兵来绕过。`storage_writer_locked` 表示正在运行或持有者无法确认；停止并核对进程，保留未知/旧格式锁，不能按年龄删锁。新版 Store 只自动接管能证明旧持有者已死的锁。配置损坏时只读检查会输出固定错误码；从离线备份恢复正确配置，或对备份后的副本用 `config template` / `config check` 修复，再重复检查，不用空配置覆盖现有数据路径。

## 6. 排错

| 现象 | 先看 |
|---|---|
| Connector 一直 `disconnected` | `connector_disconnect` 行的 `close_reason`：`transport_closed` 是 Gateway 主动关，`transport_abnormal` / `code=1006` 是网络被掐或对端无关闭帧，`handshake_timeout` 是握手无回应；再看 Gateway 的 `devices.hostname` 是否允许远端；地址 / 防火墙；Gateway 判断线约 20 秒（空闲超时） |
| MCP 401 | Bearer 是否过期（默认 30 天，`rovloom token renew`）；代理是否保留 Authorization、MCP 会话头和 `/mcp` 路径 |
| 调用停在 `dispatching` 很久 | 设备可能刚断网（Gateway 20 秒内发现后立即 `not_dispatched`）；已写出的调用是 `outcome_unknown`，**不会自动重发**，先核对再决定 |
| `invalid_device_credential` | 凭据被撤销或重配：生成新码重新 join |
| `configuration_required` | 需要真实本地终端完成配对 / 批准；不要删数据后重登记，结果不确定时保留原状态 |
| Luvus / Herdr 不可用 | Connector 会按退避自动重新附着或重建；Linux 上附着要求对端是**你已安装的同一个**程序 |

保留错误码求助；Bearer、管理员口令、配对码不要贴出来。

## 7. 验证你的部署

仓库的 [`e2e/`](../e2e/README.md) 是同一流程的自动化版本，覆盖真实终端配对、官方 MCP SDK、崩溃、断网、未知结果、撤销和两容器两机。跨机的 NAT、TLS 和防火墙需要你在自己的两台机器上按[快速开始](QUICK-START-zh.md)走一遍。


### Connector 容量

Connector 发送墓碑保留至首次登记的执行 deadline（最长 10 分钟），到期后随下一次 claim 在事务内回收。当前发送账本 schema v2 仅保存 ID、32 字节绑定摘要和固定 deadline，旧 schema 拒绝打开，不自动清空或转换。Gateway 的 30 天调用 key 去重窗口不变。

本地 `connector_transport` 观测中 `reason=claim_capacity` / `connector_attempt_capacity` 的 `capacity` 区分 `claim_entries`、`claim_bytes`、`attempt_entries`、`attempt_bytes`。`reclaim_at` 是已知最早回收时间（Unix 毫秒），不是重试授权。字节满额报告 `null`，需检查磁盘和配置预算。不要删除账本、回调系统时间、重发旧 attempt 或自动换 key 重做写入；已接收后断连的调用可能保持 `outcome_unknown`，应先核对原生结果。

### MCP、管理页与 API 反向代理

MCP 的 `/mcp` 反向代理到 9444，管理站点与 `/admin/v1/…` API 反向代理到 9445，设备 WebSocket 与配对入口反向代理到 9443。无需公网 URL、域名白名单或可信代理 IP 配置。支持 Nginx、Caddy、Traefik 等代理，外部 HTTPS 与内部 HTTP、任意域名和端口、保留或改写 Host 均可。

Caddy 示例：

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:9444 {
        flush_interval -1
    }
}

manage.example.com {
    reverse_proxy 127.0.0.1:9445
}

devices.example.com {
    reverse_proxy 127.0.0.1:9443
}
```

AI 客户端填写 `https://mcp.example.com/mcp`；Connector 使用 `wss://devices.example.com`，管理页使用 `https://manage.example.com`。代理须保留 Authorization、MCP 会话头与原路径，并逐块转发 MCP SSE 响应；MCP 的 Bearer 与管理 API 的 Cookie / CSRF 分别核验。

管理页不把浏览器 Origin 与代理内部地址强行比较。浏览器跨站元数据仍会被拒绝；读取和写入继续验证独立管理员会话，写入额外验证 CSRF，响应不开放跨站 CORS。代理头不提供管理员身份。HTTPS 请求、HTTPS Origin 或代理常用的 `X-Forwarded-Proto: https` / `Forwarded: proto=https` 会使登录 Cookie 带上 Secure；协议头仅影响 Cookie 属性，不是认证条件。

### Connector 断连诊断

Connector 新断开的诊断行是 `connector_disconnect`，有对端关闭码时字段为 `code=<4位> close_reason=<原因词>`，本机原因没有关闭码时只有 `close_reason=<原因词>`。晚到的关闭码使用 `connector_disconnect_update` 补报订正，不代表再次断连。相位行 `connector_transport <phase> provider_ready=<bool>` 只说明当前相位，两者可以同时出现。

观察器启动时同步建立基线，订阅后首个 250 毫秒窗口里的断开照常补报。断开和订正按独立事件序号交付，共用最多 16 条的事件日志；同一窗口里的事件按时间顺序打印，超出容量只保留最新事件。累计断连次数只在新断开时增加。原因词与白名单见[通道文档](TRANSPORT.md#断线与重连)。

已断开的 Connector 上重复调用断开（例如来源重建）不会再记一次断开，也不会推迟重连。停止已经没有 socket 的进程也不会虚增断连。

`connector_observation unavailable` 表示状态取样暂时失败，不能据此推断设备断开；观察器会继续取样并在恢复后重新报告相位。
