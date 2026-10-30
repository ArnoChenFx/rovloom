# ADR 0009：provider 中性端口与 herdr-core 观察层

状态：随 #252 的实现 PR 评审；启动条件「接入第三种 provider」已由用户批准。

## 背景

#252 记录了两件事：provider 装配已走中性接缝（#313/#316），但 `Descriptor` / `LocalIdentityVerifier` / `NativeOwner` 这套端口没有引入；理由是只有两种 provider 时先抽端口、等使用者出现正是要避免的模式。现在第三种 provider（herdr-core，官方二进制 `herdr-core`，客户端 `hc`，JSON-RPC 2.0 over Unix socket）要接，端口有了真实使用者。

herdr-core 与现有 Herdr TUI 适配（`herdr` 命令，65 个普通 RPC）不是同一个原生协议：core 有 32 个方法、扁平的 `tN` 终端、framed 通道与信用流控，没有 workspace/tab/pane。二者必须是不同的 provider kind，不能共用方法表或保证强度。

## 决策

### 端口层（`src/runtime/provider-port.ts`）

只定义五个端口，不铺开抽象：`ProviderDescriptor`（kind、协议族、方法到档位的审核表、逐项保证）、`ProviderCatalogPort`、`ProviderSessionPort`、`LocalIdentityVerifier`、`NativeOwner`。注册表按 kind 固定登记，拒绝重复 kind、缺失端口、表外档位和自由文本保证；档位与保证都是闭合集合。

本 PR 的落点是：Herdr TUI 的描述只从现有已审核表派生（`HERDR_RESPONSE_TYPES` 与终端执行表），herdr-core 的描述来自 spike 的实测档位表。Herdr TUI 的档位里只有协议探测是观察档，其余普通读取按 ADR 0004 留在有条件档——普通读取也可能改变终端状态。

### herdr-core 的档位（0.1.14，提交 29e6d37）

32 个方法分四档：A 观察 6、B 有条件 6、C 输入与控制 8、D 宿主级 12。第一阶段只开放 5 个普通读取：`server.status`、`terminal.get`、`terminal.list`、`terminal.read`（`lines` 必须为 0）、`terminal.wait`（timeout ≤ 60 秒）；无过滤的 `events.subscribe` 只给本地订阅入口，不进目录与 Wire 准入（见下）。其余方法返回固定 `herdr_core_method_unavailable`。

不传 `caller`、`on`、`core`、`calls_you`、`children_of`：`caller` 无认证且会把子终端消息标成已读，`on` 会把请求转发给远端机器，`core` 会把连接登记成对端。参数规则先于任何原生请求，错误只带固定码或公共诊断的路径与规则。

### 契约与结果

`rpc.discover` 的文档是唯一输入：编译时补 `uint8`/`double` 格式，参数根由本仓库拼出（按名传参、`additionalProperties: false`），结果对象逐层收紧，未知字段是协议不符而不是被忽略。唯一按证据放宽的是 `terminal.list` 的 `machines`：上游标成 required，未配置机器时 core 不输出该字段，5/5 真实样本不符。契约身份用去掉 `info.version` 的规范化内容摘要。

### 身份与终端标识

端点按 core 的公式定位：优先 `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`，否则 `<state>/herdr-core/<session>/<session>.sock`。session 名上限按最长 holder 套接字路径（`<session>.holder.<8 位 id>.sock`，Linux 107 字节）在配置阶段计算并拒绝，不留给 core 报 usage：`/run/user/1000` 下 60 个字符，`$HOME/.local/state` 回退下 25 个字符。

pid 取自这条连接的内核 peer（`SO_PEERCRED`，经 `HerdrCoreClient.peer()`），必须属于本用户，并且与服务端在 `server.status` 里自报的 pid 一致；自报值本身不是证据，否则同用户的另一个监听者（例如转发到真 core 的代理）可以让后面的核对对着真 core 通过。在此基础上再核对 `/proc/<pid>/exe` 的 SHA-256（直接读正在运行的映像，不按路径读文件）、`argv` 恒为 `<bin> serve`、`HC_SESSION` 与本次 session 一致，以及套接字文件与所在目录属于本用户且目录为 0700。仅 Linux：其它平台没有等价的内核证据，明确拒绝而不是降级。终端标识是 `(core.id, created_ms, address)`：只删 `terminals.json` 时地址会被复用，`(core.id, 地址)` 不唯一。

