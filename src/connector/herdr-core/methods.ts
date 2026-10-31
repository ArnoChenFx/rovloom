/**
 * herdr-core 的 32 个方法档位与本期开放集合（按 0.1.14 核对，0.1.15 实测一致）；档位来自只读 spike（out/method-tiers.json），
 * 方法是否只读按参数判断，不能凭方法名或 schema 枚举开放。
 */
import type { ProviderMethodTier } from '../../runtime/provider-port.js'
import { fail, fields } from '../../wire/index.js'

/**
 * rovloom 自己审核的方法档位表与参数规则的修订号，配对时记入 `classification_revision`。
 * 它标识的是本仓库的表，不是 core 的版本：core 升级不改变它，只有改了档位或参数规则才递增。
 */
export const HERDR_CORE_CLASSIFICATION_REVISION = 'herdr-core-tiers-2'

/**
 * 仍能读进配置的分类修订（封闭集合，只追加）：`-1` 是 0.10.0 配对时写下的值。
 * 档位表变了（新增宿主级开放与 parent 栅栏），但已配对的设备不能因此要求重新配对：
 * 旧值照常启动，新配对写新值；表外值仍然拒绝。
 */
export const HERDR_CORE_CLASSIFICATION_REVISIONS: readonly string[] = Object.freeze([
  'herdr-core-tiers-2',
  'herdr-core-tiers-1'
])

/**
 * core 的版本号与协议代次都不设限制：握手只确认这是一个 framed 的 herdr-core（有核心 id、方法表与能力表），
 * 并把实际的版本与协议代次原样记进配对记录。兼容性由这几道门判定，而不是版本号：`rpc.discover` 文档必须能编译且
 * 档位表里每个方法都在、新版多出来的方法保持不可用、结果逐层严格、配对钉住二进制摘要与契约哈希。
 */

/**
 * A 观察 6、B 有条件 6、C 输入与控制 8、D 宿主级 12。
 * 档位只描述调用面；原生能力与保证强度另由 ProviderDescriptor 交付。
 */
export const HERDR_CORE_METHODS: Readonly<Record<string, ProviderMethodTier>> = Object.freeze({
  // A 观察档：不向程序送输入，也不需要额外授权。
  hello: 'observe',
  'server.status': 'observe',
  'rpc.discover': 'observe',
  'terminal.get': 'observe',
  'terminal.wait': 'observe',
  'events.subscribe': 'observe',
  // B 有条件档：默认副作用随参数或清理策略出现，调用方必须逐项复核。
  'terminal.list': 'conditional',
  'terminal.read': 'conditional',
  'terminal.attach': 'conditional',
  'templates.list': 'conditional',
  'doc.get': 'conditional',
  'machine.list': 'conditional',
  // C 输入与控制档：直接把字节送到程序或改变终端记录。
  'terminal.send': 'control',
  'terminal.keys': 'control',
  'terminal.interrupt': 'control',
  'terminal.put': 'control',
  'terminal.kill': 'control',
  'terminal.rm': 'control',
  'terminal.keep': 'control',
  'terminal.label': 'control',
  // D 宿主级：任意命令、任意文件、机器与 core 生命周期，不进入 MCP。
  // 将来开 terminal.run 时必须显式 notes=false 或不设父，否则 core 会往父智能体输入里打字。
  'terminal.run': 'host',
  'machine.exec': 'host',
  'file.read': 'host',
  'file.write': 'host',
  'file.edit': 'host',
  'doc.set': 'host',
  'machine.add': 'host',
  'machine.connect': 'host',
  'machine.rename': 'host',
  'machine.rm': 'host',
  'server.stop': 'host',
  'server.restart': 'host'
})

/**
 * 只读集合：不送输入、不改终端记录的普通读取，也是本地观察入口唯一接受的方法。
 */
export const HERDR_CORE_READ_METHODS: readonly string[] = Object.freeze([
  'server.status',
  'templates.list',
  'terminal.get',
  'terminal.list',
  'terminal.read',
  'terminal.wait'
])

/**
 * 控制档 8 个方法：宿主级 12 个方法（`terminal.run`、`machine.*`、`file.*`、`doc.set`、
 * `server.stop/restart`）仍不开放，目录、Wire 准入与参数复核三处继续拒绝。
 */
export const HERDR_CORE_CONTROL_METHODS: readonly string[] = Object.freeze([
  'terminal.send',
  'terminal.keys',
  'terminal.interrupt',
  'terminal.put',
  'terminal.kill',
  'terminal.rm',
  'terminal.keep',
  'terminal.label'
])

/**
 * 真正把字节送到程序的三个方法：core 只在 `send` 上拦 blocked，`keys`/`interrupt` 照常送达
 * （spike 3f），所以 blocked 只能由 rovloom 自己判断。`put` 只写文件、不送输入。
 */
export const HERDR_CORE_INPUT_METHODS: readonly string[] = Object.freeze([
  'terminal.send',
  'terminal.keys',
  'terminal.interrupt'
])

/**
 * 开放集合 = 5 个读取 + 8 个控制档。目录、Wire 准入与执行入口都只认这个集合：
 * Wire 桥接只做普通 RPC，不带流。
 */
/**
 * 启动类：`terminal.run` 是宿主级的任意程序能力，随 `allow_terminal_execution` 开放；
 * 它不接收 `terminal`，所以不需要终端三元组栅栏（带 `parent` 时另核对父终端），
 * 模板形态要先用 `templates.list` 核对。
 */
export const HERDR_CORE_RUN_METHODS: readonly string[] = Object.freeze(['terminal.run'])

