/**
 * herdr-core 0.1.14/0.1.15 的 32 个方法档位与本期开放集合；档位来自只读 spike（out/method-tiers.json），
 * 方法是否只读按参数判断，不能凭方法名或 schema 枚举开放。
 */
import type { ProviderMethodTier } from '../../runtime/provider-port.js'
import { fail, fields } from '../../wire/index.js'

/**
 * 已审核的 core 版本与各自的上游发布提交。0.1.14 与 0.1.15 的 OpenRPC 契约除版本串和一句 `installed_by`
 * 说明外逐字相同；0.1.15 另在 360 个候选参数上与 0.1.14 的接受/拒绝结果逐条一致、真实输出样本形状一致，
 * 所以两者共用同一张档位表。新版本必须重新核对后再加入，不能用 schema 兼容代替行为兼容。
 */
export const HERDR_CORE_REVIEWED_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  '0.1.14': '29e6d37',
  '0.1.15': 'd028423'
})

/** 被测契约位置；版本以 {@link HERDR_CORE_REVIEWED_VERSIONS} 为准。 */
export const HERDR_CORE_REVIEW = Object.freeze({
  /** 最新一次审核的版本，只用于文案与默认值，不参与握手判定。 */
  latest: '0.1.15',
  protocol_generation: 1,
  openrpc: '1.3.2',
  methods_total: 32,
  /** 无认证的多余字段一律忽略，所以审核只信本仓库自己的参数规则。 */
  strictness: 'rovloom_reviewed_schemas'
})

/** 该版本已审核时返回它的发布提交，否则 `undefined`；只认自有键，`constructor` 之类原型键一律不算。 */
export function herdrCoreReviewedCommit(version: unknown): string | undefined {
  return typeof version === 'string' && Object.hasOwn(HERDR_CORE_REVIEWED_VERSIONS, version)
    ? HERDR_CORE_REVIEWED_VERSIONS[version]
    : undefined
}

/** 配对时记录的分类修订：`<版本>@<提交>`；未审核版本返回 `undefined`。 */
export function herdrCoreClassificationRevision(version: unknown): string | undefined {
  const commit = herdrCoreReviewedCommit(version)
  return commit === undefined ? undefined : `${version as string}@${commit}`
}

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
 * 启动类：`terminal.run` 是宿主级的任意程序能力，本阶段随 `allow_terminal_execution` 开放；
 * 它不接收 `terminal`，所以不需要终端三元组栅栏，但模板形态要先用 `templates.list` 核对。
 */
export const HERDR_CORE_RUN_METHODS: readonly string[] = Object.freeze(['terminal.run'])

/**
 * rovloom 自己提供的观察方法（不是 core 的方法）：`terminal.events` 是长轮询，
 * 一次返回「当前快照 + 自水位以来至多 N 条事件」。它走普通 RPC，不建立流。
 */
export const HERDR_CORE_EVENTS_POLL_METHOD = 'terminal.events'

export const HERDR_CORE_EXPOSED_METHODS: readonly string[] = Object.freeze([
  ...HERDR_CORE_READ_METHODS,
  ...HERDR_CORE_CONTROL_METHODS,
  ...HERDR_CORE_RUN_METHODS,
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
export const HERDR_CORE_OWNED_PARAMS: readonly string[] = Object.freeze([...HERDR_CORE_FENCE_PARAMS, 'template'])

/** `terminal.run` 的参数上限：argv 条数与总字节、env 条数、路径与名称长度。 */
export const HERDR_CORE_RUN_MAX_ARGV = 64
export const HERDR_CORE_RUN_MAX_ARGV_BYTES = 32 * 1024
export const HERDR_CORE_RUN_MAX_ENV = 64
export const HERDR_CORE_RUN_MAX_LINE_BYTES = 32 * 1024
/** `terminal.read` 的历史行数上限：单次结果仍受结果预算约束。 */
export const HERDR_CORE_READ_MAX_LINES = 1000
/** 由本 Connector 同时存活的、经 `terminal.run` 启动的终端上限（默认值，进配置参考）。 */
export const HERDR_CORE_MAX_RUN_TERMINALS = 32

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
  'terminal.events': Object.freeze([
    'Long poll: returns the current terminal snapshot plus up to `limit` events after `after_seq`. `rebuilt:true` means the state was replaced (missed events or a core restart) and earlier events are gone; `truncated:true` means the local buffer overflowed. Feed `next_after_seq` back as `after_seq`; filter with `address`/`labels`.'
  ])
})

/** 已审核但本期不开放的方法及原因；原因写在这里，避免调用面自行解释档位。 */
export const HERDR_CORE_UNAVAILABLE: Readonly<Record<string, string>> = Object.freeze({
  'terminal.attach': 'needs_terminal_emulator'
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
  'invalid_template'
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
  'parent',
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
  for (const key of ['keep', 'rm', 'wait', 'die_with_parent', 'outlive_parent']) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') {
      fail('herdr_core_param_invalid')
    }
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
