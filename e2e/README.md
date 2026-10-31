# 端到端验收（e2e）

不属于单元测试门禁。用**真实发布产物**、**官方 Herdr 0.9.5**、**官方 MCP SDK 客户端**走完整链路，并制造故障。
每个场景独占一套全新状态（独立 Gateway / Connector 目录、空 `PATH`、空 `HOME`、新端口、新凭据）。

## 运行

```sh
bun --no-env-file run release:build                      # 产物：dist/release/bun-linux-x64/candidate/rovloom
curl -L -o /tmp/herdr https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64
bun --no-env-file e2e/run.mjs dist/release/bun-linux-x64/candidate/rovloom /tmp/herdr [场景名...]
```

Herdr 二进制必须是固定的 0.9.5（SHA-256 `14d9e8bc…929d`，夹具会校验）。仅支持 Linux x64。
输出为每个场景一行 JSON（含证据与耗时），最后一行汇总环境与是否全部通过。

## 场景

| 场景                    | 验证                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full-chain-herdr`      | machines → providers → discover → describe → call → get → result_read（摘要校验）；有副作用的 `workspace.create` 用 `session.snapshot` 读回；显式关闭终端开关（`allow_terminal_execution:false`）时目录隐藏 `pane.send_text` |
| `idempotent-retry`      | 同 `client_request_key` + 同意图返回同一 `call_id` 且原生只执行一次；同 key 不同意图 → `conflict`；无 key 不合并                                                                                                             |
| `terminal-switch`       | 配置省略 `allow_terminal_execution`（默认开启）时 `pane.send_text` 放行且目录可见；写入显式 `false` 重启后目录隐藏、同一调用 → `not_dispatched`，连接与只读调用不受影响                                                      |
| `connector-restart`     | 正常停止后 native 子进程被回收；离线调用立即 `unavailable`（毫秒级，不挂起）；重启后恢复                                                                                                                                     |
| `connector-crash`       | `kill -9`：Gateway 立即判不可用；孤儿 native 仍在监听时**重启被拒（退出码 3，fail-closed）且不触碰孤儿**；native 也消失（等同掉电）后重启自动清理遗留并恢复                                                                  |
| `attach-existing`       | 用户已运行 Herdr：Connector 附着它（不再起第二个）；Connector 退出后用户的实例继续存在                                                                                                                                       |
| `attach-create-persist` | 没有实例：Connector 自建并放手；Connector 退出后仍运行，重启后附着同一个（之前创建的 workspace 还在）                                                                                                                        |
| `attach-recover`        | 附着的实例被 `kill -9`：Connector 自行重建并结束当前连接，数秒内调用恢复，Connector 进程不退出                                                                                                                               |
| `device-revoke`         | Gateway 停止后经正式 Store 撤销设备，重启后设备为 `revoked`，调用不可达，Connector 持续重试而不得服务                                                                                                                        |
| `unknown-outcome`       | native 已收到请求但未应答时 Connector 被杀：调用为 `outcome_unknown`；Connector 重启后状态不变，新 native 收不到该请求（不自动重发）                                                                                         |

## 从零部署（真实首次配对）

默认场景用预置夹具跳过首次配对。`e2e/quickstart.py` 则按 Quick Start 走完整流程：`rovloom config init connector --provider herdr|luvus` 生成 Connector 配置
→ `rovloom gateway --issue-code` 签发一机一码并打印加入命令 → `rovloom connector --join <码>` 一条命令配对并启动
→ Connector 日志出现 `connector_transport ready provider_ready=true`（脚本以 `provider_ready=true` 判定就绪）。
Herdr 不写 `runtime_bin_dirs`，由 `PATH` 自动发现。

```sh
python3 e2e/quickstart.py --binary dist/release/bun-linux-x64/candidate/rovloom --herdr /tmp/herdr \
  --then "bun --no-env-file e2e/herdr-session.mjs"
