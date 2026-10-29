# 原生契约校验与宿主接口

本文说明 Luvus 与 Herdr 安装契约的编译、原生请求与响应的校验，以及宿主必须提供的可信来源。

- `src/connector/luvus/contract/index.ts`：异步契约编译，同步的原生校验与授权内核。准确签名见 `src/connector/luvus/contract/types.ts`。
- `src/connector/luvus/wire.ts`：`createLuvusWireAdapter(backend, limits?)` 把内核接入 [Wire v2](WIRE-PROTOCOL.md)；Luvus 后端接口在 `src/connector/luvus/backend.ts`，公共 attempt 账本事实在 `src/wire/backend.ts`。
- `src/connector/luvus/`、`src/connector/herdr/`：Connector 上的本机 adapter。
- 设计取舍见 [ADR 0004](../adr/0004-multi-runtime-provider.md)。

## 契约与内存许可

`await compileBundle(bytes, options, signal?)` 在 Bun Worker 中接纳安装 bundle 的完整根、条件及引用闭包。使用 Ajv2020 离线完整编译，并生成 standalone 校验代码。

- 不联网解析 `$ref`，不读路径，不补默认值，不转换类型，不删除原生字段。
- URL 只是 bundle 内的索引。未知方言、未知关键字、缺失引用、副本冲突和资源超限一律拒绝。
- `parseNativeJson` 做有界 JSON 检查。字符串与 UTF-8 字节入口都拒绝 BOM。
- 引用遍历使用显式栈。循环和超过预算的引用链返回 `schema_unavailable`，不生成 handle。

| 原生内核预算 | 默认上界 |
|---|---|
| 单个 JSON 对象 | 1 MiB、深度 64、100,000 个节点 |
| 安装 bundle | 2 MiB、150,000 个节点 |
| documents | 64 份，每份 512 KiB |
| 引用 | 2,048 条，任一路径至多 32 条 `$ref`（结构边不计） |
| `terminal.frame` JSON 编码 | 64 KiB（不含 LF），另验原生 text / bytes / lines 约束 |

- 64 KiB 的限制只适用于 `terminal.frame`。其它终端事件，如 `terminal.metadata_changed`，按单个 JSON 对象预算校验。
- 在线 request、response 帧的预算包含结尾 LF。session capability 必须提供正安全整数的 `limits.frame_bytes`、`terminal.limits.request_bytes` 和 `terminal.limits.response_bytes`。请求与响应取通用预算与终端预算的交集。
- `CompileOptions.limits` 只能降低这些上界。预算按结构和字节计量，不代表 JS heap 或 CPU 隔离。

### 编译 Worker 与生成物接纳

Rovloom 使用宿主实际安装的程序导出的 schema 原字节，按协议和实际接口能力判断兼容性。版本只用于诊断，不设发行版或 binary / schema 摘要白名单。缺失的可选接口只使依赖它的功能不可用。

- 远端 Gateway 可以使用受保护配置交付的同一份 schema，在本地 Worker 中编译，不要求安装或运行 Luvus。Gateway 不信任 Wire 传来的对象、远端 URL 或调用方提交的 schema。
- 公共工厂只接收原字节、安装身份、限额和可选取消信号，不接收代码、路径或 Worker 工厂。源码和构建产物使用同一个固定 Worker 入口，构建时内嵌 Worker 模块。
- Worker 先检查原字节摘要、文档、方言、关键字、引用闭包、alias 与预算，再用锁定的 Ajv 8.20.0 和固定选项完整编译，覆盖完整根、条件、引用闭包和事件分支。没有预编译资产，冷编译约 0.7 秒。
- 禁止未知方言和关键字、自定义 format / keyword、在线 resolver 和裁剪约束。
- 能力广告可带额外诊断字段。方法描述只取 `method / access / scope / idempotent`，无法理解的授权语义只隔离对应方法。`server_version` 缺失时保持 null。
- Herdr 目录只解析原文内可准确描述的引用分支，未知或不兼容的分支不阻断健康方法。执行时始终校验完整原生根。

接纳控制：

