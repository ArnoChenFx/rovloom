// 已配对设备追加「配对时没有的 provider」：本机准备 → 用设备凭据向 Gateway 追加登记 → 写本机注册表。
// 不换配对码、不改设备身份；追加失败一律非致命，只打印固定码，继续用已配对来源启动。
import { setTimeout as delay } from 'node:timers/promises'
import { CliError, type ConnectorConfig, type NativeProviderKind } from './config.js'
import { parseJson } from '../json/bounds.js'
import { boundedJson, fields, object } from '../wire/index.js'
import type { SetupConsole } from './setup-console.js'
import { writeSetupJson } from './setup-files.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { providerSetupPath } from './provider-control.js'
import { prepareSetupHerdr } from './setup-herdr.js'
import { prepareSetupHerdrCore } from './setup-herdr-core.js'
import { prepareSetupNative } from './setup-native.js'
import { setupReference, SIMPLE_SETUP_ACTOR } from './setup-targets.js'
import { readSetupJson } from './setup-files.js'
import { createHash, randomUUID } from 'node:crypto'

/** 追加登记的单次请求上限：不能让 Gateway 不可达拖住 Connector 启动。 */
export const APPEND_TIMEOUT_MS = 10_000

export type AppendOutcome = Readonly<{
  appended: readonly NativeProviderKind[]
  /** 每个失败只带 kind 与固定原因码，不含路径、异常文本或凭据。 */
  failed: readonly Readonly<{ kind: NativeProviderKind; code: string }>[]
}>

/** 本机准备：复用 join 用的三个准备函数；已有 prepared 记录且设置未变时直接复用（重试收敛）。 */
async function prepare(
  config: ConnectorConfig,
  kind: NativeProviderKind,
  machine: string,
  attempt: string,
  console: SetupConsole
): Promise<Readonly<{ reference: string; local: unknown; remote: unknown }>> {
  const path = providerSetupPath(config.state_dir, kind)
  const existing = readSetupJson(path, 1_048_576)
  if (existing !== undefined) {
    let row: Record<string, unknown>
    try {
      row = object(existing)
    } catch {
      throw new CliError('configuration_required')
    }
    if (row.phase === 'prepared') {
      // 设置变了就不复用旧准备记录：那是上一次（可能是别的 native 配置）留下的，不替用户改写。
      if (boundedJson(row.settings) !== boundedJson(config.native ?? {})) {
        throw new CliError('configuration_required')
      }
      const reference = typeof row.reference === 'string' ? row.reference : ''
      const stored = typeof row.attempt_id === 'string' ? row.attempt_id : ''
      if (reference !== setupReference(stored, kind)) {
        throw new CliError('configuration_required')
      }
      return Object.freeze({ reference, local: row.local, remote: row.remote })
    }
    // 半完成的 initializing 记录没有任何已登记内容；挪进 retired/ 保留证据，再从头准备。
    retireSetupRecord(config, kind, path)
  }
  const authorization = { principal_id: SIMPLE_SETUP_ACTOR }
  const prepared =
    kind === 'luvus'
      ? await prepareSetupNative(config, console, machine, attempt, authorization)
      : kind === 'herdr'
        ? await prepareSetupHerdr(config, console, machine, attempt, authorization)
        : await prepareSetupHerdrCore(config, console, machine, attempt, authorization)
  return Object.freeze({ reference: prepared.reference, local: prepared.local, remote: prepared.remote })
}

/** 半完成记录退役到 retired/：只移动我们自己状态目录里的这一条，不删除、不覆盖。 */
function retireSetupRecord(config: ConnectorConfig, kind: NativeProviderKind, path: string): void {
  const target = runtimeReference(config.state_dir, 'retired/setup-' + kind + '-' + randomUUID())
  try {
    writeSetupJson(target, object(readSetupJson(path, 1_048_576)), false, 1_048_576)
    writeSetupJson(
      path,
      { schema_version: 1, retired_to: createHash('sha256').update(target).digest('hex').slice(0, 16) },
      true,
      1_048_576
    )
  } catch {
    throw new CliError('configuration_required')
  }
}

/** 有界读取响应体：只接受固定的小 JSON。 */
async function responseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > 65_536) {
      return undefined
    }
    const parsed = parseJson(bytes, { object_bytes: 65_536 })
    return parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 追加一个来源：POST 成功之后才写本机注册表，顺序固定。 */