```

`--then` 会拿到 `MCP_CONFIG`（URL、Bearer、target）。`herdr-session.mjs` 使用官方 MCP SDK 验证只读调用及
workspace 创建后的计数，不调用模型。可选的 Agent 两轮对话方法见下节，须另外核实授权与累计剩余预算。

不带 `--work` 时脚本自己创建 `~/.rq-*` 并在结束时清理：成功则整个删除；失败或被 `timeout`、CI 取消终止（SIGTERM/SIGHUP 同样会走清理）时
只保留 `c`、`g`、`mcp.json` 这类小体积状态与日志，约 110 MB 的二进制副本总是删除。无论哪种结局，本轮私有目录里的 herdr/luvus server
都会被回收——Connector 在附着模式下自建的 server 会在 Connector 退出后继续运行（这是产品行为），收尾由脚本负责。
显式传入的 `--work` 目录不会被删除。SIGKILL 无法被捕获，`timeout -k` 的强杀仍会留下残余，需手工清理。

`--repair` 在就绪后停止 Connector，用 `rovloom gateway --issue-code` 重新签发一张新码，再次 `rovloom connector --join`
（本机重置本地状态，作为新设备重新配对）：断言本机凭据文件被替换、`pairing_completed` 与 `provider_ready=true` 再次出现，
并用**未改变的 MCP Bearer** 跑 `--then` 链路（授权与原生设置不变）。

`--second-device`（Herdr）在就绪后再用 `rovloom gateway --issue-code` 签发一张新码，配对第二台 Connector（独立 HOME；第一台继续运行并自行重连），然后用 `two-devices-check.mjs`、原 Bearer 对两台设备各完成一次真实调用。

## 两台“机器”（独立容器、真实 TCP）

`e2e/two_host.py`（CI：`.github/workflows/two-host.yml`）把 Gateway 和 Connector 放进两个 Docker 容器：各自独立的文件系统（互相看不到对方的数据目录、凭据和程序），
只通过 Docker 网络上的真实 TCP 通信；Gateway 容器里没有 Herdr，设备监听 `0.0.0.0`，Connector 用容器 DNS 名 `ws://rv-gw-…:9443` 连接。
配对仍在两个容器的真实 TTY（`docker run -it`）里按 Quick Start 完成；MCP 只在 Gateway 的回环上（设计如此），客户端容器共享该网络命名空间，用官方 MCP SDK 走完整 Herdr 链路。
随后 `docker network disconnect` 把 Connector 摘出网络：Gateway 在空闲超时（20 秒）内发现，新调用立即不可用而不是悬挂；接回后数秒内自动恢复。

## 追加来源（不重新 join）

```sh
# 已按 luvus 配对后，把 native.provider 改成 luvus,herdr 并重启 Connector（不 join）
python3 e2e/quickstart.py --binary dist/release/bun-linux-x64/candidate/rovloom \
  --luvus /path/to/luvus --append luvus,herdr --append-binaries herdr=/path/to/herdr \
  --then "bun --no-env-file e2e/provider-append-session.mjs"
```

`--append-binaries` 只把二进制放进 PATH 供追加使用，不参与配对；`--append-core` 起一个私有 core 供追加 core；
`--append-crash` 追加成功后再把本机注册表回滚并重启，模拟「Gateway 已登记而本机没写完」。
`e2e/provider-append-http.mjs` 直接对 `POST /pairing/providers` 构造错凭据与已存在 kind 的请求，
`e2e/provider-append-failure.mjs` 验证追加失败非致命。
`--narrow <kind>`（配合 `--append`）在追加后把 `native.provider` 缩小到只剩 `<kind>` 再重启 Connector，`e2e/provider-narrow-session.mjs` 检查：Gateway 仍登记着被缩掉的来源，留下的来源照常可用；调用被缩掉的来源会得到 `outcome_unknown` 并让这台设备重连一次（约 1 秒，其它来源随后自动恢复）——这是已知毛刺，脚本只断言「不挂起、留下的来源在有限时间内恢复」。

## 真实 herdr-core 链路（Linux）

