# Wire v2：Gateway 与 Connector 的消息协议

Wire 当前版本为 major **2** / minor **3**。每条 WebSocket 消息是一个 UTF-8 JSON 信封。编解码在 `src/wire/`，Luvus 原生校验经 `src/connector/luvus/wire.ts` 接入（Luvus 后端接口在 `src/connector/luvus/backend.ts`，公共 attempt 账本事实在 `src/wire/backend.ts`），见 [原生契约](NATIVE-CONTRACT.md)。认证、存储和传输由宿主提供可信实现，见 [通道](../TRANSPORT.md)。总览见 [协议总览](../PROTOCOL.md)。

Luvus / Herdr 的原生协议、UHP 标识和 fixture 保持原样，Wire 不改写它们。

## 版本与能力

`decodeWireFrame(input, context)` 与 `encodeWireFrame(frame, context)` 只接受 v2。

- major 不同直接拒绝。minor 取双方与本实现已支持 minor 的交集上界。
- 能力只取双方显式广告且当前 minor 已知的交集。未知的可选能力被忽略，未知或双方未共同支持的 required 能力被拒绝。
- `capabilities` 与 `required` 各至多 64 项，无重复。`required` 必须属于本方的 `capabilities`。
- 业务帧使用已选定的 minor，不能按消息重新猜测版本。握手 offer 中较高的 minor 只是协商上界，不允许直接用于业务帧。
- `welcome` 必须匹配本地保存的 offer 与 required，并用 `in_reply_to` 核对原握手的 `message_id`。收到 `welcome` 本身不产生已认证上下文。
- 缺少认证上下文的编码和仅带 epoch 的调用被拒绝。

| 可选能力 | 用途 |
|---|---|
| `rpc` | 普通 request / accepted / response / cancel |
| `dispatch_refusal` | Connector 对确定未写出的调用逐个拒绝。依赖 `rpc` |
| `provider_snapshot` | Connector 上报实测的 provider 来源快照。依赖 `rpc`，不传输 schema 或 opaque handle |
| `terminal_execution_state` | Connector 上报本机终端开关的布尔值，仅供目录使用。依赖 `rpc` |
| `provider_fence` | 普通 RPC 的逐 provider 来源永久撤回。依赖 `rpc` |
| `late_evidence` | 为 `outcome_unknown` 的同一 attempt 补充证据 |
| `device_platform` | Connector 上报本机 os / arch / Linux 发行版标识。minor ≥ 1 |
| `host_profile` | Connector 在 welcome 后一次上报最小主机信息；minor ≥ 2，不建立执行许可 |
| `host_cpu_quota` | `host_profile` 内可选的小数核 CPU 配额；minor ≥ 3，必须同时协商 `host_profile` |

## 信封与消息类型

共同根字段：`protocol_major`、`protocol_minor`、`type`、`message_id`、`payload`。已认证帧还必须带 `machine_id`、`recovery_generation`、`connection_epoch`，并逐项与当前认证连接核对。

- `recovery_generation` 是 Gateway 账本的代次标识，账本创建时随机生成。
- `connection_epoch` 在每次设备认证成功时分配。

| type | 方向 | 必填 payload |
|---|---|---|
| `enroll` | Connector → Gateway，预认证 | registration_id, connector_instance_id, enrollment_credential, offer |
| `authenticate` | Connector → Gateway，预认证 | machine_id, recovery_generation, connector_instance_id, device_credential, offer |
| `welcome` | Gateway → Connector，预认证 | machine_id, recovery_generation, connection_epoch, in_reply_to, selected |
| `provider_snapshot` | Connector → Gateway | binding, target, source, capabilities, capability_revision |
| `terminal_execution_state` | Connector → Gateway | binding, enabled |
| `device_platform` | Connector → Gateway | os, arch, distribution |
| `host_profile` | Connector → Gateway | os, arch, cpus, memory_bytes, container, agent_version, providers；协商 `host_cpu_quota` 后可带 cpu_quota 与 cpu_quota_status |
| `provider_fenced` | 双向 | binding |
| `request` | Gateway → Connector | attempt, expected_binding_revision, native_request, validation |
| `accepted` | Connector → Gateway | attempt |
| `dispatch_refused` | Connector → Gateway | attempt, code |
| `response` | Connector → Gateway | attempt, native_response |
| `cancel` | Gateway → Connector | attempt, reason |
| `heartbeat` | 双向 | sequence |
| `error` | 双向 | source, code, retryable, cause_message_id? |

