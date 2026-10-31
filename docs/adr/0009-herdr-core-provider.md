# ADR 0009：provider 中性端口与 herdr-core 观察层

状态：随 #252 的实现 PR 评审；启动条件「接入第三种 provider」已由用户批准。

## 背景

#252 记录了两件事：provider 装配已走中性接缝（#313/#316），但 `Descriptor` / `LocalIdentityVerifier` / `NativeOwner` 这套端口没有引入；理由是只有两种 provider 时先抽端口、等使用者出现正是要避免的模式。现在第三种 provider（herdr-core，官方二进制 `herdr-core`，客户端 `hc`，JSON-RPC 2.0 over Unix socket）要接，端口有了真实使用者。

herdr-core 与现有 Herdr TUI 适配（`herdr` 命令，65 个普通 RPC）不是同一个原生协议：core 有 32 个方法、扁平的 `tN` 终端、framed 通道与信用流控，没有 workspace/tab/pane。二者必须是不同的 provider kind，不能共用方法表或保证强度。

## 决策

### 端口层（`src/runtime/provider-port.ts`）

只定义五个端口，不铺开抽象：`ProviderDescriptor`（kind、协议族、方法到档位的审核表、逐项保证）、`ProviderCatalogPort`、`ProviderSessionPort`、`LocalIdentityVerifier`、`NativeOwner`。注册表按 kind 固定登记，拒绝重复 kind、缺失端口、表外档位和自由文本保证；档位与保证都是闭合集合。

本 PR 的落点是：Herdr TUI 的描述只从现有已审核表派生（`HERDR_RESPONSE_TYPES` 与终端执行表），herdr-core 的描述来自 spike 的实测档位表。Herdr TUI 的档位里只有协议探测是观察档，其余普通读取按 ADR 0004 留在有条件档——普通读取也可能改变终端状态。

### herdr-core 的档位（按 0.1.14 提交 29e6d37 核对，0.1.15 提交 d028423 实测一致）

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

### 版本策略（spike 第 9 条的结论被用户放宽）

**对 core 的版本号和协议代次都不设限制**（用户决定：core 的大部分功能已经稳定，后面有调整就接着修，不做任何限制）。握手只确认这是一个 framed 的 herdr-core（有 core id、方法表与能力表，`version` 是字符串、`generation` 是整数），并把实际的版本与协议代次原样记进配对记录；不按版本号放行或拒绝，`openrpc` 文档版本号也不钉。契约来源的 `classification_revision` 不再是 `<version>@<commit>`，而是常量 `herdr-core-tiers-1`，标识**本仓库的档位表与参数规则**：core 升级不改变它，改了档位或参数规则才递增。

兼容性由这几道失败关闭的门共同判定，而不是版本号：①`rpc.discover` 的文档必须能编译，且本仓库档位表里的每个方法都在文档里（缺项 `herdr_core_schema_method_missing`）；新版本多出来的方法被忽略，不进目录，保持不可用；②参数规则由本仓库自己的 schema 收紧，结果逐层严格——新版本给已审核方法的结果加了字段，该方法会以 `herdr_core_result_invalid` 失败，而不是原样放行，出现时再调整；③配对时钉住二进制摘要与契约哈希。

**已知的两个版本。** 0.1.14 与 0.1.15 各有真实文档与真实输出样本夹具（`test/fixtures/herdr-core/`），CI 的真实 core 端到端只跑上游当前发布的最新版，不钉具体版本（这两个夹具留给单测）。0.1.15 与 0.1.14 的 `rpc.discover` 文档逐字相同，只差 `info.version` 与 `StatusResult.installed_by` 的一句说明；同一批 360 个候选参数 core 接受/拒绝结果 0 条不同；上游 `29e6d37..d028423` 的净 diff 没有触及 `terminal.*`，systemd 关机守卫只在 `hc` 自动拉起路径上，managed 直接 `execve serve` 不经过它。

配对记录二进制摘要与契约哈希，所以升级 core 等于换了二进制：已配对设备按现有语义失败关闭（`herdr_core_installation_changed` / `herdr_core_schema_unreviewed`），用新的配对码重新配对即可（`rovloom connector --join …` 把这台机器作为新设备对新 core 重新配对；这与 Herdr TUI 换了二进制后的处理一致）。

### 输入与控制档（spike 第 5 条）