- 每个进程至多一个在途编译，没有等待队列。并发请求返回 `compiler_busy`。
- 接纳期限为 10 秒（Luvus 与 Herdr 相同），从工厂调用开始，覆盖 Worker 启动、预检、完整编译、standalone 生成、消息传递和宿主初始化。
- 失败只返回安全错误码和固定 reason，不透传 schema、生成代码、私人路径或异常原文。普通 schema 拒绝统一为 `origin: contract / code: schema_unavailable / stage: compile`，Worker 可继续复用。
- 取消、期限到达或 Worker 与私有协议故障会永久退役当前编译服务：终止 Worker，拒绝后续任务和所有迟到回复。恢复需要角色进程重新初始化。已取消的调用不启动 Worker。
- 宿主只消费自己当前 Worker 的当前任务回复。私有协议版本为 1，未知版本、未知字段和错误的任务身份一律拒绝。
- 产物绑定 binary、schema、revision、Ajv 与生成器版本、生成选项摘要和源码摘要。生成源码至多 8 MiB，必须覆盖所有根和事件导出。
- 宿主用私有 CJS 容器初始化生成函数，`require` 只映射 Ajv 的 `ucs2length` 和 `equal` 两个纯 helper。核对和加载都在期限内通过，才登记 `CompiledContract`。已接纳的契约不依赖 Worker 存活。

这个边界可取消，也能拒绝迟到产物，但不提供硬 heap 隔离，也不保证 Worker 在指定时刻退出。主线程仍要解析生成的 JavaScript 并同步执行校验。因此不会自动编译不受信任的 schema。

## 校验接口

`NativeValidator` 的主要入口（见 `src/connector/luvus/contract/types.ts`）：

| 入口 | 作用 |
|---|---|
| `checkCapabilitiesShape(input, expected)` | 校验能力响应、完整方法目录、protocol、session / generation 和终端预算。只返回结构结果，不认证来源，不登记任何 handle。远端 epoch 接纳可用它拒绝非法快照 |
| `bindCapabilities(response, source)` | 取得独立的当前 `TrustedNativeContext` 后，生成 Gateway 本地的 opaque 能力视图 |
| `describe(view, method)` | 返回方法描述，不授予执行权限 |
| `checkRequestShape(request)` | 有界复制后检查请求。已收录方法检查完整请求根，未知方法只检查 raw 最小信封。成功返回 void，不表示参数覆盖完整，不授予任何权限 |
| `checkRequest` / `checkRawRequest` | 建立候选。`checkRawRequest` 允许未收录方法产生 `unavailable` 候选 |
| `checkDispatch` | 全部门禁通过后签发不可从 JSON 复制的 `DispatchPermit` |
| `checkResponseShape` / `checkResponse` | 前者只证明结构。后者再关联原候选或 permit、native ID、方法结果和可信来源 |
| `sealResponseContext` / `checkResponseOnly` / `releaseResponseContext` | 从真实 RPC permit 封存最小响应约束，供内容清理后核对迟到响应。`checkResponseOnly` 只返回校验结论，不返回载荷，不授予读取或派发能力 |

Gateway 可把 `checkRequestShape` 接入首次登记事务的同步预检。非法参数使登记回滚，后续 Wire 与实际 I/O 门禁仍完整复验。

### 方法表与 raw 授权

`checkDispatch` 的门禁：

- 方法必须在静态方法表（`src/connector/luvus/methods.ts`）中，并且目标 profile 为 session、传输为单请求 RPC。表外方法（包括流、token、Host 与 server 管理方法）返回 `method_not_listed`。
- 安装契约广告的 `access / scope / idempotent` 提示必须与表项逐字段一致，否则返回 `method_contract_mismatch`。
- 调用方与本机策略都必须授权该方法。
- `strict` 模式拒绝参数覆盖不完整（`parameter_schema_incomplete`）和不可用（`schema_unavailable`）的方法。
- `raw_contract` 模式只在 Owner 显式选择、可信的精确范围 grant 有效、其它门禁均满足时，放宽参数覆盖要求。已有的 schema 约束仍然生效，表外方法也不能借 raw 通过。

raw 的 `validation=unavailable` 只适用于 bundle 已可信、可编译，但在线方法未收录于该 bundle 的情形。整个 bundle 编译失败时仍是 `schema_unavailable`，不能借 raw 作为无 schema 的执行入口。

原生 `method_contracts` 只用于核对静态方法表，不单独授权。raw grant 绑定调用主体、完整目标、精确方法、契约与 revision、有效期。方法表是上限，具体 provider 仍用自己的白名单进一步收窄。