- 所有根、payload、target、registration 字段严格列举，未知字段和未知枚举被拒绝。
- `cancel.reason` 取 `caller_cancelled` 或 `deadline_exceeded`。
- 网关 `error.source` 只有 `gateway` 或 `transport`，`code` 匹配 `^[a-z][a-z0-9_]{0,63}$`，不含原文。原生 error 与 data 原样保留在 `native_response` 中，不伪装成网关 error。
- `accepted` 不表示远端已执行或消费。`cancel` 不等于回滚。

## 身份、Target 与绑定

`V2Target` 有两种形态：

- `{machine_id, provider_id, profile: "session", session}`
- `{machine_id, provider_id, profile: "host"}`

`ProviderBinding` 为 `{machine_id, provider_id, kind: "luvus" | "herdr", config_ref, binding_revision, enabled}`。

- `Target` 不含 `kind` 或 `expected_binding_revision`。`session` 必须显式给出且非空，不继承 shell、current 或 default。
- `provider_id` 只在所属 machine 内解析，稳定且不可复用。`binding_revision` 是正的安全整数，单调且不可复用。配置或启用状态变化必须分配新的 revision。revision 的分配与不可复用由可信 registry 的事务保证，codec 不能从单个快照证明。
- `config_ref` 是受信本地配置的 opaque 引用。codec 不读取该路径或 URI，也不接受调用方替换本机 endpoint。
- 解析 provider 时必须返回与 machine、provider 精确匹配的可信 binding。先检查 `enabled`，再检查 `kind` 与 revision。消息中的 `kind` 只用于核对，实际取值来自可信 binding。
- 禁用的 provider 阻断自己的派发、内容读取辅助判断与迟到补证，不撤销设备身份，也不影响其它 provider。重新启用得到的新 revision 不能沿用旧 attempt。
- Herdr 的 host profile 在派发前报 `unsupported_profile`。Herdr 只接纳固定的评审来源，其它来源报 `provider_support_candidate`。

## ContractSource 与 contract_ref

`ContractSource` 描述一份安装契约的来源：

| 字段 | 取值 |
|---|---|
| `provider_kind` | `luvus` 或 `herdr` |
| `protocol_family` | `uhp` 或 `herdr-json` |
| `binary_version`、`binary_sha256`、`schema_sha256` | 安装程序与 schema 的版本和摘要 |
| `schema_origin` | 固定 `installed_cli` |
| `schema_command` | `luvus uhp schema` 或 `herdr api schema --json` |
| `server_version`、`native_protocol_version`、`runtime_generation` | 未观察到时为 null，不合成 |
| `adapter_revision`、`classification_revision` | Rovloom 适配与方法分类的版本。`classification_revision` 可为 null |
| `support_basis` | `live_catalog` 或 `schema_and_version` |

`contract_ref = SHA256(boundedJson(ContractSource))`，编码为 64 位小写 hex。它是内容摘要，不是签名、认证、执行许可或 native request id。任何来源值变化都会改变 `contract_ref`。

- 必填来源缺失、未知的 `schema_origin` 或命令、`kind` / 协议族 / 命令不一致，一律拒绝。网页上的 schema 不能代替 `installed_cli`。
- Wire 只按 ref 查可信的 `ContractRecord {source, support_status: "candidate" | "validated"}`，并重新计算摘要核对。消息自带的 `ContractSource` 不能自证来源。`candidate` 状态永远不派发。
- 可执行的 Luvus 契约还要求 `validated` 状态、`live_catalog` 和非空的 `classification_revision`。方法与子动作的多轴门禁由原生模块判定。
- 原生缓存与 handle 必须另外绑定完整的 provider / profile / session / attempt，不能只按 schema hash 或 ref 在 provider 之间共享执行身份。