### 保证强度

`event_recovery` 是 `snapshot_rebuild`（快照加 `missed` 重建当前状态，没有回放），`terminal_fence`、`cancel`、`prompt_completion` 都是 `unavailable`。`turn` 在 core 崩溃后会少算，`seq` 在重启和崩溃后归零，所以都不能当成本轮完成或没丢事件的证据。

## 第二阶段（同一 PR 追加）

### Wire kind 与配置

`ProviderKind` 抽成 `PROVIDER_KINDS` 单一来源（`luvus`、`herdr`、`herdr-core`），Wire 校验器与 WebUI 共用。只追加，不改旧值：旧绑定、旧契约来源、旧调用记录与 `native.provider` 的 `mixed` 含义都不变，`mixed` 仍只表示 Luvus + Herdr TUI。herdr-core 需要显式 `native.provider: "herdr-core"`；省略与旧值解析结果与之前完全一致。契约来源新增 `herdr-core-jsonrpc` / `rpc.discover` / `live_instance` 三项并要求组合匹配，旧 provider 不能借用新协议族。

旧版本程序兼容代码按 #315 的边界删除，用户数据与配置的迁移路径保留：`provider-control` 的旧布局迁移仍只枚举 `luvus`/`herdr`（herdr-core 是新增 kind，没有历史文档要搬），已有用户的配置、配对、token 与调用记录不需要改动。

### 端口层成为装配入口

`createHerdrCoreGatewayResources` 交付五个端口并在 `createProviderPortRegistry` 登记。Gateway 运行时新增 `ports` 来源：一组 provider 的会话来源必须二选一（原工厂 `session` 或端口层 `ports`），两者都缺或同时出现都在启动时以 `runtime_provider_session_source_invalid` 拒绝；端口层登记的组按 kind 取 `ProviderSessionPort`，不再接受组内自带会话。herdr-core 的生产来源只交付 `ports`，因此它的 Wire 会话、准入账本与证据保留真的经由端口层装配。Herdr TUI 与 Luvus 仍走原工厂，未在本期迁移（它们的 descriptor 只用于登记与档位查询）。

### 事件订阅（spike 第 7 条）

`events.subscribe` 不是普通 RPC，不在开放集合（目录、Wire 准入与观察入口都不认它）：它在 framed 通道上建立持续流，而 Wire 桥接只做普通 RPC。本地订阅入口 `subscribeHerdrCoreEvents` 单独使用它，且只接受空参数：按终端、子终端或标签过滤的订阅会留下空洞（spike 4a1 实测 3,5,7…），不能当连续流。事件只走 framed 通道，信用按实际消费字节回补（帧循环完成）。`missed` 用新快照重建，水位换成快照 `seq`，其后不超过水位的在途事件丢弃并计数；EOF 结束本地等待返回 `closed(eof)`，由调用方重新握手；慢消费者以 `closed(backpressure)` 显式结束，已收到的通知仍可取走，不静默丢中间事件。`seq` 只用于同一 core 进程内排序，重连后丢弃旧水位。

### 版本重新分类（spike 第 9 条）

握手要求 `version` 等于审核过的 `0.1.14`，未审核版本以 `herdr_core_version_unreviewed` 拒绝，与形状不符的 `herdr_core_handshake_refused` 分开；契约来源的 `classification_revision` 固定为 `<version>@<commit>`，配置解析阶段就拒绝不属于本次审核表的来源。

### 输入与控制档（spike 第 5 条）

本期不开放控制档，所以“blocked 由 rovloom 自己判断并拦 keys/interrupt/force”没有可以实施的调用面：`terminal.send`/`keys`/`interrupt` 等仍不在 `HERDR_CORE_EXPOSED_METHODS`，参数复核、Wire 核心与目录三处都会拒绝。`terminal-execution` 的 herdr-core 直接输入集合从同一份审核档位表派生（当前全是 control，因此目录与执行门禁都不放开），宿主级集合保持为空。blocked 状态判定留到开放控制档时与 send 一起实现，届时必须由 rovloom 自己判断，不能信 `blocked` 闸门（spike 2：keys/interrupt/force 在 blocked 时照常送达）。

## 第三阶段（同一 PR 追加）

### Connector 附着执行端

`src/connector/herdr-core/installation.ts` 只连接已运行的 core，不启动、停止或接管实例：