/**
 * 宿主级能力（除 `terminal.run` 外）：任意命令、任意文件、文档与 core 生命周期。
 * 它们不针对单个终端，所以没有终端三元组；`server.*` 用 `core_id` 栅栏防错 core。
 * 能力上都不超过 `terminal.run`（它已经能执行任意程序），所以与它共用同一个本机开关，
 * 不新增第三个开关、不改 Wire。
 */
export const HERDR_CORE_HOST_METHODS: readonly string[] = Object.freeze([
  'machine.exec',
  'file.read',
  'file.write',
  'file.edit',
  'doc.get',
  'doc.set',
  'server.restart',
  'server.stop'
])

/** 受 `allow_terminal_execution` 约束的全部方法：控制档 + 启动类 + 宿主级。 */
export const HERDR_CORE_SWITCHED_METHODS: readonly string[] = Object.freeze([
  ...HERDR_CORE_CONTROL_METHODS,
  ...HERDR_CORE_RUN_METHODS,
  ...HERDR_CORE_HOST_METHODS
])

/** 需要 `core_id` 栅栏（不针对终端）的方法：core 生命周期。 */
export const HERDR_CORE_CORE_FENCE_METHODS: readonly string[] = Object.freeze(['server.restart', 'server.stop'])

/**
 * rovloom 自己提供的观察方法（不是 core 的方法）：`terminal.events` 是长轮询，
 * 一次返回「当前快照 + 自水位以来至多 N 条事件」。它走普通 RPC，不建立流。
 */
export const HERDR_CORE_EVENTS_POLL_METHOD = 'terminal.events'

export const HERDR_CORE_EXPOSED_METHODS: readonly string[] = Object.freeze([
  ...HERDR_CORE_READ_METHODS,
  ...HERDR_CORE_CONTROL_METHODS,
  ...HERDR_CORE_RUN_METHODS,
  ...HERDR_CORE_HOST_METHODS,
  HERDR_CORE_EVENTS_POLL_METHOD
])

/** 由 rovloom 提供、core 没有对应方法的入口；契约里没有它们，参数与结果由本仓库审核。 */
export const HERDR_CORE_SYNTHETIC_METHODS: readonly string[] = Object.freeze([HERDR_CORE_EVENTS_POLL_METHOD])

/** 长轮询参数上限与默认值。 */
export const HERDR_CORE_EVENTS_MAX_LIMIT = 256
export const HERDR_CORE_EVENTS_DEFAULT_LIMIT = 64
export const HERDR_CORE_EVENTS_MAX_TIMEOUT_MS = 30_000

/** describe 用的参数 schema（core 的契约里没有这个方法，由本仓库审核）。 */
export const HERDR_CORE_EVENTS_PARAMS_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    after_seq: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: HERDR_CORE_EVENTS_MAX_LIMIT },
    timeout_ms: { type: 'integer', minimum: 1, maximum: HERDR_CORE_EVENTS_MAX_TIMEOUT_MS },
    address: { type: 'string', pattern: '^t[0-9]{1,9}$' },
    labels: { type: 'object', additionalProperties: { type: 'string' } }
  },
  additionalProperties: false
})

/**
 * 控制档的终端栅栏参数：调用方必须带上它认定的 `(core_id, created_ms)`。
 * 终端地址在同一 core 内永久，但只删 `terminals.json` 后地址会被复用（spike 4b-F），
 * `(core.id, 地址)` 不唯一；这三个字段与实时 `terminal.get` 不一致就拒绝，
 * 绝不把输入送给同地址的另一个终端。
 */
export const HERDR_CORE_FENCE_PARAMS: readonly string[] = Object.freeze(['core_id', 'created_ms'])

/**
 * rovloom 自有参数：`template` 让调用方声明 `argv[0]` 是模板名（core 不认识它），
 * 执行端据此决定是否用 `templates.list` 核对。它们与栅栏字段一样在发送前剥离。
 */
export const HERDR_CORE_OWNED_PARAMS: readonly string[] = Object.freeze([
  ...HERDR_CORE_FENCE_PARAMS,
  'template',
  'parent_created_ms'
])

/** `terminal.run` 的参数上限：argv 条数与总字节、env 条数、路径与名称长度。 */
export const HERDR_CORE_RUN_MAX_ARGV = 64
export const HERDR_CORE_RUN_MAX_ARGV_BYTES = 32 * 1024
export const HERDR_CORE_RUN_MAX_ENV = 64
export const HERDR_CORE_RUN_MAX_LINE_BYTES = 32 * 1024
/** `terminal.read` 的历史行数上限：单次结果仍受结果预算约束。 */
export const HERDR_CORE_READ_MAX_LINES = 1000
/** 由本 Connector 同时存活的、经 `terminal.run` 启动的终端上限（默认值，进配置参考）。 */
export const HERDR_CORE_MAX_RUN_TERMINALS = 32

/** `machine.exec` 的 `timeout` 上限（秒）：core 允许 600，但本地请求上限是 65 秒，超过就会先本地超时。 */
export const HERDR_CORE_EXEC_MAX_SECONDS = 60
/** `file.*` / `doc.*` 的单个载荷上限：受请求帧预算约束，超限拒绝而不是截断。 */
export const HERDR_CORE_FILE_MAX_BASE64 = 256 * 1024
export const HERDR_CORE_EDIT_MAX = 64
export const HERDR_CORE_EDIT_MAX_BYTES = 64 * 1024
/** `doc.set` 的 `value` 序列化后上限；core 允许 1 MiB，这里按请求预算收紧。 */
export const HERDR_CORE_DOC_MAX_BYTES = 200 * 1024
/** core 的终端/文档名字规则：1–32 位小写字母、数字与 `- _ .`。 */
export const HERDR_CORE_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/u

