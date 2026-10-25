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
  rovloom gateway [--issue-code] [--config /absolute/path/config.json] [--non-interactive]
  rovloom connector --join <ws://host:port#pairing-code> [--config /absolute/path/config.json]
  rovloom connector --unpair [--non-interactive]
  rovloom service --help
  rovloom token --help
  rovloom doctor --help
  rovloom storage --help
  rovloom admin --help

gateway / connector starts the matching role. Pairing is one command: create a per-device pairing code on the
management page (or run 'rovloom gateway --issue-code' to print one), then run the displayed join command on the
Connector machine. No prompts, approvals or verification codes.
--issue-code makes the running Gateway print one fresh per-device pairing code and the full join command.
--join pairs and starts in one step; running it again with a new code re-pairs this machine as a new device,
and a join command from a different Gateway retires the previous local state and pairs there.
--unpair retires all local pairing state (kept under state/retired/) and clears the Gateway address for a clean start.
--non-interactive disables local interactive behavior (services run this way).
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
pairs the first Connector (generate a per-device code, then run the displayed join command on the device).
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
  'run.pairingRequiredHint':
    'Gateway is running; pair a Connector (management page or rovloom gateway --issue-code, then run the join command on the device) before using an Agent.\n',
  'run.configurationRequiredHint':
    'Setup requires a reachable Gateway, a valid pairing code and a compatible installed Luvus or Herdr. Preserve uncertain setup state for owner review.\n',
  'setup.native.managedUnsupportedWindows':
    '{provider}_managed_unsupported_on_windows: set native.{configKey}.mode to "attach".\n',
  'setup.native.managedUnsupportedMacos':
    '{provider}_managed_unsupported_on_macos: set native.{configKey}.mode to "attach".\n',
  'setup.join.completed': 'pairing_completed: device {machine} is paired with {url}.\n',
  'setup.join.providers': 'providers: {entries}\n',
  'setup.join.mcpBlock': 'MCP URL: {url}\nBearer (private): {token}\n',
  'setup.join.resettingState':
    'Previous pairing state for another device was retired to {retired}; pairing as a new device.\n',
  'setup.join.switchingGateway': 'Joining a different Gateway; previous pairing state was retired to {retired}.\n',
  'unpair.completed':
    'unpair_completed: local pairing state was retired to {retired} and the Gateway address was cleared.\nRun rovloom connector --join to pair with any Gateway.\n',
  'unpair.empty': 'unpair_completed: no local pairing state found; nothing to reset.\n',
  'setup.native.statePathTooLongLuvus':
    'native_state_path_too_long: choose a shorter data.directory before initialization (Luvus state path maximum 52 UTF-8 bytes).\n',
  'setup.native.statePathTooLongHerdr':
    'native_state_path_too_long: choose a shorter data.directory for the private Herdr sockets (herdr.sock and herdr-client.sock).\n',
  'setup.gateway.joinCommandBlock':
    'Join command (one per device; run it on the Connector machine to consume):\n  {command}\n',
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
  rovloom gateway [--issue-code] [--config /absolute/path/config.json] [--non-interactive]
  rovloom connector --join <ws://host:port#配对码> [--config /absolute/path/config.json]
  rovloom connector --unpair [--non-interactive]
  rovloom service --help
  rovloom token --help
  rovloom doctor --help
  rovloom storage --help
  rovloom admin --help

gateway / connector 启动对应角色。配对只需一条命令：在管理页生成一机一码（或运行 rovloom gateway --issue-code 打印一张），把显示的加入命令复制到 Connector 机器执行即可。没有问答、批准或核对码。
--issue-code 让运行中的 Gateway 打印一张新的一机一码及完整加入命令。
--join 一条命令完成配对并启动；用新码再次执行即把本机作为新设备重新配对，
换一台 Gateway 的加入命令则会退役旧状态并直接配对过去。
--unpair 把本地配对状态整体退役（保留在 state/retired/）并清空 Gateway 地址，得到干净的起点。
--non-interactive 关闭本地交互行为（服务以此运行）。
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
配对首台 Connector（生成一机一码，设备执行显示的加入命令）。
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
  'run.pairingRequiredHint':
    'Gateway 已启动；使用 Agent 前先配对一台 Connector（管理页或 rovloom gateway --issue-code 生成配对码，设备执行加入命令）。\n',
  'run.configurationRequiredHint':
    '初始化需可达 Gateway、有效配对码及兼容的 Luvus/Herdr 安装；结果不确定时保留原状态并由所有者核查。\n',
  'setup.native.managedUnsupportedWindows':
    '{provider}_managed_unsupported_on_windows: Windows 上暂不支持 managed，请把 native.{configKey}.mode 设为 "attach"。\n',
  'setup.native.managedUnsupportedMacos':
    '{provider}_managed_unsupported_on_macos: macOS 上暂不支持 managed，请把 native.{configKey}.mode 设为 "attach"。\n',
  'setup.join.completed': 'pairing_completed: 设备 {machine} 已与 {url} 完成配对。\n',
  'setup.join.providers': 'providers: {entries}\n',
  'setup.join.mcpBlock': 'MCP URL: {url}\nBearer (private): {token}\n',
  'setup.join.resettingState': '另一台设备的旧配对状态已退役到 {retired}；正以新设备身份重新配对。\n',
  'setup.join.switchingGateway': '正在加入另一台 Gateway；旧配对状态已退役到 {retired}。\n',
  'unpair.completed':
    'unpair_completed: 本地配对状态已退役到 {retired}，Gateway 地址已清空。\n运行 rovloom connector --join 即可与任意 Gateway 重新配对。\n',
  'unpair.empty': 'unpair_completed: 本机没有可重置的配对状态。\n',
  'setup.native.statePathTooLongLuvus':
    'native_state_path_too_long: 初始化前请缩短 data.directory（Luvus 状态路径最多52个UTF-8字节）。\n',
  'setup.native.statePathTooLongHerdr':
    'native_state_path_too_long: 请缩短 data.directory 以容纳隔离 Herdr 的 socket（含 herdr-client.sock）。\n',
  'setup.gateway.joinCommandBlock': '加入命令（一机一码，复制到 Connector 机器执行即消费）：\n  {command}\n',
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