## Attempt 与 request

每次派发有一个 attempt，所有 attempt 帧都带完整的 `attempt` 对象：

| 字段 | 说明 |
|---|---|
| `call_id`、`attempt_id` | Gateway ID |
| `native_request_id` | 原生 request ID，由 Gateway 注入 |
| `target`、`provider_kind`、`binding_revision` | 完整目标与 provider 绑定 |
| `contract_ref` | 见上节 |
| `registration.deadline` | 正安全整数，绝对毫秒。codec 不读取设备时钟 |
| 旧 `registration.*_policy_revision` | 只兼容解码旧帧，不校验、不在新登记中生成 |

- `request.payload.expected_binding_revision` 是独立的调用字段，必须与 `attempt.binding_revision` 和可信的当前 binding 一致。
- 每个 attempt 帧（包括 `request`）都要经独立的 `resolveAttempt` 取回登记的锚点，核对 machine、provider、revision、kind、profile / session、`recovery_generation`、epoch、call / attempt / native ID、`contract_ref` 与 registration。不能用 payload 自己构造预期锚点。不能换目标、契约、范围或登记条件，也不能用新 revision 接纳旧执行。
- 新派发核对当前来源、完整 binding、契约、期限与参数，不核对 caller/local 策略 revision。结果提交后按 token 设备范围与原主体归属读取。
- 实际写出前，宿主原子地核对 deadline 与预算，并提交 `dispatching` 锚点。
- `native_request` 只含 `method` 与 `params`，调用方提交的 `id` 或 `auth` 被拒绝。`validation` 取 `strict` 或 `raw-contract`，必须与登记时的模式一致。

示例（结构与 [测试示例](../../test/wire/v2-examples.json) 一致，该文件另含 accepted、response、cancel）：

```json
{
  "protocol_major": 2,
  "protocol_minor": 0,
  "type": "request",
  "message_id": "example_request",
  "machine_id": "machine_1",
  "recovery_generation": "recovery_1",
  "connection_epoch": "connection_1",
  "payload": {
    "attempt": {
      "call_id": "call_1",
      "attempt_id": "attempt_1",
      "native_request_id": "proxy-ping",
      "target": {
        "machine_id": "machine_1",
        "provider_id": "provider_1",
        "profile": "session",
        "session": "default"
      },
      "provider_kind": "luvus",
      "binding_revision": 1,
      "contract_ref": "aa705145f483bd10592632ee9748978c745f0ff7e73263271fe6e3fae234e973",
      "registration": {
        "deadline": 1000,
        "caller_policy_revision": "caller_policy_1",
        "local_policy_revision": "local_policy_1"
      }
    },
    "expected_binding_revision": 1,
    "native_request": {
      "method": "ping",
      "params": {}
    },
    "validation": "strict"
  }
}
```

## 可选 provider 来源快照

`provider_snapshot` 只在双方协商后使用，不从 `welcome` 或心跳推断。

- 生产 Gateway 按受保护的 machine 名单要求远端快照。本机附着的设备不受其它远端设备能力广告的影响。显式的 required 与设备范围冲突时拒绝，不静默删除 required。
- 当前只支持 Luvus 的 session。`binding`、`target`、`source` 的形状严格校验，并逐项绑定真实设备、`recovery_generation` 与当前 epoch。
- `capabilities` 是同一次原生 result 的完整能力信封。`capability_revision` 是该 result 的规范 JSON 的 SHA-256。
- 消息不携带 schema、compiled / view / permit、PID / uid、路径，也不携带 `authenticated` / `source_verified` 的自报字段。
- 每个 provider 每个 epoch 发送一次，单帧不超过 1 MiB。每个 epoch 至多 64 个 provider，累计 20 MiB。精确重复的快照幂等，不刷新来源或期限。
- 未协商 `provider_fence` 时，同一 provider 的快照内容变化会关闭连接。Connector 的快照来源是固定的深冻结数据，每次发送前仍核实实际 readiness。
- 重连后必须重新认证并独立交付快照，旧调用不重发。