/** `put` 的数据是 base64 文本；上限按单帧预算收紧，超限拒绝而不是截断。 */
export const HERDR_CORE_PUT_MAX_BASE64 = 512 * 1024
/** `send` 的文本上限；粘贴间隔 200 ms，文本越大占用的本地期限越长。 */
export const HERDR_CORE_SEND_MAX_BYTES = 64 * 1024
/** `keys` 一次最多按的键数与单个键名长度。 */
export const HERDR_CORE_KEYS_MAX = 64
export const HERDR_CORE_KEY_MAX_LENGTH = 32
/** `label` 一次最多写入的标签数与键值长度。 */
export const HERDR_CORE_LABELS_MAX = 32
export const HERDR_CORE_LABEL_MAX_LENGTH = 128
/** `send` 在 `wait=false` 时的本地期限：粘贴安静窗口约 3 秒，加逐段粘贴余量。 */
export const HERDR_CORE_SEND_MAX_MS = 20_000
/** `interrupt` 不传 timeout 时 core 自己观察 10 秒；本地期限据此留余量。 */
export const HERDR_CORE_INTERRUPT_DEFAULT_SECONDS = 10
/** `terminal.run` 不带 wait 时的本地期限：模板启动要等第一次状态报告（core 最多 30 秒）。 */
export const HERDR_CORE_RUN_MAX_MS = 40_000

/**
 * 事件订阅不是普通 RPC：它在 framed 通道上建立持续流，只给本地订阅入口（events.ts）使用，
 * 不进目录与 Wire 准入，否则 MCP 客户端会看到一个调了也无法运转的方法。
 */
export const HERDR_CORE_EVENT_METHOD = 'events.subscribe'

/**
 * 由 rovloom 自己撰写、经审核的使用说明：随 `runtime_describe` 交付给控制端。
 * 只写用法与已知边界，不转抄 core 的 SKILL 原文，也不引入新的机器可读合同。
 */
export const HERDR_CORE_GUIDE: readonly string[] = Object.freeze([
  'Run agents interactively (never one-shot flags). Put the task in the first `terminal.run` after a template name; a `send` to an agent that is still starting can be lost.',
  '`first_message.sent=false` means the first message was NOT delivered. Read the terminal before deciding; do not resend blindly.',
  'Multi-turn: `terminal.send` with `wait=true` and an explicit `timeout` sends and waits for that turn, then `terminal.read` with `lines` reads the reply. `reason=timeout` is a check-in, not a failure; `not_started` means the agent never went to work, so read the screen.',
  "Status comes from the program's own OSC 7501 report. `reported=false` means it never reports, and `wait` then only ends when it exits. Do not guess status from screen text.",
  '`blocked` needs a person (permission, question or auth): read the screen and hand it to the user. `force` is rejected and `keys` must not be used to bypass it.',
  '`turn` and `seq` are not proof that a turn succeeded. `screen=inexact` means core crashed and older history may be missing.',
  'Codex must run with `--no-daemon`, otherwise its commands run outside core.',
  "core capabilities rovloom does NOT expose: `machine.*` and the `on` parameter (they route through core's own machine table and would bypass the per-device scope of a rovloom token), `terminal.attach` (raw VT stream), `events.subscribe` (streaming; use `terminal.events`). `caller`/`calls_you`/`core` are unauthenticated identity fields and are always rejected.",
  'Write calls are never replayed. After a disconnect the result may be `outcome_unknown`; check `terminal.list` (by `name` or labels) before retrying.'
])

/** 逐方法的使用说明；没有条目的方法不补造。 */
export const HERDR_CORE_METHOD_USAGE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'terminal.read': Object.freeze([
    '`lines=0` reads the screen only and never types into the program. `lines>0` may type scroll keys into a full-screen program (stitching, up to 15s) and needs `allow_terminal_execution`.'
  ]),
  'terminal.wait': Object.freeze([
    'With `children`, pass `terminal` explicitly: rovloom never sends `caller`. `output` is for plain programs, not agents.'
  ]),
  'terminal.send': Object.freeze(['`wait=true` requires an explicit `timeout` (≤60s). rovloom rejects `force`.']),
  'terminal.interrupt': Object.freeze(['Sends the stop key and observes the outcome; it never escalates.']),
  'machine.exec': Object.freeze([
    'Runs one program without a terminal. `timeout` is required and capped by rovloom at 60s; `truncated:true` means it wrote more than core kept, so do not treat stdout/stderr as complete.'
  ]),
  'file.read': Object.freeze([
    '`path` must be absolute; `offset`/`limit` are 1-based lines. rovloom rejects a relative path and never guesses `cwd`.'
  ]),
  'file.write': Object.freeze([
    '`path` must be absolute; the write is swapped in whole by core (a reader sees old or new). `data` is base64 and bounded by the request budget.'
  ]),
  'file.edit': Object.freeze([
    '`path` must be absolute; every `old` must occur exactly once in the file as it was, and all edits are made or none. `cwd` is rejected.'
  ]),
  'doc.set': Object.freeze([
    '`version` is required and must be the current one from `doc.get` (0 for a name never written): this is a compare-and-set, rovloom does not guess it.'
  ]),
  'server.restart': Object.freeze([
    'Planned restart: screens are saved and programs keep running; the next core adopts them. `core_id` must match the connected core. The reply may be lost if the connection closes first (then the call is `outcome_unknown`).'
  ]),
  'server.stop': Object.freeze([
    'Stops the core and its programs; kept terminals get new shells when a core starts again. `core_id` must match. In attach mode the provider stays unavailable until someone starts the core; in managed mode the next call starts it again.'
  ]),
  'terminal.events': Object.freeze([
    'Long poll: returns the current terminal snapshot plus up to `limit` events after `after_seq`. `rebuilt:true` means the state was replaced (missed events or a core restart) and earlier events are gone; `truncated:true` means the local buffer overflowed. Feed `next_after_seq` back as `after_seq`; filter with `address`/`labels`.'
  ])
})