- 端点由本地配置固定的 `runtime_dir` 或 `state_home` 重算，运行时不再读 `cwd` 或环境变量；目录必须是本用户 0700，套接字必须是本用户的 socket。
- pid 取自这条连接的内核 peer（`SO_PEERCRED`），必须属于本用户并与 `server.status` 自报值一致；自报值本身不是证据。`/proc/<pid>/exe` 的 SHA-256 必须等于配对时发布的 `binary_sha256`，`argv` 恒为 `<bin> serve`，`HC_SESSION` 与本次 session 一致。每次执行前重读这些事实，不缓存旧许可。
- 契约只来自本次连接的 `rpc.discover`，字节摘要必须等于配对时发布的 `schema_sha256`；摘要不符、版本未审核、目录权限不对、代理冒充都在读写任何结果前失败关闭。
- 只执行 `HERDR_CORE_EXPOSED_METHODS` 的 5 个读取；`reviewHerdrCoreParams` 与审核 schema 在发送前、结果 schema 在返回前各复核一次。控制档与宿主级方法仍在目录、Wire 准入和参数三处拒绝。
- Connector 只在本地配置里携带 `connector`（session、固定端点、principal、发送墓碑）；Gateway 侧配置没有这些本机事实。

### 配对路径与 kind 白名单

`PROVIDER_KINDS` 成为 Store 配对认领、管理面与 WebUI 的唯一 kind 来源。`activatePairingProviders`、`provider_enable`/`provider_disable`、WebUI 的 provider/调用视图都接受 `herdr-core`，旧 `luvus`/`herdr` 的取值、配置和迁移路径不变。`native.provider: "herdr-core"` 只表示附着本机已运行 core；`mixed` 仍是 Luvus + Herdr TUI，不能表达 `luvus + herdr-core` 或 `herdr + herdr-core`（`native.provider` 是单值或既有 `mixed`）。

配对时 `prepareSetupHerdrCore` 连接一次真实 core，核对身份后把本次 `rpc.discover` 的内容寻址副本发布给两端，并建立 Connector 私有发送墓碑；`join` 与 Gateway 的 `reviewSetupManifest` 都按同一 Target/session 核对。已有用户的配置、配对、token 与调用记录不需要改动。

## 第四阶段（同一 PR 追加）

### 输入与控制档

开放 C 档 8 个方法：`terminal.send`、`terminal.keys`、`terminal.interrupt`、`terminal.put`、`terminal.kill`、`terminal.rm`、`terminal.keep`、`terminal.label`。D 档 12 个宿主级方法（`terminal.run`、`machine.*`、`file.*`、`doc.set`、`server.stop/restart`）仍不开放：目录、Wire 准入与参数复核三处继续拒绝，档位表本身不改。

**终端三元组栅栏**。终端地址在同一 core 内永久，但只删 `terminals.json` 后地址会被复用（spike 4b-F：`core.id` 不变，新终端复用 `t1`），`(core.id, 地址)` 不唯一。控制档的每个方法都必须带 rovloom 自有的 `core_id` 与 `created_ms`（`HERDR_CORE_FENCE_PARAMS`），执行端在写入前用同一条连接读一次 `terminal.get`，要求 `client.hello.core.id === core_id`、`live.address === terminal`、`live.created_ms === created_ms`、`live.state === 'live'`，任一不符即 `herdr_core_terminal_identity_mismatch`，绝不把输入送给同地址的另一个终端。`terminal` 只接受裸本地地址 `tN`：名字会被 `label` 改写，`machine/tN` 属于远端路由。这两个字段由 `paramsSchema` 追加进参数根（必需），core 不认识它们，执行端在发送前显式剥离，不依赖 core 静默忽略未知字段。

**blocked 由 rovloom 判断**。spike 3f 实测 core 只在 `send` 上拦 blocked，`keys`、`interrupt`、`force` 照常送达；官方安全文档也说 blocked 不是访问边界。所以 `send`/`keys`/`interrupt` 在写入前自己判断：`terminal.get` 的 `status.state === 'blocked'` 即 `herdr_core_terminal_blocked`。判定 fail-closed：读不到终端事实、状态字形状不符、终端已结束都拒绝。`status === null`（程序从未上报 OSC 7501）不算未知——这类程序不可能进入 blocked，core 的闸门也只认上报过的状态；否则 `cat` 一类普通程序永远不能输入，e2e 的输入回显也就无从验证。`put` 只写文件、不送输入，`kill`/`rm`/`keep`/`label` 改的是终端记录，它们只做三元组核对：blocked 时仍必须能收拾现场。