本期不开放控制档，所以“blocked 由 rovloom 自己判断并拦 keys/interrupt/force”没有可以实施的调用面：`terminal.send`/`keys`/`interrupt` 等仍不在 `HERDR_CORE_EXPOSED_METHODS`，参数复核、Wire 核心与目录三处都会拒绝。`terminal-execution` 的 herdr-core 直接输入集合从同一份审核档位表派生（当前全是 control，因此目录与执行门禁都不放开），宿主级集合保持为空。blocked 状态判定留到开放控制档时与 send 一起实现，届时必须由 rovloom 自己判断，不能信 `blocked` 闸门（spike 2：keys/interrupt/force 在 blocked 时照常送达）。

## 第三阶段（同一 PR 追加）

### Connector 附着执行端

`src/connector/herdr-core/installation.ts` 只连接已运行的 core，不启动、停止或接管实例：

- 端点由本地配置固定的 `runtime_dir` 或 `state_home` 重算，运行时不再读 `cwd` 或环境变量；目录必须是本用户 0700，套接字必须是本用户的 socket。
- pid 取自这条连接的内核 peer（`SO_PEERCRED`），必须属于本用户并与 `server.status` 自报值一致；自报值本身不是证据。`/proc/<pid>/exe` 的 SHA-256 必须等于配对时发布的 `binary_sha256`，`argv` 恒为 `<bin> serve`，`HC_SESSION` 与本次 session 一致。每次执行前重读这些事实，不缓存旧许可。
- 契约只来自本次连接的 `rpc.discover`，字节摘要必须等于配对时发布的 `schema_sha256`；摘要不符、目录权限不对、代理冒充都在读写任何结果前失败关闭。
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

Connector 不再只附着一次。`HerdrCoreInstallation` 保留同一个附着对象，连接关闭后由 `ensure()` 用有退避、有上限的单飞轮重新走一遍**完整**身份核对：套接字目录 0700 与属主、内核 peer 的 pid/uid、`server.status` 自报 pid 与内核值一致、`/proc/<pid>/exe` 的 SHA-256、`argv` 恒为 `<bin> serve`、`HC_SESSION`、本次 `rpc.discover` 的摘要与编译身份、配对时记录的版本与协议代次（升级即换二进制，所以会触发 `herdr_core_installation_changed`）。任何一项不符仍失败关闭（`herdr_core_installation_changed` / `herdr_core_schema_unreviewed`），不因为「以前核对过」而放行。

- 退避序列 0/250/500/1000/1500/2000 毫秒（合计约 5.25 秒，覆盖 holder 默认 3 秒宽限加新 core 启动），单轮总预算上限 6 秒并按调用方剩余期限再收紧；一轮失败后冷却 1 秒，期间调用直接失败，不逐请求热循环。并发调用共享同一轮，不会同时建立多条连接。
- 重新附着只在调用路径上发生（`executeWire` 在写入前、`readiness` 只踢一次后台轮），`current()` 不会自己重连。断线时 `client()`/`assert()` 直接 `herdr_core_connection_closed`，不返回已关闭的连接。
- `core.id` 变了就是新实例：调用方的 `core_id` 栅栏自动失效（旧三元组不会被接受），`created_ms` 也不会与旧终端相同。`core.id` 不变（计划重启、SIGKILL core 后 holder 重建）时终端记录保留，三元组仍然有效。
- 断线时在途调用保持 `outcome_unknown`，**不重放**：附着层不保存请求，重新附着后也不重发任何调用。
- `readiness()` 只在附着对象已关闭时报告不可用。core 正在重启时报告不可用会让 transport 永久撤回 provider（`provider_fence`），所以「可重新附着」按可用报告；单次调用仍逐次核对身份，断线期间的调用明确失败（未派发），不悬挂、不重放。这是有意的取舍：可用性判断不再等价于「此刻已连接」。

### 与 Luvus / Herdr TUI 的组合

`native.provider` 追加三个组合取值：`"luvus,herdr"`、`"luvus,herdr-core"` 与 `"herdr,herdr-core"`，并改变 `mixed` 的含义：**在 Linux 上表示全部三种**（Luvus + Herdr TUI + herdr-core），macOS/Windows 上仍是 Luvus + Herdr TUI（herdr-core 靠内核 peer 凭据，只支持 Linux，不能让 `mixed` 在其它平台的新配对里准备一个跑不起来的来源）。原来的 Luvus + Herdr TUI 组合用显式的 `luvus,herdr` 表达。三种单值（省略、`luvus`、`herdr`、`herdr-core`）的解析结果与之前逐字相同。取值是闭合表（`NATIVE_PROVIDER_SELECTIONS`），不按分隔符猜测：`"herdr-core,luvus"`、带空格的、自己拼的三项串都拒绝，三项只能写 `mixed`。