`--herdr-core` 只附着已运行的 core：脚本在私有 `XDG_RUNTIME_DIR` 下用 `hc run --bg --json` 拉起 core
（版本取自二进制自己的 `--version`；CI 只测上游发布的最新版）和一个打印 `rovloom-e2e` 后休眠的终端，再按 Quick Start 完成配对。`herdr-core-session.mjs` 经 MCP 验证
machines → providers（kind `herdr-core`）→ discover（24 个方法：读取、控制、宿主级与 `terminal.events`）→ describe → `server.status` /
`terminal.list` / `terminal.get` / `terminal.read(lines=0)` / `terminal.wait`，并确认控制档被 Gateway 拒绝。同一脚本还覆盖
「省略 `params` 等同 `{}`」、预检拒绝带固定 path 且没有调用记录、省略 `core_id`/`created_ms` 与名字形态的控制调用、
错的 `created_ms` 仍是 `fence_mismatch`、`machine/t7` 与 `server.stop` 缺 `core_id` 仍被拒。

```sh
python3 e2e/quickstart.py --binary dist/release/bun-linux-x64/candidate/rovloom \
  --herdr-core /path/to/herdr-core-0.1.15 --work ~/.rq-core \
  --then "bun --no-env-file e2e/herdr-core-session.mjs"
# 宿主级能力（machine.exec / file.* / doc.* / server.* / parent 编排 / 开关关闭）：
python3 e2e/quickstart.py --binary dist/release/bun-linux-x64/candidate/rovloom \
  --herdr-core /path/to/herdr-core-0.1.15 --work ~/.rq-host \
  --then "bun --no-env-file e2e/herdr-core-host.mjs"
# 老设备升级（v0.10.0 配对 → 候选原位替换，不重新配对）：
python3 e2e/quickstart.py --binary dist/release/bun-linux-x64/candidate/rovloom \
  --upgrade-from /path/to/rovloom-0.10.0-linux-x64 --herdr-core /path/to/herdr-core-0.1.15 \
  --work ~/.rq-upgrade --then "bun --no-env-file e2e/herdr-core-host.mjs"
```

同一次运行还会验证两处身份失败关闭：同机转发代理 `herdr_core_peer_pid_mismatch`、0755 socket 目录
`herdr_core_endpoint_untrusted`。结束时按 exe 路径、`HC_SESSION` 与私有 cwd 回收 core/holder 和终端。

## 真实 Luvus 链路

```sh
curl -L -o /tmp/luvus.tgz https://github.com/RizRiyz/luvus/releases/download/v0.14.3/luvus-v0.14.3-x86_64-unknown-linux-musl.tar.gz
tar -xzf /tmp/luvus.tgz -C /tmp luvus   # SHA-256 895073022da8edd2…，与仓库固定的官方摘要一致
LUVUS_WRITE='{}' python3 e2e/quickstart.py --work ~/.rq1 --binary dist/release/bun-linux-x64/candidate/rovloom \
  --luvus /tmp/luvus --then "bun --no-env-file e2e/luvus-session.mjs"
```

加 `--crash` 会在就绪后 `kill -9` Connector 再重启：Luvus 的 claim 锁与 owner 锁由新 Connector 自行接管，随后的读写调用照常通过。

`--luvus` 走 Quick Start 的默认 Luvus 引导（隔离状态，不动你的 Luvus）。Luvus 的状态路径上限 52 字节，所以脚本把
`data.directory` 改成 `<work>/d`，`--work` 请用短路径。`luvus-session.mjs` 经 MCP 完成 machines → providers →
discover→ describe → `workspace.list` → `session.snapshot`；设置 `LUVUS_WRITE` 后再 `workspace.new` 并读回
workspace 计数（1→2）。

默认（`--luvus-mode attach`）走附着方式：没有实例时 Connector 在 Connector 用户的 `~/.luvus` 里自建 default 会话。
附加选项把附着链路的几种情形也跑一遍（都用真实 Luvus 0.14.3，`LUVUS_WRITE='{}'` 读回写入）：

- `--pre-existing`：先像用户那样启动 `luvus --session default server`，部署后断言 Connector 附着了它（进程不变、没有第二个）。
- `--pre-existing --kill-luvus`：就绪后 `kill -9` 该 server，断言 Connector 自行重建（新 PID）并重连，随后的读写调用通过。
- `--crash`：就绪后 `kill -9` Connector 再重启，断言 claim 锁自动接管并重新附着仍在运行的 Luvus；`--luvus-mode managed` 则是隔离实例的同一验证。