**残余竞态（未消除）**。判定与写入之间终端状态仍可能变化：`send` 还有 core 自己的 blocked 闸门兜底，`keys`/`interrupt` 没有原生闸门，程序在这段窗口里转成 blocked 时输入仍会送达。判定是写入前最后一个原生请求，二者之间没有额外等待，也不跨连接、不跨实例；这只能缩小窗口，不能消除。

**开关**。8 个控制档方法全部受既有的 `allow_terminal_execution` 约束（`kill`/`rm`/`keep`/`label` 不是输入，但它们是同一批审核过的控制面，默认从严一并纳入）。三处门禁共用 Connector 上报的同一个观察值：Gateway 目录（`terminal_execution_catalog`）隐藏方法、Gateway 在登记前拒绝（`bindTerminalExecution` 晚绑定 `transport.terminalExecutionState`，未上报一律当作关闭）、Connector 在原生写入前再检查。关闭时的拒绝是确定未派发：`dispatch_refused` 的固定码集合因此只追加 herdr-core 的四个执行前固定码（`herdr_core_terminal_blocked`、`_identity_mismatch`、`_unavailable`、`herdr_core_connection_closed`），写入之后才失败的调用仍按 `outcome_unknown` 走保守路径，绝不自动重放。

**期限**。`send` 默认要等粘贴安静窗口（约 3 秒）并按 200 ms 间隔逐段粘贴，本地期限 20 秒；`wait=true` 是这一轮的检查点，期限由调用方显式给出且 ≤60 秒（否则会落到 core 默认的 180 秒）。`interrupt` 不传 `timeout` 时 core 自己观察 10 秒，本地期限 15 秒。所有期限共用 `HERDR_CORE_REQUEST_MAX_MS`；超时只结束本地等待，不宣称原生停止。`force=true` 一律拒绝（`herdr_core_force_unsupported`）：它绕过 core 的 blocked 闸门，而 rovloom 的判定不依赖它。

### core 重启后的重新附着

Connector 不再只附着一次。`HerdrCoreInstallation` 保留同一个附着对象，连接关闭后由 `ensure()` 用有退避、有上限的单飞轮重新走一遍**完整**身份核对：套接字目录 0700 与属主、内核 peer 的 pid/uid、`server.status` 自报 pid 与内核值一致、`/proc/<pid>/exe` 的 SHA-256、`argv` 恒为 `<bin> serve`、`HC_SESSION`、本次 `rpc.discover` 的摘要与编译身份、版本 0.1.14。任何一项不符仍失败关闭（`herdr_core_installation_changed` / `herdr_core_schema_unreviewed` / `herdr_core_version_unreviewed`），不因为「以前核对过」而放行。

- 退避序列 0/250/500/1000/1500/2000 毫秒（合计约 5.25 秒，覆盖 holder 默认 3 秒宽限加新 core 启动），单轮总预算上限 6 秒并按调用方剩余期限再收紧；一轮失败后冷却 1 秒，期间调用直接失败，不逐请求热循环。并发调用共享同一轮，不会同时建立多条连接。
- 重新附着只在调用路径上发生（`executeWire` 在写入前、`readiness` 只踢一次后台轮），`current()` 不会自己重连。断线时 `client()`/`assert()` 直接 `herdr_core_connection_closed`，不返回已关闭的连接。
- `core.id` 变了就是新实例：调用方的 `core_id` 栅栏自动失效（旧三元组不会被接受），`created_ms` 也不会与旧终端相同。`core.id` 不变（计划重启、SIGKILL core 后 holder 重建）时终端记录保留，三元组仍然有效。
- 断线时在途调用保持 `outcome_unknown`，**不重放**：附着层不保存请求，重新附着后也不重发任何调用。
- `readiness()` 只在附着对象已关闭时报告不可用。core 正在重启时报告不可用会让 transport 永久撤回 provider（`provider_fence`），所以「可重新附着」按可用报告；单次调用仍逐次核对身份，断线期间的调用明确失败（未派发），不悬挂、不重放。这是有意的取舍：可用性判断不再等价于「此刻已连接」。

### 与 Luvus / Herdr TUI 的组合