/**
 * 审核过、但 rovloom 永远不开放的方法及原因；随 `runtime_describe` 的 `blocked_methods` 交付，
 * 让控制端能发现「core 有、这个 provider 不给」的部分，而不是以为能力缺失是 bug。
 */
export const HERDR_CORE_UNAVAILABLE: Readonly<Record<string, string>> = Object.freeze({
  'terminal.attach': 'raw_vt_stream_not_request_response',
  'events.subscribe': 'streaming_not_request_response',
  'machine.list': 'bypasses_per_device_token_scope',
  'machine.add': 'bypasses_per_device_token_scope',
  'machine.connect': 'bypasses_per_device_token_scope',
  'machine.rename': 'bypasses_per_device_token_scope',
  'machine.rm': 'bypasses_per_device_token_scope'
})

/**
 * core 用 JSON-RPC 错误响应明确答复、且**在写入之前**就失败的 `data.kind`（读 0.1.14 源码核对；0.1.15 的净 diff 没有触及这些路径）：
 * - `status_mismatch` / `blocked`：`input.rs::send` 在 `type_in` 的 prepare 闭包里抛出，早于任何 Step::Write；
 * - `finished`：`check_program` 与 `type_in` 的活终端检查，同样早于写入；
 * - `not_found` / `machine_unknown` / `invalid_params`：目标或参数在动作之前就不可用。
 * 其它类别（`unavailable`、`config`、`internal`…）可能发生在动作中间，仍按 `outcome_unknown` 保守处理。
 */
export const HERDR_CORE_NATIVE_REJECTION_KINDS: readonly string[] = Object.freeze([
  'status_mismatch',
  'blocked',
  'finished',
  'not_found',
  'machine_unknown',
  'invalid_params',
  // terminal.run：名字在创建终端之前就查重，模板不可用也在启动之前。
  'name_taken',
  'invalid_template',
  // file.edit：先算出全部替换再落盘，任何一条不满足就整体失败、文件不变。
  'edit_failed',
  'not_text',
  // doc.set：版本不符发生在写入之前（CAS），文件/文档不变。
  'conflict'
])

/** 固定码：core 明确拒绝（不是「结果未知」），带上 core 自己的类别。 */
export function herdrCoreNativeRejectionCode(kind: string): string {
  return `herdr_core_native_${kind}`
}

/** 不传即不建立可信来源：caller 无认证、on 会把请求转发给远端机器、core 会把连接登记成对端。 */
export const HERDR_CORE_BLOCKED_PARAMS: readonly string[] = Object.freeze([
  'caller',
  'calls_you',
  'core',
  'on',
  'die_with_parent',
  'children_of'
])

/** wait 的检查间隔上限：超时只是 check-in，不能把长等当成完成证明。 */
export const HERDR_CORE_WAIT_MAX_SECONDS = 60
/** wait 请求的本地期限 = 检查间隔上限 + 5 秒余量；超时只结束本地等待，不宣称原生停止。 */
export const HERDR_CORE_REQUEST_MAX_MS = (HERDR_CORE_WAIT_MAX_SECONDS + 5) * 1000
/** 单帧上限与 core 的 MAX_PAYLOAD 一致；超过即拒绝，不静默截断。 */
export const HERDR_CORE_MAX_FRAME_BYTES = 16 * 1024 * 1024
/** 审核后的普通请求预算，远小于帧上限。 */
export const HERDR_CORE_MAX_REQUEST_BYTES = 256 * 1024

/**
 * 本地请求期限：wait 的检查间隔留 5 秒余量并取整（timeout 是秒，可以带小数）；
 * `send` 要等粘贴安静窗口并按 200 ms 间隔逐段粘贴，`interrupt` 默认观察 10 秒，
 * 其余方法用固定 5 秒。上限与 `HERDR_CORE_REQUEST_MAX_MS` 共用，超时只结束本地等待，
 * 不宣称原生停止；写类方法超时按 `outcome_unknown` 处理，绝不自动重放。
 */
