# Gateway 与 Connector 通道

Connector 主动出站连接 Gateway，Gateway 不连接设备。通道上的帧使用 [Wire v2](protocol/WIRE-PROTOCOL.md)。系统语义见 [DESIGN](DESIGN.md)，调用账本见 [存储与数据保留](STORAGE.md)。

## 连接

- Gateway 在 `devices.hostname:devices.port` 监听 WebSocket `/connector`。Connector 连接配置中的 `gateway.url`，地址格式见 [配置参考](CONFIGURATION-zh.md)。
- 本机或可信网络直接使用 `ws://`。公网应由外部 HTTPS/WSS 反向代理终止 TLS。Rovloom 不创建证书，不安装系统信任，也不配置反向代理。
- Connector 连接 `wss://` 时使用系统信任库并校验主机名，不支持自定义 CA 或跳过校验。
- 设备 listener 只接受 GET `/connector`，拒绝带浏览器 `Origin` 头的请求。
- 设备自报的名称、实例 ID 或 welcome 内容不能建立身份。身份只来自设备凭据，见 [存储与数据保留](STORAGE.md#设备凭据)。

连接依次经过三个状态：已连接、已认证、provider ready。设备认证成功后才分配连接 epoch。provider ready 要求 Gateway 和 Connector 两端的绑定、启停状态、策略修订和本机健康一致。一个 provider 未就绪不影响同一设备上的其他 provider。

## 配对与凭据

- 配对码由 Gateway 终端签发，Connector 在真实终端输入兑换。兑换后设备凭据只交给 Connector 的受保护存储，不出现在 welcome 帧、日志或普通响应中。
- 凭据交付失败或结果未知时，Gateway 清除该凭据，设备回到待配对状态，需要重新配对。交付不会自动重试。
- 撤销或重新配对后，该设备的所有旧连接立即关闭。
- 步骤与命令见 [运维指南](OPERATIONS.md#4-凭据)。

## 限额与超时

| 项 | 默认 |
|---|---|
| Gateway 同时连接 | 64，其中未认证 8 |
| 认证次数 | 每分钟 120 |
| 每连接消息 | 每秒 256 条 |
| Gateway 全局在途请求 | 128 |
| Connector 同时原生执行 | 8 |
| 单帧与单个原生 JSON | 1 MiB |
| 握手超时 | 5 秒 |
| 心跳间隔 | 5 秒 |
| 无有效心跳关闭 | 20 秒 |
| Connector 单个 epoch 记录的 attempt | 4096 |

- 发送不排队。单帧超限或背压时直接关闭连接。
- 接收去重窗口满时拒绝新帧，不提前淘汰有效记录。Connector 的 attempt 记录达到 4096 时关闭连接并重连。
- 响应必须放入单个帧。超过 1 MiB 的响应不分片，Connector 写出失败，Gateway 保持 `outcome_unknown`。

## 断线与重连

- Connector 断线后按指数退避重连，间隔从 250 毫秒起，上限 30 秒，带随机抖动。重连使用稳定的设备 ID 和新的 epoch。
- 重连不会迁入或重放任何旧请求。断线时旧 epoch 上未完成的调用由 Gateway 记为 `outcome_unknown`。
- 旧 epoch 的响应、过期的 provider 绑定或策略修订的响应一律拒绝。
- Connector 的断开诊断是独立一行 `connector_disconnect code=<4位关闭码> close_reason=<固定原因词>`；本机原因没有对端关闭码时只输出 `connector_disconnect close_reason=<原因>`。
  - `transport_closed`：对端（Gateway）主动关闭。
  - `transport_abnormal`：未收到关闭帧，例如 TCP 被掐或连接被强制终止；此时通常同时给出 `code=1006`。
  - `transport_unclassified`：收到了关闭码，但原因不在固定白名单内。
  - `handshake_timeout`、`transport_idle`、`connector_failure`、`transport_unavailable`、`connector_disconnected`、`connector_stopped`：Connector 本机收敛的原因，不带对端关闭码。
- 断开诊断按累计断开次数补报，与相位采样相位解耦：CLI 每 250 毫秒采样一次，只要本次采样的断开次数比上次大，就从有界队列里按时间从旧到新逐条补打。同一个采样窗口内发生多次断开（例如先收到 `1008 transport_closed`，重连又被拒收到 `1006`）时每条都会打印，不会只留最后一条。首次采样只记录基线，进程启动前已有的历史断连不打印。
- 断开队列上限 16 条，超出丢最老的；累计次数仍完整记录。若两次采样之间的断开数超过队列长度，只补报队列里实际保留的条目，不虚构事件。
- 相位行 `connector_transport <phase> provider_ready=<bool>` 只描述当前相位，不再附带关闭码；快速重连时可能出现“`ready` 行 + 一条 `connector_disconnect` 行”，两者不矛盾。
- 远端关闭晚于本机收敛时（例如先收到底层网络错误、随后才收到 `1006` 关闭帧），只把最近一次断开的定性纠正为实际观察值，不重复计数；新 epoch 建立之后到达的旧 socket 事件一律忽略，不会覆盖当前观测。
- 断开观测只输出白名单原因和数值关闭码。对端给出的任意关闭正文、凭据和路径一律不进入日志；越界或未知值整条丢弃。

## 派发

- Gateway 在派发记录持久化之后才发送 `request`。请求发送前失败的调用为 `not_dispatched`，发送后结果未知的为 `outcome_unknown`。
- 每个调用只有一次 attempt。重复的 `client_request_key` 只返回原调用，不会再次发送，也不会延长期限。
- Connector 收到请求后、执行前，记录 `call_id:attempt_id` 和请求摘要，并在本机持久化。同一完整 attempt 在任何 epoch 或正常重启后都不会再次写入原生。记录保留至原执行 deadline（最多 10 分钟）；到期后请求始终被期限检查拒绝。回收与持久时钟高水位原子提交，拒绝回拨。Gateway 的 30 天调用 key 去重窗口不变。详见 [Wire 协议](protocol/WIRE-PROTOCOL.md#connector-本机去重)。
- Connector 检查方向、完整绑定、当前双端权限、期限和并发额度，通过后才执行。`accepted` 只表示已接受，不表示原生完成。
- 原生请求中的认证信息由 Connector 在本机注入，Gateway 不接触。

## 取消

取消先在 Gateway 持久记录停止，再向原连接发送取消帧。

- 未派发的调用变为 `not_dispatched`。可能已送达的调用保持 `outcome_unknown`。
- 取消帧只中止 Connector 上对应 attempt 的等待。它不是原生回滚，原生动作可能继续。
- 取消帧最多发送一次，不排队。连接已断开或发送失败时不重发。
- 双方协商了 `late_evidence` 时，取消后到达的同 attempt 响应仍可补记，但不改变已取消的历史、原期限和保留期。

## 响应与结果读取

- Gateway 在提交响应事务之后才将调用标为 `responded`。提交失败不会报告成功。
- 响应原文只通过结果读取返回。每次读取都重新检查调用方归属、双端权限、内容期限和原请求，不使用缓存的授权。
- 调用完成后，Gateway 最多保留 128 个调用的读取上下文。满额时拒绝新的派发，不淘汰仍有效的上下文。
- 设备撤销、连接关闭、内容到期或被丢弃后，结果不能再读取。

## 单个 provider 失效

Gateway 与 Connector 协商 `provider_fence` 后，单个 provider 的来源失效时，只撤回该 provider：

- 关闭该 provider 的 adapter 和读取上下文，通知对端撤回同一绑定。
- 该 provider 上未确定完成的调用记为 `outcome_unknown`。
- 同一设备上健康的 provider、连接和 epoch 保持不变。

撤回在本 epoch 内不可逆。底层恢复后需要重新连接才能建立新的来源，旧调用、结果句柄和 unknown 调用不会迁移。协议细节见 [Wire 协议](protocol/WIRE-PROTOCOL.md#可选逐-provider-来源撤回)。

## 终端执行开关观察

Connector 通过 `terminal_execution_state` 向 Gateway 报告本机 `allow_terminal_execution` 的当前布尔值。Gateway 据此隐藏直接终端写入方法。该值只影响方法目录，不是执行许可，Connector 在实际写入前仍检查本机开关。未报告、断连或来源失效时状态为 unknown，按关闭处理。详见 [终端执行](TERMINAL-EXECUTION.md)。

## 传输观测

管理页显示的连接状态来自 Gateway 对实际 WebSocket 的只读观测：

- 连接和认证只在有证据时显示为在线和已认证。没有证据的显示为未核实，不从持久化的 `online` 状态推断。
- 最近心跳是 Gateway 收到合法心跳的本机时间，不使用客户端自报的时间。
- 每个 provider 的 `dispatch_ready` 只说明 Gateway 的派发门禁已满足，不表示原生 runtime 可达。
- Gateway 正常关闭后设备条目消失，消费者应将缺项视为未知。
- 存储降级或时钟异常时，观测读取失败，不沿用旧结果。

页面见 [管理页](GATEWAY-WEBUI.md)。