Luvus 故障场景（`--pre-existing`，经 `e2e/luvus-faults.mjs` 分步驱动，同样用真实 Luvus 0.14.3）：

- `--unknown-outcome`：先对 Luvus server 发 `SIGSTOP`，再提交 `workspace.new`，随后 `kill -9` Connector 并恢复 Luvus、重启 Connector。断言该调用收敛为
  `outcome_unknown`，workspace 数最多比调用前多 1 且 10 秒内保持稳定（没有第二次执行），同一设备上的新写调用照常成功。
- `--revoke`：停止两个角色，经正式 Store 离线撤销设备，再重启。断言 `machines_get` 为 `revoked`、调用被拒绝、Connector 始终不会就绪。

## 真实 LLM Agent（可选）

以下脚本会发出模型请求。只有在明确授权所选 provider/model、核实本次执行所需的累计剩余预算后才可运行；
预算不按轮次重置。两个用户回合各自可能包含多次模型请求，并非只收费两次。未核实预算时只运行合成回归。
不得为了跑通而换模型、provider 或收费 fallback；超时、错误及不确定结果不自动重跑。

```sh
npm i opencode-ai   # 放在仓库之外的临时目录
DEEPSEEK_API_KEY=… bun e2e/agent.mjs dist/release/bun-linux-x64/candidate/rovloom /tmp/herdr <opencode可执行文件>
```

provider 与模型在 opencode 配置中显式声明并关闭模型目录拉取（`models.opencode.ai` 在受限网络下不可达）。
密钥只经环境变量传入，Agent 只继承代理/证书变量。通过条件由 Rovloom 侧独立读回，不采信 Agent 自述。

### 同一 session 两轮上下文方法

`agent-session.mjs` 只连接已经部署的 Herdr 目标（`MCP_CONFIG` 必须仅有一个明确 target，binding revision 1），不部署或改动
Gateway/Connector。模型参数没有默认值；必须传入已授权且经供应商核实可用的精确 `ds/model`，不会自动选择其它模型。
MCP 配置与密钥由操作员在受保护环境准备，不要贴入命令记录、PR、配置样例或输出。

```sh
# 仅测试验收器与续接参数；不需要 MCP_CONFIG、Agent 程序或模型密钥，不调用模型。
bun --no-env-file test ./test/mcp/agent-conversation.test.mjs

# 可选收费执行；只有预算与精确模型授权都已核实后，才替换下列参数并显式允许。
bun --no-env-file e2e/agent-session.mjs --allow-model-requests <opencode绝对路径> <已授权的ds/model>
```

验收流程与通过条件：

1. 第一轮提供随机合成上下文值，要求 list → discover → describe → 一次 ping → get → 全部分页结果。
2. 从 OpenCode `run --format json` 事件取得精确 `sessionID`，第二轮只用 `--session <该ID>` 续接；
   第二轮提示词不含该值，要求回忆它并执行一次新的 ping。两轮使用同一 HOME、模型与配置，不用最近会话或 fork。
3. 两轮均须有完成的 MCP 工具事件，目标、binding、契约、call_id、result_id、分页游标与 SHA-256 相互关联；
   独立 MCP 客户端只查询 Agent 的原 call_id 并读回同一结果，不另发 ping 代替 Agent 的执行证据。
   独立读回最多 128 页，元数据查询和所有分页共用 30 秒总期限；非 EOF 空页立即拒绝，游标变化不续期。
4. 第二轮 session ID 必须相同，消息、调用与结果必须是新的；最终 assistant 文本须报告真实版本与第一轮的值。
   只有 `RESULT` 字符串、stderr、工具输出内的答案、旧事件重放、错误或不完整分页都不能通过。

Agent 仅获上述七个 MCP 工具的许可，其它工具默认拒绝；本地临时配置权限为 0600，结束后清理隔离目录。
stdout 只输出计数和布尔结果，失败只输出阶段及“结果未确认”，不输出提示词、随机值、ID、工具原文或 stderr。
OpenCode JSON 事件字段参考 [v1.19.3 CLI](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/cli/cmd/run.ts)
及 [MCP 工具结果处理](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/tools.ts)；
事件格式改变会拒绝验收，需要重新核实客户端兼容性。