export function herdrCoreRequestTimeout(method: string, params: Readonly<Record<string, unknown>>): number {
  const seconds = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  if (method === 'terminal.wait') {
    return Math.min(Math.ceil(seconds(params.timeout, 0) * 1000) + 5000, HERDR_CORE_REQUEST_MAX_MS)
  }
  if (method === 'terminal.send') {
    // `wait=true` 要等这一轮结束，期限由调用方显式给出（≤60 秒）；否则只等粘贴安静窗口。
    return params.wait === true
      ? Math.min(Math.ceil(seconds(params.timeout, 0) * 1000) + 5000, HERDR_CORE_REQUEST_MAX_MS)
      : HERDR_CORE_SEND_MAX_MS
  }
  if (method === 'terminal.interrupt') {
    return Math.min(
      Math.ceil(seconds(params.timeout, HERDR_CORE_INTERRUPT_DEFAULT_SECONDS) * 1000) + 5000,
      HERDR_CORE_REQUEST_MAX_MS
    )
  }
  if (method === HERDR_CORE_EVENTS_POLL_METHOD) {
    // 长轮询的本地期限 = 等待时限 + 5 秒余量；上限与其它方法共用。
    const timeout = typeof params.timeout_ms === 'number' ? params.timeout_ms : HERDR_CORE_EVENTS_MAX_TIMEOUT_MS
    return Math.min(timeout + 5000, HERDR_CORE_REQUEST_MAX_MS)
  }
  if (method === 'terminal.run' && params.wait === true) {
    // 启动 + 等第一轮；期限由调用方显式给出（≤60 秒），与 send wait 一致。
    return Math.min(Math.ceil(seconds(params.timeout, 0) * 1000) + 5000, HERDR_CORE_REQUEST_MAX_MS)
  }
  if (method === 'terminal.run') {
    // 模板形态要等智能体第一次报状态（core 默认最多 30 秒），留出余量。
    return HERDR_CORE_RUN_MAX_MS
  }
  return 5000
}

/** 表外方法一律拒绝；档位不按前缀猜测。 */
export function herdrCoreTier(method: string): ProviderMethodTier | undefined {
  return Object.hasOwn(HERDR_CORE_METHODS, method) ? HERDR_CORE_METHODS[method] : undefined
}

/** 开放集合（读取 + 控制档）；表外方法由调用方给出固定错误码。 */
export function herdrCoreExposed(method: string): boolean {
  return HERDR_CORE_EXPOSED_METHODS.includes(method)
}

/** 只读集合：本地观察入口不接受控制档，避免绕过 blocked 与三元组核对。 */
export function herdrCoreReadable(method: string): boolean {
  return HERDR_CORE_READ_METHODS.includes(method)
}

/** 控制档方法与需要 blocked 判定的输入方法。 */
export function herdrCoreControl(method: string): boolean {
  return HERDR_CORE_CONTROL_METHODS.includes(method)
}

export function herdrCoreInput(method: string): boolean {
  return HERDR_CORE_INPUT_METHODS.includes(method)
}

/**
 * 去掉 rovloom 自有的栅栏参数，只把原生参数交给 core。
 * 这些字段在审核 schema 里是必需的（调用方必须提供），但 core 不认识它们；
 * core 对未知字段静默忽略，所以必须在发送前显式剥离，不能依赖它被忽略。
 */
export function herdrCoreNativeParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const native: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (!HERDR_CORE_OWNED_PARAMS.includes(key)) {
      native[key] = value
    }
  }
  return native
}

/**
 * 只接受本地终端地址 `t7`：名字会被 label 改写，`machine/t7` 属于远端路由，
 * 都不做输入目标。0.1.14/0.1.15 的扁平终端地址恒为 `tN`。
 */
function reviewAddress(params: Readonly<Record<string, unknown>>): string {
  const address = params.terminal
  if (typeof address !== 'string' || !/^t[0-9]{1,9}$/u.test(address)) {
    fail('herdr_core_terminal_address_unsupported')
  }
  return address
}

/** 栅栏字段必须齐全且形状正确；缺失与形状不符分开，便于诊断。 */
function reviewFence(params: Readonly<Record<string, unknown>>): void {
  if (params.core_id === undefined || params.created_ms === undefined) {
    fail('herdr_core_terminal_fence_required')
  }
  const coreId = params.core_id
  const created = params.created_ms
  if (
    typeof coreId !== 'string' ||
    !/^[a-f0-9]{8,64}$/u.test(coreId) ||
    !Number.isSafeInteger(created) ||
    (created as number) < 0
  ) {
    fail('herdr_core_terminal_fence_invalid')
  }
}

/** 文本/数组/对象的长度上限：超限拒绝，绝不截断。 */
function reviewBounded(value: unknown, code: string, limit: number): void {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) {
    fail(code)
  }
}

/** `env` 键名沿用进程环境变量的形状；只校验形状，不回显值。 */
function reviewRunEnv(value: unknown): void {
  if (value === undefined) {
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('herdr_core_param_invalid')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > HERDR_CORE_RUN_MAX_ENV) {
    fail('herdr_core_param_invalid')
  }
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== 'string' || entry.length > 4096) {
      fail('herdr_core_param_invalid')
    }
  }
}

/** 长轮询参数：水位、条数、等待时限与 client 侧过滤；全部有界。 */
function reviewEventsParams(params: Readonly<Record<string, unknown>>): void {
  // 多余字段是协议不符，不静默忽略。
  fields(params, [], ['after_seq', 'limit', 'timeout_ms', 'address', 'labels'])
  const after = params.after_seq
  if (after !== undefined) {
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
      fail('herdr_core_event_invalid')
    }
  }
  const limit = params.limit
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > HERDR_CORE_EVENTS_MAX_LIMIT) {
      fail('herdr_core_event_invalid')
    }
  }
  const timeout = params.timeout_ms
  if (timeout !== undefined) {
    if (
      typeof timeout !== 'number' ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > HERDR_CORE_EVENTS_MAX_TIMEOUT_MS
    ) {
      fail('herdr_core_event_invalid')
    }
  }
  if (params.address !== undefined) {
    if (typeof params.address !== 'string' || !/^t[0-9]{1,9}$/u.test(params.address)) {
      fail('herdr_core_terminal_address_unsupported')
    }
  }
  if (params.labels !== undefined) {
    const labels = params.labels
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
      fail('herdr_core_param_invalid')
    }
    const entries = Object.entries(labels as Record<string, unknown>)
    if (
      entries.length > HERDR_CORE_LABELS_MAX ||
      entries.some(
        /** 过滤用的标签键与值都是普通文本，有界。 */ ([key, value]) =>
          !/^[A-Za-z0-9._-]{1,64}$/u.test(key) ||
          typeof value !== 'string' ||
          value.length > HERDR_CORE_LABEL_MAX_LENGTH
      )
    ) {
      fail('herdr_core_param_invalid')
    }
  }
}