async function appendOne(
  config: ConnectorConfig,
  kind: NativeProviderKind,
  credential: Readonly<{ machine_id: string; recovery_generation: string; credential: string }>,
  signal: AbortSignal,
  console: SetupConsole
): Promise<'appended' | Readonly<{ code: string }>> {
  let prepared: Readonly<{ reference: string; local: unknown; remote: unknown }>
  try {
    // 重试沿用 setup.json 里的 attempt id，Gateway 已登记时同 reference 幂等。
    const stored = readSetupJson(providerSetupPath(config.state_dir, kind), 1_048_576)
    const storedAttempt =
      stored !== undefined &&
      typeof stored === 'object' &&
      typeof (stored as Record<string, unknown>).attempt_id === 'string'
        ? String((stored as Record<string, unknown>).attempt_id)
        : undefined
    prepared = await prepare(config, kind, credential.machine_id, storedAttempt ?? randomUUID(), console)
  } catch (error) {
    return Object.freeze({ code: error instanceof CliError ? error.code : 'append_prepare_failed' })
  }
  const origin = new URL(config.gateway_url)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  let response: Response
  try {
    response = await fetch(new URL('/pairing/providers', origin), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: boundedJson(
        {
          machine_id: credential.machine_id,
          recovery_generation: credential.recovery_generation,
          credential: credential.credential,
          installation: { reference: prepared.reference, value: prepared.remote }
        },
        1_048_576
      ),
      signal: AbortSignal.any([signal, AbortSignal.timeout(APPEND_TIMEOUT_MS)])
    })
  } catch (error) {
    return Object.freeze({ code: (error as Error)?.name === 'TimeoutError' ? 'append_timeout' : 'append_network' })
  }
  const body = await responseJson(response)
  if (response.status !== 200 || body?.state !== 'appended') {
    const code =
      typeof body?.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(body.error)
        ? body.error
        : 'append_http_' + response.status
    return Object.freeze({ code })
  }
  // 只在 Gateway 确认之后写本机注册表：保留已有条目，追加同一个 {reference, local}。
  const path = runtimeReference(config.state_dir, 'providers')
  const current = object(readRuntimeJson(path, 1_048_576))
  fields(current, ['schema_version', 'role', 'providers'])
  if (current.schema_version !== 1 || current.role !== 'connector' || !Array.isArray(current.providers)) {
    return Object.freeze({ code: 'append_registry_invalid' })
  }
  const entries = current.providers as { reference: string; value: unknown }[]
  const found = entries.find(/** 同一 reference。 */ (entry) => entry.reference === prepared.reference)
  if (found) {
    if (boundedJson(found.value, 1_048_576) !== boundedJson(prepared.local, 1_048_576)) {
      return Object.freeze({ code: 'append_registry_conflict' })
    }
  } else {
    entries.push({ reference: prepared.reference, value: prepared.local })
  }
  try {
    writeSetupJson(path, { schema_version: 1, role: 'connector', providers: entries }, true, 1_048_576)
  } catch {
    return Object.freeze({ code: 'append_registry_unwritable' })
  }
  return 'appended'
}

/**
 * 依次追加 `kinds`。每个来源独立成败、互不影响；调用方在失败后继续用已配对来源启动，
 * 运行中不重试（下次启动再试）。
 */
export async function appendNativeProviders(input: {
  config: ConnectorConfig
  kinds: readonly NativeProviderKind[]
  credential: Readonly<{ machine_id: string; recovery_generation: string; credential: string }>
  console: SetupConsole
  signal: AbortSignal
}): Promise<AppendOutcome> {
  const appended: NativeProviderKind[] = []
  const failed: { kind: NativeProviderKind; code: string }[] = []
  for (const kind of input.kinds) {
    if (input.signal.aborted) {
      failed.push({ kind, code: 'append_cancelled' })
      continue
    }
    const outcome = await appendOne(input.config, kind, input.credential, input.signal, input.console)
    if (outcome === 'appended') {
      appended.push(kind)
    } else {
      failed.push({ kind, code: outcome.code })
    }
    // 每个来源之间让出事件循环：多个失败也按顺序打印，不阻塞角色装配。
    await delay(0)
  }
  return Object.freeze({ appended: Object.freeze(appended), failed: Object.freeze(failed) })
}
