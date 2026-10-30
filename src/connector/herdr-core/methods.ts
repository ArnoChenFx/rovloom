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
 * 本期只开放不送输入、不改终端记录的普通读取；控制档仍不开放。
 * 目录、Wire 准入与观察入口都只认这个集合：Wire 桥接只做普通 RPC，不带流。
 */
export const HERDR_CORE_EXPOSED_METHODS: readonly string[] = Object.freeze([
  'server.status',
  'terminal.get',
  'terminal.list',
  'terminal.read',
  'terminal.wait'
])

/**
 * 事件订阅不是普通 RPC：它在 framed 通道上建立持续流，只给本地订阅入口（events.ts）使用，
 * 不进目录与 Wire 准入，否则 MCP 客户端会看到一个调了也无法运转的方法。
 */
export const HERDR_CORE_EVENT_METHOD = 'events.subscribe'

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
 * 其它方法用固定 5 秒。上限与 `HERDR_CORE_REQUEST_MAX_MS` 共用，超时只结束本地等待。
 */
export function herdrCoreRequestTimeout(method: string, params: Readonly<Record<string, unknown>>): number {
  const timeout = method === 'terminal.wait' && typeof params.timeout === 'number' ? params.timeout : 0
  return Math.min(Math.ceil(timeout * 1000) + 5000, HERDR_CORE_REQUEST_MAX_MS)
}

/** 表外方法一律拒绝；档位不按前缀猜测。 */
export function herdrCoreTier(method: string): ProviderMethodTier | undefined {
  return Object.hasOwn(HERDR_CORE_METHODS, method) ? HERDR_CORE_METHODS[method] : undefined
}

/** 本期开放的普通读取；其它已审核方法返回 undefined，由调用方给出固定错误码。 */
export function herdrCoreExposed(method: string): boolean {
  return HERDR_CORE_EXPOSED_METHODS.includes(method)
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