/** 绝对路径：不接受相对路径、NUL 或超长。 */
function reviewAbsolutePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || Buffer.byteLength(value) > 4096) {
    fail('herdr_core_param_invalid')
  }
  return value
}

/** base64 文本的体积上限；超限拒绝而不是截断。 */
function reviewBase64(value: unknown, limit: number): void {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) {
    fail('herdr_core_text_too_large')
  }
}

/**
 * 宿主级方法的逐项收紧：任意命令、任意文件、文档与 core 生命周期。
 * 它们都不接受 `on`（远程机器会绕过按设备限定的 token）与 `cwd`（相对路径必须由调用方自己解析成绝对路径）。
 */
function reviewHostParams(method: string, params: Readonly<Record<string, unknown>>): void {
  // `on` 一律拒绝；`cwd` 只有 machine.exec 接受（必须是绝对路径），文件方法是绝对路径语义。
  if (params.on !== undefined) {
    fail('herdr_core_param_blocked')
  }
  if (method !== 'machine.exec' && params.cwd !== undefined) {
    fail('herdr_core_param_blocked')
  }
  if (method === 'machine.exec') {
    if (params.cwd !== undefined && params.cwd !== null) {
      reviewAbsolutePath(params.cwd)
    }
    const argv = params.argv
    const line = params.line
    if ((argv === undefined) === (line === undefined)) {
      // 恰好给一个：两个都给或都不给都不猜。
      fail('herdr_core_param_invalid')
    }
    if (argv !== undefined) {
      if (
        !Array.isArray(argv) ||
        argv.length < 1 ||
        argv.length > HERDR_CORE_RUN_MAX_ARGV ||
        argv.some(
          /** 逐项字符串，NUL 与空串都不接受。 */ (entry) => typeof entry !== 'string' || !entry || entry.includes('\0')
        ) ||
        Buffer.byteLength(JSON.stringify(argv)) > HERDR_CORE_RUN_MAX_ARGV_BYTES
      ) {
        fail('herdr_core_param_invalid')
      }
    }
    if (line !== undefined) {
      if (typeof line !== 'string' || !line || line.includes('\0')) {
        fail('herdr_core_param_invalid')
      }
      if (Buffer.byteLength(line) > HERDR_CORE_RUN_MAX_LINE_BYTES) {
        fail('herdr_core_text_too_large')
      }
    }
    reviewRunEnv(params.env)
    if (params.input !== undefined && params.input !== null) {
      reviewBase64(params.input, HERDR_CORE_FILE_MAX_BASE64)
    }
    // 必须显式给 timeout：core 默认 60 秒、上限 600，而本地请求上限是 65 秒。
    const timeout = params.timeout
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      fail('herdr_core_timeout_invalid')
    }
    if (timeout > HERDR_CORE_EXEC_MAX_SECONDS) {
      fail('herdr_core_timeout_exceeds_limit')
    }
    return
  }
  if (method === 'file.read') {
    reviewAbsolutePath(params.path)
    for (const key of ['offset', 'limit']) {
      const value = params[key]
      if (value !== undefined && value !== null) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          fail('herdr_core_param_invalid')
        }
      }
    }
    return
  }
  if (method === 'file.write') {
    reviewAbsolutePath(params.path)
    reviewBase64(params.data, HERDR_CORE_FILE_MAX_BASE64)
    return
  }
  if (method === 'file.edit') {
    reviewAbsolutePath(params.path)
    const edits = params.edits
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > HERDR_CORE_EDIT_MAX) {
      fail('herdr_core_param_invalid')
    }
    let bytes = 0
    for (const entry of edits) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail('herdr_core_param_invalid')
      }
      const edit = entry as Record<string, unknown>
      if (typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string') {
        fail('herdr_core_param_invalid')
      }
      bytes += Buffer.byteLength(edit.old) + Buffer.byteLength(edit.new)
    }
    if (bytes > HERDR_CORE_EDIT_MAX_BYTES) {
      fail('herdr_core_text_too_large')
    }
    return
  }
  if (method === 'doc.get') {
    if (typeof params.name !== 'string' || !HERDR_CORE_NAME_PATTERN.test(params.name)) {
      fail('herdr_core_param_invalid')
    }
    return
  }
  if (method === 'doc.set') {
    if (typeof params.name !== 'string' || !HERDR_CORE_NAME_PATTERN.test(params.name)) {
      fail('herdr_core_param_invalid')
    }
    if (params.value === undefined) {
      fail('herdr_core_param_invalid')
    }
    if (Buffer.byteLength(JSON.stringify(params.value)) > HERDR_CORE_DOC_MAX_BYTES) {
      fail('herdr_core_text_too_large')
    }
    // 版本是 core 的 CAS 语义：必填，不替调用方猜。
    if (!Number.isSafeInteger(params.version) || (params.version as number) < 0) {
      fail('herdr_core_param_invalid')
    }
    return
  }
  if (HERDR_CORE_CORE_FENCE_METHODS.includes(method)) {
    // core 生命周期用 core_id 栅栏：调用方必须先读 server.status，绝不把 stop/restart 打到错的 core。
    const coreId = params.core_id
    if (typeof coreId !== 'string') {
      fail('herdr_core_core_id_required')
    }
    if (!/^[a-f0-9]{8,64}$/u.test(coreId)) {
      fail('herdr_core_core_id_invalid')
    }
    if (Object.keys(params).some(/** 只有 core_id 一个自有参数，没有原生命令参数。 */ (key) => key !== 'core_id')) {
      fail('herdr_core_param_invalid')
    }
    return
  }
  fail('herdr_core_method_unavailable')
}