codec 成功只证明消息边界。受保护配置先固定 schema 原字节及版本、hash、revision，Gateway 在本地 Worker 中编译。runtime 再核对规范 binding、完整 Target、能力、当前 SocketChannel 与 Store epoch，成功后才发布 live 来源。schema 不经 Wire 传输，快照不是 provider 注册入口，也不是任意 schema 的信任入口。

## 可选设备平台上报

`device_platform` 只在双方协商后由当前认证的 Connector 发送，并在 `welcome` 之后立即发一次。

- payload 严格只有 `os`（`linux` / `darwin` / `win32`）、`arch`（`x64` / `arm64`）与 `distribution`。
- `distribution` 只在 `os` 为 `linux` 且 `/etc/os-release` 可读时非空，形如 `{id, version_id}`，两者都是受限字符集的原始标识；macOS / Windows 明确为 `null`。codec 拒绝 `linux` 缺发行版或非 Linux 带发行版的不一致形状。
- 该帧不携带路径、环境变量、命令输出、凭据或任何执行许可，也不改变身份、provider 或调用账本。
- 老 Gateway 只广告 minor 0：协商结果不含该能力，Connector 因此不发此帧，握手与业务帧与升级前完全一致。
- Gateway 把它记成该设备"最近一次上报"的平台，离线后保留旧值，管理面标注为历史观测。

## 可选终端开关观察

`terminal_execution_state` 只在双方协商后由当前认证的 Connector 发送。

- payload 严格只有完整 `ProviderBinding` 与布尔 `enabled`，不接受原生请求、schema、环境、执行许可或凭据。每个 epoch 至多 64 个 provider。
- Connector 首次报告和值变化时发送，不变的值去重。
- Gateway 只把当前 epoch 与 binding 的值用于目录过滤。未知状态、断连、来源撤回、配置变化后，不沿用旧值。迟到的报告不能复活已失效的 provider。
- 它不修改原生 capabilities，不授予派发许可，也不代替 Connector 在写入前的最终检查。未协商时连接照常工作，直接终端方法按未知状态隐藏。

## 可选逐 provider 来源撤回

`provider_fence` 在双方协商后启用普通 RPC 的逐 provider 隔离。

- `provider_fenced` 只携带原 `ProviderBinding`，仍逐项验证方向、设备、`recovery_generation` 与当前 epoch，并由 session 的同步 `fenceProvider(binding)` 再核对受保护配置。消息只收紧来源，不注册 provider、不替换 revision、不导入 native context，也不创建 permit。没有同步端口的宿主不能协商此能力。
- 原安装来源、readiness 或固定快照失效时，两端永久撤回本 epoch 内该 provider，释放它的 adapter、快照 pin、接纳证明和结果读取上下文。
- 已锚定但还没有确定响应的在途调用，通过 Store 的停止事务收敛为 `outcome_unknown`。不伪称未派发，不自动取消原生工作，不重试。
- 其它 provider 保留连接、epoch、请求和结果门禁。设备认证、心跳和整体资源预算仍属于原通道。
- 撤回后，底层服务恢复不会复活旧来源。只有显式配置并重新认证后，才在新 epoch 建立独立来源。旧的 unknown 不迁移，不重放。
- 已撤回来源的迟到普通 RPC 和快照，在原业务 decoder 拒绝之后可以直接丢弃。丢弃前仍核验当前认证信封、固定的外层形状和原 binding / revision，只返回丢弃结论，不解码原生正文，不重建 attempt 或 permit，也不生成响应。已协商 `dispatch_refusal` 时，迟到的 `dispatch_refused` 同样只丢弃，不会把 `outcome_unknown` 倒退为 `not_dispatched`。
- 错误的 epoch、其它来源或不在白名单内的消息仍按原协议拒绝。该能力不隔离原生事件或终端流。

## Connector 本机去重

Connector 持久发送墓碑的当前格式见 [ADR 0008](../adr/0008-compact-connector-claims.md)：32 字节摘要不改变 Wire 完整绑定、唯一派发或 deadline 校验。