**已配对设备启动不再核对 `native`（#315 边界与用户反馈）。** 早先 Connector 每次启动都把配对时记下的整段 `native` 与当前配置逐字比较，不同即 `configuration_required`：省略与显式写默认值算不同、改一个不影响实例的字段也算，报错还不说是哪一项；`mixed` 的含义改变时还要靠 `pairedNativeProviders` 给旧设备开特例。这条比较并不是安全门——每个来源实际连哪个实例、用哪个二进制，配对时已固化进受保护的本地配置（`providers.json` 与准备记录），启动并不靠 `native` 选实例。现在：配对记录决定有哪些来源，`native.provider` 只是对它们的筛选（`src/cli/native-selection.ts`）；没选中的不启动，选了但从未配对的来源提示 `native_provider_not_paired` 后跳过（`mixed` 是「本平台全部」，不算点名）；固化字段（实例、二进制与目录）改了只打印 `native_settings_kept: <字段名>` 并沿用配对值；herdr-core 的 `session` / `mode` / `config_home` 同样沿用配对值（managed 按它们推导套接字，用新值会拉起另一个 core，而配对钉住的是原来那个）。仍然拒绝的只有：Gateway URL 与配对时不同（设备凭据不得发往另一个 origin）、配对记录自身不完整或被改动、以及没有任何可启动的已配对来源。旧版 `mixed` 设备（只有 `luvus`+`herdr` 两条准备记录）因此无需特例也照旧启动；已有的配置、token、设备凭据、配对记录与旧 schema 布局继续按原样读取。新配对的 `mixed` 在 Linux 上要求三者都装好、并有一个在运行的 herdr-core（attach）或配置成 managed；没有 herdr-core 的人用 `luvus,herdr`。join 的续传只在准备记录里的 native 设置与现在相同时成立，设置变了就退役重来。

装配层只做了几处最小改动：`selectedNativeProviders` 用固定映射展开组合值（`mixed` 按平台），启动时用 `selectNativeProviders` 筛选已配对来源；`prepareMixedConnector` 不再要求必须存在 Luvus 原生资源（`herdr + herdr-core` 没有 Luvus），没有 host 但有 Luvus 的既有「provider 明确不可用」形态保持不变。`routeProductionSources` 的分组、`prepareMixedGateway` 与 Gateway 侧每设备一份引用的路由原本就是中性的，没有改。

配对发布路径不改语义：`publish` 对同一路径的差异一律 `configuration_required`，`mergeSetupProviders` 只追加相同引用、冲突即拒绝，`publishSetupCaller` 拒绝改写同一主体的凭据。本仓库没有名为 `unionGrants` 的函数（主管指令里提到的名字在本仓库不存在），等价的「绝不回溯扩大已批准权限」语义由上面三处承担，本次没有放宽。

## 仍未包含（第五阶段之后）

- **`machine.*` 与 `on`**：core 自己的机器表与远端路由永远不开放——一个 token 会因此摸到别的设备，绕过 rovloom 按设备限定范围。多机本来就是每台机器各自一个 Connector。
- **原始流**：`terminal.attach`（首屏 VT 字节流）与 `events.subscribe`（framed 持续流）不进 MCP；读屏幕/历史用 `terminal.read`，状态变化用 `terminal.events` 长轮询。
- **无认证身份字段**：`caller`、`calls_you`、`core` 一律拒绝。
- **Luvus/Herdr 的端口迁移**：两种既有 provider 仍走原工厂；把它们也迁到 `ProviderPorts` 会改动它们的会话、目录与身份路径，留给后续。
- **Gateway 侧的本地身份事实**：`LocalIdentityVerifier` 端口仍没有 Gateway 本机的 core 身份事实；身份核对发生在 Connector（`HerdrCoreInstallation`），Gateway 只信任已认证设备通道和发布的契约来源。

## 已配对设备追加来源（ADR 补充）

