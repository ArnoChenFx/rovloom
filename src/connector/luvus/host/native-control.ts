/** 内部控制口只启动本机配置指定的 Luvus child 并执行有限来源/凭据引导 RPC，不是公开 native 调用通道。 */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { compileBundle, createNativeValidator, parseNativeJson } from '../contract/index.js'
import type { CompiledContract } from '../contract/index.js'
import { boundedJson } from '../../../wire/index.js'
import { LuvusAdapterError, readLinuxLuvusPeer } from '../index.js'
import type { EndpointIdentity, LuvusLocalConfig } from '../index.js'
import {
  LUVUS_ENDPOINT_TRANSPORT,
  localLimits,
  pinConfig,
  measureLuvusInstallation,
  verifyInstallation,
  inspectEndpoint,
  recheckEndpoint
} from '../local.js'
import { deadline, runFixedProcess, runSocket } from '../io.js'
import { parseRpcFrame } from '../adapter.js'
import { OwnedNativeProcess, ownedPathStamp } from './native-process.js'

// 历史离线证据与预编译缓存标识，不用于安装接纳。
export const FIXED_LUVUS_SHA256 = '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9'
export const FIXED_LUVUS_SCHEMA_SHA256 = '00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6'
const controlBrand = Symbol('controlled-luvus-session')
export interface ControlledLuvusSession {
  readonly [controlBrand]: true
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly process: OwnedNativeProcess
  readonly endpoint: EndpointIdentity
  readonly binaryVersion: string
  readonly compiled: CompiledContract
}
type ControlState = Readonly<{ assertOwnership(): void; endpointStamp: string }>
const sessions = new WeakMap<ControlledLuvusSession, ControlState>()

