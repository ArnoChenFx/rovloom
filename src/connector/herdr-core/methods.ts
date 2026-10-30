/**
 * herdr-core 0.1.14 的 32 个方法档位与本期开放集合；档位来自只读 spike（out/method-tiers.json），
 * 方法是否只读按参数判断，不能凭方法名或 schema 枚举开放。
 */
import type { ProviderMethodTier } from '../../runtime/provider-port.js'
import { fail } from '../../wire/index.js'

/** 被测版本与契约位置；升级后必须重新核对档位，不能用 schema 兼容代替行为兼容。 */
export const HERDR_CORE_REVIEW = Object.freeze({
  version: '0.1.14',
  commit: '29e6d37',
  protocol_generation: 1,
  openrpc: '1.3.2',
  methods_total: 32,
  /** 无认证的多余字段一律忽略，所以审核只信本仓库自己的参数规则。 */
  strictness: 'rovloom_reviewed_schemas'
})

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
export const HERDR_CORE_EXPOSED_METHODS: readonly string[] = Object.freeze([
  ...HERDR_CORE_READ_METHODS,
  ...HERDR_CORE_CONTROL_METHODS
])

/**
 * 控制档的终端栅栏参数：调用方必须带上它认定的 `(core_id, created_ms)`。
 * 终端地址在同一 core 内永久，但只删 `terminals.json` 后地址会被复用（spike 4b-F），
 * `(core.id, 地址)` 不唯一；这三个字段与实时 `terminal.get` 不一致就拒绝，
 * 绝不把输入送给同地址的另一个终端。
 */
export const HERDR_CORE_FENCE_PARAMS: readonly string[] = Object.freeze(['core_id', 'created_ms'])

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
  'terminal.interrupt': Object.freeze(['Sends the stop key and observes the outcome; it never escalates.'])
})

/** 已审核但本期不开放的方法及原因；原因写在这里，避免调用面自行解释档位。 */
export const HERDR_CORE_UNAVAILABLE: Readonly<Record<string, string>> = Object.freeze({
  'terminal.attach': 'needs_terminal_emulator'
})

/** 不传即不建立可信来源：caller 无认证、on 会把请求转发给远端机器、core 会把连接登记成对端。 */
export const HERDR_CORE_BLOCKED_PARAMS: readonly string[] = Object.freeze([
  'caller',
  'calls_you',
  'core',
  'on',
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
    if (!HERDR_CORE_FENCE_PARAMS.includes(key)) {
      native[key] = value
    }
  }
  return native
}

/**
 * 只接受本地终端地址 `t7`：名字会被 label 改写，`machine/t7` 属于远端路由，
 * 都不做输入目标。0.1.14 的扁平终端地址恒为 `tN`。
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
    // lines>0 会让 core 自己滚动取历史：全屏程序会收到鼠标滚轮输入。
    const lines = params.lines
    if (lines !== undefined && lines !== 0) {
      fail('herdr_core_read_history_unsupported')
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
  if (method === 'terminal.get') {
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
