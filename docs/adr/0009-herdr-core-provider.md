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

## 本 PR 未包含

- **Wire kind 与配置接线**：`validateProvider` 的 kind 联合、`NativeProviderKind`、CLI 配置与生产来源注册仍是两种 provider。加第三种要同时决定 Wire 的 kind 联合与存储迁移（#315 的边界），不在本 PR 单方面改动。
- **ProviderSession 端口**：herdr-core 的 Wire 会话、准入账本与证据保留未实现，所以 herdr-core 还没有进入 `ProviderPorts` 注册表；端口层当前登记 Herdr TUI 一种描述。
- **事件订阅**：framed 通道、信用回补与 `missed`/EOF 重订阅规则已在 spike 里定清（只走 framed、按字节回补、重连后丢弃旧 `seq` 水位），但本 PR 未实现 `events.subscribe`。
- **输入与控制档、宿主级方法**：`send`/`keys`/`interrupt`/`put`/`kill`/`rm`/`keep`/`label` 与 12 个宿主级方法都不开放。`terminal.attach` 需要终端模拟器解释首屏 VT 字节流，本期不适用。

## 验证

单测用假 core 覆盖 framed 握手、请求配对、错误映射、超时、EOF、参数先于原生请求、结果严格性与三元组；schema 用 0.1.14 的真实 OpenRPC 文档和 7 个真实输出样本核对。真实 core 验收脚本 `scripts/herdr-core/verify-observation.ts` 在私有沙箱里对 0.1.14 跑通：`rpc.discover` 契约身份、`server.status` 的 pid 与 `/proc/<pid>/exe` 摘要、`argv`、`HC_SESSION`，以及 `terminal.list`/`get`/`read`/`wait`；XDG 运行时目录与状态目录回退两种布局都实测。