/** `terminal.run` 的逐项收紧：任意程序执行，参数必须完整可核对。 */
function reviewRunParams(params: Readonly<Record<string, unknown>>): void {
  const argv = params.argv
  const line = params.line
  if (argv !== undefined && line !== undefined) {
    fail('herdr_core_param_invalid')
  }
  if (argv !== undefined) {
    if (
      !Array.isArray(argv) ||
      argv.length > HERDR_CORE_RUN_MAX_ARGV ||
      argv.some(
        /** 逐项字符串，NUL 与空串都不接受。 */ (entry) => typeof entry !== 'string' || !entry || entry.includes('\0')
      )
    ) {
      fail('herdr_core_param_invalid')
    }
    if (Buffer.byteLength(JSON.stringify(argv)) > HERDR_CORE_RUN_MAX_ARGV_BYTES) {
      fail('herdr_core_text_too_large')
    }
  }
  if (line !== undefined) {
    if (typeof line !== 'string' || !line || line.includes('\0')) {
      fail('herdr_core_param_invalid')
    }
    if (Buffer.byteLength(line) > HERDR_CORE_RUN_MAX_LINE_BYTES) {
      fail('herdr_core_text_too_large')
    }
  }
  if (params.template !== undefined && typeof params.template !== 'boolean') {
    fail('herdr_core_param_invalid')
  }
  if (params.template === true && (!Array.isArray(argv) || argv.length === 0)) {
    fail('herdr_core_template_required')
  }
  if (params.cwd !== undefined && params.cwd !== null) {
    if (
      typeof params.cwd !== 'string' ||
      !params.cwd.startsWith('/') ||
      params.cwd.includes('\0') ||
      Buffer.byteLength(params.cwd) > 4096
    ) {
      fail('herdr_core_param_invalid')
    }
  }
  if (params.name !== undefined && params.name !== null) {
    if (typeof params.name !== 'string' || !/^[a-z0-9._-]{1,32}$/u.test(params.name)) {
      fail('herdr_core_param_invalid')
    }
  }
  reviewRunEnv(params.env)
  if (params.labels !== undefined) {
    const labels = params.labels
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
      fail('herdr_core_param_invalid')
    }
    const entries = Object.entries(labels as Record<string, unknown>)
    if (
      entries.length > HERDR_CORE_LABELS_MAX ||
      entries.some(
        /** 标签键与值都只接受有界文本。 */ ([key, value]) =>
          !/^[A-Za-z0-9._-]{1,64}$/u.test(key) ||
          typeof value !== 'string' ||
          value.length > HERDR_CORE_LABEL_MAX_LENGTH
      )
    ) {
      fail('herdr_core_param_invalid')
    }
  }
  for (const key of ['keep', 'rm', 'wait', 'outlive_parent']) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') {
      fail('herdr_core_param_invalid')
    }
  }
  // 父终端：与三元组同款的栅栏——地址 + 调用方认定的 created_ms，绝不把子终端挂到同地址的另一个终端。
  if (params.parent !== undefined && params.parent !== null) {
    if (typeof params.parent !== 'string' || !/^t[0-9]{1,9}$/u.test(params.parent)) {
      fail('herdr_core_terminal_address_unsupported')
    }
    const created = params.parent_created_ms
    if (!Number.isSafeInteger(created) || (created as number) < 0) {
      fail('herdr_core_terminal_fence_required')
    }
    if (params.no_parent === true) {
      fail('herdr_core_param_invalid')
    }
  } else if (params.parent_created_ms !== undefined) {
    fail('herdr_core_param_invalid')
  }
  // 没有父终端时 core 会往父智能体输入里打字；这两个参数只接受 true，不要求必填。
  for (const key of ['no_parent', 'no_notify']) {
    if (params[key] !== undefined && params[key] !== true) {
      fail('herdr_core_parent_unsupported')
    }
  }
  if (params.wait === true) {
    const timeout = params.timeout
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      fail('herdr_core_timeout_invalid')
    }
    if (timeout > HERDR_CORE_WAIT_MAX_SECONDS) {
      fail('herdr_core_timeout_exceeds_limit')
    }
  } else if (params.timeout !== undefined && params.timeout !== null) {
    fail('herdr_core_param_invalid')
  }
}

/**
 * 控制档的逐方法复核：终端地址与栅栏先于任何原生请求，再按方法收紧参数。
 * 这里不判断 blocked（需要实时终端状态，只有执行端能做），也不改写调用方参数。
 */