/** 读取版本仅供诊断；命令不支持或格式未知不影响其它兼容接口，身份与取消错误照常保留。 */
export async function readLuvusVersion(config: LuvusLocalConfig, signal: AbortSignal): Promise<string> {
  const scope = deadline(signal, Math.min(1000, localLimits(config.limits).timeout_ms))
  try {
    const output = await runFixedProcess(config, localLimits(config.limits), 'version', scope.signal)
    const value = output.stdout
      .toString('utf8')
      .trim()
      .replace(/^luvus\s+/i, '')
    return output.exit_code === 0 &&
      value.length > 0 &&
      value.length <= 128 &&
      [...value].every(
        /** 诊断标签不得携带终端控制字符。 */ (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      )
      ? value
      : 'unavailable'
  } catch (error) {
    if (error instanceof LuvusAdapterError && error.code === 'native_timeout' && !signal.aborted) {
      return 'unavailable'
    }
    throw error
  } finally {
    scope.close()
  }
}

/** 从实际本机安装准备内部配置与完整编译契约；调用方不需要提供发行版 pin，不启动 server。 */
export async function discoverLuvusInstallation(
  input: Omit<LuvusLocalConfig, 'binary_sha256'>,
  options: Readonly<{ revision: string; signal: AbortSignal }>
): Promise<Readonly<{ config: LuvusLocalConfig; binaryVersion: string; compiled: CompiledContract }>> {
  const measured = await measureLuvusInstallation(input.binary)
  const config = pinConfig({ ...input, binary_sha256: measured.sha256 })
  const binaryVersion = await readLuvusVersion(config, options.signal)
  const schema = await runFixedProcess(config, localLimits(config.limits), 'schema', options.signal)
  if (schema.exit_code !== 0) {
    throw new LuvusAdapterError('native_schema_unavailable')
  }
  const compiled = await compileBundle(
    schema.stdout,
    {
      identity: {
        binary_sha256: measured.sha256,
        schema_sha256: createHash('sha256').update(schema.stdout).digest('hex'),
        revision: options.revision
      }
    },
    options.signal
  )
  if (!compiled.ok) {
    throw new LuvusAdapterError(compiled.error.code)
  }
  await verifyInstallation(config)
  return Object.freeze({ config, binaryVersion, compiled: compiled.value })
}

/** 每次核验真实受控 child、endpoint 与独立目录所有权；控制 handle 不从 JSON 重建。 */
export function assertControlledLuvus(session: ControlledLuvusSession): void {
  const state = sessions.get(session)
  if (!state) {
    throw new LuvusAdapterError('native_control_untrusted')
  }
  state.assertOwnership()
  session.process.assertLive()
  if (ownedPathStamp(session.endpoint.address, 'socket') !== state.endpointStamp) {
    throw new LuvusAdapterError('owned_endpoint_mismatch')
  }
}

/** 从受保护的实际安装启动本轮 child；失败清理也须确认真实退出，绝不从发现 PID 认领或补杀。 */
export async function startControlledLuvus(
  config: LuvusLocalConfig,
  options: Readonly<{ revision: string; signal: AbortSignal; assertOwnership(): void }>
): Promise<ControlledLuvusSession> {
  const fixed = pinConfig(config)
  if (fixed.transport !== 'ipc' || process.arch !== 'x64' || !process.versions.bun) {
    throw new LuvusAdapterError('native_control_installation_unsupported')
  }
  const limits = localLimits(fixed.limits)
  let child: OwnedNativeProcess | undefined
  try {
    options.assertOwnership()
    await verifyInstallation(fixed)
    const discovery = await discoverLuvusInstallation(fixed, options)
    options.assertOwnership()
    child = new OwnedNativeProcess(fixed)
    await child.started()
    let endpoint: EndpointIdentity | undefined
    while (!endpoint) {
      options.assertOwnership()
      child.assertLive()
      const discovery = await runFixedProcess(fixed, limits, 'sessions', options.signal)
      const parsed = parseNativeJson(discovery.stdout, { object_bytes: Math.min(limits.discovery_bytes, 1_048_576) })
      if (
        discovery.exit_code !== 0 ||
        !parsed.ok ||
        !parsed.value ||
        typeof parsed.value !== 'object' ||
        Array.isArray(parsed.value)
      ) {
        throw new LuvusAdapterError('native_control_discovery_invalid')
      }
      const rows = (parsed.value as Record<string, unknown>).sessions
      if (!Array.isArray(rows) || rows.length > 256) {
        throw new LuvusAdapterError('native_control_discovery_invalid')
      }
      const matches = rows.filter(
        /* 只使用固定 session 的地址发现，不采信广告 PID、actor 或其它自报身份。 */ (row) =>
          row?.name === fixed.target.session && row.running === true
      )
      if (matches.length > 1) {
        throw new LuvusAdapterError('native_control_discovery_invalid')
      }
      if (matches.length === 1) {
        if (
          matches[0].endpoint?.transport !== LUVUS_ENDPOINT_TRANSPORT ||
          typeof matches[0].endpoint?.address !== 'string'
        ) {
          throw new LuvusAdapterError('native_control_discovery_invalid')
        }
        endpoint = await inspectEndpoint(fixed, matches[0].endpoint.address)
      } else {
        await new Promise(/* 有界启动范围内等待本轮 server 建立 endpoint。 */ (resolve) => setTimeout(resolve, 20))
      }
    }
    const session: ControlledLuvusSession = Object.freeze({
      [controlBrand]: true as const,
      config: fixed as LuvusLocalConfig & { readonly transport: 'ipc' },
      process: child,
      endpoint,
      binaryVersion: discovery.binaryVersion,
      compiled: discovery.compiled
    })
    sessions.set(session, {
      assertOwnership: options.assertOwnership,
      endpointStamp: ownedPathStamp(endpoint.address, 'socket')
    })
    assertControlledLuvus(session)
    return session
  } catch (error) {
    await child?.close()
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_control_start_failed')
  }
}

/** 私有 finite RPC 只允许能力探测、精确短期 token 创建和开发空白预检，不能调用任意 method/params。 */
export async function controlledLuvusRpc(
  session: ControlledLuvusSession,
  method: 'uhp.token.create' | 'uhp.capabilities' | 'task.list' | 'automation.list' | 'module.list',
  params: Readonly<Record<string, unknown>>,
  auth: string | undefined,
  signal: AbortSignal
): Promise<
  Readonly<{
    frame: Record<string, unknown>
    result: Record<string, unknown>
  }>
> {
  assertControlledLuvus(session)
  if (method === 'uhp.token.create') {
    if (
      auth !== undefined ||
      Object.keys(params).sort().join(',') !== 'scopes,ttl_s' ||
      (!isDeepStrictEqual(params.scopes, ['read']) && !isDeepStrictEqual(params.scopes, ['read', 'orchestration'])) ||
      !Number.isSafeInteger(params.ttl_s) ||
      (params.ttl_s as number) < 1 ||
      (params.ttl_s as number) > 300
    ) {
      throw new LuvusAdapterError('native_control_request_forbidden')
    }
  } else if (Object.keys(params).length || (method !== 'uhp.capabilities' && !auth)) {
    throw new LuvusAdapterError('native_control_request_forbidden')
  }
  if (auth !== undefined && !/^[!-~]{1,256}$/u.test(auth)) {
    throw new LuvusAdapterError('native_auth_required')
  }
  const limits = localLimits(session.config.limits)
  const id = randomUUID()
  const bytes = Buffer.from(boundedJson({ id, method, params, ...(auth ? { auth } : {}) }, limits.request_bytes) + '\n')
  if (bytes.length > limits.request_bytes) {
    throw new LuvusAdapterError('native_request_limit')
  }
  const reply = await runSocket(
    session.endpoint.address,
    limits.response_bytes,
    signal,
    /** 同一已连接 socket 在发送前和最后同步栈内都必须测量真实内核 peer。 */ async (socket) => {
      await recheckEndpoint(session.config, session.endpoint)
      assertControlledLuvus(session)
      if (!isDeepStrictEqual(readLinuxLuvusPeer(socket), session.process.identity())) {
        throw new LuvusAdapterError('owned_peer_mismatch')
      }
      return {
        bytes,
        /** 最后一次 await 后独立复核实际 socket 与受控 child，不将先前身份缓存为永久许可。 */
        beforeWrite() {
          assertControlledLuvus(session)
          if (!isDeepStrictEqual(readLinuxLuvusPeer(socket), session.process.identity())) {
            throw new LuvusAdapterError('owned_peer_mismatch')
          }
        }
      }
    }
  )
  assertControlledLuvus(session)
  const frame = parseRpcFrame(reply, limits.response_bytes)
  if (
    frame.id !== id ||
    !createNativeValidator(session.compiled).checkResponseShape(frame).ok ||
    frame.error ||
    !frame.result ||
    typeof frame.result !== 'object' ||
    Array.isArray(frame.result)
  ) {
    throw new LuvusAdapterError('native_control_response_invalid')
  }
  return Object.freeze({ frame, result: frame.result as Record<string, unknown> })
}
