// CLI 中英文词典与语言解析；只翻译固定文案，稳定错误/状态码、退出码与协议内容不随语言变化。
export type CliLanguage = 'en' | 'zh-CN'

// 显式 ROVLOOM_LANG 是唯一语言开关（zh 前缀选中文）；未设置时固定英文，不随系统 locale 变化。
// 语言只是显示偏好：无法识别的取值静默回退英文，不产生新的失败路径。
function prefersChinese(tag: string): boolean {
  return tag.split('.')[0]!.toLowerCase().replace(/_/gu, '-').startsWith('zh')
}

export function resolveCliLanguage(env: Readonly<Record<string, string | undefined>>): CliLanguage {
  const explicit = env.ROVLOOM_LANG?.trim()
  if (explicit) {
    return prefersChinese(explicit) ? 'zh-CN' : 'en'
  }
  return 'en'
}

export const english = Object.freeze({
  'help.main': `Rovloom {version}

Usage:
  rovloom --help
  rovloom --version
  rovloom config template gateway|connector
  rovloom config init connector [--provider luvus|herdr|mixed] [--config /absolute/path/config.json]
  rovloom config init gateway [--container] [--config /absolute/path/config.json]
  rovloom config check [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom config check-runtime [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom gateway [--add-device | --repair-device] [--config /absolute/path/config.json] [--non-interactive]
  rovloom connector [--repair | --claim] [--config /absolute/path/config.json] [--non-interactive]
  rovloom service --help
  rovloom token --help
  rovloom doctor --help
  rovloom storage --help
  rovloom admin --help

gateway / connector starts the matching role. The first run completes one-time pairing and native installation approval in a real local terminal;
declining the pairing prompt keeps the Gateway running unpaired, so rovloom admin create can be run first and first pairing completed from the management page;
--add-device pairs one more Connector on top of a completed setup (same MCP credential; authorization grows to the new device);
--repair-device / --repair re-pairs the same already-paired device (lost or leaked credentials), keeping native setup and MCP authorization.
--claim lets an unpaired Connector claim an administrator-created pairing application from a running Gateway online (management-page code approval; the Gateway keeps running).
These four options need a real local terminal and cannot be combined with --non-interactive. --non-interactive disables the local interactive setup (services run this way).
token manages MCP Bearer tokens, admin manages management-page administrators, and service manages boot services; see each --help.
config check validates the configuration file read-only; check-runtime additionally verifies program-managed state without reading credentials.

Without --config, ~/.config/rovloom/gateway.json or connector.json is used (Windows also uses the user home).
A missing file is created with defaults on the first run; an existing file is never overwritten or reset.
Gateway supports Linux/macOS/Windows; Connector supports Linux x64, Windows x64 and macOS (x64 / arm64, attaching only already-running Herdr / Luvus).
First-run setup selects luvus (default), herdr or mixed via the Connector's native.provider.
Agent and model logins must be prepared separately; a ready native installation does not mean a model has replied.
Exit codes: 0 success/clean shutdown, 2 argument or configuration error, 3 backend unavailable, 1 runtime or shutdown failure.
`,
  'help.admin': `Usage:
  rovloom admin list [--config /absolute/path/gateway.json]
  rovloom admin create [--principal ID] [--ttl-days N] [--config /absolute/path/gateway.json]
  rovloom admin revoke [--principal ID] [--config /absolute/path/gateway.json]

The management page (default http://127.0.0.1:9445/) signs in with HTTP Basic: the user name is the administrator ID (default admin) and the password is the secret printed by create.
The password is written to stdout once, only by create (the Gateway stores only a SHA-256 digest); everything else goes to stderr. If the password is lost, run create again:
an administrator with the same name is re-issued, and the old password plus signed-in browser sessions stop working immediately. revoke removes an administrator with the same immediate effect. Changes apply without restarting the Gateway.
Administrators cannot call MCP and share nothing with MCP tokens or device credentials; the default validity is {ttlDays} days (1-365).
Can be created before the first pairing: a fresh Gateway initializes an empty MCP caller registry on its own, after which the management page
pairs the first Connector online (create a pairing application, then run rovloom connector --claim on the device).
`,
  'help.token': `Usage:
  rovloom token list [--config /absolute/path/gateway.json]
  rovloom token create --principal ID --like EXISTING_ID [--ttl-days N]
  rovloom token renew --principal ID [--ttl-days N]
  rovloom token rotate --principal ID [--ttl-days N] [--grace-minutes M]
  rovloom token revoke --principal ID
  rovloom token permissions --principal ID --discard-response true|false

The token registry lives in the Gateway state directory; the Gateway re-reads it on every authentication, so changes apply immediately without a restart.
create/rotate write the new token value to stdout once (new tokens are kept in the private registry and can be viewed again in the Dashboard); everything else goes to stderr.
create clones the new principal's permissions from the existing principal named by --like, without widening them. renew extends the expiry; the token stays the same.
rotate issues a new token; the old one keeps working within --grace-minutes (default 0, immediate invalidation). revoke removes the principal.
permissions manages the explicit result-discard permission, hot-reloaded and off by default. Read and save anything you need before discarding results.
ttl defaults to 30 days (1-365).
`,
  'help.storage': `Usage:
  rovloom doctor --role gateway|connector [--config /absolute/config.json] [--json]
  rovloom storage check --role gateway [--config /absolute/config.json] [--json]
  rovloom storage backup --role gateway --output /path/to/gateway.backups/snapshot.db [--config /absolute/config.json] [--json]
  rovloom storage resume --role gateway [--config /absolute/config.json] [--json]

Gateway commands require the service to be stopped first; they share the same write lock and refuse active or undeterminable holders.
check is read-only; backup only uses the plain <state>.backups directory next to the real state directory and exports a redacted snapshot (no raw text or valid credentials); full state needs a separate offline backup.
resume is an explicit degradation release approved by the local operator and still refuses when integrity, clock or budget checks fail.
Connector doctor only checks the configuration and managed state; it starts no native runtime and claims no native readiness.
`,
  'help.service': `service install --role gateway|connector [--executable ABS] [--config ABS] --workdir ABS --user ACCOUNT
service uninstall|start|restart|stop --role gateway|connector
install registers boot startup without starting; uninstall only revokes future boot startup and preserves running instances and their control records.
Omitted --executable uses the current standalone binary; a different binary is rejected.
Omitted --config uses the same current-user role file as foreground startup. Installation fixes its absolute path; background startup does not select another home.
Linux uses systemd system units; macOS uses system LaunchDaemons; Windows uses boot-triggered tasks, not SCM services or login tasks.
Gateway services support Linux systemd, macOS system LaunchDaemons and Windows boot-triggered tasks; the local native Connector service supports Linux x64, Windows x64 and macOS (x64 / arm64).
Windows uses the explicitly selected existing user with S4U, without storing a password or requiring login. It does not provide an interactive desktop or Windows network credentials/EFS access. Running services receive a local shutdown request; queued/start-racing tasks return service_busy without forced termination; uninstall never stops it.
`,
  'guard.bunUnsupported': 'Rovloom requires Bun {minimum} or newer (https://bun.sh); this runtime is not supported.\n',
  'run.wildcardListenWarning':
    'wildcard_listener\nMCP/management listen on all interfaces over plain HTTP; protect them with a firewall or a TLS reverse proxy.\n',
  'run.pairingRequiredHint': 'Gateway is running; complete local pairing and native setup before using an Agent.\n',
  'run.configurationRequiredHint':
    'Setup requires a local terminal, a reachable Gateway, completed pairing and a compatible installed Luvus. Preserve uncertain setup state for owner review.\n',
  'setup.gatewayAddressPrompt': 'Gateway address (ws://host:port or wss://host): ',
  'setup.connector.pairingCodePrompt': 'One-time pairing code: ',
  'setup.connector.trustGateway':
    'Trust this Gateway address for one-time device enrollment and reviewed native setup?',
  'setup.connector.pairingCompleted':
    'pairing_completed: Device identity is durably paired; discovering the selected native installation next.\n',
  'setup.connector.nativeSetupResponseUnavailable':
    'Native setup response unavailable; retain the original setup and rerun Connector to check it.\n',
  'setup.connector.nativeStatePrepared':
    'Native state prepared; starting the real Connector. Watch Gateway for connector_ready.\n',
  'setup.native.managedUnsupportedWindows':
    '{provider}_managed_unsupported_on_windows: set native.{configKey}.mode to "attach".\n',
  'setup.native.managedUnsupportedMacos':
    '{provider}_managed_unsupported_on_macos: set native.{configKey}.mode to "attach".\n',
  'setup.native.statePathTooLongLuvus':
    'native_state_path_too_long: choose a shorter data.directory before initialization (Luvus state path maximum 52 UTF-8 bytes).\n',
  'setup.native.statePathTooLongHerdr':
    'native_state_path_too_long: choose a shorter data.directory for the private Herdr sockets (herdr.sock and herdr-client.sock).\n',
  'setup.prompt.connectorNativeAttachEnabled':
    'Attach to your running {kind} session (or start one in your own config directory if none is running); remote callers will act on your REAL workspaces (terminal execution ENABLED in user config)?',
  'setup.prompt.connectorNativeAttachDisabled':
    'Attach to your running {kind} session (or start one in your own config directory if none is running); remote callers will act on your REAL workspaces (terminal execution disabled)?',
  'setup.prompt.connectorNativeIsolatedEnabled':
    'Discover {kind} and create isolated state (terminal execution ENABLED in user config)?',
  'setup.prompt.connectorNativeIsolatedDisabled':
    'Discover this {kind} installation and create its isolated local state (terminal execution disabled)?',
  'setup.prompt.gatewayNative':
    "Allow this paired device's measured Luvus ({version}, binary SHA-256 {sha}) for reviewed workspace/Agent operations and one local MCP caller? Terminal execution is controlled by the Connector machine owner's local configuration.",
  'setup.prompt.gatewayNativeInstallations':
    "Allow this paired device's measured native installations ({entries}) for reviewed workspace/Agent operations and one local MCP caller? Terminal execution is controlled by the Connector machine owner's local configuration.",
  'setup.repair.alreadyPaired':
    'This Connector is paired as {machine}. Re-pairing replaces only its Gateway credential; native setup is kept. Stop any other running Connector for this device first.\n',
  'setup.repair.codePrompt': 'One-time re-pairing code from rovloom gateway --repair-device: ',
  'setup.repair.trustConfirm': 'Trust this Gateway address and replace this device credential with a new one?',
  'setup.repair.confirmationUnavailable':
    'Gateway confirmation unavailable; if this Connector cannot authenticate, run the re-pairing again.\n',
  'setup.repair.deviceRepaired': 'device_repaired: The device credential is replaced; starting the Connector.\n',
  'setup.gateway.resumeRePairing': 'Resuming the device re-pairing; waiting for the Connector to reconnect.\n',
  'setup.gateway.repairCodeBlock':
    'Gateway MCP: {mcpUrl}\nConnector endpoint: {endpoint}\nOne-time re-pairing code for the existing device (5 minutes; keep private):\n{code}\nStop that Connector, then run rovloom connector --repair on its machine and enter the code. The old credential no longer works.\n',
  'setup.gateway.endpoints': 'Gateway MCP: {mcpUrl}\nConnector endpoint: {endpoint}\n',
  'setup.gateway.unpairedRunning': 'Gateway stays unpaired and running; no enrollment or credential is issued.\n',
  'setup.gateway.managementFirstPairing':
    'Finish first pairing from the management page: create the administrator with `rovloom admin create`, sign in at {page}, create a pairing application, then run `rovloom connector --claim` on the device.\n',
  'setup.gateway.managementDisabled': 'Management is disabled; enable it or rerun to pair from this terminal.\n',
  'setup.gateway.pairingCodeBlock':
    'One-time pairing code (5 minutes; keep private):\n{code}\nRun rovloom connector in another local terminal and enter the Gateway address and code.\n',
  'setup.gateway.resumingExisting': 'Resuming the existing setup; no new enrollment or credential is issued.\n',
  'setup.gateway.connectorReady':
    'connector_ready: The Connector passed real authentication and every selected native provider is ready.\n',
  'setup.gateway.adminBlock':
    '\nManagement page: {page}\nManagement user: admin\nManagement password (private): {secret}\n(Shown once; run rovloom admin create to re-issue.)',
  'setup.gateway.adminNotCreated': '\nManagement administrator was not created; run rovloom admin create.',
  'setup.gateway.nativeSaved':
    'Native configuration saved; Gateway will reopen its real providers.\nMCP credential file: {clientPath}\nMCP URL: {url}\nTargets: {targets}\nBinding revision: 1',
  'setup.gateway.bearerAdditional':
    '\nExisting MCP Bearer now also covers this device (not shown again; tokens made with rovloom token create --like need re-creating).',
  'setup.gateway.bearerSecret': '\nBearer (private): {token}',
  'setup.approval.resumeConfirm': 'Resume the existing device setup?',
  'setup.approval.pairConfirm': 'Pair one Connector with this Gateway?',
  'setup.approval.repairDeviceConfirm':
    'Re-pair the existing Connector device {name} ({machine})? The credential it holds stops working now and in-flight calls become unknown.',
  'setup.claim.pairingCompletedActivated':
    'pairing_completed: Device identity is durably paired and native activation is complete.\n',
  'setup.claim.waitEnded': 'Approval wait ended; rerun the same command to resume this claim.\n',
  'setup.claim.restartConfirm': 'Start a new claim with a new pairing application?',
  'setup.claim.pairingIdPrompt': 'Pairing application ID: ',
  'setup.claim.trustConfirm': 'Trust this Gateway address for online device enrollment?',
  'setup.claim.claimCodeBlock':
    'Claim code: {code}\nApprove this exact code for machine {machine} in the management page.\n',
  'setup.claim.activationResponseUnavailable':
    'Native activation response unavailable; rerun the same command to check the original claim.\n',
  'setup.claim.nativeStatePrepared': 'Native state prepared; starting the real Connector.\n',
  'admin.create.login': 'login at {url} with user "{user}" and the password below (shown once)\n',
  'admin.create.created': 'created administrator {principal} expires {expires}\n',
  'admin.revoked': 'revoked administrator {principal}\n',
  'token.created': 'created {principal} expires {expires}\n',
  'token.renewed': 'renewed {principal} expires {expires}\n',
  'token.rotated': 'rotated {principal} expires {expires}\n',
  'token.permissions': 'permissions {principal} discard_response={discard}\n',
  'token.revoked': 'revoked {principal}\n',
  'mcp.instructions':
    'Tool availability does not imply a ready backend; execution, authorization, confirmation, deduplication and result retention are owned by the trusted service.',
  'mcp.tool.machines_list':
    'List the devices visible to the current caller; paging and counts must pass the current ACL.',
  'mcp.tool.machines_get': 'Read a visible device by stable ID or exact name.',
  'mcp.tool.providers_list':
    'List the configured providers visible to the current caller under a device; local machine configuration is not returned.',
  'mcp.tool.providers_get': 'Read the kind, revision and readiness of an explicit provider.',
  'mcp.tool.runtime_discover':
    'Discover the effective capabilities and sources of an explicit Target/revision; grants no execution permission.',
  'mcp.tool.runtime_describe':
    'Describe the exact methods\u2019 native parameters, categories and limits under an explicit Target/revision.',
  'mcp.tool.runtime_call':
    'Submit one native call for an explicit Target/revision/contract. deadline is an absolute millisecond deadline; wait_ms only controls short waits; no retries or provider management.',
  'mcp.tool.runtime_call_get':
    'Read a call under the current ownership, both-end policies and content gating; a short-wait timeout does not change the execution deadline.',
  'mcp.tool.runtime_call_cancel':
    'Request stopping a wait or bridge; reports only what the service can confirm and promises no native rollback.',
  'mcp.tool.runtime_result_read':
    'Read bounded result pages under the current read authorization and deadlines; the cursor is bound by the service to the caller and the original result.',
  'mcp.tool.runtime_response_discard':
    'After processing, explicitly delete the raw text and handle and release read capacity; ownership, the current original-method policy and the independent discard_response permission must be verified. Reading to EOF does not delete the result.'
})