function reviewControlParams(method: string, params: Readonly<Record<string, unknown>>): void {
  reviewAddress(params)
  reviewFence(params)
  if (method === 'terminal.send') {
    // force 会绕过 core 自己的 blocked 闸门，而 rovloom 的判定不依赖它；默认从严，不接受。
    if (params.force === true) {
      fail('herdr_core_force_unsupported')
    }
    if (typeof params.text !== 'string' || Buffer.byteLength(params.text) > HERDR_CORE_SEND_MAX_BYTES) {
      fail('herdr_core_text_too_large')
    }
    if (params.wait !== undefined && typeof params.wait !== 'boolean') {
      fail('herdr_core_param_invalid')
    }
    if (params.wait === true) {
      // wait 是这一轮的检查点，期限必须由调用方显式给出，不能落到 core 默认的 180 秒。
      const timeout = params.timeout
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        fail('herdr_core_timeout_invalid')
      }
      if (timeout > HERDR_CORE_WAIT_MAX_SECONDS) {
        fail('herdr_core_timeout_exceeds_limit')
      }
    } else if (params.timeout !== undefined && params.timeout !== null) {
      fail('herdr_core_param_invalid')
    }
    if (params.if !== undefined && params.if !== null && params.if !== 'idle' && params.if !== 'working') {
      fail('herdr_core_param_invalid')
    }
    return
  }
  if (method === 'terminal.keys') {
    const keys = params.keys
    if (
      !Array.isArray(keys) ||
      keys.length < 1 ||
      keys.length > HERDR_CORE_KEYS_MAX ||
      keys.some(
        /** 键名是 core 自己的词汇，这里只限长度与形状。 */ (key) =>
          typeof key !== 'string' || key.length < 1 || key.length > HERDR_CORE_KEY_MAX_LENGTH
      )
    ) {
      fail('herdr_core_param_invalid')
    }
    return
  }
  if (method === 'terminal.interrupt') {
    const timeout = params.timeout
    if (timeout !== undefined && timeout !== null) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
        fail('herdr_core_timeout_invalid')
      }
      if (timeout > HERDR_CORE_WAIT_MAX_SECONDS) {
        fail('herdr_core_timeout_exceeds_limit')
      }
    }
    return
  }
  if (method === 'terminal.put') {
    reviewBounded(params.data, 'herdr_core_text_too_large', HERDR_CORE_PUT_MAX_BASE64)
    // 文件名只用来保留后缀，不接受路径分隔符或上跳。
    if (typeof params.name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(params.name)) {
      fail('herdr_core_param_invalid')
    }
    return
  }
  if (method === 'terminal.keep') {
    if (typeof params.keep !== 'boolean') {
      fail('herdr_core_param_invalid')
    }
    return
  }
  if (method === 'terminal.label') {
    const labels = params.labels
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
      fail('herdr_core_param_invalid')
    }
    const entries = Object.entries(labels as Record<string, unknown>)
    if (
      entries.length > HERDR_CORE_LABELS_MAX ||
      entries.some(
        /** 键与值都只接受有界文本；空值表示删除该标签。 */ ([key, value]) =>
          !/^[A-Za-z0-9._-]{1,64}$/u.test(key) ||
          typeof value !== 'string' ||
          value.length > HERDR_CORE_LABEL_MAX_LENGTH
      )
    ) {
      fail('herdr_core_param_invalid')
    }
    return
  }
  // kill/rm 只需要终端地址与栅栏，没有额外参数。
}

/**
 * 逐方法复核参数，再交给审核 schema。这里只做与安全性直接相关的规则：
 * 不传 caller/on/core/children_of；read 不取历史；wait 有上限。
 */
export function reviewHerdrCoreParams(method: string, params: Readonly<Record<string, unknown>>): void {
  if (!herdrCoreExposed(method)) {
    fail('herdr_core_method_unavailable')
  }
  for (const key of Object.keys(params)) {
    if (HERDR_CORE_BLOCKED_PARAMS.includes(key)) {
      fail('herdr_core_param_blocked')
    }
  }
  // parent / parent_created_ms 只属于 terminal.run（多 agent 编排）；其它方法出现它就是协议不符。
  if (method !== 'terminal.run' && (params.parent !== undefined || params.parent_created_ms !== undefined)) {
    fail('herdr_core_param_blocked')
  }
  if (herdrCoreControl(method)) {
    reviewControlParams(method, params)
    return
  }
  if (method === 'server.status' || method === 'terminal.list') {
    return
  }
  if (method === 'terminal.read') {
    // lines>0 会让 core 自己滚动取历史：全屏程序会收到鼠标滚轮输入，所以它同时受开关约束。
    const lines = params.lines
    if (lines !== undefined) {
      if (typeof lines !== 'number' || !Number.isSafeInteger(lines) || lines < 0) {
        fail('herdr_core_param_invalid')
      }
      if (lines > HERDR_CORE_READ_MAX_LINES) {
        fail('herdr_core_read_history_exceeds_limit')
      }
    }
    return
  }
  if (method === 'terminal.wait') {
    const timeout = params.timeout
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        fail('herdr_core_timeout_invalid')
      }
      if (timeout > HERDR_CORE_WAIT_MAX_SECONDS) {
        fail('herdr_core_timeout_exceeds_limit')
      }
    }
    return
  }
  if (method === 'terminal.get' || method === 'templates.list') {
    return
  }
  if (method === 'terminal.run') {
    reviewRunParams(params)
    return
  }
  if (HERDR_CORE_HOST_METHODS.includes(method)) {
    reviewHostParams(method, params)
    return
  }
  if (method === HERDR_CORE_EVENTS_POLL_METHOD) {
    reviewEventsParams(params)
    return
  }
  fail('herdr_core_method_unavailable')
}

/**
 * 订阅参数：按终端/子终端/标签过滤的订阅会留下空洞（spike 4a1 实测 3,5,7…），只接受无过滤订阅；
 * 需要过滤时由调用方在快照和连续事件上自行筛选。
 */
export function reviewHerdrCoreEventParams(params: Readonly<Record<string, unknown>>): void {
  if (Object.keys(params).length) {
    fail('herdr_core_param_blocked')
  }
}
