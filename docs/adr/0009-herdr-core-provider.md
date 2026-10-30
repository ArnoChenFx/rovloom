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

32 个方法分四档：A 观察 6、B 有条件 6、C 输入与控制 8、D 宿主级 12。本 PR 只开放 5 个普通读取：`server.status`、`terminal.get`、`terminal.list`、`terminal.read`（`lines` 必须为 0）、`terminal.wait`（timeout ≤ 60 秒）。其余方法返回固定 `herdr_core_method_unavailable`。

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

`events.subscribe` 进入本期开放集合，但只接受空参数：按终端、子终端或标签过滤的订阅会留下空洞（spike 4a1 实测 3,5,7…），不能当连续流。事件只走 framed 通道，信用按实际消费字节回补（帧循环完成）。`missed` 用新快照重建，水位换成快照 `seq`，其后不超过水位的在途事件丢弃并计数；EOF 结束本地等待返回 `closed(eof)`，由调用方重新握手；慢消费者以 `closed(backpressure)` 显式结束，已收到的通知仍可取走，不静默丢中间事件。`seq` 只用于同一 core 进程内排序，重连后丢弃旧水位。

### 版本重新分类（spike 第 9 条）

握手要求 `version` 等于审核过的 `0.1.14`，未审核版本以 `herdr_core_version_unreviewed` 拒绝，与形状不符的 `herdr_core_handshake_refused` 分开；契约来源的 `classification_revision` 固定为 `<version>@<commit>`，配置解析阶段就拒绝不属于本次审核表的来源。

### 输入与控制档（spike 第 5 条）

本期不开放控制档，所以“blocked 由 rovloom 自己判断并拦 keys/interrupt/force”没有可以实施的调用面：`terminal.send`/`keys`/`interrupt` 等仍不在 `HERDR_CORE_EXPOSED_METHODS`，参数复核、Wire 核心与目录三处都会拒绝。`terminal-execution` 的 herdr-core 直接输入集合从同一份审核档位表派生（当前全是 control，因此目录与执行门禁都不放开），宿主级集合保持为空。blocked 状态判定留到开放控制档时与 send 一起实现，届时必须由 rovloom 自己判断，不能信 `blocked` 闸门（spike 2：keys/interrupt/force 在 blocked 时照常送达）。

## 本 PR 仍未包含

- **Connector 执行端口**：herdr-core 目前只交付 Gateway 侧 Wire 会话、准入与证据保留；没有附着/启动 core 的 Connector 执行路径，因此选择 herdr-core 作为 Connector provider 会明确 `backend_unavailable`，而不是给一个不执行的会话。真实 core 的只读验收仍由 `scripts/herdr-core/verify-observation.ts` 在私有沙箱里跑。
- **输入与控制档、宿主级方法**：`send`/`keys`/`interrupt`/`put`/`kill`/`rm`/`keep`/`label` 与 12 个宿主级方法都不开放。`terminal.attach` 需要终端模拟器解释首屏 VT 字节流，本期不适用。
- **Luvus/Herdr 的端口迁移**：两种既有 provider 仍走原工厂；把它们也迁到 `ProviderPorts` 会改动它们的会话、目录与身份路径，留给后续。

## 验证

单测用假 core 覆盖 framed 握手、请求配对、错误映射、超时、EOF、参数先于原生请求、结果严格性与三元组；schema 用 0.1.14 的真实 OpenRPC 文档和 7 个真实输出样本核对。真实 core 验收脚本 `scripts/herdr-core/verify-observation.ts` 在私有沙箱里对 0.1.14 跑通：`rpc.discover` 契约身份、`server.status` 的 pid 与 `/proc/<pid>/exe` 摘要、`argv`、`HC_SESSION`，以及 `terminal.list`/`get`/`read`/`wait`；XDG 运行时目录与状态目录回退两种布局都实测。