export type MessageKey = keyof typeof english

// 中文词典与英文键集由类型强制一致；占位符一致性由测试单独核对。
export const chinese: Readonly<Record<MessageKey, string>> = Object.freeze({
  'help.main': `Rovloom {version}

用法：
  rovloom --help
  rovloom --version
  rovloom config template gateway|connector
  rovloom config init connector [--provider luvus|herdr|mixed] [--config /absolute/path/config.json]
  rovloom config init gateway [--container] [--config /absolute/path/config.json]
  rovloom config check [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom config check-runtime [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom gateway [--add-device | --repair-device] [--config /absolute/path/config.json] [--non-interactive]
  rovloom connector [--repair | --claim] [--config /absolute/path/config.json] [--non-interactive]
  rovloom service --help
  rovloom token --help
  rovloom doctor --help
  rovloom storage --help
  rovloom admin --help

gateway / connector 启动对应角色。首次运行时在真实本地终端完成一次性配对与原生安装批准；
在终端拒绝配对提示时，Gateway 保持未配对运行，可先运行 rovloom admin create 再从管理页完成首台配对；
--add-device 在已完成的引导之上再配对一台 Connector（沿用同一 MCP 凭据，授权随之扩大到新设备）；
--repair-device / --repair 重新配对已配对的同一设备（凭据丢失或泄漏），保留原生设置与 MCP 授权。
--claim 让未配对的 Connector 向运行中的 Gateway 在线认领管理员创建的配对申请（管理页核对码批准，Gateway 不停机）。
这四个选项需要真实本地终端，不可与 --non-interactive 合用。--non-interactive 关闭本地交互引导（服务以此运行）。
token 管理 MCP Bearer 令牌，admin 管理管理页管理员，service 管理开机服务；详见各自的 --help。
config check 只读检查配置文件；check-runtime 另核对程序管理的状态，不读取凭据。

省略 --config 时读取 ~/.config/rovloom/gateway.json 或 connector.json（Windows 同样使用用户 home）。
文件缺失时首次运行会生成默认配置，已有文件不会被覆盖或重置。
Gateway 支持 Linux/macOS/Windows；Connector 支持 Linux x64、Windows x64 与 macOS（x64 / arm64，仅附着已运行的 Herdr / Luvus）。
首次引导按 Connector 的 native.provider 选择 luvus（默认）、herdr 或 mixed。
Agent 与模型登录需独立准备；原生 ready 不代表模型已回复。
退出码：0 成功/正常关闭，2 参数或配置错误，3 后端不可用，1 运行或关闭失败。
`,
  'help.admin': `用法：
  rovloom admin list [--config /absolute/path/gateway.json]
  rovloom admin create [--principal ID] [--ttl-days N] [--config /absolute/path/gateway.json]
  rovloom admin revoke [--principal ID] [--config /absolute/path/gateway.json]

管理页（默认 http://127.0.0.1:9445/）用 HTTP Basic 登录：用户名是管理员 ID（默认 admin），密码是 create 输出的口令。
口令原值只在 create 时写到 stdout 一次（Gateway 只保存 SHA-256 摘要）；其余信息写到 stderr。丢失口令就再 create 一次：
同名管理员被重新签发，旧口令与已登录的浏览器会话立即失效。revoke 删除管理员，同样立即生效。修改无需重启 Gateway。
管理员不能调用 MCP，也与 MCP 令牌、设备凭据互不通用；有效期默认 {ttlDays} 天（1-365）。
可在首次配对前创建：全新 Gateway 会自行初始化空的 MCP 调用方注册表，随后即可在管理页
在线配对首台 Connector（新建申请，设备运行 rovloom connector --claim）。
`,
  'help.token': `用法：
  rovloom token list [--config /absolute/path/gateway.json]
  rovloom token create --principal ID --like EXISTING_ID [--ttl-days N]
  rovloom token renew --principal ID [--ttl-days N]
  rovloom token rotate --principal ID [--ttl-days N] [--grace-minutes M]
  rovloom token revoke --principal ID
  rovloom token permissions --principal ID --discard-response true|false

令牌注册表位于 Gateway 状态目录；Gateway 每次认证重读，修改立即生效、无需重启。
create/rotate 把新令牌原值只写到 stdout 一次（新令牌保存在私有注册表，可在管理员面板再次查看）；其余信息写到 stderr。
create 的新主体权限克隆自 --like 指定的现有主体，不扩大权限。renew 延长到期时间、令牌不变。
rotate 签发新令牌；--grace-minutes 内旧令牌继续有效（默认 0，立即失效）。revoke 删除主体。
permissions 显式管理结果删除权限，热生效；默认关闭。删除结果前应先读取并保存所需内容。
ttl 默认 30 天（1-365）。
`,
  'help.storage': `用法：
  rovloom doctor --role gateway|connector [--config /absolute/config.json] [--json]
  rovloom storage check --role gateway [--config /absolute/config.json] [--json]
  rovloom storage backup --role gateway --output /path/to/gateway.backups/snapshot.db [--config /absolute/config.json] [--json]
  rovloom storage resume --role gateway [--config /absolute/config.json] [--json]

Gateway 命令须先停止服务；沿用同一写锁，拒绝活动或无法判定的持有者。
check 只读；backup 仅使用真实状态目录同级的 <state>.backups 普通目录，导出脱敏快照（不含原文及有效凭据），完整状态需另行离线备份。
resume 是本机操作员显式批准的解除降级，完整性、时钟或预算不正常时仍拒绝。
Connector doctor 只检查配置及 managed 状态，不启动 native，也不声明 native 就绪。
`,
  'help.service': `service install --role gateway|connector [--executable ABS] [--config ABS] --workdir ABS --user ACCOUNT
service uninstall|start|restart|stop --role gateway|connector
install 注册开机自启但不立即启动；uninstall 只撤销未来的开机自启，保留正在运行的实例及其控制记录。
省略 --executable 时使用当前独立可执行文件；传入其它可执行文件会被拒绝。
省略 --config 时沿用与前台启动相同的当前用户角色文件；安装固定其绝对路径，后台启动不再选择其它 home。
Linux 使用 systemd system 单元；macOS 使用系统 LaunchDaemons；Windows 使用开机触发任务，不是 SCM 服务或登录任务。
Gateway 服务支持 Linux systemd、macOS 系统 LaunchDaemons 和 Windows 开机触发任务；本机原生 Connector 服务支持 Linux x64、Windows x64 和 macOS（x64 / arm64）。
Windows 使用显式选择的既有用户与 S4U，不保存密码、不要求登录；不提供交互桌面或 Windows 网络凭据/EFS 访问。运行中的服务收到本地停止请求；排队/启动竞态中的任务返回 service_busy 且不强停；uninstall 从不停止它。
`,
  'guard.bunUnsupported': 'Rovloom 需要 Bun {minimum} 或更高版本（https://bun.sh）；当前运行时不受支持。\n',
  'run.wildcardListenWarning':
    'wildcard_listener\nMCP/管理页监听所有网卡且为明文 HTTP；请用防火墙或 TLS 反向代理收口。\n',
  'run.pairingRequiredHint': 'Gateway 已启动；使用 Agent 前仍需完成本地配对和原生初始化。\n',
  'run.configurationRequiredHint':
    '初始化需本地终端、可达 Gateway、完整配对及兼容 Luvus 安装；结果不确定时保留原状态并由所有者核查。\n',
  'setup.gatewayAddressPrompt': 'Gateway 地址: ',
  'setup.connector.pairingCodePrompt': '一次性配对码: ',
  'setup.connector.trustGateway': '信任此 Gateway 地址并兑换一次性设备配对？',
  'setup.connector.pairingCompleted': 'pairing_completed: 设备身份已持久配对；接下来发现所选原生安装。\n',
  'setup.connector.nativeSetupResponseUnavailable': '原生设置响应不可用；保留原状态，重新运行 Connector 核对。\n',
  'setup.connector.nativeStatePrepared': '原生状态已准备；启动正式 Connector，以 Gateway 的实际就绪提示为准。\n',
  'setup.native.managedUnsupportedWindows':
    '{provider}_managed_unsupported_on_windows: Windows 上暂不支持 managed，请把 native.{configKey}.mode 设为 "attach"。\n',
  'setup.native.managedUnsupportedMacos':
    '{provider}_managed_unsupported_on_macos: macOS 上暂不支持 managed，请把 native.{configKey}.mode 设为 "attach"。\n',
  'setup.native.statePathTooLongLuvus':
    'native_state_path_too_long: 初始化前请缩短 data.directory（Luvus 状态路径最多52个UTF-8字节）。\n',
  'setup.native.statePathTooLongHerdr':
    'native_state_path_too_long: 请缩短 data.directory 以容纳隔离 Herdr 的 socket（含 herdr-client.sock）。\n',
  'setup.prompt.connectorNativeAttachEnabled':
    '附着到你正在运行的 {kind} 会话（没有则在你自己的配置目录里启动一个），远程调用将直接操作你的真实工作区（用户配置已开启终端执行）？',
  'setup.prompt.connectorNativeAttachDisabled':
    '附着到你正在运行的 {kind} 会话（没有则在你自己的配置目录里启动一个），远程调用将直接操作你的真实工作区（关闭终端执行）？',
  'setup.prompt.connectorNativeIsolatedEnabled': '发现 {kind} 并创建隔离状态（用户配置已开启终端执行）？',
  'setup.prompt.connectorNativeIsolatedDisabled': '发现 {kind} 并创建隔离状态（关闭终端执行）？',
  'setup.prompt.gatewayNative':
    '批准这台设备的实测 Luvus（版本 {version}，二进制 SHA-256 {sha}）、普通窗口/Agent 操作及一个本机 MCP caller（终端执行由 Connector 本机所有者配置决定）？',
  'setup.prompt.gatewayNativeInstallations':
    '批准这些实测原生来源（{entries}）、各自窗口/Agent 操作及一个本机 MCP caller（终端执行由 Connector 本机所有者配置决定）？',
  'setup.repair.alreadyPaired':
    '此 Connector 已配对为 {machine}。重新配对只更换与 Gateway 的凭据，保留原生设置；请先停止该设备上其它正在运行的 Connector。\n',
  'setup.repair.codePrompt': '来自 rovloom gateway --repair-device 的一次性码: ',
  'setup.repair.trustConfirm': '信任此 Gateway 地址并用新凭据替换本机设备凭据？',
  'setup.repair.confirmationUnavailable': '未收到 Gateway 的确认；若 Connector 之后无法认证，请重新执行重新配对。\n',
  'setup.repair.deviceRepaired': 'device_repaired: 设备凭据已更换；正在启动 Connector。\n',
  'setup.gateway.resumeRePairing': '继续原重新配对，等待 Connector 重连。\n',
  'setup.gateway.repairCodeBlock':
    'Gateway MCP: {mcpUrl}\nConnector endpoint: {endpoint}\n已有设备的一次性重新配对码（5分钟，请保密）:\n{code}\n在该设备上停止 Connector，运行 rovloom connector --repair 并输入此码；旧凭据已失效。\n',
  'setup.gateway.endpoints': 'Gateway MCP: {mcpUrl}\nConnector endpoint: {endpoint}\n',
  'setup.gateway.unpairedRunning': 'Gateway 保持未配对并继续运行，不签发凭据。\n',
  'setup.gateway.managementFirstPairing':
    '在管理页完成首次配对：先用 `rovloom admin create` 创建管理员，登录 {page} 新建配对申请，再在设备上运行 `rovloom connector --claim`。\n',
  'setup.gateway.managementDisabled': '管理页未启用；请启用后重试或在本终端完成配对。\n',
  'setup.gateway.pairingCodeBlock':
    '一次性配对码（5分钟，请保密）:\n{code}\n在 Connector 的本地终端输入 Gateway 地址与该码；随后回到此终端批准实测安装。\n',
  'setup.gateway.resumingExisting': '继续原设置，不重新签发。\n',
  'setup.gateway.connectorReady': 'connector_ready: Connector 已通过真实认证且全部所选原生 provider 就绪。\n',
  'setup.gateway.adminBlock':
    '\n管理页: {page}\n管理员: admin\n管理员密码: {secret}\n(只显示一次；丢失后运行 rovloom admin create 重新签发。)',
  'setup.gateway.adminNotCreated': '\n未能创建管理页管理员，请稍后运行 rovloom admin create。',
  'setup.gateway.nativeSaved':
    '原生配置已保存，Gateway 将重开实际 provider。\nMCP 凭据文件: {clientPath}\nMCP URL: {url}\nTargets: {targets}\nBinding revision: 1',
  'setup.gateway.bearerAdditional':
    '\n现有 MCP Bearer 已覆盖此设备（不再显示；用 token create --like 克隆的令牌需要重新克隆）。',
  'setup.gateway.bearerSecret': '\nBearer (private): {token}',
  'setup.approval.resumeConfirm': '继续原设备设置？',
  'setup.approval.pairConfirm': '允许配对一个 Connector？',
  'setup.approval.repairDeviceConfirm':
    '重新配对已有设备 {name}（{machine}）？该设备当前凭据立即失效，进行中的调用结果变为未知。',
  'setup.claim.pairingCompletedActivated': 'pairing_completed: 设备身份已持久配对，原生激活已完成。\n',
  'setup.claim.waitEnded': '等待批准已结束；重新运行同一命令可继续原认领。\n',
  'setup.claim.restartConfirm': '原认领已终止或过期，是否使用新的配对申请重新认领？',
  'setup.claim.pairingIdPrompt': '配对申请 ID: ',
  'setup.claim.trustConfirm': '信任此 Gateway 地址并在线认领设备配对？',
  'setup.claim.claimCodeBlock': '核对码: {code}\n请在管理页为设备 {machine} 核对并批准此码。\n',
  'setup.claim.activationResponseUnavailable': '原生激活响应不可用；重新运行同一命令按原认领核对。\n',
  'setup.claim.nativeStatePrepared': '原生状态已准备；启动正式 Connector。\n',
  'admin.create.login': '在 {url} 用用户名 "{user}" 和下方密码登录（密码只显示一次）\n',
  'admin.create.created': '已创建管理员 {principal}，到期时间 {expires}\n',
  'admin.revoked': '已撤销管理员 {principal}\n',
  'token.created': '已创建 {principal}，到期时间 {expires}\n',
  'token.renewed': '已续期 {principal}，到期时间 {expires}\n',
  'token.rotated': '已轮换 {principal}，到期时间 {expires}\n',
  'token.permissions': '已设置 {principal} 的权限 discard_response={discard}\n',
  'token.revoked': '已撤销 {principal}\n',
  'mcp.instructions': '工具存在不表示后端可用；执行、授权、确认、去重与结果保留由受信服务负责。',
  'mcp.tool.machines_list': '列出当前 caller 可见的设备；分页和计数须经过当前 ACL。',
  'mcp.tool.machines_get': '按稳定 ID 或精确名称读取可见设备。',
  'mcp.tool.providers_list': '列出指定设备下当前 caller 可见的已配置 provider；不返回本机配置。',
  'mcp.tool.providers_get': '读取显式 provider 的 kind、revision 和 readiness。',
  'mcp.tool.runtime_discover': '发现显式 Target/revision 的有效能力及来源；不授予执行权限。',
  'mcp.tool.runtime_describe': '描述显式 Target/revision 下精确方法的原生参数、分类和限制。',
  'mcp.tool.runtime_call':
    '提交一次显式 Target/revision/契约的原生调用。deadline 是绝对毫秒期限，wait_ms 只控制短等；不重试或管理 provider。',
  'mcp.tool.runtime_call_get': '按当前归属、双端策略和内容门禁读取调用；短等到期不改变执行期限。',
  'mcp.tool.runtime_call_cancel': '请求停止等待或桥接；仅报告服务可确认程度，不承诺原生回滚。',
  'mcp.tool.runtime_result_read': '按当前读取授权和期限读取有界结果页；cursor 由服务绑定 caller 和原结果。',
  'mcp.tool.runtime_response_discard':
    '处理完结果后显式删除原文与句柄并释放读取容量；必须验证归属、当前原方法策略及独立 discard_response 权限。读取到 EOF 不会自动删除结果。'
})

// 词典键集由 english 的字面键类型固定；两种语言共享同一套键与占位符。
export function cliMessages(language: CliLanguage = 'en'): Readonly<Record<MessageKey, string>> {
  return language === 'zh-CN' ? chinese : english
}

// 仅替换词典占位符；缺失的占位符原样保留，便于测试发现遗漏。
export function formatMessage(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match
  )
}