Gateway 在 Store 的派发事务提交（持久 `dispatching`）之后才发送 `request`。同一个 call 只有一次派发机会，断线后的变更调用保持 `outcome_unknown`，不自动重发。

Connector 不依赖 Gateway 额外交付的 TTL 或上下文。受保护配置限制执行窗口最多 10 分钟，防重记录固定保留至原意图的执行 deadline（证明与信任边界见 [ADR 0005](../adr/0005-connector-claim-lifetime.md)）：

- 在内存的 attempt book 中记录 `call_id:attempt_id`、请求摘要和首次固定的期限。
- 用持久 claim 阻止同一 attempt 在任何 epoch、重启之后再次写入原生。

规则：

- 相同 call / attempt 的精确重复请求是幂等的，不刷新期限。请求摘要或绑定有任何变化，都按冲突拒绝。
- 准入层拒绝只在 attempt 未进入执行时生成：已执行中（running）或已观察（seen）的 attempt 重发时，Connector 静默丢弃重复帧，不另发拒绝证明；账本状态由原执行路径收敛。
- 请求到达时核对认证连接、完整 attempt、provider 与契约、deadline。主体来自 Connector 受保护的完整 Target 路由，不采信消息自报。
- claim 与 attempt book 跨 epoch 共享。断连只释放该 epoch 的请求正文，不提前清除墓碑、不续期、不重放。deadline 到达后回收防重记录；原完整意图仍被期限检查拒绝。回收与持久时钟推进在同一事务完成，时钟回退不允许再次 claim。
- 执行许可仍由 Wire 来源/binding 与 provider 自己的原生校验器建立。

## dispatch_refused

`dispatch_refused` 只在双方协商 `dispatch_refusal` 后由 Connector 发送，须经当前认证连接和独立登记的完整 attempt 校验。旧版准入层的 revision 拒绝仅为兼容输入，Connector 编码拒绝帧只绑定当前认证连接与 attempt 结构，锚点、策略与 revision 的全量复核由 Gateway 接收端在其自身账本完成；执行器拒绝仍经原 adapter 完整校验。

- `code` 只允许 `terminal_execution_disabled`，不承载原生响应、异常正文或任意字符串。
- 拒绝证明仅由本机 adapter 的终端最终开关生成 `not_dispatched`；`accepted` 之后仍可确证未写出。普通异常、原生 error、超时和 `outcome_unknown` 都不能生成此证明。
- Gateway 先在账本事务中核对原 tuple、当前 provider 与 epoch、固定 deadline，提交拒绝和必要审计，之后才清理该 call 的在途与读取上下文。
- 只有尚未到期的 `dispatching` / `connector_accepted` 可变为 `not_dispatched`（执行器可能在 accepted 后、原生写入前才复核终端开关并报告真实未写出）。重放帧的防御在 Connector 的 running/seen 守卫：已进入执行的 attempt 重发不生成拒绝证明。已 unknown、已响应或已拒绝的状态保持不变，不续期，不重派。合法的拒绝不关闭连接，不取消其它在途调用。
- 未协商、认证或锚点错误、存储提交失败都保守拒绝，不发布虚假终态。
- Store 须提供 `commitDispatchRefusal(binding, code)`，否则 Gateway 不广告该能力。若配置要求此能力，则以 `dispatch_refusal_backend_unavailable` 拒绝启动。该事务只在真正提交 `not_dispatched` 时返回 true。对 unknown、responded 或已拒绝的状态返回 false，此时 Gateway 不释放上下文，response 之后到达的拒绝不会驱逐仍有效的结果读取许可。

## 可信 context 与原生校验

已认证 context（`AuthenticatedContext`）由宿主提供：当前连接事实 `connection`、`resolveProvider`、`resolveContract`、按 provider kind 选择的 `validators`（`NativePayloadValidator`）和 `resolveAttempt`。缺任何一个必要来源都默认拒绝。`authenticated` / `active` 是外部事实输入，不由 epoch 或 `welcome` 自报产生。codec 不实现 TLS、凭据认证、签发或撤销。

校验流程：