`native.provider` 点名了这台设备没配对过的 kind 时，Connector 在启动时用设备凭据把它追加进 Gateway（`POST /pairing/providers`），当次启动即使用；不需要新的配对码，设备身份、凭据与 MCP token 不变。信任锚是设备凭据：Gateway 只读核验（不改 epoch、不写设备状态），只能追加、不能覆盖，同 reference 同内容的重放幂等。`mixed` 也参与追加（Linux 上会追加 herdr-core；macOS/Windows 的 mixed 只有两项）。追加失败一律非致命，只打印 `native_provider_append_failed: <kind> <固定码>`。

安全后果：追加后持有该设备范围令牌的调用方默认就能使用新来源（`allow_terminal_execution` 默认开启）；设备凭据泄漏者能追加 provider，但他本来就能冒充该设备。

## 验证

单测用假 core 覆盖 framed 握手、请求配对、错误映射、超时、EOF、参数先于原生请求、结果严格性与三元组；Connector 执行端覆盖 5 个读取、控制档拒绝、`/proc` 事实不符与契约摘要不符的失败关闭；配对认领覆盖 `herdr-core` 与旧 kind 不变。schema 用 0.1.14 的真实 OpenRPC 文档和 7 个真实输出样本核对。

第四阶段把验收扩到控制档：`e2e/quickstart.py --herdr-core` 在同一轮配对里先验开关关闭（目录只剩 5 个读取、`runtime_call` 在登记前以 `forbidden` 拒绝），再改本机开关重启 Connector 验控制档——13 个方法、`send` 后用 `terminal.read(lines=0)` 读回、blocked 终端上 `send`/`keys`/`interrupt` 全部 `not_dispatched` 且程序日志为空、`kill`/`rm` 作用于本轮终端、`created_ms`/`core_id`/名字/远端目标四种栅栏拒绝、`hc server restart` 与 SIGKILL core 后在途调用 `outcome_unknown` 且重新附着后继续读（`core.id` 不变、终端记录保留）。`scripts/herdr-core/mutation-check.mjs` 逐条去掉 blocked 判定、三元组核对、Connector 与 Gateway 两处开关门禁，验证对应测试变红再恢复变绿。

真实 core 验收脚本 `scripts/herdr-core/verify-observation.ts` 在私有沙箱里对 0.1.14（0.1.15 见上文）跑通：`rpc.discover` 契约身份、`server.status` 的 pid 与 `/proc/<pid>/exe` 摘要、`argv`、`HC_SESSION`，以及 `terminal.list`/`get`/`read`/`wait`；XDG 运行时目录与状态目录回退两种布局都实测。第三阶段新增 `e2e/quickstart.py --herdr-core`：真实 Gateway + Connector 配对 herdr-core、在目录看到 5 个方法、经 MCP 对沙箱 core 执行 5 个读取；同一次运行里用同机转发代理验证 `herdr_core_peer_pid_mismatch`、用 0755 socket 目录验证 `herdr_core_endpoint_untrusted`。

## 附录 A：herdr-core 能力目录（0.1.14 与 0.1.15 相同）

**没有第二个开关。** 早期设想给 `machine.exec` / `file.*` 单独的 `allow_machine_exec`，**已作废**：这些能力都不超过 `terminal.run`（后者已经能在本机执行任意程序），再引入第三个开关要新增 Wire 能力协商、并改掉文档里「两个权限开关」的说法，代价大于收益。8 个宿主级方法全部与输入/启动类共用 `allow_terminal_execution`：目录里照旧「列出但 `available:false`」，Gateway 登记前 `forbidden`，Connector 最终写入前 `not_dispatched` + `terminal_execution_disabled`。

32 个 core 方法里开放 23 个（6 读取 + 8 控制 + 9 宿主级含 `terminal.run`），不开放 9 个：`hello`、`rpc.discover`（协议自身）、`events.subscribe`、`terminal.attach`（流），以及 `machine.list/add/connect/rename/rm`（绕过设备范围）。再加上 rovloom 自有的 `terminal.events`，目录里共 24 个方法。

"开关"指 `allow_terminal_execution`。目录里的 `available` 与 `terminal_execution.local_state` 就是这一列的可机读形式；关闭时控制档与启动类仍会列出，但 `available:false`，调用在 Gateway 登记前被拒。