`native.provider` 只追加两个组合取值：`"luvus,herdr-core"` 与 `"herdr,herdr-core"`。`mixed` 的含义不变（仍只表示 Luvus + Herdr TUI），三种单值（省略、`luvus`、`herdr`、`herdr-core`）的解析结果与之前逐字相同；已有配置、token、设备凭据、配对记录与旧 schema 布局继续按原样读取（#315 边界）。取值是闭合表（`NATIVE_PROVIDER_SELECTIONS`），不按分隔符猜测：`"herdr-core,luvus"`、带空格的、三项的都拒绝。

装配层只做了两处最小改动：`selectedNativeProviders` 用固定映射展开组合值；`prepareMixedConnector` 不再要求必须存在 Luvus 原生资源（`herdr + herdr-core` 没有 Luvus），没有 host 但有 Luvus 的既有「provider 明确不可用」形态保持不变。`routeProductionSources` 的分组、`prepareMixedGateway` 与 Gateway 侧每设备一份引用的路由原本就是中性的，没有改。

配对发布路径不改语义：`publish` 对同一路径的差异一律 `configuration_required`，`mergeSetupProviders` 只追加相同引用、冲突即拒绝，`publishSetupCaller` 拒绝改写同一主体的凭据。本仓库没有名为 `unionGrants` 的函数（主管指令里提到的名字在本仓库不存在），等价的「绝不回溯扩大已批准权限」语义由上面三处承担，本次没有放宽。

## 本 PR 仍未包含

- **输入与控制档、宿主级方法**：`send`/`keys`/`interrupt`/`put`/`kill`/`rm`/`keep`/`label` 与 12 个宿主级方法都不开放。`terminal.attach` 需要终端模拟器解释首屏 VT 字节流，本期不适用。
- **Luvus/Herdr 的端口迁移**：两种既有 provider 仍走原工厂；把它们也迁到 `ProviderPorts` 会改动它们的会话、目录与身份路径，留给后续。
- **Gateway 侧的本地身份事实**：`LocalIdentityVerifier` 端口仍没有 Gateway 本机的 core 身份事实；本期身份核对发生在 Connector（`HerdrCoreInstallation`），Gateway 只信任已认证设备通道和发布的契约来源。

## 验证

单测用假 core 覆盖 framed 握手、请求配对、错误映射、超时、EOF、参数先于原生请求、结果严格性与三元组；Connector 执行端覆盖 5 个读取、控制档拒绝、`/proc` 事实不符与契约摘要不符的失败关闭；配对认领覆盖 `herdr-core` 与旧 kind 不变。schema 用 0.1.14 的真实 OpenRPC 文档和 7 个真实输出样本核对。

第四阶段把验收扩到控制档：`e2e/quickstart.py --herdr-core` 在同一轮配对里先验开关关闭（目录只剩 5 个读取、`runtime_call` 在登记前以 `forbidden` 拒绝），再改本机开关重启 Connector 验控制档——13 个方法、`send` 后用 `terminal.read(lines=0)` 读回、blocked 终端上 `send`/`keys`/`interrupt` 全部 `not_dispatched` 且程序日志为空、`kill`/`rm` 作用于本轮终端、`created_ms`/`core_id`/名字/远端目标四种栅栏拒绝、`hc server restart` 与 SIGKILL core 后在途调用 `outcome_unknown` 且重新附着后继续读（`core.id` 不变、终端记录保留）。`scripts/herdr-core/mutation-check.mjs` 逐条去掉 blocked 判定、三元组核对、Connector 与 Gateway 两处开关门禁，验证对应测试变红再恢复变绿。

真实 core 验收脚本 `scripts/herdr-core/verify-observation.ts` 在私有沙箱里对 0.1.14 跑通：`rpc.discover` 契约身份、`server.status` 的 pid 与 `/proc/<pid>/exe` 摘要、`argv`、`HC_SESSION`，以及 `terminal.list`/`get`/`read`/`wait`；XDG 运行时目录与状态目录回退两种布局都实测。第三阶段新增 `e2e/quickstart.py --herdr-core`：真实 Gateway + Connector 配对 herdr-core、在目录看到 5 个方法、经 MCP 对沙箱 core 执行 5 个读取；同一次运行里用真实 0.1.13 core 验证版本拒绝、用同机转发代理验证 `herdr_core_peer_pid_mismatch`、用 0755 socket 目录验证 `herdr_core_endpoint_untrusted`。