1. Wire 先拒绝 `native_request` 中调用方的 `id` / `auth`，再用 `resolveAttempt` 从受信账本取回该 attempt 登记的 `method` 与 `mode`，核对完整 binding，并核对当前 provider 绑定（启用、kind、revision）与契约（`resolveContract` 的来源和 `validated` 状态），以及协商的 `rpc` 能力。消息里的 `method`、`expected_binding_revision` 与 `validation` 必须与登记一致。
2. 把可信的 `native_request_id` 补入原生请求，交给 validator。validator 按可信 `ProviderBinding.kind` 选择，不用消息自报的字段。
3. `raw-contract` 在原生薄适配中映射为原生的 `raw_contract`。原生检查失败转为只含 code 的 `WireError`。异常的 message 与原始 data 被清除，只保留合法 code 或通用的 `native_*` 错误。成功的校验必须实际返回 undefined。
4. `response` 同样先由 `resolveAttempt` 取回登记上下文，再以该上下文（binding、method、mode）调用 `validateResponse`。响应里的 attempt 必须与登记的完整 binding 逐项相同，调用身份不能从响应内容重建。

`validateRequest` / `validateResponse` 校验后端暴露方法、原生参数、实际来源和完整 binding。`strict` 对 generic / unavailable 分别报参数契约不完整或不可用；`raw-contract` 只标记原生参数 schema 覆盖程度，不是额外授权，也不产生 raw grant。

`createLuvusWireAdapter` 实现 Luvus 的 Check / permit 适配：它的 `NativeWireBackend` 提供已认证连接（`connection()`）、Gateway 登记的 provider 与 Connector 本机 provider（`provider` / `localProvider`）、契约记录（`contract`）和独立核验的原生来源（`nativeSource(callId, attemptId)`）；适配器私有保存最初的 `DispatchPermit`，并逐次重新授权结果读取。精确签名见 [原生契约](NATIVE-CONTRACT.md)。

## Provider scope 权限

Herdr、Luvus 与混合模式采用相同权限模型：Gateway 核对 token 的设备范围，Connector 核对直接终端执行开关。没有 ProviderPolicy、caller/local grants、methods/actions 或策略修订比对。

响应按完整原尝试关联并在入库时核验来源与结构。保存原文只服从内容状态、固定期限和唯一 Store 预算；已撤销 token 不能读取，旧执行无需重发。provider 禁用、撤销和 binding 漂移属于实例生命周期校验。

## 登记与迟到响应

| 接口 | 宿主必须保证的输入与原子后续 |
|---|---|
| `registeredRequestDigest(payload, callerId)` | 来自已认证的调用方。摘要绑定完整 Target、provider、revision、kind、契约、登记条件、validation 和 native request，不含新分配的 call / attempt / native ID |
| `resolveAttempt` | 返回原完整 AttemptBinding、method 与 mode。不从消息补建 |
| `resolveProvider` / `resolveContract` | 当前可信的 provider 绑定（启用、kind、revision）与已核验的契约来源；禁用、撤销与 binding 漂移在这里被拒绝 |
| `planResponseEvidence(frame, context, anchor, now)` | 持久的派发锚点、固定的内容与墓碑期限、内容状态。事务成功后才发布状态 |

- `registeredRequestDigest` 是已登记意图的规范摘要，不是自动迁移或重签旧 key 的授权。重试必须继续使用原 `client_request_key` 和原登记数据，不能因发现新的 provider revision 或契约而重算、重派。同一主体在窗口内，同 key 同摘要只返回原 call，摘要不同报 conflict。key 只由 Gateway Store 处理，不进入 Wire。
- 迟到响应必须仍在有效认证的连接上，当前 provider 启用，revision、contract 与全部 attempt 精确匹配，完整原生响应通过该 kind 的 validator 校验（Luvus 适配器用封存的响应上下文和独立核验的原生来源复核）。对 `outcome_unknown` 的补证需要 `late_evidence` 能力。缺锚点、旧 attempt、墓碑已删、冲突、旧 revision 一律拒绝，不创建执行。
- 证据计划恒为 `dispatch: false`。原超时、取消的历史与 TTL 不变。相同 hash 与长度的重复响应不产生 payload 或句柄的写入意图。
- 内容已过期、被丢弃、不可用，或当前分类、内容权限、read scope 不允许时，只保留元数据：ID、接收时间、hash、长度、result / error 类别。不恢复原文，不生成句柄，不续期。
- `ResponseEvidencePlan` 没有持久化副作用。宿主必须在同一个 writer 事务中再次核对原锚点、证据 hash 与长度、固定期限和当前状态后提交。事务失败时保持 `outcome_unknown`，不发布 `responded`，也不制造重派。
- 原生较低的帧预算同样适用于仅元数据的补证。原文不保留不代表可以跳过响应校验。
- 持久化、固定期限、预算和备份恢复由宿主负责。