固定的 Luvus 0.14.3 输入有 29 份 schema 文档、223 个方法。部分方法只有通用 params 对象，不能宣称完整参数校验。session、Host 与 access_machines 三类接口分开，`machine.*` 不用作 Gateway 设备注册。数据与审计入口见 [开发指引](../DEVELOPMENT.md#固定输入与维护用途)。

## 宿主必须提供的可信来源

`NativeWireBackend` 由认证、账本、双端受保护配置和原生 endpoint 证明实现。调用方、消息、设备广告或相同的 hash 都不能自证信任。

| backend 来源 | 必须保证 |
|---|---|
| `connection` / `currentPrincipal` | 当前已认证且 active 的连接、恢复代次、epoch 与读取身份 |
| `attempt` | 原登记的完整 AttemptBinding、请求、主体、method 与 mode |
| `provider` / `localProvider` | 双端独立的受保护配置，完整 binding 精确一致 |
| `contract` | 不可变的 ContractSource、真实编译 handle、能力 revision。重算 `contract_ref` 并核对 binary / schema |
| `nativeSource` | 独立的 endpoint 与身份实证，`authenticated` / `source_verified` 成立且完整 NativeBinding 匹配 |
| `policies` / `authority` | 当前双方精确的 Target grant、Owner 与 raw grant。方法表是静态常量，不由宿主提供 |
| `now` / `contentStatus` / `responseAnchor` | 受信时钟、固定的内容状态与持久的原派发锚点，不从回复补建 |

- direction 来自宿主角色。Wire 的 `V2Target` 投影为原生 Target。`kind / provider / revision / contract_source_ref` 单独保存在 NativeBinding，revision 不做字符串与数字转换。
- 组合后的 `contract_ref` 不能强转为 schema hash。
- 完整 provider tuple 求双方权限交集后才投影给原生 Policy，不从独立数组拼出笛卡尔授权。
- `contract` resolver 只能返回已接纳的 handle。opaque handle、permit 和来源 token 都不能序列化后跨进程或重启恢复。

## 请求、控制与交付

- 每帧重新读取原 attempt、双端 binding、契约和原生来源，并核对原请求。调用方提交的 id / auth 被拒绝，native ID 从登记绑定注入，auth 只由 Connector 在本机注入。校验失败只返回 code 与 reason，不记录载荷。backend 异常返回 `native_adapter_unavailable`。
- adapter 按完整 AttemptBinding 私有保存最初的 permit，重复编解码不替换。
- `checkResult(binding, nativeFrame?)` 检查实际响应。省略 frame 时只核对当前读取权限。解码与顺序校验成功不授予内容读取权限。
- `checkResultBoundary` 另验当前读取者、双方 read grant 和内容状态。`planEvidence` 只返回待持久化的意图，只有当前读取者仍是派发主体且双端读权限有效，才能包含载荷。内容过期、被丢弃、不可用或撤权时，不输出原文，不生成句柄，不延长期限。事务提交成功前不发布持久的 `responded`。
- 创建结果句柄前使用 `checkResultRetention(binding, nativeFrame)`。它核对活的原请求、精确响应和当前读取授权，再用原 permit 复验派发主体与当前来源。没有原上下文时拒绝，不从账本或响应 JSON 创建 permit。
- 宿主先用 `observeMessage` 过滤重复，重复消息不得再执行。内存中的 handle 与 source token 不序列化，关闭、到期、撤权时必须释放。缺失 handle 时拒绝，不从回复重建 permit，不通过重新派发恢复结果。
- 默认至多 128 个 attempt，合计 16 MiB 保留 JSON 快照。快照逐项计入 UTF-8、转义、键和标点，超限先拒绝。共享同一 `CompiledContract` 的 attempt 可共享 handle，但完整可信 binding 仍须一致。该计量不是 JS heap 隔离。
- 响应必须放入单个 1 MiB Wire 帧，超限不分片，Connector 写出时因预算错误失败，调用保持 `outcome_unknown`。读取细节见 [通道](../TRANSPORT.md)。
- 内容到期或被丢弃后，adapter 把 RPC 切换为仅响应上下文，只允许在原去重期限内提交仅元数据的证据，不恢复内容读取、原请求或派发权限。Store 提交后的回收通知与 adapter 的内存期限维护共同回收原文。断连、撤销、provider fence、关闭或去重到期都会释放句柄。
- 原生 error 与 data 原样保留，网关错误不写回原生 error。
- 不提供流（open / event / control 帧），流类方法不在方法表中，不进入 RPC 派发。