| 分组 | 方法 | 开放 | 档位 | 开关 | 关键参数限制 |
|---|---|---|---|---|---|
| 握手 | `hello` | 否 | 观察 | — | 只用于 framed 握手；不给 Wire 客户端 |
| 契约 | `rpc.discover` | 否 | 观察 | — | 只由附着层调用；契约通过 `runtime_describe` 交付 |
| 状态 | `server.status` | 是 | 观察 | 否 | — |
| 状态 | `terminal.get` | 是 | 观察 | 否 | 只接受本地地址 `tN` |
| 状态 | `terminal.list` | 是 | 有条件 | 否 | 接受 core 自带的过期清理 |
| 读取 | `terminal.read` | 是 | 有条件 | **`lines>0` 时需要** | `lines` ≤ 1000；`lines>0` 可能向全屏程序发滚轮输入 |
| 多轮 | `terminal.wait` | 是 | 观察 | 否 | `timeout` ≤ 60 秒；`children` 必须显式给 `terminal`（rovloom 不发 `caller`）；`output` 给普通程序 |
| 启动 | `terminal.run` | 是 | 宿主级 | 是 | 模板形态要 `template:true` 并用 `templates.list` 核对；`caller`/`on` 拒绝；`parent` 只接受 `tN` 且必须带 `parent_created_ms`（父必须 live、created_ms 一致），与 `no_parent` 互斥；`no_notify` 只接受 `true`；`wait=true` 必须给 ≤60 秒 `timeout`；argv ≤64 项/32 KiB、line ≤32 KiB、env ≤64 项、name 1–32 位；本 Connector 同时最多 32 个自己启动的存活终端 |
| 启动 | `templates.list` | 是 | 有条件 | 否 | 只列出名称/描述/命令；命令文本由机主维护 |
| 输入 | `terminal.send` | 是 | 控制 | 是 | 必须带 `core_id`+`created_ms`；`force` 拒绝；blocked 拒绝；`wait=true` 必须给 ≤60 秒 `timeout` |
| 输入 | `terminal.keys` | 是 | 控制 | 是 | 同上三元组栅栏；≤64 键，每个 ≤32 字符；blocked 拒绝 |
| 输入 | `terminal.interrupt` | 是 | 控制 | 是 | 同上；`timeout` ≤60 秒；blocked 拒绝 |
| 输入 | `terminal.put` | 是 | 控制 | 是 | 同上三元组栅栏；data ≤512 KiB base64、name 只允许后缀字符 |
| 关闭 | `terminal.kill` | 是 | 控制 | 是 | 三元组栅栏；blocked 时仍可用 |
| 关闭 | `terminal.rm` | 是 | 控制 | 是 | 同上；可作用于已结束终端 |
| 关闭 | `terminal.keep` | 是 | 控制 | 是 | 同上；keep 只换 shell，不重跑任务 |
| 状态 | `terminal.label` | 是 | 控制 | 是 | 同上；≤32 个标签，键/值有界 |
| 读取 | `terminal.attach` | 否 | 有条件 | — | 首屏是 VT 字节流，需要终端模拟器；不属于 MCP 调用面 |
| 状态 | `terminal.events` | 是 | 观察 | 否 | **rovloom 自有方法（不是 core 方法）**：长轮询，返回当前快照 + 水位之后至多 `limit` 条事件；见下 |
| 事件 | `events.subscribe` | 否 | 观察 | — | framed 持续流，Wire 桥接只做普通 RPC；由 `terminal.events` 承接 |
| 手 | `machine.exec` | 是 | 宿主级 | 是 | `argv` 与 `line` 恰好一个；`timeout` 必填且 ≤60 秒（本地请求上限 65 秒）；`cwd` 绝对路径；`env` ≤64 项；`input` base64 ≤256 KiB；`on` 拒绝；`truncated` 原样透传 |
| 手 | `file.read` | 是 | 宿主级 | 是 | `path` 绝对路径、不接受 `cwd`；`offset`/`limit` 非负整数。结果受 1 MiB 响应帧上限约束，超出的文件读不到整段，需自己分页 |
| 手 | `file.write` | 是 | 宿主级 | 是 | `path` 绝对路径、不接受 `cwd`；`data` base64 ≤256 KiB；core 整份替换写入 |
| 手 | `file.edit` | 是 | 宿主级 | 是 | `path` 绝对路径、不接受 `cwd`；`edits` 1–64 条、合计 ≤64 KiB；每个 `old` 恰好出现一次，全成或全不成 |
| 文档 | `doc.get` | 是 | 有条件 | 是 | `name` 1–32 位小写字母/数字/`-_.`（沿用 core 的终端名规则） |
| 文档 | `doc.set` | 是 | 宿主级 | 是 | 同上名字规则；`value` 序列化 ≤200 KiB（core 允许 1 MiB）；`version` 必填（CAS，不符返回 `conflict`） |
| 远程 | `machine.list` / `machine.add` / `machine.connect` / `machine.rename` / `machine.rm` | 否 | 有条件/宿主级 | — | 绕过 rovloom 的设备/凭据模型（一台设备经 `on` 摸到另一台）；`runtime_describe` 的 `blocked_methods` 带固定原因 |
| 生命周期 | `server.stop` / `server.restart` | 是 | 宿主级 | 是 | 只有一个 rovloom 自有的 `core_id`（必填，必须等于当前连接；不符 `fence_mismatch`，不转发给 core）。`stop` 在 attach 模式下让 provider 不可用直到有人拉起 core，managed 模式下下一次调用重新拉起；`restart` 之后自动重新附着 |