## 资源与顺序

| 边界 | 规则 |
|---|---|
| 单条消息 | 1 MiB UTF-8 JSON。非法 UTF-8、非法 JSON、BOM、孤立 surrogate 被拒绝 |
| JSON | 深度 0..64，至多 100,000 个 value 节点。编码时拒绝循环引用、getter、toJSON 类对象、symbol 和稀疏数组 |
| 标识 | 网关 ID `[A-Za-z0-9_-]{1,128}`，原生 request ID `[A-Za-z0-9._:-]{1,128}`，摘要为 64 位小写 hex |
| 响应 | 必须放入单条消息。超限不分片，写出失败，调用保持 unknown。不扩大原生广告的更低限额 |
| MessageWindow | 默认 4096 条已验证的逻辑消息、固定 60 秒。相同 ID 与内容为 duplicate，ID 相同内容不同则拒绝，窗口满则拒绝 |

`MessageWindow` 只是连接内的内存窗口。窗口之外、重启之后的执行幂等性依赖宿主的持久化，窗口过期不是新的派发许可。

原生契约的编译预算见 [原生契约](NATIVE-CONTRACT.md#契约与内存许可)，编译边界见 [编译 Worker 与生成物接纳](NATIVE-CONTRACT.md#编译-worker-与生成物接纳)。构建与验证命令见 [开发指引](../DEVELOPMENT.md)。

## 主机握手报告

`host_profile` 是连接级消息，必须经双方 minor ≥ 2 能力协商，在 welcome 后由 Connector 发送一次。Gateway 按认证机器、当前恢复代次与 epoch 关联，不接受 payload 自报身份、时间或来源。旧 Gateway 不协商，因此新 Connector 不发送；旧 Connector 也不因缺报而失败。组合会话不得将它路由给某个 provider。

只允许 OS family / 发行版 / 内核、架构、CPU、内存、容器类别、Connector 版本和 provider 版本摘要；未知数值为 null。字段精确列举、字符串和 provider 数量有界，禁止网络、环境、路径及任意扩展字段。Gateway 在接收后添加固定 source 和 reported_at，仅用于 machines_get 的设备属性，不形成原生契约或执行、读取许可。MCP 详情只向 token 范围内设备公开其 provider 摘要。

该报告和有效收包时间在当前 Gateway 进程内有界保留，读取不续期；断开后 link_since 为 null，重启或恢复代次变更后未知。详细字段与边界见[设备详情](../PROTOCOL.md#设备详情与原生版本)。

新配对与登记不保存 methods/actions 或 caller/local/gateway 策略；旧字段只在兼容解码边界接纳并忽略。

`host_cpu_quota` 只扩展当前 host 报告，不产生新消息。未协商时 Connector 必须同时剥离 `cpu_quota` 与 `cpu_quota_status`，Gateway 拒绝未经协商携带它的帧；因此旧 Gateway 不会因未知字段断连。两个字段须同时存在，状态为 limited / unlimited / unknown / partial / unsupported。unsupported 仅用于非 Linux，表示不支持此探测；unknown 表示无法核实。limited/partial 要求正的有限小数核；unknown/unlimited/unsupported 要求 null。unlimited 仅用于 Linux。只有 unlimited 表示完整可见层级未限额；partial 说明已知有限上界但链未走完，null 不可自行解读为无限。只从当前进程可见 cgroup CPU 带宽上限取得，取可见祖先的最小值，不代表实际可用并行度。