合成测试只证明验收器拒绝假通过，以及驱动传递了精确 session 参数；不能证明真实模型回复或 OpenCode 的持久会话已经成功。
即便此可选脚本通过，也只覆盖外部 MCP Agent 的两轮上下文与 Herdr ping；不等同原生窗口内 Agent 的
发现/选择/状态/`agent.prompt`/回复流程、WebUI 管理、真实双机网络或已发布二进制验证。相关缺口继续由
[#153](https://github.com/ArnoChenFx/Rovloom/issues/153) 与 [#154](https://github.com/ArnoChenFx/Rovloom/issues/154) 跟踪。

## Windows

`quickstart_windows.py` 在真实 Windows runner 的 ConPTY 里完成同样的从零配对，并附着官方 Herdr 或 Luvus（`--herdr-dir` / `--luvus-dir`），可选 `--pre-existing`、`--service`、`--kill-herdr`、`--kill-luvus`。CI 见 [Windows e2e](../.github/workflows/windows-e2e.yml)。

## 边界

- **单台主机**：默认场景里 Gateway 与 Connector 是两个独立进程，经回环 WebSocket 通信；“两台机器”场景用两个容器（独立文件系统与网络命名空间、真实 TCP）
  验证了跨网络路径，但仍在同一台宿主上，不等同真实跨机的 NAT / TLS / 防火墙 / 公网延迟。
- **Luvus 的故障场景**：真实 Luvus 0.14.3 已覆盖首次配对 → 发现 → 描述 → 只读/写调用读回，以及崩溃接管、Luvus 被杀后重建、未知结果不重发、离线撤销（见“真实 Luvus 链路”）；“终端开关”“重复请求幂等”这类与 provider 无关的 Gateway 行为只在 Herdr 场景里验证。
- **设备撤销是离线撤销**：管理员写入走带确认的 HTTP 管理接口，这里停 Gateway 后用正式 `Store.revoke` 代替，没有走 WebUI。
- **崩溃后自动清理仅限 Linux**：证据是 owner 进程已死（PID + 内核启动 tick）且端点无监听；其它平台、记录不可读、孤儿 native 仍活着时保持 fail-closed。
- **LLM Agent 单独脚本**：`e2e/agent.mjs` 让 opencode（DeepSeek `deepseek-chat`）经 MCP 完成 list → discover → ping → `workspace.create`，再由独立 MCP 客户端读回 workspace 数（0→1）。依赖模型 API 域名可达与 `DEEPSEEK_API_KEY`，不在默认场景集里；模型输出有随机性，仅作冒烟。
- `unknown-outcome` 证明“新 native 未被重发”；被暂停后又恢复的旧 native 是否执行了该请求，不在 Rovloom 可观察范围内
  （这正是 `outcome_unknown` 的含义）。

## 原位升级回归

`quickstart.py --upgrade-from /absolute/old/rovloom --binary /absolute/new/rovloom` 先使用旧二进制真实配对、创建普通 MCP token 并提交 `pane.list`；停止两端后只替换程序，不重新 join、不编辑 managed 配对文件。新版必须沿用原 token/设备凭据、读取旧结果句柄（完整 bytes/hash/TTL），并完成新调用。随后真实 `token scope` 写盘应生成无策略字段的 v2 注册表，同一 token 仍可调用。Luvus 还验证 `wait.output` 的命中、超时与连接存活。

```sh
python3 e2e/quickstart.py --upgrade-from /absolute/old/rovloom --binary /absolute/new/rovloom \
  --herdr /absolute/herdr --work /absolute/private/upgrade-herdr
python3 e2e/quickstart.py --upgrade-from /absolute/old/rovloom --binary /absolute/new/rovloom \
  --luvus /absolute/luvus --work /absolute/private/upgrade-luvus
```

Luvus 增加 `--luvus-mode managed` 可覆盖托管模式；缺省覆盖附着模式。目录必须隔离且足够短，以满足 Unix socket 路径长度限制。本地回归从 0.6.9 发布提交构建的旧程序升级到当前候选；不代表未测过的更早版本均兼容。