### 状态变化推送：`terminal.events` 长轮询

Wire 桥接只做普通 RPC，`events.subscribe` 是 framed 持续流，因此不暴露成 MCP 工具。要让控制端看到「哪个终端变成了 blocked/done」，`terminal.events` 由 Connector 自己实现：一条无过滤订阅 + 有界环形缓冲（默认 256 条），一次普通请求最多等 `timeout_ms`（≤30 秒），返回「当前终端快照（现读 `terminal.list`）+ 自 `after_seq` 以来至多 `limit` 条事件」。

- `seq` 只在同一个 core 进程内有效；`after_seq` 大于当前水位（core 重启后归零）时丢弃旧水位、整份重建，返回 `rebuilt:true`，调用方必须从新水位重新开始。早于本订阅快照起点的水位（`missed`、EOF 后重新订阅）同样 `rebuilt:true`。
- 缓冲已把调用方还没取走的事件挤掉时返回 `truncated:true` 与 `dropped` 条数，绝不静默丢事件。`rebuilt`/`truncated`/`dropped` 由调用方带来的 `after_seq` 与 feed 现有范围**现算**，不在 feed 上累积，因此追平后不会黏住（无过滤订阅的 `seq` 连续，空洞即丢失）。
- 事件不按「终端是否还在快照里」过滤：`finished`/`removed`/`lost` 恰恰发生在终端消失之后；`address` 直接比对事件的终端，`labels` 用 feed 见过的快照里的标签。
- 已知局限：core 重启后 `core.id` 不变，`seq` 归零，一个恰好落在新范围内的旧水位与正常续读无法区分；调用方应持续轮询，把 `seq` 变小当作重启信号。
- 并发的多个轮询共用同一次订阅（单飞），同一条事件唤醒全部等待者；`next_after_seq` 用取定事件时的水位，读快照期间到达的事件留给下一次轮询。
- 只用无过滤订阅（spike 4a1：按终端/标签过滤的订阅有空洞），`address`/`labels` 在 Connector 侧过滤快照与事件。
- 观察档：不受 `allow_terminal_execution` 约束；参数（水位/条数/时限/过滤）逐项审核，多余字段拒绝；结果由本仓库的严格 schema 复验。
- 订阅遇到 `missed`、EOF 或背压都按重建处理；Connector 重新附着后连接换了，feed 自己重建。

### 智能体兼容性

- **pi 1.4.0**：启动即报 OSC 7501（`app=pi`，`state=idle`）；主管经 MCP 用它跑过两轮上下文连续的对话与一次中断。本阶段的 e2e 用假智能体（`e2e/herdr-core-fakeagent.py`）覆盖同样的状态机，CI 不需要模型。
- **Claude Code 2.1.312 / Codex 0.164.0**：**未验证**。空 HOME 下停在首次登录引导，没有进入主界面，因此不能据此判断它们是否上报状态；需要已登录环境与用户授权。
- **Codex** 必须带 `--no-daemon`，否则它的命令跑在 core 之外，状态与轮次都会错。rovloom 不会替你改命令；写进模板或 README。

### 交互要点（由 rovloom 撰写，随 `runtime_describe` 的 `guide` 交付）

交互式运行、任务写进第一次 `terminal.run`、`first_message.sent=false` 不要盲目重发、`wait=true` 是检查点、状态来自 OSC 7501、`blocked` 交给人、`turn`/`seq` 不是完成证明、Codex 需要 `--no-daemon`、写类调用不重放。逐方法补充在 `terminal.read`/`terminal.wait`/`terminal.send`/`terminal.interrupt` 的 `usage` 里。
